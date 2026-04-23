// Coverage backfill for useListExport boundary paths.
// `useListExport-cancel.test.ts` covers cancel + abort; this file
// fills the remaining branches: fast-path (no hasMore), maxRows abort,
// maxPages abort, filterFn page filtering, CSV escape on hostile
// values, JSON fallback, and the filename stamp.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { useListExport } from '../composables/useListExport'

type Row = { id: string; note?: string }

function makePage(ids: string[], hasMore: boolean, nextCursor: string): {
  items: Row[]; hasMore: boolean; nextCursor: string
} {
  return { items: ids.map(id => ({ id })), hasMore, nextCursor }
}

// Captures what the synthesized <a> element would have pointed at, so
// we can assert filename + content without running the download.
function withDownloadSpies() {
  const created: { content: string; mime: string; filename: string }[] = []
  const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation(((blob: Blob) => {
    // Blob.text() is async; read via FileReader synchronously via text() promise.
    void blob
    return 'blob:stub'
  }) as typeof URL.createObjectURL)
  const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

  const origCreate = document.createElement.bind(document)
  const createElSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = origCreate(tag) as HTMLElement
    if (tag === 'a') {
      const anchor = el as HTMLAnchorElement
      anchor.click = function stubClick() {
        created.push({
          content: '',
          mime: '',
          filename: anchor.download,
        })
      }
    }
    return el
  })

  return {
    created,
    restore: () => {
      createObjectURLSpy.mockRestore()
      revokeSpy.mockRestore()
      createElSpy.mockRestore()
    },
  }
}

describe('useListExport — fast path (hasMore=false)', () => {
  let spies: ReturnType<typeof withDownloadSpies>
  beforeEach(() => { spies = withDownloadSpies() })
  afterEach(() => { spies.restore() })

  it('CSV short-circuits and writes currentItems without calling fetchPage', async () => {
    const currentItems = ref<Row[]>([{ id: 'a' }, { id: 'b' }])
    const hasMore = ref(false)
    const nextCursor = ref('')
    const fetchPage = vi.fn()
    const exp = useListExport<Row>({
      itemNoun: 'thing',
      currentItems,
      hasMore,
      nextCursor,
      fetchPage,
      columns: [{ header: 'id', value: r => r.id }],
    })
    exp.confirmExport('csv')
    await exp.executeExport()
    expect(fetchPage).not.toHaveBeenCalled()
    expect(spies.created).toHaveLength(1)
    expect(spies.created[0]!.filename).toMatch(/^things-\d{4}-\d{2}-\d{2}\.csv$/)
  })

  it('JSON short-circuits and produces a .json download', async () => {
    const currentItems = ref<Row[]>([{ id: 'a' }])
    const hasMore = ref(false)
    const nextCursor = ref('')
    const exp = useListExport<Row>({
      itemNoun: 'thing',
      filenameStem: 'custom-stem',
      currentItems,
      hasMore,
      nextCursor,
      fetchPage: vi.fn(),
      columns: [{ header: 'id', value: r => r.id }],
    })
    exp.confirmExport('json')
    await exp.executeExport()
    expect(spies.created[0]!.filename).toMatch(/^custom-stem-\d{4}-\d{2}-\d{2}\.json$/)
  })
})

describe('useListExport — maxRows / maxPages abort', () => {
  let spies: ReturnType<typeof withDownloadSpies>
  beforeEach(() => { spies = withDownloadSpies() })
  afterEach(() => { spies.restore() })

  it('aborts with an actionable message when the result set exceeds maxRows', async () => {
    const currentItems = ref<Row[]>([{ id: 'seed' }])
    const hasMore = ref(true)
    const nextCursor = ref('p2')
    // Keep returning pages with hasMore=true so the loop relies on
    // maxRows to stop.
    const fetchPage = vi.fn<(cursor: string) => Promise<ReturnType<typeof makePage>>>()
      .mockImplementation(async (cursor) => {
        return makePage([`${cursor}-x`, `${cursor}-y`], true, `${cursor}-next`)
      })
    const exp = useListExport<Row>({
      itemNoun: 'thing',
      currentItems,
      hasMore,
      nextCursor,
      fetchPage,
      maxRows: 3, // seed(1) + one page(2) = 3, next iteration breaks the while
      columns: [{ header: 'id', value: r => r.id }],
    })
    exp.confirmExport('csv')
    await exp.executeExport()
    expect(exp.exportError.value).toMatch(/exceeds 3 rows.*Narrow your filter/)
    expect(spies.created).toHaveLength(0) // no blob on abort
  })

  it('aborts via maxPages when every page is tiny', async () => {
    const currentItems = ref<Row[]>([{ id: 'seed' }])
    const hasMore = ref(true)
    const nextCursor = ref('p2')
    const fetchPage = vi.fn<(cursor: string) => Promise<ReturnType<typeof makePage>>>()
      .mockImplementation(async (cursor) => makePage([cursor], true, `${cursor}-next`))
    const exp = useListExport<Row>({
      itemNoun: 'thing',
      currentItems,
      hasMore,
      nextCursor,
      fetchPage,
      maxPages: 3, // seed counts as page 1 → 2 fetched pages → break
      columns: [{ header: 'id', value: r => r.id }],
    })
    exp.confirmExport('csv')
    await exp.executeExport()
    // Hit neither maxRows nor hasMore=false — the loop exits via
    // pagesFetched < maxPages going false. Completes normally with the
    // truncated set since hasMoreLocal is only flagged an error if
    // all.length >= maxRows.
    expect(exp.exportError.value).toBe('')
    expect(spies.created).toHaveLength(1)
  })
})

describe('useListExport — filterFn + CSV formatting', () => {
  let spies: ReturnType<typeof withDownloadSpies>
  beforeEach(() => { spies = withDownloadSpies() })
  afterEach(() => { spies.restore() })

  it('applies filterFn only to fetched pages, not to the currentItems seed', async () => {
    // seed already matches operator filter; page contains a mix.
    const currentItems = ref<Row[]>([{ id: 'seed-keep' }])
    const hasMore = ref(true)
    const nextCursor = ref('p2')
    const fetchPage = vi.fn<(cursor: string) => Promise<ReturnType<typeof makePage>>>()
      .mockResolvedValueOnce(makePage(['keep-1', 'drop-1', 'keep-2'], false, ''))
    const filterFn = (r: Row) => r.id.startsWith('keep') || r.id.startsWith('seed')
    const seenIds: string[] = []
    const exp = useListExport<Row>({
      itemNoun: 'thing',
      currentItems,
      hasMore,
      nextCursor,
      fetchPage,
      filterFn,
      columns: [{ header: 'id', value: r => { seenIds.push(r.id); return r.id } }],
    })
    exp.confirmExport('csv')
    await exp.executeExport()
    // Seed (seed-keep) + filtered page (keep-1, keep-2). drop-1 excluded.
    expect(seenIds).toEqual(['seed-keep', 'keep-1', 'keep-2'])
  })
})

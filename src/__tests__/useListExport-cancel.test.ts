// Non-spec scale polish: verify the multi-page export loop observes
// `cancelRunningExport()` and bails without writing a blob.
//
// Pre-fix: an operator who kicked off a wrong-filter export (heading
// for the 50k-row cap) had no way to abort short of closing the tab
// — losing every other bit of session state. The overlay now renders
// a Cancel button when `exportCancellable` is true; useListExport
// owns the AbortController and checks between page fetches.

import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { useListExport } from '../composables/useListExport'

type Row = { id: string }

function makePage(ids: string[], hasMore: boolean, nextCursor: string) {
  return { items: ids.map(id => ({ id })), hasMore, nextCursor }
}

describe('useListExport cancellation', () => {
  it('bails from the multi-page loop when cancelRunningExport() fires', async () => {
    const currentItems = ref<Row[]>([{ id: 'seed' }])
    const hasMore = ref(true)
    const nextCursor = ref('p2')

    const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:noop')
    const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const fetchPage = vi.fn<(cursor: string) => Promise<ReturnType<typeof makePage>>>()
      .mockImplementation(async (cursor) => {
        if (cursor === 'p2') return makePage(['a', 'b'], true, 'p3')
        if (cursor === 'p3') return makePage(['c', 'd'], true, 'p4')
        return makePage(['e', 'f'], false, '')
      })

    const exp = useListExport<Row>({
      itemNoun: 'thing',
      currentItems,
      hasMore,
      nextCursor,
      fetchPage,
      columns: [{ header: 'id', value: r => r.id }],
    })

    // Open the confirm dialog, then kick off export.
    exp.confirmExport('csv')
    expect(exp.showExportConfirm.value).toBe('csv')

    const promise = exp.executeExport()

    // Yield once so the slow-path branch sets exportCancellable before cancel.
    await Promise.resolve()
    expect(exp.exportCancellable.value).toBe(true)

    // Cancel the running export; the next iteration of the cursor loop
    // must observe the signal and return null.
    exp.cancelRunningExport()

    await promise

    expect(exp.exportError.value).toBe('Export cancelled.')
    expect(exp.exporting.value).toBe(false)
    expect(exp.exportCancellable.value).toBe(false)
    // No blob written when cancelled — createObjectURL never fires.
    expect(createObjectURLSpy).not.toHaveBeenCalled()

    createObjectURLSpy.mockRestore()
    revokeObjectURLSpy.mockRestore()
  })

  it('P0-C4: drops a late page when cancel fires mid-fetch', async () => {
    // Pre-fix: cancel during an in-flight fetchPage was a no-op — the
    // fetch completed, data was appended, and only the NEXT iteration
    // noticed the abort. That's a correctness bug when the late page
    // either (a) slips into the blob the user thought they cancelled,
    // or (b) lands after the overlay has already closed.
    const currentItems = ref<Row[]>([{ id: 'seed' }])
    const hasMore = ref(true)
    const nextCursor = ref('p2')

    const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:noop')
    const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    let resolveFirstPage!: (v: ReturnType<typeof makePage>) => void
    const firstPagePromise = new Promise<ReturnType<typeof makePage>>(r => { resolveFirstPage = r })
    let receivedSignal: AbortSignal | undefined
    const fetchPage = vi.fn<(cursor: string, signal?: AbortSignal) => Promise<ReturnType<typeof makePage>>>()
      .mockImplementation(async (_cursor, signal) => {
        receivedSignal = signal
        return firstPagePromise
      })

    const exp = useListExport<Row>({
      itemNoun: 'thing',
      currentItems,
      hasMore,
      nextCursor,
      fetchPage,
      columns: [{ header: 'id', value: r => r.id }],
    })

    exp.confirmExport('csv')
    const promise = exp.executeExport()
    await Promise.resolve()

    // Signal was forwarded into fetchPage.
    expect(receivedSignal).toBeDefined()
    expect(receivedSignal?.aborted).toBe(false)

    // Cancel while the page is still in flight.
    exp.cancelRunningExport()
    expect(receivedSignal?.aborted).toBe(true)

    // Now the in-flight page resolves with "late" data. Composable must
    // notice the aborted signal and drop it rather than append.
    resolveFirstPage(makePage(['late'], true, 'p3'))
    await promise

    expect(exp.exportError.value).toBe('Export cancelled.')
    expect(createObjectURLSpy).not.toHaveBeenCalled()

    createObjectURLSpy.mockRestore()
    revokeObjectURLSpy.mockRestore()
  })

  it('P0-C4: surfaces AbortError from fetchPage as a cancel, not a crash', async () => {
    // When fetchPage rethrows an AbortError (what fetch() does when the
    // signal aborts mid-request), we must treat it as cancellation —
    // not surface "AbortError" as the export error text.
    const currentItems = ref<Row[]>([{ id: 'seed' }])
    const hasMore = ref(true)
    const nextCursor = ref('p2')

    const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:noop')
    const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const fetchPage = vi.fn<(cursor: string, signal?: AbortSignal) => Promise<ReturnType<typeof makePage>>>()
      .mockImplementation(async (_cursor, signal) => {
        // Simulate the real fetch() behaviour when aborted.
        await Promise.resolve()
        signal?.throwIfAborted?.()
        // If not aborted yet, throw to simulate an abort that already fired.
        throw new DOMException('aborted', 'AbortError')
      })

    const exp = useListExport<Row>({
      itemNoun: 'thing',
      currentItems,
      hasMore,
      nextCursor,
      fetchPage,
      columns: [{ header: 'id', value: r => r.id }],
    })

    exp.confirmExport('csv')
    const promise = exp.executeExport()
    await Promise.resolve()
    exp.cancelRunningExport()
    await promise

    expect(exp.exportError.value).toBe('Export cancelled.')
    expect(createObjectURLSpy).not.toHaveBeenCalled()

    createObjectURLSpy.mockRestore()
    revokeObjectURLSpy.mockRestore()
  })

  it('completes normally when not cancelled', async () => {
    const currentItems = ref<Row[]>([{ id: 'seed' }])
    const hasMore = ref(true)
    const nextCursor = ref('p2')

    const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:noop')
    const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    // Stub anchor click so JSDOM doesn't navigate.
    const origCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag) as HTMLElement
      if (tag === 'a') (el as HTMLAnchorElement).click = () => {}
      return el
    })

    const fetchPage = vi.fn<(cursor: string) => Promise<ReturnType<typeof makePage>>>()
      .mockResolvedValueOnce(makePage(['a'], false, ''))

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

    expect(exp.exportError.value).toBe('')
    expect(exp.exporting.value).toBe(false)
    expect(exp.exportCancellable.value).toBe(false)
    expect(createObjectURLSpy).toHaveBeenCalledOnce()

    createObjectURLSpy.mockRestore()
    revokeObjectURLSpy.mockRestore()
    vi.restoreAllMocks()
  })
})

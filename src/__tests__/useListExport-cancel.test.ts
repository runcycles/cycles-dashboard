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

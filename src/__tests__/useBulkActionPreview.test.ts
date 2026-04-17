// O1 (UI/UX P0): preview composable for filter-apply bulk actions.
// Walks the cursor with the bulk endpoint's same server-side filter,
// applies an action-specific predicate client-side, and surfaces a
// count + sample. Tests the four states callers care about:
//   1. exact count (walk completed naturally) → reachedEnd=true
//   2. capped at maxMatches (501+) → cappedAtMax=true, no expected_count
//   3. capped at maxPages (partial, unknown total) → cappedAtPages=true
//   4. cancellation (mid-walk abort) → previewError set, no further pages
//
// Plus correctness around sample collection (first 10) and predicate
// filtering (server `search` returns superset; client predicate prunes).

import { describe, it, expect, vi } from 'vitest'
import { useBulkActionPreview, type PreviewSample } from '../composables/useBulkActionPreview'

type Row = { id: string; name: string; status: string }

function row(id: string, status = 'ACTIVE'): Row {
  return { id, name: `name-${id}`, status }
}

function pages(...batches: Array<{ items: Row[]; hasMore: boolean; nextCursor: string }>) {
  let i = 0
  return vi.fn(async () => {
    if (i >= batches.length) return { items: [], hasMore: false, nextCursor: '' }
    return batches[i++]
  })
}

const toSample = (r: Row): PreviewSample => ({ id: r.id, primary: r.name, status: r.status })
const acceptAll = () => true
const onlyActive = (r: Row) => r.status === 'ACTIVE'

describe('useBulkActionPreview', () => {
  it('walks pages, collects exact count + first 10 samples when has_more=false', async () => {
    // 12 matching rows across two pages; samples should cap at 10.
    const fetchPage = pages(
      { items: Array.from({ length: 7 }, (_, i) => row(`a${i}`)), hasMore: true, nextCursor: 'p2' },
      { items: Array.from({ length: 5 }, (_, i) => row(`b${i}`)), hasMore: false, nextCursor: '' },
    )
    const p = useBulkActionPreview<Row>({ fetchPage, filterFn: acceptAll, toSample })
    await p.startPreview()
    expect(p.previewCount.value).toBe(12)
    expect(p.previewSamples.value).toHaveLength(10)
    expect(p.previewSamples.value[0].id).toBe('a0')
    expect(p.previewSamples.value[9].id).toBe('b2')
    expect(p.reachedEnd.value).toBe(true)
    expect(p.cappedAtMax.value).toBe(false)
    expect(p.cappedAtPages.value).toBe(false)
    expect(p.previewError.value).toBe('')
    expect(p.previewLoading.value).toBe(false)
  })

  it('applies the client-side filterFn (server search returns a superset)', async () => {
    // Page returns mixed statuses; client predicate keeps only ACTIVE.
    const fetchPage = pages({
      items: [row('a', 'ACTIVE'), row('b', 'SUSPENDED'), row('c', 'ACTIVE'), row('d', 'CLOSED')],
      hasMore: false,
      nextCursor: '',
    })
    const p = useBulkActionPreview<Row>({ fetchPage, filterFn: onlyActive, toSample })
    await p.startPreview()
    expect(p.previewCount.value).toBe(2)
    expect(p.previewSamples.value.map(s => s.id)).toEqual(['a', 'c'])
    expect(p.reachedEnd.value).toBe(true)
  })

  it('caps at maxMatches and flags cappedAtMax (no expected_count for caller)', async () => {
    // Generate enough rows that we exceed the default maxMatches=501.
    // Use a small maxMatches override so the test stays cheap.
    const fetchPage = pages({
      items: Array.from({ length: 10 }, (_, i) => row(`r${i}`)),
      hasMore: true,
      nextCursor: 'next',
    })
    const p = useBulkActionPreview<Row>({
      fetchPage, filterFn: acceptAll, toSample,
      maxMatches: 5,
    })
    await p.startPreview()
    expect(p.previewCount.value).toBe(5)
    expect(p.cappedAtMax.value).toBe(true)
    expect(p.reachedEnd.value).toBe(false)
    expect(p.cappedAtPages.value).toBe(false)
    // Walk stopped after first page since count >= maxMatches.
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('caps at maxPages and flags cappedAtPages (partial count, unknown total)', async () => {
    // Each page yields 1 match; maxPages=2 → walk halts before completion.
    const fetchPage = vi.fn(async (cursor: string) => ({
      items: [row(`x-${cursor || 'first'}`)],
      hasMore: true,
      nextCursor: `${cursor || 'p1'}+`,
    }))
    const p = useBulkActionPreview<Row>({
      fetchPage, filterFn: acceptAll, toSample,
      maxPages: 2,
    })
    await p.startPreview()
    expect(fetchPage).toHaveBeenCalledTimes(2)
    expect(p.previewCount.value).toBe(2)
    expect(p.cappedAtPages.value).toBe(true)
    expect(p.cappedAtMax.value).toBe(false)
    expect(p.reachedEnd.value).toBe(false)
  })

  it('reports zero matches when no items pass the filter', async () => {
    const fetchPage = pages({
      items: [row('a', 'CLOSED'), row('b', 'CLOSED')],
      hasMore: false,
      nextCursor: '',
    })
    const p = useBulkActionPreview<Row>({ fetchPage, filterFn: onlyActive, toSample })
    await p.startPreview()
    expect(p.previewCount.value).toBe(0)
    expect(p.previewSamples.value).toEqual([])
    expect(p.reachedEnd.value).toBe(true)
  })

  it('cancelPreview() aborts the walk and surfaces "Preview cancelled."', async () => {
    // Each fetchPage call resolves on the next microtask so we can
    // cancel between pages.
    let resolveFirst: (v: { items: Row[]; hasMore: boolean; nextCursor: string }) => void = () => {}
    const fetchPage = vi.fn().mockImplementationOnce(() =>
      new Promise<{ items: Row[]; hasMore: boolean; nextCursor: string }>(r => { resolveFirst = r })
    ).mockImplementationOnce(async () => ({
      items: [row('after-cancel')],
      hasMore: false,
      nextCursor: '',
    }))
    const p = useBulkActionPreview<Row>({ fetchPage, filterFn: acceptAll, toSample })
    const promise = p.startPreview()
    // Cancel before resolving the in-flight first page.
    p.cancelPreview()
    resolveFirst({ items: [row('a')], hasMore: true, nextCursor: 'p2' })
    await promise
    expect(p.previewError.value).toBe('Preview cancelled.')
    // Loop bailed at the abort check before the second fetchPage call.
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('surfaces fetch errors via previewError', async () => {
    const fetchPage = vi.fn(async () => { throw new Error('network down') })
    const p = useBulkActionPreview<Row>({ fetchPage, filterFn: acceptAll, toSample })
    await p.startPreview()
    expect(p.previewError.value).toBe('network down')
    expect(p.previewLoading.value).toBe(false)
    expect(p.previewCount.value).toBe(0)
  })

  it('resetPreview() clears state for the next open() cycle', async () => {
    const fetchPage = pages({ items: [row('a')], hasMore: false, nextCursor: '' })
    const p = useBulkActionPreview<Row>({ fetchPage, filterFn: acceptAll, toSample })
    await p.startPreview()
    expect(p.previewCount.value).toBe(1)
    p.resetPreview()
    expect(p.previewCount.value).toBe(0)
    expect(p.previewSamples.value).toEqual([])
    expect(p.previewError.value).toBe('')
    expect(p.cappedAtMax.value).toBe(false)
    expect(p.cappedAtPages.value).toBe(false)
    expect(p.reachedEnd.value).toBe(false)
  })

  it('a fresh startPreview() supersedes an in-flight earlier one', async () => {
    // Prove that two open()s don't trample each other's counters.
    let resolveFirst: (v: { items: Row[]; hasMore: boolean; nextCursor: string }) => void = () => {}
    const fetchPage = vi.fn()
      .mockImplementationOnce(() => new Promise<{ items: Row[]; hasMore: boolean; nextCursor: string }>(r => { resolveFirst = r }))
      .mockImplementationOnce(async () => ({ items: [row('z')], hasMore: false, nextCursor: '' }))
    const p = useBulkActionPreview<Row>({ fetchPage, filterFn: acceptAll, toSample })
    const first = p.startPreview()
    // Second call aborts the first.
    const second = p.startPreview()
    // Resolve the first call's in-flight page after the abort flag was set.
    resolveFirst({ items: [row('stale')], hasMore: true, nextCursor: 'p2' })
    await Promise.all([first, second])
    // Final state reflects the second walk only.
    expect(p.previewCount.value).toBe(1)
    expect(p.previewSamples.value[0].id).toBe('z')
  })
})

// walkCursorPages — the plain cursor-walk primitive behind Overview's
// aggregate reads. The server clamps `limit` to 100 rows per page on
// every list endpoint, so "big limit" single requests silently
// truncate; this helper follows next_cursor and reports honestly
// (partial=true) when it stops at the page cap with rows remaining.
import { describe, it, expect, vi } from 'vitest'
import { walkCursorPages, CURSOR_WALK_MAX_PAGES, LIST_PAGE_LIMIT, type CursorPage } from '../utils/cursorWalk'

function pagesOf<T>(pages: Array<{ items: T[]; hasMore: boolean; nextCursor: string }>) {
  let call = 0
  return vi.fn(async (cursor: string): Promise<CursorPage<T>> => {
    const page = pages[call]
    // Assert cursor threading: page N receives page N-1's nextCursor.
    expect(cursor).toBe(call === 0 ? '' : pages[call - 1].nextCursor)
    call++
    return page
  })
}

describe('walkCursorPages', () => {
  it('exports the documented server clamp and default page cap', () => {
    expect(LIST_PAGE_LIMIT).toBe(100)
    expect(CURSOR_WALK_MAX_PAGES).toBe(10)
  })

  it('returns a single page when has_more is false', async () => {
    const fetchPage = pagesOf([{ items: [1, 2, 3], hasMore: false, nextCursor: '' }])
    const res = await walkCursorPages(fetchPage)
    expect(res.items).toEqual([1, 2, 3])
    expect(res.partial).toBe(false)
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('follows next_cursor across pages and concatenates items in order', async () => {
    const fetchPage = pagesOf([
      { items: ['a', 'b'], hasMore: true, nextCursor: 'c1' },
      { items: ['c'], hasMore: true, nextCursor: 'c2' },
      { items: ['d', 'e'], hasMore: false, nextCursor: '' },
    ])
    const res = await walkCursorPages(fetchPage)
    expect(res.items).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(res.partial).toBe(false)
    expect(fetchPage).toHaveBeenCalledTimes(3)
  })

  it('stops at the default page cap and flags the result partial', async () => {
    const fetchPage = vi.fn(async (cursor: string) => ({
      items: [cursor || 'first'],
      hasMore: true,
      nextCursor: `c-${cursor || '0'}`,
    }))
    const res = await walkCursorPages(fetchPage)
    expect(fetchPage).toHaveBeenCalledTimes(CURSOR_WALK_MAX_PAGES)
    expect(res.items.length).toBe(CURSOR_WALK_MAX_PAGES)
    expect(res.partial).toBe(true)
  })

  it('honors a caller-supplied maxPages override', async () => {
    const fetchPage = vi.fn(async () => ({ items: [1], hasMore: true, nextCursor: 'c' }))
    const res = await walkCursorPages(fetchPage, { maxPages: 3 })
    expect(fetchPage).toHaveBeenCalledTimes(3)
    expect(res.items).toEqual([1, 1, 1])
    expect(res.partial).toBe(true)
  })

  it('stops defensively (partial) when has_more is true but no cursor is returned', async () => {
    const fetchPage = vi.fn(async () => ({ items: [1], hasMore: true, nextCursor: '' }))
    const res = await walkCursorPages(fetchPage)
    // Without the guard this would loop maxPages times re-fetching page 1.
    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(res.items).toEqual([1])
    expect(res.partial).toBe(true)
  })

  it('handles an empty first page', async () => {
    const fetchPage = pagesOf<number>([{ items: [], hasMore: false, nextCursor: '' }])
    const res = await walkCursorPages(fetchPage)
    expect(res.items).toEqual([])
    expect(res.partial).toBe(false)
  })

  it('propagates fetch errors to the caller (no swallowing)', async () => {
    const fetchPage = vi.fn(async () => { throw new Error('outage') })
    await expect(walkCursorPages(fetchPage)).rejects.toThrow('outage')
  })
})

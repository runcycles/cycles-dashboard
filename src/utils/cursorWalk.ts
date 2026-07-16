// Cursor-walk helper for "give me the whole set" reads against the
// admin list endpoints. The server clamps `limit` to a maximum of 100
// rows per page on every list endpoint (BudgetController and
// equivalents), so a single large-limit request silently truncates —
// any consumer that aggregates (Overview stats, exclusion sets) must
// follow `next_cursor` while `has_more` instead.
//
// Distinct from useBulkActionPreview / useListExport, which are
// stateful composables wired to dialog UX (abort, sampling, row caps).
// This is the plain awaitable primitive: walk pages, concatenate items,
// stop at a hard page cap, and report honestly whether the result is
// partial so callers can surface a "counts may be partial" hint instead
// of presenting a truncated set as the full fleet.

export interface CursorPage<T> {
  items: readonly T[]
  hasMore: boolean
  nextCursor: string
}

export interface CursorWalkResult<T> {
  items: T[]
  /**
   * True when the walk stopped with the server still reporting more
   * rows (page cap hit, or a defensive stop on has_more without a
   * cursor). Callers should treat aggregates over `items` as a lower
   * bound and say so in the UI.
   */
  partial: boolean
}

/** Server-side clamp on `limit` — requests above this are truncated to it. */
export const LIST_PAGE_LIMIT = 100

/** Default page cap: 10 pages × 100 rows = 1,000 rows per walk. */
export const CURSOR_WALK_MAX_PAGES = 10

export async function walkCursorPages<T>(
  fetchPage: (cursor: string) => Promise<CursorPage<T>>,
  options: { maxPages?: number } = {},
): Promise<CursorWalkResult<T>> {
  const maxPages = options.maxPages ?? CURSOR_WALK_MAX_PAGES
  const items: T[] = []
  let cursor = ''
  let pages = 0
  let hasMore = true
  while (hasMore && pages < maxPages) {
    const page = await fetchPage(cursor)
    items.push(...page.items)
    pages++
    hasMore = page.hasMore
    cursor = page.nextCursor
    // Defensive: a server that says has_more but returns no cursor
    // would loop on page 1 forever. Stop and report partial.
    if (hasMore && !cursor) break
  }
  return { items, partial: hasMore }
}

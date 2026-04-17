import { ref, type Ref } from 'vue'
import { csvEscape, safeJsonStringify } from '../utils/safe'

// Cell value types the CSV row-mapper is allowed to return. Everything
// that isn't a plain primitive (arrays, objects, metadata blobs) should
// be stringified via safeJsonStringify at the call site so the composable
// doesn't have to know about each row shape.
export type CsvCellValue = string | number | boolean | null | undefined

export interface ExportColumn<T> {
  header: string
  value: (item: T) => CsvCellValue
}

export interface UseListExportOptions<T> {
  /** "tenant", "event", "delivery" — pluralized as noun + "s" in dialog copy + filename. */
  itemNoun: string
  /** Filename stem before "-YYYY-MM-DD.ext" (defaults to itemNoun + 's'). */
  filenameStem?: string
  /** The rows currently visible on screen — used for the fast-path and as the seed for multi-page assembly. */
  currentItems: Ref<readonly T[]>
  /** Whether the server reports more rows beyond what's loaded; drives single-page vs multi-page export flow. */
  hasMore: Ref<boolean>
  /** Cursor for fetching additional pages. Ignored when hasMore is false. */
  nextCursor: Ref<string>
  /**
   * Fetches a single cursor page. Called only on the multi-page slow path.
   * Implementations should return the server's raw shape translated into this uniform envelope.
   */
  fetchPage: (cursor: string) => Promise<{ items: readonly T[]; hasMore: boolean; nextCursor: string }>
  /** Column spec for CSV output. JSON export just serializes the raw items array. */
  columns: ReadonlyArray<ExportColumn<T>>
  /**
   * Hard row ceiling. Above this we abort the export with an operator-facing error
   * pointing at narrower filters. 50k default — covers typical compliance windows
   * while staying well below Blob / spreadsheet row limits.
   */
  maxRows?: number
  /**
   * Optional iteration cap against pathological tiny-page servers. 500 default;
   * a combination of max_rows=50_000 and page_size<100 triggers this sooner.
   */
  maxPages?: number
  /**
   * Optional predicate applied to every fetched page before items are
   * added to the export buffer. For views with client-side filters
   * (TenantsView search, WebhooksView URL filter) this keeps the export
   * consistent with what the operator sees on screen — without this,
   * the cursor-follow would dump the server's raw (unfiltered) results
   * into the CSV.
   *
   * Note: the `currentItems` seed is assumed to already match the
   * filter (it's usually a `filtered...` computed the view already
   * renders) — filterFn is only applied to newly-fetched pages.
   */
  filterFn?: (item: T) => boolean
}

/**
 * Shared export machinery for list views. Manages:
 *  - Confirm-dialog state (`showExportConfirm`)
 *  - Multi-page cursor follow with progress counter (`exporting`, `exportFetched`)
 *  - EXPORT_MAX_ROWS / MAX_PAGES safety caps with actionable abort message
 *  - CSV (with csvEscape formula-injection guard) and JSON download triggering
 *
 * Views wire the composable + render the shared `<ExportDialog>` +
 * `<ExportProgressOverlay>` components; the per-view customization is
 * the column spec and the `fetchPage` callback.
 *
 * Pre-extraction this logic lived duplicated in EventsView and AuditView.
 * With 6+ list views needing export parity, the cost of the abstraction
 * flipped in favor of the shared primitive.
 */
export function useListExport<T>(options: UseListExportOptions<T>) {
  const maxRows = options.maxRows ?? 50_000
  const maxPages = options.maxPages ?? 500
  const stem = options.filenameStem ?? `${options.itemNoun}s`

  const showExportConfirm = ref<'csv' | 'json' | null>(null)
  const exporting = ref(false)
  const exportFetched = ref(0)
  const exportError = ref('')
  // Cancellation: the multi-page export loop observes this ref and bails
  // cleanly on the next iteration. Reset to null outside an active
  // export; a live AbortController means the overlay's Cancel button
  // should render. Not an AbortSignal threaded into fetch() directly
  // because `fetchPage` doesn't accept one — the in-flight request
  // still completes, but no subsequent page is fetched and no blob is
  // assembled.
  let abortExport: AbortController | null = null
  const exportCancellable = ref(false)

  function confirmExport(format: 'csv' | 'json') {
    if (options.currentItems.value.length === 0) return
    showExportConfirm.value = format
  }

  function cancelExport() {
    showExportConfirm.value = null
  }

  function cancelRunningExport() {
    abortExport?.abort()
  }

  async function fetchAllForExport(): Promise<readonly T[] | null> {
    const all: T[] = [...options.currentItems.value]
    exportFetched.value = all.length
    let cursor = options.nextCursor.value
    let hasMoreLocal = options.hasMore.value
    let pagesFetched = 1
    while (hasMoreLocal && cursor && all.length < maxRows && pagesFetched < maxPages) {
      if (abortExport?.signal.aborted) {
        exportError.value = 'Export cancelled.'
        return null
      }
      const page = await options.fetchPage(cursor)
      const matched = options.filterFn ? page.items.filter(options.filterFn) : page.items
      all.push(...matched)
      exportFetched.value = all.length
      hasMoreLocal = page.hasMore
      cursor = page.nextCursor
      pagesFetched++
    }
    if (abortExport?.signal.aborted) {
      exportError.value = 'Export cancelled.'
      return null
    }
    if (all.length >= maxRows && hasMoreLocal) {
      exportError.value = `Export aborted: result set exceeds ${maxRows.toLocaleString()} rows. Narrow your filter before retrying.`
      return null
    }
    return all
  }

  function csvFor(rows: readonly T[]): string {
    const headers = options.columns.map(c => csvEscape(c.header)).join(',')
    const lines = rows.map(r =>
      options.columns.map(c => csvEscape(c.value(r))).join(','),
    )
    return [headers, ...lines].join('\n')
  }

  function triggerDownload(content: string, mime: string, ext: string) {
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${stem}-${new Date().toISOString().slice(0, 10)}.${ext}`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function executeExport() {
    const format = showExportConfirm.value
    if (!format) return
    showExportConfirm.value = null
    exportError.value = ''

    // Fast path: server already reports the loaded set IS the full
    // set. Dump directly to blob without additional fetches.
    if (!options.hasMore.value) {
      const items = options.currentItems.value
      if (format === 'csv') triggerDownload(csvFor(items), 'text/csv', 'csv')
      else triggerDownload(safeJsonStringify(items, 2), 'application/json', 'json')
      return
    }

    // Slow path: paginate through remaining pages. Blocking progress
    // overlay visible via the `exporting` ref. The overlay now renders
    // a Cancel button (wired to `cancelRunningExport`) because a
    // wrong-filter export that's going to hit the 50k cap is otherwise
    // a 500-page dead wait — the operator's only previous option was
    // to close the tab and discard everything including session state.
    exporting.value = true
    exportCancellable.value = true
    exportFetched.value = options.currentItems.value.length
    abortExport = new AbortController()
    try {
      const all = await fetchAllForExport()
      if (!all) return // exportError already set
      if (format === 'csv') triggerDownload(csvFor(all), 'text/csv', 'csv')
      else triggerDownload(safeJsonStringify(all, 2), 'application/json', 'json')
    } catch (e) {
      exportError.value = e instanceof Error ? e.message : String(e)
    } finally {
      exporting.value = false
      exportCancellable.value = false
      abortExport = null
    }
  }

  return {
    showExportConfirm,
    exporting,
    exportFetched,
    exportError,
    exportCancellable,
    maxRows,
    confirmExport,
    cancelExport,
    cancelRunningExport,
    executeExport,
  }
}

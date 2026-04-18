import { ref } from 'vue'

// O1 (UI/UX P0): the bulk filter-apply path on TenantsView / WebhooksView
// previously sent a single POST to /v1/admin/.../bulk-action with no
// preview — the operator typed a filter and committed it sight-unseen.
// A mistyped filter could suspend hundreds of tenants. This composable
// is the dashboard-side preview: walk listTenants/listWebhooks with the
// SAME server-side filter as the bulk action, then apply the action's
// derived predicate (status, parent, etc. that the list endpoints don't
// accept server-side) client-side. Surface a count + first 10 sample
// rows for operator review BEFORE the confirm button arms.
//
// Why dashboard-side and not a server preview endpoint:
//   - Server has no count-only endpoint today. AUDIT.md flagged this as
//     deferred to a future spec bump.
//   - The bulk endpoint already enforces a 500-row hard cap server-side
//     (LIMIT_EXCEEDED), so "more than 500 matches" is the only count
//     resolution the operator strictly needs to make a safe decision.
//   - Walking N pages of listTenants for the first 500 matches is
//     bounded (page size × maxPages). Acceptable preview latency.
//
// Correctness notes:
//   - maxMatches defaults to 501 — above the server's 500-row cap, so
//     "≥501 matches" UX-wise reads "more than the bulk endpoint will
//     accept; narrow the filter before submit".
//   - When the walk completes (hasMore=false) WITHOUT hitting maxMatches,
//     the count is exact and callers should pass it to the bulk endpoint
//     as `expected_count` for COUNT_MISMATCH drift detection.
//   - When the walk hits a cap, the count is a lower bound and
//     `expected_count` MUST NOT be sent — the server would reject every
//     submit with COUNT_MISMATCH.

export interface PreviewSample {
  id: string
  primary: string
  sublabel?: string
  status?: string
}

export interface UseBulkActionPreviewOptions<T> {
  /** Fetch one cursor page using the same server-side filter as the bulk action. */
  fetchPage: (cursor: string) => Promise<{ items: readonly T[]; hasMore: boolean; nextCursor: string }>
  /**
   * Filter each page client-side to match the bulk action's full filter set.
   * Captures the dimensions the list endpoint doesn't accept server-side
   * (action-derived status, parent_tenant_id, etc.). Should mirror what the
   * server applies inside the bulk endpoint exactly — drift here means
   * the preview lies.
   */
  filterFn: (item: T) => boolean
  /** Map a matching item to a sample row for the preview UI. */
  toSample: (item: T) => PreviewSample
  /**
   * Optional: map a matching item to an `{ id, label }` pair captured
   * into a full id→label lookup for post-submit result rendering. Unlike
   * `toSample` (which caps at SAMPLE_LIMIT for the preview UI), this runs
   * for EVERY matched row so the post-submit `BulkActionResultDialog`
   * can render the server's succeeded/failed/skipped rows with a
   * human-readable label next to the opaque id. Primary use case:
   * BudgetsView, where ids are UUIDs and scopes are the meaningful name.
   */
  labelFn?: (item: T) => { id: string; label: string }
  /**
   * Hard ceiling on collected matches. Default 501 — one above the bulk
   * endpoint's 500-row cap. Hitting this means the bulk submit will
   * fail LIMIT_EXCEEDED, so the preview button should disable.
   */
  maxMatches?: number
  /**
   * Hard ceiling on cursor pages walked. Default 20. Guards against a
   * filter that would otherwise walk the entire universe (e.g. a parent
   * filter on the root org with no search). At 100 items/page that's
   * 2000 items inspected — enough to find any plausible 500-match set.
   */
  maxPages?: number
}

export function useBulkActionPreview<T>(options: UseBulkActionPreviewOptions<T>) {
  const SAMPLE_LIMIT = 10
  const maxMatches = options.maxMatches ?? 501
  const maxPages = options.maxPages ?? 20

  const previewLoading = ref(false)
  const previewCount = ref(0)
  const previewSamples = ref<PreviewSample[]>([])
  // Full id→label lookup of every matched row, populated when the caller
  // supplies labelFn. Used by BulkActionResultDialog to render scope
  // alongside the opaque ledger-id on succeeded/failed/skipped rows.
  // Ref stores the reactive snapshot; the live Map is mutated during the
  // walk and the ref is replaced each page so consumers see updates.
  const previewLabels = ref<Record<string, string>>({})
  const previewError = ref('')
  // When the walk hits maxMatches: count is a lower bound; bulk submit
  // must not pass expected_count.
  const cappedAtMax = ref(false)
  // When the walk hits maxPages without finishing AND without hitting
  // maxMatches: count is a partial sample, not a true total.
  const cappedAtPages = ref(false)
  // When the walk completed naturally (hasMore=false) without either cap:
  // count is exact and bulk submit can pass expected_count for tighter
  // drift detection.
  const reachedEnd = ref(false)

  let abort: AbortController | null = null

  async function startPreview(): Promise<void> {
    // Replace any in-flight walk: a fresh open() always wins.
    abort?.abort()
    abort = new AbortController()
    const myAbort = abort

    previewLoading.value = true
    previewError.value = ''
    previewCount.value = 0
    previewSamples.value = []
    previewLabels.value = {}
    cappedAtMax.value = false
    cappedAtPages.value = false
    reachedEnd.value = false

    let cursor = ''
    let pages = 0
    let count = 0
    const samples: PreviewSample[] = []
    const labels: Record<string, string> = {}
    let hasMore = true

    try {
      while (hasMore && pages < maxPages && count < maxMatches) {
        if (myAbort.signal.aborted) {
          previewError.value = 'Preview cancelled.'
          return
        }
        const page = await options.fetchPage(cursor)
        // Re-check after the await: a fresh startPreview() (or
        // cancelPreview()) may have fired while this fetch was in flight.
        // Without this check, the in-flight resolution would overwrite
        // the newer walk's count/samples on the shared refs.
        if (myAbort.signal.aborted) {
          previewError.value = 'Preview cancelled.'
          return
        }
        pages++
        for (const it of page.items) {
          if (options.filterFn(it)) {
            count++
            if (samples.length < SAMPLE_LIMIT) samples.push(options.toSample(it))
            if (options.labelFn) {
              const { id, label } = options.labelFn(it)
              labels[id] = label
            }
            if (count >= maxMatches) break
          }
        }
        previewCount.value = count
        previewSamples.value = [...samples]
        if (options.labelFn) previewLabels.value = { ...labels }
        hasMore = page.hasMore
        cursor = page.nextCursor
        if (!cursor) break
      }
      cappedAtMax.value = count >= maxMatches
      cappedAtPages.value = !cappedAtMax.value && hasMore && pages >= maxPages
      reachedEnd.value = !cappedAtMax.value && !cappedAtPages.value
    } catch (e) {
      if (myAbort.signal.aborted) return
      previewError.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (!myAbort.signal.aborted) {
        previewLoading.value = false
      }
      if (abort === myAbort) abort = null
    }
  }

  function cancelPreview() {
    abort?.abort()
    previewLoading.value = false
  }

  function resetPreview() {
    cancelPreview()
    previewCount.value = 0
    previewSamples.value = []
    previewLabels.value = {}
    previewError.value = ''
    cappedAtMax.value = false
    cappedAtPages.value = false
    reachedEnd.value = false
  }

  return {
    previewLoading,
    previewCount,
    previewSamples,
    previewLabels,
    previewError,
    cappedAtMax,
    cappedAtPages,
    reachedEnd,
    startPreview,
    cancelPreview,
    resetPreview,
  }
}

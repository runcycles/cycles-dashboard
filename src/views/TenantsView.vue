<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useRouter, useRoute } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { useSort } from '../composables/useSort'
import { useDebouncedRef } from '../composables/useDebouncedRef'
import { useListExport } from '../composables/useListExport'
import { listTenants, createTenant, updateTenantStatus, bulkActionTenants, ApiError } from '../api/client'
import { rateLimitedBatch } from '../utils/rateLimitedBatch'
import { synthesizeRowSelectBulkResult } from '../utils/rowSelectBulkResult'
import type { RowSelectBulkResponse } from '../utils/rowSelectBulkResult'
import { generateIdempotencyKey } from '../utils/idempotencyKey'
import type { TenantBulkAction, TenantBulkFilter } from '../types'
import { useAuthStore } from '../stores/auth'
import type { Tenant } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import ExportDialog from '../components/ExportDialog.vue'
import ExportProgressOverlay from '../components/ExportProgressOverlay.vue'
import DownloadIcon from '../components/icons/DownloadIcon.vue'
import CloseIcon from '../components/icons/CloseIcon.vue'
import BackArrowIcon from '../components/icons/BackArrowIcon.vue'
import FormDialog from '../components/FormDialog.vue'
import ConfirmAction from '../components/ConfirmAction.vue'
import BulkActionPreviewDialog from '../components/BulkActionPreviewDialog.vue'
import BulkActionResultDialog from '../components/BulkActionResultDialog.vue'
import RowActionsMenu from '../components/RowActionsMenu.vue'
import { useBulkActionPreview } from '../composables/useBulkActionPreview'
import { formatDate } from '../utils/format'
import { writeClipboardJson } from '../utils/clipboard'
import { useToast } from '../composables/useToast'
import { toMessage } from '../utils/errors'
import { formatBulkRequestError } from '../utils/errorCodeMessages'
import type { TenantBulkActionResponse } from '../types'

const toast = useToast()

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

const canManage = computed(() => auth.capabilities?.manage_tenants !== false)

const tenants = ref<Tenant[]>([])
const error = ref('')
const search = ref('')

// Initialize filters from the URL so deep-links like /tenants?status=ACTIVE
// (Overview tile chip drill-downs) and /tenants?parent=foo (breadcrumb
// back-link from TenantDetailView "+N more") land pre-filtered on first
// render, before any watcher fires. The `watch(..., { immediate: true })`
// pattern used previously ran synchronously during setup — and since the
// callback accessed the ref, it triggered a TDZ ReferenceError whenever
// the URL carried a valid status on mount (blank page, then blank every
// subsequent navigation since the router was in a thrown-handler state).
function readStatusFromQuery(): '' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED' {
  const s = route.query.status
  if (typeof s !== 'string') return ''
  return s === 'ACTIVE' || s === 'SUSPENDED' || s === 'CLOSED' ? s : ''
}
function readParentFromQuery(): string {
  const p = route.query.parent
  return typeof p === 'string' && p ? p : ''
}
const parentFilter = ref<string>(readParentFromQuery())
const statusFilter = ref<string>(readStatusFromQuery())

// Template uses this to decide whether to render the PageHeader back-arrow
// (only when we arrived via a breadcrumb deep-link, not when the operator
// picked a parent in the dropdown).
const parentFromQuery = computed<string>(() => readParentFromQuery())

// Browser back/forward: sync filters when the URL changes without a
// re-mount. Not `immediate: true` — initial values are set above.
watch(() => route.query.parent, () => {
  const p = readParentFromQuery()
  if (parentFilter.value !== p) parentFilter.value = p
})
watch(() => route.query.status, () => {
  const s = readStatusFromQuery()
  if (statusFilter.value !== s) statusFilter.value = s
})

// V5 (Phase 3): debounce the search input so filter re-computation
// runs 200ms AFTER the last keystroke instead of on every character.
// Debouncing a client-side filter is subtler than debouncing a fetch —
// each re-filter is cheap on its own, but the cascade (filter →
// virtualizer re-index → sort re-run) adds up when a 10k-tenant list
// is being typed-through. 200ms is enough time for a fast typist
// to land more keystrokes before the filter runs.
const debouncedSearch = useDebouncedRef(search, 200)

// R5 (scale-hardening): cursor pagination. Pre-fix, listTenants()'s
// has_more / next_cursor were discarded and every tenant loaded into
// memory. Deployments with thousands of tenants silently dropped the
// tail if the server page size was smaller. Load-more appends.
// Polling refreshes page 1 (and drops the loaded tail) — same
// documented trade-off as ReservationsView.
const hasMore = ref(false)
const nextCursor = ref('')
const loadingMore = ref(false)

// v0.1.25.21 (#2): show hierarchy. Derive child counts once per poll so
// the column render doesn't re-filter tenants.value for every row.
const childCountMap = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = {}
  for (const t of tenants.value) {
    if (t.parent_tenant_id) counts[t.parent_tenant_id] = (counts[t.parent_tenant_id] ?? 0) + 1
  }
  return counts
})

// V3 (scale-hardening): O(1) tenant lookup by id. Pre-fix, parentName()
// called tenants.value.find() per-row in the template — that's
// O(n) per row × n rows = O(n²) render cost. At 10k tenants that's
// 100M comparisons every time Vue re-ran the parent-name cell.
// Build a Map once per change in tenants.value and .get() in the row.
const tenantById = computed<Map<string, Tenant>>(() => {
  const m = new Map<string, Tenant>()
  for (const t of tenants.value) m.set(t.tenant_id, t)
  return m
})

const filteredTenants = computed(() => {
  let out = tenants.value
  if (parentFilter.value) {
    if (parentFilter.value === '__root__') {
      // "(root-level only)" pseudo-option — tenants with no parent.
      out = out.filter(t => !t.parent_tenant_id)
    } else {
      out = out.filter(t => t.parent_tenant_id === parentFilter.value)
    }
  }
  if (statusFilter.value) {
    out = out.filter(t => t.status === statusFilter.value)
  }
  if (debouncedSearch.value) {
    const q = debouncedSearch.value.toLowerCase()
    out = out.filter(t => t.tenant_id.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
  }
  return out
})
// Default sort: newest tenants first. created_at is an ISO-8601 string,
// which sorts lexicographically in chronological order, so 'desc' ==
// newest first. Click any header to switch to that column's natural order.
//
// V4 stage 2: server-side sort against listTenants (tenant_id, name,
// status, created_at enum). Parent + Children columns are NOT server-
// sortable — they're client-derived from tenantById / childCountMap
// and the server has no index over them — so those columns render as
// plain headers below (no SortHeader). onChange refreshes page 1 so
// the cursor tuple stays aligned with the new (sort_by, sort_dir).
const { sortKey, sortDir, toggle, sorted: sortedTenants } = useSort(
  filteredTenants,
  'created_at',
  'desc',
  undefined,
  { serverSide: true, onChange: () => { refresh() } },
)

// Parents available in the filter dropdown — union of tenants that have
// at least one child, so the filter doesn't list tenants with no kids
// (those would always produce an empty table).
const parentOptions = computed<Tenant[]>(() => {
  const withChildren = new Set(Object.keys(childCountMap.value))
  return tenants.value.filter(t => withChildren.has(t.tenant_id))
})

// ─── #4 bulk suspend / reactivate ─────────────────────────────────────
// Selected tenant_ids. Resets on filter/search changes so users don't
// accidentally bulk-act on rows they can't see. Held as a Set for O(1)
// toggle in the checkbox handler.
const selected = ref<Set<string>>(new Set())
// Clear selection when filters change so a hidden-by-filter row never
// gets unexpectedly bulk-acted on. Same reasoning as WebhooksView.
watch([search, parentFilter, statusFilter], () => { selected.value = new Set() })
function toggleSelect(id: string) {
  const next = new Set(selected.value)
  next.has(id) ? next.delete(id) : next.add(id)
  selected.value = next
}
function toggleSelectAll() {
  if (selectedVisibleAll.value) {
    selected.value = new Set()
  } else {
    selected.value = new Set(filteredTenants.value.map(t => t.tenant_id))
  }
}
const selectedVisibleAll = computed(() =>
  filteredTenants.value.length > 0 &&
  filteredTenants.value.every(t => selected.value.has(t.tenant_id)),
)
const selectedVisibleCount = computed(() =>
  filteredTenants.value.filter(t => selected.value.has(t.tenant_id)).length,
)

// Bulk action state machine. We sequence the per-tenant calls rather
// than parallelizing because (a) it's simpler to report progress and
// (b) a burst of admin writes could trip rate limits. Users can cancel
// between calls — progress resumes only on a fresh click.
const bulkAction = ref<'SUSPENDED' | 'ACTIVE' | null>(null)
const bulkProgress = ref({ done: 0, total: 0, failed: 0 })
const bulkRunning = ref(false)

function openBulk(action: 'SUSPENDED' | 'ACTIVE') {
  bulkAction.value = action
}
// W4: concurrent bulk runner with 429 backoff. Pre-fix, executeBulk
// was a plain sequential `for` loop. At 50+ tenants it was painfully
// slow and any 429 from the admin tier counted as a hard failure —
// operators would see half the batch fail under load. rateLimitedBatch
// runs 4 in parallel with exponential-backoff retries on 429 specifically.
let bulkAbort: AbortController | null = null
async function executeBulk() {
  if (!bulkAction.value || bulkRunning.value) return
  const action = bulkAction.value
  // Filter the selection to only tenants whose current status would
  // actually change. Avoids noisy "already suspended" 409s from the
  // server and keeps the progress count honest.
  const targets = tenants.value.filter(t =>
    selected.value.has(t.tenant_id) &&
    t.status !== action &&
    // CLOSED is terminal — never reactivate or re-suspend.
    t.status !== 'CLOSED'
  )
  bulkProgress.value = { done: 0, total: targets.length, failed: 0 }
  bulkRunning.value = true
  bulkAbort = new AbortController()
  // Capture settled-successful indices so synthesizeRowSelectBulkResult
  // can enumerate succeeded + skipped (unreached on cancel) rows for the
  // result dialog — rateLimitedBatch only tracks failures natively.
  const settledSucceeded: number[] = []
  const result = await rateLimitedBatch(
    targets,
    async (t, i) => {
      await updateTenantStatus(t.tenant_id, action)
      settledSucceeded.push(i)
    },
    {
      signal: bulkAbort.signal,
      onProgress: (done, total, failed) => { bulkProgress.value = { done, total, failed } },
    },
  )
  bulkRunning.value = false
  bulkAbort = null
  const succeeded = result.done - result.failed
  const summary = `${succeeded}/${bulkProgress.value.total} tenants ${action === 'SUSPENDED' ? 'suspended' : 'reactivated'}`
  if (result.failed > 0) {
    toast.error(`${summary}, ${result.failed} failed — see details`)
  } else if (result.cancelled) {
    toast.success(`${summary} (cancelled by user)`)
  } else {
    toast.success(summary)
  }
  bulkAction.value = null
  selected.value = new Set()
  // Open the per-row dialog whenever there's anything to triage — failures
  // or unreached-on-cancel rows. Replaces the pre-fix console.warn loop
  // so operators can see which tenants failed and why without tailing devtools.
  if (result.failed > 0 || result.cancelled) {
    bulkResult.value = {
      actionVerb: action === 'SUSPENDED' ? 'Suspend' : 'Reactivate',
      response: synthesizeRowSelectBulkResult({
        targets,
        result,
        succeededIndices: settledSucceeded,
        idOf: t => t.tenant_id,
      }),
    }
  }
  await refresh()
}
function cancelBulk() {
  if (bulkRunning.value) {
    bulkAbort?.abort()
  } else {
    bulkAction.value = null
  }
}

// ─── W1 filter-apply path (cycles-governance-admin v0.1.25.21) ───────
// Additive alongside the row-select path above. Row-select issues one
// PATCH per tenant via rateLimitedBatch (bounded concurrency + 429
// backoff). Filter-apply sends a single POST to /v1/admin/tenants/
// bulk-action with a filter body — the server counts matches, enforces
// a 500-row hard cap, and returns split succeeded/failed/skipped arrays.
//
// Scope deliberately conservative on first cut:
//   - status filter is DERIVED from the action (SUSPEND→ACTIVE,
//     REACTIVATE→SUSPENDED). The server would otherwise silently skip
//     mismatched rows, which is correct but wastes the 500-row budget.
//   - parent_tenant_id filter is taken from parentFilter when the
//     operator has selected a specific parent (not '__root__' — the
//     server has no "null parent" filter, so that UI pseudo-option is
//     unsupported on the bulk path and the button is disabled).
//   - search is taken from debouncedSearch.trim() when non-empty.
//   - CLOSE is not offered here — the server-side spec allows it but
//     CLOSE is terminal and the dashboard requires a per-tenant
//     confirmation flow that doesn't fit a bulk action; offer later.
const filterBulkAction = ref<TenantBulkAction | null>(null)
const filterBulkRunning = ref(false)
// Submit-time error surfaced inside the preview dialog (kept open on
// error so the operator sees what failed instead of a disjoint toast).
const filterBulkSubmitError = ref('')
// Per-row result dialog (BulkActionResultDialog). Opens with the server
// response whenever failed[] or skipped[] is non-empty, so the operator
// can triage per-row error_code + message beyond the toast summary.
const bulkResult = ref<{ actionVerb: string; response: TenantBulkActionResponse | RowSelectBulkResponse } | null>(null)

// O1: cursor-walk preview before commit. Walks listTenants with the
// same `search` server-side filter as the bulk action, then filters
// each page client-side by the action-derived status + parent_tenant_id
// (listTenants doesn't accept those server-side). On Confirm we send
// `expected_count: previewCount` IFF the walk reached an exact total
// (reachedEnd) — not when capped — so the server's COUNT_MISMATCH gate
// engages on drift between preview and submit.
const filterBulkPreview = useBulkActionPreview<Tenant>({
  fetchPage: async (cursor) => {
    const params: Record<string, string> = {}
    const q = debouncedSearch.value.trim()
    if (q) params.search = q
    if (cursor) params.cursor = cursor
    const res = await listTenants(params)
    return { items: res.tenants, hasMore: !!res.has_more, nextCursor: res.next_cursor ?? '' }
  },
  filterFn: (t) => {
    if (!filterBulkAction.value) return false
    const wantStatus = filterBulkAction.value === 'SUSPEND' ? 'ACTIVE' : 'SUSPENDED'
    if (t.status !== wantStatus) return false
    if (parentFilter.value && parentFilter.value !== '__root__' && t.parent_tenant_id !== parentFilter.value) return false
    return true
  },
  toSample: (t) => ({
    id: t.tenant_id,
    primary: t.name || '',
    status: t.status,
  }),
})

function openFilterBulk(action: TenantBulkAction) {
  filterBulkAction.value = action
  filterBulkSubmitError.value = ''
  // Kick the cursor walk immediately on open — operator's first impression
  // is "Counting…" with a spinner, which lands within the typical first-
  // page round-trip (≤ ~300ms).
  void filterBulkPreview.startPreview()
}
function canApplyFilterBulk(): boolean {
  // parent_tenant_id='__root__' is a dashboard UI pseudo-value with no
  // server-side equivalent on the bulk endpoint, so disallow.
  return parentFilter.value !== '__root__'
}
const filterBulkSummary = computed<string>(() => {
  const parts: string[] = []
  if (filterBulkAction.value === 'SUSPEND') parts.push('status=ACTIVE')
  else if (filterBulkAction.value === 'REACTIVATE') parts.push('status=SUSPENDED')
  if (parentFilter.value && parentFilter.value !== '__root__') parts.push(`parent_tenant_id=${parentFilter.value}`)
  const q = debouncedSearch.value.trim()
  if (q) parts.push(`search="${q}"`)
  return parts.join(' AND ')
})
function cancelFilterBulk() {
  if (filterBulkRunning.value) return
  filterBulkPreview.cancelPreview()
  filterBulkPreview.resetPreview()
  filterBulkAction.value = null
  filterBulkSubmitError.value = ''
}
async function executeFilterBulk() {
  if (!filterBulkAction.value || filterBulkRunning.value) return
  // Guard rails — these mirror the dialog's Confirm-disabled conditions
  // but are duplicated here as a defence-in-depth so a programmatic
  // emit('confirm') can never silently send a no-op or LIMIT_EXCEEDED.
  if (filterBulkPreview.previewLoading.value) return
  if (filterBulkPreview.previewCount.value === 0) return
  if (filterBulkPreview.cappedAtMax.value) return

  const action = filterBulkAction.value
  const filter: TenantBulkFilter = {}
  if (action === 'SUSPEND') filter.status = 'ACTIVE'
  else if (action === 'REACTIVATE') filter.status = 'SUSPENDED'
  if (parentFilter.value && parentFilter.value !== '__root__') filter.parent_tenant_id = parentFilter.value
  const q = debouncedSearch.value.trim()
  if (q) filter.search = q
  filterBulkRunning.value = true
  filterBulkSubmitError.value = ''
  try {
    const body: import('../types').TenantBulkActionRequest = {
      filter,
      action,
      idempotency_key: generateIdempotencyKey(),
    }
    // Only send expected_count when the preview walk produced an exact
    // count. When we hit either cap, expected_count would be a partial
    // and every submit would 409 COUNT_MISMATCH against the real total.
    if (filterBulkPreview.reachedEnd.value) {
      body.expected_count = filterBulkPreview.previewCount.value
    }
    const res = await bulkActionTenants(body)
    const verb = action === 'SUSPEND' ? 'suspended' : 'reactivated'
    const parts = [`${res.succeeded.length}/${res.total_matched} tenants ${verb}`]
    if (res.skipped.length) parts.push(`${res.skipped.length} skipped (already in target state)`)
    if (res.failed.length) parts.push(`${res.failed.length} failed`)
    const summary = parts.join(', ')
    if (res.failed.length) toast.error(`${summary} — see details`)
    else toast.success(summary)
    // Always close the preview dialog first; the result dialog (if any)
    // renders as a separate overlay and has its own focus trap.
    filterBulkAction.value = null
    filterBulkPreview.resetPreview()
    // Open the per-row result dialog whenever any row is not a plain
    // success — operators need codes + ids to triage without re-running.
    if (res.failed.length || res.skipped.length) {
      bulkResult.value = { actionVerb: action === 'SUSPEND' ? 'Suspend' : 'Reactivate', response: res }
    }
  } catch (e) {
    // Humanize the two bulk-action safety gates (governance spec v0.1.25.23
    // added these to the ErrorCode enum; prose was already in v0.1.25.21):
    //   - LIMIT_EXCEEDED (400): filter matched >500 rows; operator must
    //     narrow the filter. Server echoes total_matched in details.
    //   - COUNT_MISMATCH (409): preview-time count differed from the
    //     server's at-submit count — typically because another writer
    //     created/deleted/changed status of a matching tenant in the
    //     interval. Surface inline so the operator can refresh the
    //     preview and retry.
    // Other errors fall through to the generic toMessage formatter.
    if (e instanceof ApiError && (e.errorCode === 'LIMIT_EXCEEDED' || e.errorCode === 'COUNT_MISMATCH')) {
      filterBulkSubmitError.value = formatBulkRequestError(e.errorCode, 'tenants', 500, e.details as Record<string, unknown> | undefined) ?? `Bulk ${action} failed: ${toMessage(e)}`
    } else {
      filterBulkSubmitError.value = `Bulk ${action} failed: ${toMessage(e)}`
    }
  } finally {
    filterBulkRunning.value = false
    await refresh()
  }
}

// ─── Create tenant (existing) ─────────────────────────────────────────
const showCreate = ref(false)
const createLoading = ref(false)
const createError = ref('')
const createForm = ref({ tenant_id: '', name: '', parent_tenant_id: '' })

function openCreate() {
  createForm.value = { tenant_id: '', name: '', parent_tenant_id: '' }
  createError.value = ''
  showCreate.value = true
}

async function submitCreate() {
  createError.value = ''
  if (!/^[a-z0-9-]+$/.test(createForm.value.tenant_id)) {
    createError.value = 'Tenant ID must contain only lowercase letters, numbers, and hyphens'
    return
  }
  createLoading.value = true
  try {
    const body: Record<string, unknown> = { tenant_id: createForm.value.tenant_id, name: createForm.value.name }
    if (createForm.value.parent_tenant_id) body.parent_tenant_id = createForm.value.parent_tenant_id
    await createTenant(body as any)
    showCreate.value = false
    toast.success(`Tenant '${createForm.value.name}' created`)
    router.push({ name: 'tenant-detail', params: { id: createForm.value.tenant_id } })
  } catch (e) { createError.value = toMessage(e) }
  finally { createLoading.value = false }
}

// ─── Single-row suspend / reactivate (retained) ──────────────────────
const pendingStatusAction = ref<{ tenantId: string; name: string; action: 'SUSPENDED' | 'ACTIVE' } | null>(null)

async function copyTenantId(tenantId: string) {
  try {
    await navigator.clipboard.writeText(tenantId)
    toast.success('Tenant ID copied')
  } catch {
    toast.error('Copy failed — clipboard unavailable')
  }
}

async function copyTenantJson(tenant: Tenant) {
  if (await writeClipboardJson(tenant)) toast.success('Tenant JSON copied')
  else toast.error('Copy failed — clipboard unavailable')
}

async function executeStatusAction() {
  if (!pendingStatusAction.value) return
  const { tenantId, action } = pendingStatusAction.value
  try {
    await updateTenantStatus(tenantId, action)
    toast.success(action === 'SUSPENDED' ? 'Tenant suspended' : 'Tenant reactivated')
    await refresh()
  } catch (e) {
    const msg = toMessage(e)
    error.value = msg
    toast.error(`${action === 'SUSPENDED' ? 'Suspend' : 'Reactivate'} failed: ${msg}`)
  }
  finally { pendingStatusAction.value = null }
}

// Fold the current sort + search tuple into a listTenants params record.
// Every listTenants call site (polling, loadMore, export fetchPage)
// must forward the same tuple — the server binds its opaque cursor to
// (sort_by, sort_dir, filter_hash), so a mismatched follow-up 400s.
//
// search (cycles-governance-admin v0.1.25.21): case-insensitive
// substring match on tenant_id + name, server-side. Empty string is
// treated as absent — don't send `search=""`. Additive per spec:
// older servers MUST ignore the unknown param, so the client-side
// filter on filteredTenants stays as graceful degradation for
// pre-0.1.25.21 deployments.
function withListParams(params: Record<string, string> = {}): Record<string, string> {
  if (sortKey.value) {
    params.sort_by = sortKey.value
    params.sort_dir = sortDir.value
  }
  const q = debouncedSearch.value.trim()
  if (q) params.search = q
  return params
}

const { refresh, isLoading, lastUpdated } = usePolling(async () => {
  try {
    const res = await listTenants(withListParams())
    tenants.value = res.tenants
    hasMore.value = !!res.has_more
    nextCursor.value = res.next_cursor ?? ''
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
}, 60000)

// Refetch page 1 whenever the debounced search changes so the cursor
// stays aligned with the server's (sort_by, sort_dir, search) tuple.
// Same rationale as useSort's onChange — the opaque cursor is filter-
// scoped, so carrying it across a filter change would 400.
watch(debouncedSearch, () => { refresh() })

// Export. filterFn mirrors the client-side filteredTenants computed
// so the exported set matches what the operator sees on screen. The
// cursor-follow fetches raw server pages; the filter then prunes
// them down to the search/parentFilter match set.
function tenantMatchesFilter(t: Tenant): boolean {
  if (parentFilter.value) {
    if (parentFilter.value === '__root__') {
      if (t.parent_tenant_id) return false
    } else if (t.parent_tenant_id !== parentFilter.value) {
      return false
    }
  }
  if (debouncedSearch.value) {
    const q = debouncedSearch.value.toLowerCase()
    if (!t.tenant_id.toLowerCase().includes(q) && !t.name.toLowerCase().includes(q)) {
      return false
    }
  }
  return true
}
const {
  showExportConfirm,
  exporting,
  exportFetched,
  exportError,
  exportCancellable,
  maxRows: EXPORT_MAX_ROWS,
  confirmExport,
  cancelExport,
  cancelRunningExport,
  executeExport,
} = useListExport<Tenant>({
  itemNoun: 'tenant',
  filenameStem: 'tenants',
  currentItems: filteredTenants,
  hasMore,
  nextCursor,
  fetchPage: async (cursor) => {
    const res = await listTenants(withListParams({ cursor }))
    return { items: res.tenants, hasMore: !!res.has_more, nextCursor: res.next_cursor ?? '' }
  },
  filterFn: tenantMatchesFilter,
  columns: [
    { header: 'tenant_id',        value: t => t.tenant_id },
    { header: 'name',             value: t => t.name },
    { header: 'parent_tenant_id', value: t => t.parent_tenant_id ?? '' },
    { header: 'status',           value: t => t.status },
    { header: 'created_at',       value: t => t.created_at },
  ],
})

watch(exportError, (v) => { if (v) error.value = v })

async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return
  loadingMore.value = true
  try {
    const res = await listTenants(withListParams({ cursor: nextCursor.value }))
    tenants.value = [...tenants.value, ...res.tenants]
    hasMore.value = !!res.has_more
    nextCursor.value = res.next_cursor ?? ''
  } catch (e) { error.value = toMessage(e) }
  finally { loadingMore.value = false }
}

function parentName(id: string | undefined): string {
  if (!id) return ''
  // V3: O(1) Map lookup (was tenants.value.find() per-row — O(n²) total).
  const p = tenantById.value.get(id)
  return p?.name || id
}

// V1 virtualization. See ReservationsView.vue for the pattern rationale —
// semantic <table> becomes an ARIA grid of <div>s with fixed row
// heights; `gridTemplate` is inline (not a Tailwind arbitrary class)
// so Vue bindings can't be missed by the JIT scanner.
const scrollEl = ref<HTMLElement | null>(null)
// 52px fits a single-line row at text-sm with table-cell's py-3 padding.
// Status badges and sort icons are smaller than the line-height so no
// re-measurement needed.
const ROW_HEIGHT_ESTIMATE = 52
const virtualizer = useVirtualizer(computed(() => ({
  count: sortedTenants.value.length,
  getScrollElement: () => scrollEl.value,
  estimateSize: () => ROW_HEIGHT_ESTIMATE,
  overscan: 8,
})))
const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalHeight = computed(() => virtualizer.value.getTotalSize())

// Column layout shared by sticky header + every virtualized row.
// Checkbox + action columns only present when canManage. Widths tuned
// against a 1440px viewport with a 200px sidebar — shrinks gracefully
// via minmax fractional units, overflow-x handled by the outer scroll
// container.
const gridTemplate = computed(() =>
  canManage.value
    ? '40px minmax(180px,1.5fr) minmax(160px,2fr) minmax(140px,1fr) 110px 110px 120px 120px'
    : 'minmax(180px,1.5fr) minmax(160px,2fr) minmax(140px,1fr) 110px 110px 120px',
)
</script>

<template>
  <!-- Phase 5 (table-layout unification): flex-fill root — the table
       body grows to fill whatever viewport height remains after the
       header, filter bar, and footer take their natural height. -->
  <div class="h-full flex flex-col min-h-0">
    <PageHeader
      title="Tenants"
      item-noun="tenant"
      :loaded="filteredTenants.length"
      :has-more="hasMore"
      :loading="isLoading"
      :last-updated="lastUpdated"
      @refresh="refresh"
    >
      <template v-if="parentFromQuery" #back>
        <button
          @click="router.push({ name: 'tenant-detail', params: { id: parentFromQuery } })"
          :aria-label="`Back to parent tenant ${parentFromQuery}`"
          class="muted hover:text-gray-700 cursor-pointer"
        >
          <BackArrowIcon class="w-5 h-5" />
        </button>
      </template>
      <template #actions>
        <button @click="confirmExport('csv')" :disabled="filteredTenants.length === 0" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">
          <DownloadIcon class="w-3.5 h-3.5" />
          Export CSV
        </button>
        <button @click="confirmExport('json')" :disabled="filteredTenants.length === 0" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">
          <DownloadIcon class="w-3.5 h-3.5" />
          Export JSON
        </button>
        <button v-if="canManage" @click="openCreate" class="text-xs bg-blue-600 text-white hover:bg-blue-700 rounded px-3 py-1.5 cursor-pointer transition-colors">Create Tenant</button>
      </template>
    </PageHeader>
    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg table-cell mb-4">{{ error }}</p>

    <!-- Search + parent filter. Wrapped in card to match the filter
         toolbars in BudgetsView / EventsView / AuditView / ApiKeysView
         — consistent visual grouping & separation from the table below. -->
    <div class="card p-4 mb-4">
      <div class="flex gap-3 flex-wrap items-center">
        <input v-model="search" placeholder="Search by ID or name..." class="border border-gray-300 rounded px-3 py-1.5 text-sm max-w-xs flex-1 min-w-[14rem]" />
        <select v-model="parentFilter" aria-label="Filter by parent tenant" class="form-select">
          <option value="">All tenants</option>
          <option value="__root__">(root-level only)</option>
          <option v-for="p in parentOptions" :key="p.tenant_id" :value="p.tenant_id">Children of: {{ p.name || p.tenant_id }}</option>
        </select>
        <select v-model="statusFilter" aria-label="Filter by tenant status" class="form-select">
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="SUSPENDED">Suspended</option>
          <option value="CLOSED">Closed</option>
        </select>
        <!-- Filter-apply bulk actions. Appears when the operator has a
             non-empty filter (so the action targets an explicit subset,
             not "all tenants") AND no row-select is active (keeps the
             two paths visually distinct). Disabled when parentFilter
             is '__root__' — server bulk endpoint has no null-parent
             filter, so the '(root-level only)' pseudo-option isn't
             applicable on this path.
             Grouped in an inline-flex sub-container so label + buttons
             wrap together on narrow viewports instead of fragmenting
             into one element per line. role="group" + aria-label
             announces the cluster's purpose to screen readers. -->
        <div
          v-if="canManage && (debouncedSearch.trim() || parentFilter || statusFilter) && selectedVisibleCount === 0"
          role="group"
          aria-label="Apply action to all tenants matching the current filter"
          class="inline-flex items-center gap-2 flex-wrap"
        >
          <div class="w-px h-5 bg-gray-200 dark:bg-gray-700" aria-hidden="true"></div>
          <span class="muted-sm whitespace-nowrap">Apply to all matching filter:</span>
          <button
            @click="openFilterBulk('SUSPEND')"
            :disabled="!canApplyFilterBulk() || filterBulkRunning"
            class="text-xs text-red-700 dark:text-red-300 hover:text-red-900 dark:hover:text-red-200 border border-red-300 dark:border-red-700 bg-white dark:bg-gray-800 rounded px-2.5 py-1 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            :title="canApplyFilterBulk() ? 'Suspend all ACTIVE tenants matching filter' : 'Root-level filter is not supported by server bulk-action'"
          >Suspend all</button>
          <button
            @click="openFilterBulk('REACTIVATE')"
            :disabled="!canApplyFilterBulk() || filterBulkRunning"
            class="text-xs text-green-700 dark:text-green-300 hover:text-green-900 dark:hover:text-green-200 border border-green-300 dark:border-green-700 bg-white dark:bg-gray-800 rounded px-2.5 py-1 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            :title="canApplyFilterBulk() ? 'Reactivate all SUSPENDED tenants matching filter' : 'Root-level filter is not supported by server bulk-action'"
          >Reactivate all</button>
        </div>
      </div>
    </div>

    <!-- Floating bulk action bar — appears only when rows are
         selected. Teleported to <body>; fixed at top-center of the
         viewport so it anchors to the F-pattern reading start point
         (above where users are scanning table rows/headers). Bottom
         placement tested poorly — operators missed it on large
         monitors because their gaze was still on the table. Top
         placement matches Gmail / Linear / Jira / GitHub. Slides
         DOWN from above on appear. -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="opacity-0 -translate-y-4"
        enter-to-class="opacity-100 translate-y-0"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="opacity-100 translate-y-0"
        leave-to-class="opacity-0 -translate-y-4"
      >
        <div
          v-if="canManage && selectedVisibleCount > 0"
          role="toolbar"
          aria-label="Bulk tenant actions"
          class="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-white dark:bg-gray-900 dark:border dark:border-gray-700 border-2 border-blue-400 shadow-2xl rounded-lg px-4 py-2.5 flex items-center gap-3 max-w-[90vw]"
        >
          <span class="text-sm font-semibold text-blue-900 dark:text-blue-300 tabular-nums">{{ selectedVisibleCount }} selected</span>
          <div class="w-px h-5 bg-gray-200 dark:bg-gray-700" aria-hidden="true"></div>
          <button @click="openBulk('SUSPENDED')" class="text-xs text-red-700 hover:text-red-900 border border-red-300 bg-white rounded px-2.5 py-1 cursor-pointer">Suspend</button>
          <button @click="openBulk('ACTIVE')" class="text-xs text-green-700 hover:text-green-900 border border-green-300 bg-white rounded px-2.5 py-1 cursor-pointer">Reactivate</button>
          <button
            @click="selected = new Set()"
            aria-label="Clear selection"
            class="muted hover:text-gray-700 cursor-pointer p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <CloseIcon class="w-4 h-4" />
          </button>
        </div>
      </Transition>
    </Teleport>

    <!-- V1 virtualized grid. Pattern established in ReservationsView:
         role="table" outer, sticky role="rowgroup" header, scroll
         container with absolute-positioned virtualized rows. Shell is
         flex-1 min-h-0 flex-col so the scroll body below expands to
         fill remaining viewport (phase 5 table-layout unification). -->
    <div
      class="bg-white rounded-lg shadow overflow-hidden text-sm flex-1 min-h-0 flex flex-col"
      role="table"
      :aria-rowcount="filteredTenants.length + 1"
      :aria-colcount="canManage ? 8 : 6"
    >
      <div role="rowgroup" class="table-header border-b border-gray-200 sticky top-0 z-10">
        <div role="row" class="grid text-xs font-bold uppercase tracking-wider" :style="{ gridTemplateColumns: gridTemplate }">
          <div v-if="canManage" role="columnheader" class="table-cell">
            <input type="checkbox" :checked="selectedVisibleAll" @change="toggleSelectAll" aria-label="Select all visible tenants" />
          </div>
          <SortHeader as="div" label="Tenant ID" column="tenant_id" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Name" column="name" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <!-- Parent + Children are client-derived (tenantById name +
               childCountMap count) and have no server-side index — the
               listTenants sort_by enum is limited to tenant_id, name,
               status, created_at. Rendered as plain columnheader divs
               so operators can't request a sort that would only
               reorder the currently-loaded slice. -->
          <div role="columnheader" class="table-cell text-left">Parent</div>
          <div role="columnheader" class="table-cell text-left">Children</div>
          <SortHeader as="div" label="Status" column="status" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Created" column="created_at" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <div v-if="canManage" role="columnheader" class="table-cell" data-column="action"></div>
        </div>
      </div>

      <div
        v-if="sortedTenants.length > 0"
        ref="scrollEl"
        role="rowgroup"
        class="flex-1 overflow-auto min-h-[200px]"
      >
        <div role="presentation" :style="{ height: totalHeight + 'px', position: 'relative' }">
          <div
            v-for="v in virtualRows"
            :key="sortedTenants[v.index].tenant_id"
            role="row"
            :aria-rowindex="v.index + 2"
            class="grid table-row-hover border-b border-gray-100 absolute left-0 right-0 items-center"
            :style="{ gridTemplateColumns: gridTemplate, transform: `translateY(${v.start}px)`, height: ROW_HEIGHT_ESTIMATE + 'px' }"
          >
            <div v-if="canManage" role="cell" class="table-cell">
              <input type="checkbox" :checked="selected.has(sortedTenants[v.index].tenant_id)" @change="toggleSelect(sortedTenants[v.index].tenant_id)" :aria-label="`Select ${sortedTenants[v.index].name || sortedTenants[v.index].tenant_id}`" />
            </div>
            <div role="cell" class="table-cell">
              <router-link :to="{ name: 'tenant-detail', params: { id: sortedTenants[v.index].tenant_id } }" class="text-blue-600 hover:underline font-mono text-xs">{{ sortedTenants[v.index].tenant_id }}</router-link>
            </div>
            <div role="cell" class="table-cell text-gray-700">{{ sortedTenants[v.index].name }}</div>
            <div role="cell" class="table-cell text-xs">
              <router-link v-if="sortedTenants[v.index].parent_tenant_id" :to="{ name: 'tenant-detail', params: { id: sortedTenants[v.index].parent_tenant_id } }" class="text-blue-600 hover:underline font-mono">
                {{ parentName(sortedTenants[v.index].parent_tenant_id) }}
              </router-link>
              <span v-else class="text-gray-500" aria-hidden="true">—</span>
            </div>
            <div role="cell" class="table-cell text-xs">
              <button
                v-if="childCountMap[sortedTenants[v.index].tenant_id]"
                @click="parentFilter = sortedTenants[v.index].tenant_id"
                class="text-blue-600 hover:underline cursor-pointer"
                :aria-label="`Filter list to ${childCountMap[sortedTenants[v.index].tenant_id]} children of ${sortedTenants[v.index].name}`"
              >{{ childCountMap[sortedTenants[v.index].tenant_id] }} child{{ childCountMap[sortedTenants[v.index].tenant_id] === 1 ? '' : 'ren' }}</button>
              <span v-else class="text-gray-500" aria-hidden="true">—</span>
            </div>
            <div role="cell" class="table-cell"><StatusBadge :status="sortedTenants[v.index].status" /></div>
            <div role="cell" class="table-cell muted-sm">{{ formatDate(sortedTenants[v.index].created_at) }}</div>
            <div v-if="canManage" role="cell" class="table-cell">
              <!-- Activity + Copy tenant ID always shown so even CLOSED
                   tenants (terminal — both Reactivate and Suspend are
                   hidden) still expose a 2-item menu. -->
              <RowActionsMenu
                :aria-label="`Actions for tenant ${sortedTenants[v.index].name || sortedTenants[v.index].tenant_id}`"
                :items="[
                  { label: 'Activity', to: { name: 'audit', query: { tenant_id: sortedTenants[v.index].tenant_id } } },
                  { label: 'Copy tenant ID', onClick: () => copyTenantId(sortedTenants[v.index].tenant_id) },
                  { label: 'Copy as JSON', onClick: () => copyTenantJson(sortedTenants[v.index]) },
                  { label: 'Reactivate', onClick: () => pendingStatusAction = { tenantId: sortedTenants[v.index].tenant_id, name: sortedTenants[v.index].name, action: 'ACTIVE' }, hidden: sortedTenants[v.index].status !== 'SUSPENDED' },
                  { separator: true },
                  { label: 'Suspend', onClick: () => pendingStatusAction = { tenantId: sortedTenants[v.index].tenant_id, name: sortedTenants[v.index].name, action: 'SUSPENDED' }, danger: true, hidden: sortedTenants[v.index].status !== 'ACTIVE' },
                ]"
              />
            </div>
          </div>
        </div>
      </div>

      <div v-else>
        <EmptyState
          item-noun="tenant"
          :has-active-filter="!!(search || parentFilter || statusFilter)"
          :hint="search || parentFilter || statusFilter ? undefined : 'Tenants will appear here once created'"
        />
      </div>
    </div>

    <!-- R5: server-side cursor pagination. Search and parent-filter
         run client-side on the loaded subset — operators who can't
         find what they're looking for should Load more. Polling
         refreshes page 1 every 60s and drops any additional pages
         below it (same trade-off documented in ReservationsView). -->
    <div v-if="hasMore || loadingMore" class="mt-3 flex items-center justify-between">
      <p class="muted-sm">
        Showing {{ tenants.length.toLocaleString() }} loaded tenant{{ tenants.length === 1 ? '' : 's' }}.
        Polling refreshes page 1 every 60s, discarding additional pages loaded below.
      </p>
      <button
        @click="loadMore"
        :disabled="loadingMore || !nextCursor"
        class="text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50 cursor-pointer"
      >
        {{ loadingMore ? 'Loading…' : 'Load more' }}
      </button>
    </div>

    <!-- Single-row confirm (retained) -->
    <ConfirmAction
      v-if="pendingStatusAction"
      :title="pendingStatusAction.action === 'SUSPENDED' ? 'Suspend this tenant?' : 'Reactivate this tenant?'"
      :message="pendingStatusAction.action === 'SUSPENDED'
        ? `Suspending '${pendingStatusAction.name}' will block all API access for this tenant and its keys.`
        : `Reactivating '${pendingStatusAction.name}' will restore API access.`"
      :confirm-label="pendingStatusAction.action === 'SUSPENDED' ? 'Suspend' : 'Reactivate'"
      :danger="pendingStatusAction.action === 'SUSPENDED'"
      @confirm="executeStatusAction"
      @cancel="pendingStatusAction = null"
    />

    <!-- Bulk confirm. During execution shows a live progress message in
         the error slot (not literally an error — reusing the visible
         text region under the title). On cancel mid-run, stops after
         the current request completes. -->
    <ConfirmAction
      v-if="bulkAction"
      :title="bulkAction === 'SUSPENDED'
        ? `Suspend ${bulkRunning ? bulkProgress.total : selectedVisibleCount} tenants?`
        : `Reactivate ${bulkRunning ? bulkProgress.total : selectedVisibleCount} tenants?`"
      :message="bulkRunning
        ? `Working… ${bulkProgress.done}/${bulkProgress.total} processed${bulkProgress.failed ? ` (${bulkProgress.failed} failed)` : ''}.`
        : bulkAction === 'SUSPENDED'
          ? `This will block API access for each selected tenant and all their keys. Tenants already SUSPENDED or CLOSED will be skipped.`
          : `This will restore API access for each selected tenant. Tenants already ACTIVE or CLOSED will be skipped.`"
      :confirm-label="bulkRunning ? 'Working…' : bulkAction === 'SUSPENDED' ? 'Suspend all' : 'Reactivate all'"
      :danger="bulkAction === 'SUSPENDED'"
      :loading="bulkRunning"
      @confirm="executeBulk"
      @cancel="cancelBulk"
    />

    <!-- O1: filter-apply preview. Walks listTenants with the same server-
         side filter as the bulk request, applies the action's full filter
         predicate client-side, and surfaces count + first-10 sample rows
         BEFORE arming the Confirm button. expected_count is sent on submit
         when the walk reached an exact total so server-side COUNT_MISMATCH
         catches drift. Server caps at 500 matches per request — the
         dialog disables Confirm when the walk hits that cap and instructs
         the operator to narrow the filter. -->
    <BulkActionPreviewDialog
      v-if="filterBulkAction"
      :action-verb="filterBulkAction === 'SUSPEND' ? 'Suspend' : 'Reactivate'"
      item-noun-plural="tenants"
      :filter-description="filterBulkSummary"
      :loading="filterBulkPreview.previewLoading.value"
      :count="filterBulkPreview.previewCount.value"
      :samples="filterBulkPreview.previewSamples.value"
      :capped-at-max="filterBulkPreview.cappedAtMax.value"
      :capped-at-pages="filterBulkPreview.cappedAtPages.value"
      :reached-end="filterBulkPreview.reachedEnd.value"
      :error="filterBulkPreview.previewError.value"
      :submit-error="filterBulkSubmitError"
      :submitting="filterBulkRunning"
      :confirm-danger="filterBulkAction === 'SUSPEND'"
      @confirm="executeFilterBulk"
      @cancel="cancelFilterBulk"
    />

    <!-- Per-row result dialog. Opens after a bulk-action submit if any
         row failed or was skipped — surfaces error_code + message per row
         so operators can triage without tailing the browser console. -->
    <BulkActionResultDialog
      v-if="bulkResult"
      :action-verb="bulkResult.actionVerb"
      item-noun-plural="tenants"
      :response="bulkResult.response"
      @close="bulkResult = null"
    />

    <FormDialog v-if="showCreate" title="Create Tenant" submit-label="Create Tenant" :loading="createLoading" :error="createError" @submit="submitCreate" @cancel="showCreate = false">
      <div>
        <label for="ct-id" class="form-label">Tenant ID</label>
        <input id="ct-id" v-model="createForm.tenant_id" required pattern="^[a-z0-9-]+$" minlength="3" maxlength="64" class="form-input-mono" placeholder="acme-corp" />
        <p class="muted-sm mt-0.5">Lowercase letters, numbers, and hyphens only</p>
      </div>
      <div>
        <label for="ct-name" class="form-label">Display Name</label>
        <input id="ct-name" v-model="createForm.name" required maxlength="256" class="form-input" placeholder="Acme Corporation" />
      </div>
      <div>
        <label for="ct-parent" class="form-label">Parent Tenant (optional)</label>
        <select id="ct-parent" v-model="createForm.parent_tenant_id" class="form-select w-full">
          <option value="">None</option>
          <option v-for="t in tenants" :key="t.tenant_id" :value="t.tenant_id">{{ t.name || t.tenant_id }}</option>
        </select>
      </div>
    </FormDialog>

    <ExportDialog
      :format="showExportConfirm"
      :loaded-count="filteredTenants.length"
      :has-more="hasMore"
      :max-rows="EXPORT_MAX_ROWS"
      item-noun-plural="tenants"
      @confirm="executeExport"
      @cancel="cancelExport"
    />
    <ExportProgressOverlay
      :open="exporting"
      :fetched="exportFetched"
      :cancellable="exportCancellable"
      item-noun-plural="tenants"
      @cancel="cancelRunningExport"
    />
  </div>
</template>

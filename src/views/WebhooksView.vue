<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useRouter, useRoute } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { useSort } from '../composables/useSort'
import { useDebouncedRef } from '../composables/useDebouncedRef'
import { useListExport } from '../composables/useListExport'
import { listWebhooks, listTenants, createWebhook, updateWebhook, getWebhookSecurityConfig, updateWebhookSecurityConfig, bulkActionWebhooks, ApiError } from '../api/client'
import { rateLimitedBatch } from '../utils/rateLimitedBatch'
import { generateIdempotencyKey } from '../utils/idempotencyKey'
import type { WebhookBulkAction, WebhookBulkFilter } from '../types'
import { useAuthStore } from '../stores/auth'
import type { WebhookSubscription, WebhookCreateResponse, Tenant, WebhookSecurityConfig } from '../types'
import { EVENT_TYPES } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import TenantLink from '../components/TenantLink.vue'
import PageHeader from '../components/PageHeader.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import ExportDialog from '../components/ExportDialog.vue'
import ExportProgressOverlay from '../components/ExportProgressOverlay.vue'
import ConfirmAction from '../components/ConfirmAction.vue'
import BulkActionPreviewDialog from '../components/BulkActionPreviewDialog.vue'
import BulkActionResultDialog from '../components/BulkActionResultDialog.vue'
import FormDialog from '../components/FormDialog.vue'
import SecretReveal from '../components/SecretReveal.vue'
import RowActionsMenu from '../components/RowActionsMenu.vue'
import { useToast } from '../composables/useToast'
import { useBulkActionPreview } from '../composables/useBulkActionPreview'
import { toMessage } from '../utils/errors'
import { formatBulkRequestError } from '../utils/errorCodeMessages'
import type { WebhookBulkActionResponse } from '../types'

const toast = useToast()

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const canManage = computed(() => auth.capabilities?.manage_webhooks !== false)

const webhooks = ref<WebhookSubscription[]>([])
const tenants = ref<Tenant[]>([])
const error = ref('')

// R6 (scale-hardening): cursor pagination. Pre-fix, listWebhooks()'s
// has_more / next_cursor were discarded. Deployments with thousands
// of webhook subscriptions silently dropped the tail. Load-more
// appends; polling refreshes page 1 (drops tail). Same pattern
// established in ReservationsView / TenantsView.
const hasMore = ref(false)
const nextCursor = ref('')
const loadingMore = ref(false)

// v0.1.25.21 (#5): filter by tenant + bulk pause/enable. The existing
// view was system-wide with no way to scope to "webhooks for tenant X"
// — an ops pain when you need to pause a noisy tenant's subscriptions.
// Server sentinel `__system__` means a subscription was created without
// a tenant_id (system-wide delivery); we surface it both as a distinct
// filter option ("System-wide only") and as a labelled badge in the
// Tenant column rather than a broken TenantLink.
const SYSTEM_TENANT_ID = '__system__'
const tenantFilter = ref('')
// URL filter: substring match on the URL (or the optional `name`)
// with case-insensitive compare. Supports "example.com", "api",
// or a glob-ish "*.internal" (asterisks collapse to `.*` so
// operators who prefer wildcard notation get it for free).
// Debounced 200ms via useDebouncedRef so a 20-char URL fragment
// doesn't fire 20 filter re-computations.
const urlFilter = ref('')
const debouncedUrlFilter = useDebouncedRef(urlFilter, 200)

// I1: status URL param drives statusFilter on initial mount + back/forward.
// Used by Overview's symmetrical counter tile drill-downs (e.g.
// /webhooks?status=DISABLED) so the operator lands on a pre-filtered
// list. Failing webhooks (with_failures > 0) drill via /webhooks?failing=1
// because failure-count is a derived attribute, not a status enum.
const statusFilter = ref('')
const failingFilter = ref(false)
const statusFromQuery = computed<string | null>(() => {
  const s = route.query.status
  if (typeof s !== 'string') return null
  return s === 'ACTIVE' || s === 'PAUSED' || s === 'DISABLED' ? s : null
})
watch(statusFromQuery, s => {
  if (s && statusFilter.value !== s) statusFilter.value = s
}, { immediate: true })
const failingFromQuery = computed<boolean>(() => {
  const f = route.query.failing
  return f === '1' || f === 'true'
})
watch(failingFromQuery, f => {
  if (failingFilter.value !== f) failingFilter.value = f
}, { immediate: true })

function urlMatches(w: WebhookSubscription, needle: string): boolean {
  const q = needle.trim().toLowerCase()
  if (!q) return true
  const haystack = `${w.url} ${w.name ?? ''}`.toLowerCase()
  // Treat `*` as a wildcard. Escape the rest of the regex specials
  // so operators can paste URLs with dots / slashes literally without
  // them acting as regex metacharacters.
  if (q.includes('*')) {
    const escaped = q.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    try {
      return new RegExp(escaped).test(haystack)
    } catch { return haystack.includes(q) }
  }
  return haystack.includes(q)
}

const filteredWebhooks = computed(() => {
  let out = webhooks.value
  if (tenantFilter.value) out = out.filter(w => w.tenant_id === tenantFilter.value)
  if (statusFilter.value) out = out.filter(w => w.status === statusFilter.value)
  if (failingFilter.value) out = out.filter(w => (w.consecutive_failures ?? 0) > 0)
  if (debouncedUrlFilter.value) out = out.filter(w => urlMatches(w, debouncedUrlFilter.value))
  return out
})
function isSystemWebhook(w: WebhookSubscription): boolean {
  return !w.tenant_id || w.tenant_id === SYSTEM_TENANT_ID
}
// Clear the selection when the tenant filter changes. Otherwise a user
// who selects 5 webhooks for tenant A then switches the filter to
// tenant B would see "0 selected" in the bulk bar (selectedVisibleCount
// reads filtered state) but `selected.value` still holds the 5 hidden
// ids — clicking "Pause selected" would silently affect tenant A's
// webhooks even though tenant B is what's on screen.
watch([tenantFilter, urlFilter, statusFilter, failingFilter], () => { selected.value = new Set() })
// V4 stage 2: server-side sort. Columns (url, tenant_id, status,
// consecutive_failures) map onto listWebhookSubscriptions sort_by.
// Health + Events columns are NOT sortable — they're derived client-side
// and don't have server enum values. onChange refreshes page 1 so the
// cursor stays aligned with the new (sort_by, sort_dir) tuple.
const { sortKey, sortDir, toggle, sorted: sortedWebhooks } = useSort(
  filteredWebhooks,
  undefined,
  'asc',
  undefined,
  { serverSide: true, onChange: () => { refresh() } },
)

// Helper to fold the current sort tuple + server-side search into a
// listWebhooks params record. Every call site (polling, loadMore,
// export fetchPage) must forward the same tuple or the cursor-bound
// server validation fails.
//
// v0.1.25.21 `search`: case-insensitive substring match on
// (subscription_id, url). Wildcard (`*`) input remains client-only —
// the wire contract is literal substring, so a user typing `*.internal`
// would hit zero server rows. When the filter contains `*` we skip the
// server param and let the client-side wildcard matcher do the work.
// Client-side filter (urlMatches) also covers `name`, which the server
// search doesn't match per spec — kept as graceful degradation for
// both pre-0.1.25.21 servers and for wildcard/name matches.
function withListParams(params: Record<string, string> = {}): Record<string, string> {
  if (sortKey.value) {
    params.sort_by = sortKey.value
    params.sort_dir = sortDir.value
  }
  const q = debouncedUrlFilter.value.trim()
  if (q && !q.includes('*')) params.search = q
  return params
}

const selected = ref<Set<string>>(new Set())
function toggleSelect(id: string) {
  const next = new Set(selected.value)
  next.has(id) ? next.delete(id) : next.add(id)
  selected.value = next
}
const selectedVisibleAll = computed(() =>
  filteredWebhooks.value.length > 0 &&
  filteredWebhooks.value.every(w => selected.value.has(w.subscription_id)),
)
const selectedVisibleCount = computed(() =>
  filteredWebhooks.value.filter(w => selected.value.has(w.subscription_id)).length,
)
function toggleSelectAll() {
  if (selectedVisibleAll.value) {
    selected.value = new Set()
  } else {
    selected.value = new Set(filteredWebhooks.value.map(w => w.subscription_id))
  }
}

// Bulk pause/enable. W4 (scale-hardening): runs via rateLimitedBatch
// so a burst of PATCHes against the admin tier doesn't trip 429s
// without retries — 4 in flight, exponential backoff with jitter on
// 429 specifically, AbortSignal drives the cancel button. Same wiring
// as TenantsView.executeBulk; see that file for the deeper rationale.
const bulkAction = ref<'PAUSED' | 'ACTIVE' | null>(null)
const bulkProgress = ref({ done: 0, total: 0, failed: 0 })
const bulkRunning = ref(false)
let bulkAbort: AbortController | null = null

function openBulk(action: 'PAUSED' | 'ACTIVE') { bulkAction.value = action }
async function executeBulk() {
  if (!bulkAction.value || bulkRunning.value) return
  const action = bulkAction.value
  // Skip webhooks that are already in target state OR that are DISABLED
  // (DISABLED is set by the server after too many failures — reactivating
  // should be an explicit single-row action, not a bulk sweep, because
  // those endpoints are likely still broken).
  const targets = webhooks.value.filter(w =>
    selected.value.has(w.subscription_id) &&
    w.status !== action &&
    w.status !== 'DISABLED'
  )
  bulkProgress.value = { done: 0, total: targets.length, failed: 0 }
  bulkRunning.value = true
  bulkAbort = new AbortController()
  const result = await rateLimitedBatch(
    targets,
    async (w) => { await updateWebhook(w.subscription_id, { status: action }) },
    {
      signal: bulkAbort.signal,
      onProgress: (done, total, failed) => { bulkProgress.value = { done, total, failed } },
    },
  )
  for (const err of result.errors) {
    const w = targets[err.index]
    console.warn(`bulk ${action} failed on ${w.subscription_id}:`, toMessage(err.error))
  }
  bulkRunning.value = false
  bulkAbort = null
  const verb = action === 'PAUSED' ? 'paused' : 'enabled'
  const succeeded = result.done - result.failed
  const summary = `${succeeded}/${bulkProgress.value.total} webhooks ${verb}`
  if (result.failed > 0) {
    toast.error(`${summary}, ${result.failed} failed — check console for details`)
  } else if (result.cancelled) {
    toast.success(`${summary} (cancelled by user)`)
  } else {
    toast.success(summary)
  }
  bulkAction.value = null
  selected.value = new Set()
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
// Mirrors TenantsView: additive alongside the row-select path above.
// Single POST to /v1/admin/webhooks/bulk-action, filter body is
// derived from the active UI filters + the action's implied status.
//
//   - PAUSE → status=ACTIVE (only mutate webhooks currently delivering)
//   - RESUME → status=PAUSED (only un-pause operator-paused subs; the
//     server auto-DISABLES after repeated failures, and a bulk RESUME
//     should NOT sweep those back up — they need per-row verification)
//   - DELETE not offered on the filter-apply path — destructive,
//     needs a per-row confirmation flow that the dashboard owns.
//
// Guardrails:
//   - tenantFilter === SYSTEM_TENANT_ID is a dashboard pseudo-value
//     with no server-side equivalent, so the button is disabled.
//   - urlFilter containing `*` is wildcard-matched client-side only;
//     the server's `search` is literal substring, so sending the
//     wildcard string would silently produce a different match set.
//     Disable the button in that case.
const filterBulkAction = ref<WebhookBulkAction | null>(null)
const filterBulkRunning = ref(false)
const filterBulkSubmitError = ref('')
// Per-row result dialog (BulkActionResultDialog). Opens with the server
// response whenever failed[] or skipped[] is non-empty — surfaces per-row
// error_code + message for triage without tailing the browser console.
const bulkResult = ref<{ actionVerb: string; response: WebhookBulkActionResponse } | null>(null)

// O1: cursor-walk preview before commit. Walks listWebhooks with the
// same `search` server-side filter as the bulk action, then filters
// each page client-side by the action-derived status + tenant_id (the
// list endpoint accepts neither). `expected_count` is sent on submit
// when the walk reached an exact total so the server's COUNT_MISMATCH
// gate engages on drift between preview and submit.
const filterBulkPreview = useBulkActionPreview<WebhookSubscription>({
  fetchPage: async (cursor) => {
    const params: Record<string, string> = {}
    const q = debouncedUrlFilter.value.trim()
    if (q && !q.includes('*')) params.search = q
    if (cursor) params.cursor = cursor
    const res = await listWebhooks(params)
    return { items: res.subscriptions, hasMore: !!res.has_more, nextCursor: res.next_cursor ?? '' }
  },
  filterFn: (w) => {
    if (!filterBulkAction.value) return false
    const wantStatus = filterBulkAction.value === 'PAUSE' ? 'ACTIVE' : 'PAUSED'
    if (w.status !== wantStatus) return false
    if (tenantFilter.value && tenantFilter.value !== SYSTEM_TENANT_ID && w.tenant_id !== tenantFilter.value) return false
    // Wildcard branch falls through the server `search` param, so apply
    // the same client-side wildcard predicate the table uses to keep
    // the preview honest with what's on screen.
    const q = debouncedUrlFilter.value.trim()
    if (q && q.includes('*') && !urlMatches(w, q)) return false
    return true
  },
  toSample: (w) => ({
    id: w.subscription_id,
    primary: w.url,
    status: w.status,
  }),
})

function openFilterBulk(action: WebhookBulkAction) {
  filterBulkAction.value = action
  filterBulkSubmitError.value = ''
  void filterBulkPreview.startPreview()
}
function canApplyWebhookFilterBulk(): boolean {
  if (tenantFilter.value === SYSTEM_TENANT_ID) return false
  if (debouncedUrlFilter.value.includes('*')) return false
  return true
}
const filterBulkSummary = computed<string>(() => {
  const parts: string[] = []
  if (filterBulkAction.value === 'PAUSE') parts.push('status=ACTIVE')
  else if (filterBulkAction.value === 'RESUME') parts.push('status=PAUSED')
  if (tenantFilter.value && tenantFilter.value !== SYSTEM_TENANT_ID) parts.push(`tenant_id=${tenantFilter.value}`)
  const q = debouncedUrlFilter.value.trim()
  if (q && !q.includes('*')) parts.push(`search="${q}"`)
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
  if (filterBulkPreview.previewLoading.value) return
  if (filterBulkPreview.previewCount.value === 0) return
  if (filterBulkPreview.cappedAtMax.value) return

  const action = filterBulkAction.value
  const filter: WebhookBulkFilter = {}
  if (action === 'PAUSE') filter.status = 'ACTIVE'
  else if (action === 'RESUME') filter.status = 'PAUSED'
  if (tenantFilter.value && tenantFilter.value !== SYSTEM_TENANT_ID) filter.tenant_id = tenantFilter.value
  const q = debouncedUrlFilter.value.trim()
  if (q && !q.includes('*')) filter.search = q
  filterBulkRunning.value = true
  filterBulkSubmitError.value = ''
  try {
    const body: import('../types').WebhookBulkActionRequest = {
      filter,
      action,
      idempotency_key: generateIdempotencyKey(),
    }
    if (filterBulkPreview.reachedEnd.value) {
      body.expected_count = filterBulkPreview.previewCount.value
    }
    const res = await bulkActionWebhooks(body)
    const verb = action === 'PAUSE' ? 'paused' : 'resumed'
    const parts = [`${res.succeeded.length}/${res.total_matched} webhooks ${verb}`]
    if (res.skipped.length) parts.push(`${res.skipped.length} skipped (already in target state)`)
    if (res.failed.length) parts.push(`${res.failed.length} failed`)
    const summary = parts.join(', ')
    if (res.failed.length) toast.error(`${summary} — see details`)
    else toast.success(summary)
    filterBulkAction.value = null
    filterBulkPreview.resetPreview()
    if (res.failed.length || res.skipped.length) {
      bulkResult.value = { actionVerb: action === 'PAUSE' ? 'Pause' : 'Resume', response: res }
    }
  } catch (e) {
    // Humanize bulk-action safety-gate codes (governance spec v0.1.25.23
    // ErrorCode enum widening; v0.1.25.21 prose). See TenantsView
    // executeFilterBulk for the full rationale.
    if (e instanceof ApiError && (e.errorCode === 'LIMIT_EXCEEDED' || e.errorCode === 'COUNT_MISMATCH')) {
      filterBulkSubmitError.value = formatBulkRequestError(e.errorCode, 'webhooks', 500, e.details as Record<string, unknown> | undefined) ?? `Bulk ${action} failed: ${toMessage(e)}`
    } else {
      filterBulkSubmitError.value = `Bulk ${action} failed: ${toMessage(e)}`
    }
  } finally {
    filterBulkRunning.value = false
    await refresh()
  }
}

function healthColor(w: WebhookSubscription): string {
  if (w.status === 'DISABLED') return 'bg-red-500'
  if ((w.consecutive_failures ?? 0) >= 1) return 'bg-yellow-500'
  return 'bg-green-500'
}

function healthLabel(w: WebhookSubscription): string {
  if (w.status === 'DISABLED') return 'Disabled'
  if ((w.consecutive_failures ?? 0) >= 1) return 'Failing'
  return 'Healthy'
}

// Create webhook
const showCreate = ref(false)
const createLoading = ref(false)
const createError = ref('')
const createForm = ref({ url: '', name: '', event_types: [] as string[], tenant_id: '', scope_filter: '' })
const createdWebhook = ref<WebhookCreateResponse | null>(null)

function openCreate() {
  createForm.value = { url: '', name: '', event_types: [], tenant_id: '', scope_filter: '' }
  createError.value = ''
  showCreate.value = true
}

async function onSecretClose() {
  const subId = createdWebhook.value?.subscription?.subscription_id
  createdWebhook.value = null
  if (subId) router.push({ name: 'webhook-detail', params: { id: subId } })
  else await refresh()
}

async function submitCreate() {
  createError.value = ''
  if (!createForm.value.event_types.length) { createError.value = 'Select at least one event type'; return }
  createLoading.value = true
  try {
    const body: Record<string, unknown> = { url: createForm.value.url, event_types: createForm.value.event_types }
    if (createForm.value.name) body.name = createForm.value.name
    if (createForm.value.scope_filter) body.scope_filter = createForm.value.scope_filter
    const res = await createWebhook(body as any, createForm.value.tenant_id || undefined)
    createdWebhook.value = res
    showCreate.value = false
    toast.success('Webhook created')
  } catch (e) { createError.value = toMessage(e) }
  finally { createLoading.value = false }
}

// Pause/enable from list
const pendingStatusAction = ref<{ id: string; url: string; action: 'PAUSED' | 'ACTIVE' } | null>(null)

async function executeStatusAction() {
  if (!pendingStatusAction.value) return
  const { id, action } = pendingStatusAction.value
  try {
    await updateWebhook(id, { status: action })
    toast.success(action === 'PAUSED' ? 'Webhook paused' : 'Webhook enabled')
    await refresh()
  } catch (e) {
    const msg = toMessage(e)
    error.value = msg
    toast.error(`${action === 'PAUSED' ? 'Pause' : 'Enable'} failed: ${msg}`)
  }
  finally { pendingStatusAction.value = null }
}

// Webhook security config
const showSecurityConfig = ref(false)
const securityConfig = ref<WebhookSecurityConfig | null>(null)
const securityForm = ref({ blocked_cidr: '', allowed_patterns: '', allow_http: false })
const securityLoading = ref(false)
const securityError = ref('')

async function openSecurityConfig() {
  // Reset synchronously BEFORE the dialog appears. Otherwise the dialog
  // briefly shows the previous session's values during the GET round-trip,
  // and on a slow network the user might edit those stale values before
  // the real config arrives and clobbers them.
  securityError.value = ''
  securityConfig.value = null
  securityForm.value = { blocked_cidr: '', allowed_patterns: '', allow_http: false }
  securityLoading.value = true
  showSecurityConfig.value = true
  try {
    const cfg = await getWebhookSecurityConfig()
    securityConfig.value = cfg
    securityForm.value = {
      blocked_cidr: (cfg.blocked_cidr_ranges || []).join('\n'),
      allowed_patterns: (cfg.allowed_url_patterns || []).join('\n'),
      allow_http: cfg.allow_http || false,
    }
  } catch (e) { securityError.value = toMessage(e) }
  finally { securityLoading.value = false }
}

async function submitSecurityConfig() {
  securityError.value = ''
  securityLoading.value = true
  try {
    const body: WebhookSecurityConfig = {
      blocked_cidr_ranges: securityForm.value.blocked_cidr.split('\n').map(s => s.trim()).filter(Boolean),
      allowed_url_patterns: securityForm.value.allowed_patterns.split('\n').map(s => s.trim()).filter(Boolean),
      allow_http: securityForm.value.allow_http,
    }
    await updateWebhookSecurityConfig(body)
    showSecurityConfig.value = false
    toast.success('Webhook security config updated')
  } catch (e) { securityError.value = toMessage(e) }
  finally { securityLoading.value = false }
}

const { refresh, isLoading, lastUpdated } = usePolling(async () => {
  try {
    const [wRes, tRes] = await Promise.all([listWebhooks(withListParams()), listTenants()])
    webhooks.value = wRes.subscriptions
    hasMore.value = !!wRes.has_more
    nextCursor.value = wRes.next_cursor ?? ''
    tenants.value = tRes.tenants
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
}, 60000)

// Refetch page 1 whenever the debounced URL/search filter changes so
// the cursor stays aligned with the server's (sort_by, sort_dir,
// search) tuple. Same rationale as useSort's onChange — the opaque
// cursor is filter-scoped, so carrying it across a filter change
// would 400.
watch(debouncedUrlFilter, () => { refresh() })

async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return
  loadingMore.value = true
  try {
    const res = await listWebhooks(withListParams({ cursor: nextCursor.value }))
    webhooks.value = [...webhooks.value, ...res.subscriptions]
    hasMore.value = !!res.has_more
    nextCursor.value = res.next_cursor ?? ''
  } catch (e) { error.value = toMessage(e) }
  finally { loadingMore.value = false }
}

// Export. filterFn mirrors the tenant+URL client filters so the
// exported set matches what the operator sees on screen.
function webhookMatchesFilter(w: WebhookSubscription): boolean {
  if (tenantFilter.value && w.tenant_id !== tenantFilter.value) return false
  if (debouncedUrlFilter.value && !urlMatches(w, debouncedUrlFilter.value)) return false
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
} = useListExport<WebhookSubscription>({
  itemNoun: 'subscription',
  filenameStem: 'webhooks',
  currentItems: filteredWebhooks,
  hasMore,
  nextCursor,
  fetchPage: async (cursor) => {
    const res = await listWebhooks(withListParams({ cursor }))
    return { items: res.subscriptions, hasMore: !!res.has_more, nextCursor: res.next_cursor ?? '' }
  },
  filterFn: webhookMatchesFilter,
  columns: [
    { header: 'subscription_id',     value: w => w.subscription_id },
    { header: 'tenant_id',           value: w => w.tenant_id },
    { header: 'url',                 value: w => w.url },
    { header: 'name',                value: w => w.name ?? '' },
    { header: 'status',              value: w => w.status },
    { header: 'event_types',         value: w => (w.event_types ?? []).join('|') },
    { header: 'event_categories',    value: w => (w.event_categories ?? []).join('|') },
    { header: 'scope_filter',        value: w => w.scope_filter ?? '' },
    { header: 'consecutive_failures',value: w => w.consecutive_failures ?? 0 },
    { header: 'last_success_at',     value: w => w.last_success_at ?? '' },
    { header: 'last_failure_at',     value: w => w.last_failure_at ?? '' },
    { header: 'created_at',          value: w => w.created_at },
  ],
})

watch(exportError, (v) => { if (v) error.value = v })

// V1 virtualization. See ReservationsView.vue for the pattern.
const scrollEl = ref<HTMLElement | null>(null)
const ROW_HEIGHT_ESTIMATE = 52
const virtualizer = useVirtualizer(computed(() => ({
  count: sortedWebhooks.value.length,
  getScrollElement: () => scrollEl.value,
  estimateSize: () => ROW_HEIGHT_ESTIMATE,
  overscan: 8,
})))
const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalHeight = computed(() => virtualizer.value.getTotalSize())

// Columns: [checkbox 40] health 90 | URL flex | tenant flex | status 110 |
// failures 90 | events flex | action 96
// No Sort on Health / Events — they're plain <div role="columnheader">.
// Tenant column added so operators can see ownership without drilling
// into each webhook's detail view — system-wide subs render a badge,
// tenant-scoped subs render a TenantLink.
const gridTemplate = computed(() =>
  canManage.value
    ? '40px 90px minmax(220px,2fr) minmax(140px,1fr) 110px 90px minmax(160px,1.2fr) 96px'
    : '90px minmax(220px,2fr) minmax(140px,1fr) 110px 90px minmax(160px,1.2fr)',
)
</script>

<template>
  <!-- Phase 5 (table-layout unification): flex-fill so the table
       body grows with the viewport; no per-view calc(100vh - Npx). -->
  <div class="h-full flex flex-col min-h-0">
    <PageHeader
      title="Webhooks"
      item-noun="webhook"
      :loaded="filteredWebhooks.length"
      :has-more="hasMore"
      :loading="isLoading"
      :last-updated="lastUpdated"
      @refresh="refresh"
    >
      <template #actions>
        <button @click="confirmExport('csv')" :disabled="filteredWebhooks.length === 0" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          Export CSV
        </button>
        <button @click="confirmExport('json')" :disabled="filteredWebhooks.length === 0" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          Export JSON
        </button>
        <button v-if="canManage" @click="openSecurityConfig" class="btn-pill-secondary">Security Config</button>
        <button v-if="canManage" @click="openCreate" class="text-xs bg-blue-600 text-white hover:bg-blue-700 rounded px-3 py-1.5 cursor-pointer transition-colors">Create Webhook</button>
      </template>
    </PageHeader>
    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg table-cell mb-4">{{ error }}</p>

    <!-- Tenant + URL filters. Tenant options sourced from the loaded
         webhook set so the dropdown only lists tenants that actually
         have webhooks. URL filter supports substring ("example.com",
         "api") or glob wildcards ("*.internal"). Debounced 200ms —
         feels responsive but coalesces fast typing. Wrapped in card
         to match the toolbars in BudgetsView / EventsView / AuditView
         / ApiKeysView / TenantsView / ReservationsView. -->
    <div class="card p-4 mb-4">
      <div class="flex gap-3 flex-wrap items-center">
        <select v-model="tenantFilter" aria-label="Filter webhooks by tenant" class="form-select">
          <option value="">All webhooks</option>
          <option
            v-if="webhooks.some(isSystemWebhook)"
            :value="SYSTEM_TENANT_ID"
          >System-wide only</option>
          <option
            v-for="t in tenants.filter(t => webhooks.some(w => w.tenant_id === t.tenant_id && !isSystemWebhook(w)))"
            :key="t.tenant_id"
            :value="t.tenant_id"
          >{{ t.name || t.tenant_id }}</option>
        </select>
        <input
          v-model="urlFilter"
          type="search"
          placeholder="Filter by URL or name (supports * wildcards)"
          aria-label="Filter webhooks by URL"
          class="border border-gray-300 rounded px-3 py-1.5 text-sm w-72"
        />
        <select v-model="statusFilter" aria-label="Filter webhooks by status" class="form-select">
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="PAUSED">Paused</option>
          <option value="DISABLED">Disabled</option>
        </select>
        <label class="text-sm flex items-center gap-1.5 text-gray-700 dark:text-gray-200 whitespace-nowrap">
          <input v-model="failingFilter" type="checkbox" aria-label="Show only failing webhooks" />
          Failing only
        </label>
        <!-- Filter-apply bulk actions (see TenantsView for rationale).
             Appears when a filter is set AND no row-select is active.
             Disabled for SYSTEM_TENANT_ID (no server equivalent) and
             for wildcard url-filters (server uses literal substring).
             Grouped in inline-flex so label + buttons wrap together
             on narrow viewports. -->
        <div
          v-if="canManage && (tenantFilter || debouncedUrlFilter.trim() || statusFilter || failingFilter) && selectedVisibleCount === 0"
          role="group"
          aria-label="Apply action to all webhooks matching the current filter"
          class="inline-flex items-center gap-2 flex-wrap"
        >
          <div class="w-px h-5 bg-gray-200 dark:bg-gray-700" aria-hidden="true"></div>
          <span class="muted-sm whitespace-nowrap">Apply to all matching filter:</span>
          <button
            @click="openFilterBulk('PAUSE')"
            :disabled="!canApplyWebhookFilterBulk() || filterBulkRunning"
            class="text-xs text-red-700 dark:text-red-300 hover:text-red-900 dark:hover:text-red-200 border border-red-300 dark:border-red-700 bg-white dark:bg-gray-800 rounded px-2.5 py-1 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            :title="canApplyWebhookFilterBulk() ? 'Pause all ACTIVE webhooks matching filter' : 'System-wide or wildcard filter is not supported by server bulk-action'"
          >Pause all</button>
          <button
            @click="openFilterBulk('RESUME')"
            :disabled="!canApplyWebhookFilterBulk() || filterBulkRunning"
            class="text-xs text-green-700 dark:text-green-300 hover:text-green-900 dark:hover:text-green-200 border border-green-300 dark:border-green-700 bg-white dark:bg-gray-800 rounded px-2.5 py-1 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            :title="canApplyWebhookFilterBulk() ? 'Resume all PAUSED webhooks matching filter' : 'System-wide or wildcard filter is not supported by server bulk-action'"
          >Resume all</button>
        </div>
      </div>
    </div>

    <!-- Floating bulk action bar — same pattern as TenantsView.
         Top-anchored for F-pattern visibility. -->
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
          aria-label="Bulk webhook actions"
          class="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-white dark:bg-gray-900 dark:border dark:border-gray-700 border-2 border-blue-400 shadow-2xl rounded-lg px-4 py-2.5 flex items-center gap-3 max-w-[90vw]"
        >
          <span class="text-sm font-semibold text-blue-900 dark:text-blue-300 tabular-nums">{{ selectedVisibleCount }} selected</span>
          <div class="w-px h-5 bg-gray-200 dark:bg-gray-700" aria-hidden="true"></div>
          <button @click="openBulk('PAUSED')" class="text-xs text-red-700 hover:text-red-900 border border-red-300 bg-white rounded px-2.5 py-1 cursor-pointer">Pause</button>
          <button @click="openBulk('ACTIVE')" class="text-xs text-green-700 hover:text-green-900 border border-green-300 bg-white rounded px-2.5 py-1 cursor-pointer">Enable</button>
          <button
            @click="selected = new Set()"
            aria-label="Clear selection"
            class="muted hover:text-gray-700 cursor-pointer p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      </Transition>
    </Teleport>

    <!-- V1 virtualized grid. Shell flex-fills within the page's flex-col.
         overflow-x-auto + overflow-y-hidden pattern (same as AuditView /
         ApiKeysView): horizontal scroll is owned by the card so sticky
         header + virtual rows scroll together at narrow viewports, and
         the inner scroll body only handles vertical. Both axes pinned
         explicitly — the CSS spec auto-promotes the opposite axis from
         visible to auto when one axis is non-visible, which previously
         created a page-level horizontal scrollbar below "Load more"
         when the grid's min-content (≈946px) exceeded <main> width. -->
    <div
      class="bg-white rounded-lg shadow overflow-x-auto overflow-y-hidden text-sm flex-1 min-h-0 flex flex-col"
      role="table"
      :aria-rowcount="filteredWebhooks.length + 1"
      :aria-colcount="canManage ? 7 : 5"
    >
      <div role="rowgroup" class="table-header border-b border-gray-200 sticky top-0 z-10">
        <div role="row" class="grid text-xs font-bold uppercase tracking-wider" :style="{ gridTemplateColumns: gridTemplate }">
          <div v-if="canManage" role="columnheader" class="table-cell">
            <input type="checkbox" :checked="selectedVisibleAll" @change="toggleSelectAll" aria-label="Select all visible webhooks" />
          </div>
          <div role="columnheader" class="table-cell text-left">Health</div>
          <SortHeader as="div" label="URL" column="url" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Tenant" column="tenant_id" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Status" column="status" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Failures" column="consecutive_failures" :active-column="sortKey" :direction="sortDir" @sort="toggle" align="right" />
          <div role="columnheader" class="table-cell text-left">Events</div>
          <div v-if="canManage" role="columnheader" class="table-cell" data-column="action"></div>
        </div>
      </div>

      <div
        v-if="sortedWebhooks.length > 0"
        ref="scrollEl"
        role="rowgroup"
        class="flex-1 overflow-y-auto overflow-x-hidden min-h-[200px]"
      >
        <div role="presentation" :style="{ height: totalHeight + 'px', position: 'relative' }">
          <div
            v-for="v in virtualRows"
            :key="sortedWebhooks[v.index].subscription_id"
            role="row"
            :aria-rowindex="v.index + 2"
            class="grid table-row-hover border-b border-gray-100 absolute left-0 right-0 items-center"
            :style="{ gridTemplateColumns: gridTemplate, transform: `translateY(${v.start}px)`, height: ROW_HEIGHT_ESTIMATE + 'px' }"
          >
            <div v-if="canManage" role="cell" class="table-cell">
              <input type="checkbox" :checked="selected.has(sortedWebhooks[v.index].subscription_id)" @change="toggleSelect(sortedWebhooks[v.index].subscription_id)" :aria-label="`Select webhook ${sortedWebhooks[v.index].name || sortedWebhooks[v.index].url}`" />
            </div>
            <div role="cell" class="table-cell"><span :class="healthColor(sortedWebhooks[v.index])" class="inline-block w-2.5 h-2.5 rounded-full" :title="healthLabel(sortedWebhooks[v.index])" /></div>
            <div role="cell" class="table-cell min-w-0">
              <router-link :to="{ name: 'webhook-detail', params: { id: sortedWebhooks[v.index].subscription_id } }" class="text-blue-600 hover:underline truncate block" :title="sortedWebhooks[v.index].url">{{ sortedWebhooks[v.index].url }}</router-link>
              <span v-if="sortedWebhooks[v.index].name" class="muted-sm truncate block" :title="sortedWebhooks[v.index].name">{{ sortedWebhooks[v.index].name }}</span>
            </div>
            <div role="cell" class="table-cell min-w-0">
              <span
                v-if="isSystemWebhook(sortedWebhooks[v.index])"
                class="inline-flex items-center bg-gray-100 text-gray-600 text-xs px-1.5 py-0.5 rounded"
                title="Subscription with no tenant scope — delivers for every tenant"
              >System-wide</span>
              <TenantLink v-else :tenant-id="sortedWebhooks[v.index].tenant_id" @click.stop />
            </div>
            <div role="cell" class="table-cell"><StatusBadge :status="sortedWebhooks[v.index].status" /></div>
            <div role="cell" class="table-cell text-right tabular-nums" :class="(sortedWebhooks[v.index].consecutive_failures ?? 0) > 0 ? 'text-red-600 font-medium' : 'muted'">{{ sortedWebhooks[v.index].consecutive_failures ?? 0 }}</div>
            <div
              role="cell"
              class="table-cell muted-sm truncate"
              :title="sortedWebhooks[v.index].event_types?.join(', ') || sortedWebhooks[v.index].event_categories?.join(', ') || 'all events'"
            >{{ sortedWebhooks[v.index].event_types?.join(', ') || sortedWebhooks[v.index].event_categories?.join(', ') || 'all' }}</div>
            <div v-if="canManage" role="cell" class="table-cell">
              <RowActionsMenu
                :aria-label="`Actions for webhook ${sortedWebhooks[v.index].name || sortedWebhooks[v.index].url}`"
                :items="[
                  { label: 'Activity', to: { name: 'audit', query: { resource_type: 'webhook', resource_id: sortedWebhooks[v.index].subscription_id } } },
                  { label: 'Edit', to: { name: 'webhook-detail', params: { id: sortedWebhooks[v.index].subscription_id }, query: { action: 'edit' } } },
                  { label: 'Enable', onClick: () => pendingStatusAction = { id: sortedWebhooks[v.index].subscription_id, url: sortedWebhooks[v.index].url, action: 'ACTIVE' }, hidden: sortedWebhooks[v.index].status !== 'PAUSED' && sortedWebhooks[v.index].status !== 'DISABLED' },
                  { separator: true },
                  { label: 'Pause', onClick: () => pendingStatusAction = { id: sortedWebhooks[v.index].subscription_id, url: sortedWebhooks[v.index].url, action: 'PAUSED' }, danger: true, hidden: sortedWebhooks[v.index].status !== 'ACTIVE' },
                ]"
              />
            </div>
          </div>
        </div>
      </div>

      <div v-else>
        <EmptyState
          item-noun="webhook"
          :has-active-filter="!!(tenantFilter || statusFilter || failingFilter || debouncedUrlFilter.trim())"
          :hint="tenantFilter || statusFilter || failingFilter || debouncedUrlFilter.trim() ? undefined : 'Webhooks will appear here once configured'"
        />
      </div>
    </div>

    <!-- R6: server-side cursor pagination. Tenant filter runs
         client-side on the loaded set — Load more if a specific
         tenant's subs are on a later page. Polling refreshes page 1
         every 60s (same trade-off documented in TenantsView / Reservations). -->
    <div v-if="hasMore || loadingMore" class="mt-3 flex items-center justify-between">
      <p class="muted-sm">
        Showing {{ webhooks.length.toLocaleString() }} loaded subscription{{ webhooks.length === 1 ? '' : 's' }}.
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

    <ConfirmAction
      v-if="pendingStatusAction"
      :title="pendingStatusAction.action === 'PAUSED' ? 'Pause this webhook?' : 'Enable this webhook?'"
      :message="pendingStatusAction.action === 'PAUSED'
        ? `Pausing will stop all event deliveries to '${pendingStatusAction.url}'. Events will be silently dropped.`
        : `Enabling will resume event deliveries to '${pendingStatusAction.url}'.`"
      :confirm-label="pendingStatusAction.action === 'PAUSED' ? 'Pause' : 'Enable'"
      :danger="pendingStatusAction.action === 'PAUSED'"
      @confirm="executeStatusAction"
      @cancel="pendingStatusAction = null"
    />

    <!-- Bulk confirm (#5). DISABLED webhooks are excluded server-side from
         the loop because reactivating them should be an explicit per-row
         decision (the URL is likely still broken). -->
    <ConfirmAction
      v-if="bulkAction"
      :title="bulkAction === 'PAUSED'
        ? `Pause ${bulkRunning ? bulkProgress.total : selectedVisibleCount} webhooks?`
        : `Enable ${bulkRunning ? bulkProgress.total : selectedVisibleCount} webhooks?`"
      :message="bulkRunning
        ? `Working… ${bulkProgress.done}/${bulkProgress.total} processed${bulkProgress.failed ? ` (${bulkProgress.failed} failed)` : ''}.`
        : bulkAction === 'PAUSED'
          ? `Pauses each selected subscription. Events to paused endpoints are dropped. Webhooks already PAUSED or DISABLED are skipped.`
          : `Re-enables each selected subscription. Webhooks already ACTIVE are skipped. DISABLED webhooks (auto-disabled after failures) must be re-enabled individually so you can verify the endpoint is healthy first.`"
      :confirm-label="bulkRunning ? 'Working…' : bulkAction === 'PAUSED' ? 'Pause all' : 'Enable all'"
      :danger="bulkAction === 'PAUSED'"
      :loading="bulkRunning"
      @confirm="executeBulk"
      @cancel="cancelBulk"
    />

    <!-- O1: filter-apply preview. See TenantsView for the full pattern
         rationale. DISABLED subscriptions (auto-disabled after failures)
         are filtered out by the action's status predicate (PAUSE wants
         ACTIVE, RESUME wants PAUSED) — verify-then-enable stays per-row. -->
    <BulkActionPreviewDialog
      v-if="filterBulkAction"
      :action-verb="filterBulkAction === 'PAUSE' ? 'Pause' : 'Resume'"
      item-noun-plural="webhooks"
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
      :confirm-danger="filterBulkAction === 'PAUSE'"
      @confirm="executeFilterBulk"
      @cancel="cancelFilterBulk"
    />

    <!-- Per-row result dialog (see TenantsView for rationale). -->
    <BulkActionResultDialog
      v-if="bulkResult"
      :action-verb="bulkResult.actionVerb"
      item-noun-plural="webhooks"
      :response="bulkResult.response"
      @close="bulkResult = null"
    />

    <FormDialog v-if="showCreate" title="Create Webhook" submit-label="Create Webhook" :loading="createLoading" :error="createError" @submit="submitCreate" @cancel="showCreate = false" :wide="true">
      <div>
        <label for="cw-url" class="form-label">URL</label>
        <input id="cw-url" v-model="createForm.url" type="url" required class="form-input-mono" placeholder="https://example.com/webhooks" />
      </div>
      <div>
        <label for="cw-name" class="form-label">Name (optional)</label>
        <input id="cw-name" v-model="createForm.name" class="form-input" placeholder="Production alerts" />
      </div>
      <div>
        <label for="cw-tenant" class="form-label">Tenant (optional — omit for system-wide)</label>
        <select id="cw-tenant" v-model="createForm.tenant_id" class="form-select w-full">
          <option value="">System-wide</option>
          <option v-for="t in tenants" :key="t.tenant_id" :value="t.tenant_id">{{ t.name || t.tenant_id }}</option>
        </select>
      </div>
      <div>
        <label class="form-label">Event types</label>
        <div class="grid grid-cols-2 gap-1 max-h-48 overflow-y-auto border border-gray-200 rounded p-2">
          <label v-for="et in EVENT_TYPES" :key="et" class="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" :value="et" v-model="createForm.event_types" class="rounded" />
            {{ et }}
          </label>
        </div>
      </div>
      <div>
        <label for="cw-scope" class="form-label">Scope filter (optional)</label>
        <input id="cw-scope" v-model="createForm.scope_filter" class="form-input-mono" placeholder="tenant:acme/*" />
      </div>
    </FormDialog>

    <SecretReveal
      v-if="createdWebhook?.signing_secret"
      title="Webhook Created"
      :secret="createdWebhook.signing_secret"
      label="Signing Secret"
      @close="onSecretClose"
    />

    <!-- Webhook security config dialog -->
    <FormDialog v-if="showSecurityConfig" title="Webhook Security Config" submit-label="Save Config" :loading="securityLoading" :error="securityError" @submit="submitSecurityConfig" @cancel="showSecurityConfig = false">
      <p class="muted-sm">Server-level security rules applied to all webhook create/update operations. Changes take effect immediately. Existing subscriptions are not retroactively validated.</p>
      <div>
        <label for="sc-cidr" class="form-label">Blocked CIDR ranges (one per line)</label>
        <textarea id="sc-cidr" v-model="securityForm.blocked_cidr" rows="4" class="form-input-mono" placeholder="10.0.0.0/8&#10;172.16.0.0/12&#10;192.168.0.0/16" />
        <p class="muted-sm mt-0.5">Webhook URLs resolving to these ranges will be blocked (SSRF protection)</p>
      </div>
      <div>
        <label for="sc-patterns" class="form-label">Allowed URL patterns (one per line, glob syntax)</label>
        <textarea id="sc-patterns" v-model="securityForm.allowed_patterns" rows="3" class="form-input-mono" placeholder="https://*.example.com/*" />
        <p class="muted-sm mt-0.5">If non-empty, only URLs matching at least one pattern are allowed</p>
      </div>
      <label class="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
        <input v-model="securityForm.allow_http" type="checkbox" class="rounded" />
        Allow HTTP (non-HTTPS) webhook URLs
      </label>
    </FormDialog>

    <ExportDialog
      :format="showExportConfirm"
      :loaded-count="filteredWebhooks.length"
      :has-more="hasMore"
      :max-rows="EXPORT_MAX_ROWS"
      item-noun-plural="webhooks"
      warning="Exported files include tenant IDs and endpoint URLs. Signing secrets are never exported."
      @confirm="executeExport"
      @cancel="cancelExport"
    />
    <ExportProgressOverlay
      :open="exporting"
      :fetched="exportFetched"
      :cancellable="exportCancellable"
      item-noun-plural="webhooks"
      @cancel="cancelRunningExport"
    />
  </div>
</template>

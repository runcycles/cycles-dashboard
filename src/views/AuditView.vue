<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useRoute } from 'vue-router'
import { listAuditLogs } from '../api/client'
import { useSort } from '../composables/useSort'
import { useListExport } from '../composables/useListExport'
import { ERROR_CODES } from '../types'
import type { AuditLogEntry } from '../types'
import PageHeader from '../components/PageHeader.vue'
import CopyJsonIcon from '../components/icons/CopyJsonIcon.vue'
import DownloadIcon from '../components/icons/DownloadIcon.vue'
import ChevronRightIcon from '../components/icons/ChevronRightIcon.vue'
import MaskedValue from '../components/MaskedValue.vue'
import TenantLink from '../components/TenantLink.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import LoadingSkeleton from '../components/LoadingSkeleton.vue'
import InlineErrorBanner from '../components/InlineErrorBanner.vue'
import ExportDialog from '../components/ExportDialog.vue'
import ExportProgressOverlay from '../components/ExportProgressOverlay.vue'
import TimeRangePicker from '../components/TimeRangePicker.vue'
import BulkActionAuditDetail from '../components/BulkActionAuditDetail.vue'
import CorrelationIdChip from '../components/CorrelationIdChip.vue'
import { formatDateTime } from '../utils/format'
import { toMessage } from '../utils/errors'
import { safeJsonStringify } from '../utils/safe'
import { hasBulkAuditShape } from '../utils/auditMetadata'

const entries = ref<AuditLogEntry[]>([])
const error = ref('')
const loading = ref(false)
// Multi-row expansion — compliance reviewers compare audit entries
// side-by-side (e.g. before/after of a permission change, two PATCHes
// on the same key), so keeping multiple rows open at once is the more
// useful default. Pre-fix, opening row B auto-collapsed row A.
const expanded = ref(new Set<string>())
function toggleExpanded(id: string) {
  if (expanded.value.has(id)) expanded.value.delete(id)
  else expanded.value.add(id)
}

// Copy the full audit entry as JSON. Row-level triage affordance —
// metadata carries per-row bulk outcomes (succeeded/failed/skipped
// arrays for bulk-action calls) that aren't reachable from any
// search filter; copying the whole entry is the cleanest way to
// pull that payload into a ticket or pipe through jq.
const copiedLogId = ref<string | null>(null)
let copiedResetTimer: ReturnType<typeof setTimeout> | null = null
async function copyLogJson(entry: AuditLogEntry) {
  try {
    await navigator.clipboard.writeText(safeJsonStringify(entry))
    copiedLogId.value = entry.log_id
    if (copiedResetTimer) clearTimeout(copiedResetTimer)
    copiedResetTimer = setTimeout(() => {
      if (copiedLogId.value === entry.log_id) copiedLogId.value = null
    }, 2000)
  } catch {
    // Clipboard permission denied or insecure context — silently
    // fail rather than toast. The operator can still select-and-copy
    // from the metadata pre element.
  }
}
// V4 stage 2: server-side sort. Columns (timestamp, operation,
// resource_type, tenant_id, key_id, status) map directly onto the
// listAuditLogs sort_by enum. onChange re-runs query() which resets
// the cursor — reusing the old cursor under a different sort would
// return 400 CURSOR_SORT_MISMATCH.
const { sortKey, sortDir, toggle, sorted: sortedEntries } = useSort(
  entries,
  undefined,
  'asc',
  undefined,
  { serverSide: true, onChange: () => { query() } },
)

// Pagination state. query() loads page 1; hasMore signals that the
// export flow must paginate through the server's cursor to avoid
// silently shipping incomplete compliance data (audit item R3).
const hasMore = ref(false)
const nextCursor = ref('')

const tenantId = ref('')
const keyId = ref('')
// cycles-governance-admin v0.1.25.24: `operation` and `resource_type`
// promoted from scalar to array<string> (explode=false, maxItems 25).
// Accepts comma-separated input in the form; buildFilterParams runs the
// same normalizer as error_code (trim/split/drop-empties/dedupe). Server
// still accepts a one-element list, so single-token input is wire-
// compatible with the pre-v0.1.25.24 scalar shape.
const operation = ref('')
const resourceType = ref('')
const resourceId = ref('')
// Known resource types for resource_type datalist typeahead. Matches
// the six values the pre-v0.1.25.24 <select> offered. Kept in-file
// rather than importing from types.ts because the spec doesn't enum
// this field — servers may add new resource types without a spec
// bump, and the datalist is a hint, not a whitelist.
const KNOWN_RESOURCE_TYPES = ['tenant', 'budget', 'api_key', 'policy', 'webhook', 'config'] as const
// cycles-governance-admin v0.1.25.21: free-text `search` query param
// on listAuditLogs. Starting v0.1.25.24 the server-side match set
// extends to resource_id OR log_id OR error_code OR operation (case-
// insensitive substring) — closes the gap where `?search=budget`
// missed BUDGET_EXCEEDED and createBudget. Form-submit rather than
// debounced because this view uses explicit-submit for its whole
// filter surface.
const search = ref('')
// cycles-governance-admin v0.1.25.24: IN-list on AuditLogEntry.error_code.
// The field is a comma-separated string in the form; buildFilterParams
// normalizes (trim, split, drop empties) and passes through as a single
// comma-joined value for the explode=false wire format.
const errorCode = ref('')
// cycles-governance-admin v0.1.25.24: NOT-IN-list (error_code_exclude).
// Auditors use this to hide noisy codes (e.g. expected TIMEOUTs) while
// keeping all other rows — including successes. Per spec, NULL entry
// error_code MUST always pass this predicate, so adding an exclude list
// never silently hides success rows.
const errorCodeExclude = ref('')
// cycles-server-admin v0.1.25.31 / protocol v0.1.25.28: W3C Trace Context
// cross-surface correlation. `trace_id` (32-hex) + `request_id` are exact-
// match filters on listAuditLogs. Deep-link supported via applyQueryParams.
const traceId = ref('')
const requestId = ref('')
// Shared comma/whitespace-separated list normalizer for the four array
// filters (error_code, error_code_exclude, operation, resource_type).
// Trim each token, drop empties, dedupe preserving first-occurrence
// order. Returns a comma-joined string ready for the explode=false
// wire format. Empty input → empty string → caller omits the param.
function normalizeList(raw: string): string {
  const tokens = raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
  return Array.from(new Set(tokens)).join(',')
}
// cycles-governance-admin v0.1.25.24: status_min/status_max range filter.
// Dashboard exposes five preset bands rather than raw min/max inputs —
// operators rarely care about specific HTTP statuses, they want either
// "just errors" / "just successes" / a class. Mutex with exact `status`
// is sidestepped entirely because the dashboard never sends exact status.
const statusBand = ref<'' | 'success' | 'errors' | '4xx' | '5xx'>('')
// Five preset bands rendered as a segmented chip control. Order matches
// triage flow: All → 2xx (clear) → 4xx+5xx (quick "all errors") → 4xx /
// 5xx (split for client-vs-server triage). Labels stay short so the
// whole strip fits on one line above 1024px.
const STATUS_BANDS: { value: typeof statusBand.value; label: string }[] = [
  { value: '',        label: 'All' },
  { value: 'success', label: '2xx' },
  { value: 'errors',  label: '4xx+5xx' },
  { value: '4xx',     label: '4xx' },
  { value: '5xx',     label: '5xx' },
]
const fromDate = ref('')
const toDate = ref('')
// TimeRangePicker wants a { from, to } object as v-model. Use a
// computed passthrough over the existing fromDate / toDate refs so
// buildFilterParams / applyQueryParams / URL wiring stay untouched.
const timeRange = computed({
  get: () => ({ from: fromDate.value, to: toDate.value }),
  set: (v: { from: string; to: string }) => { fromDate.value = v.from; toDate.value = v.to },
})

// Pulls the non-cursor filter params out of the form. Shared between
// query() and the export loop so both see identical filter semantics —
// a drift here would produce exports that don't match what the operator
// sees on screen.
function buildFilterParams(): Record<string, string> {
  const params: Record<string, string> = {}
  if (tenantId.value) params.tenant_id = tenantId.value
  if (keyId.value) params.key_id = keyId.value
  // operation + resource_type: v0.1.25.24 array<string> with explode=false.
  // Share the comma-sep normalizer with error_code / error_code_exclude so
  // all four array filters have identical token semantics.
  const ops = normalizeList(operation.value)
  if (ops) params.operation = ops
  const resTypes = normalizeList(resourceType.value)
  if (resTypes) params.resource_type = resTypes
  if (resourceId.value) params.resource_id = resourceId.value
  const codes = normalizeList(errorCode.value)
  if (codes) params.error_code = codes
  const excludes = normalizeList(errorCodeExclude.value)
  if (excludes) params.error_code_exclude = excludes
  if (traceId.value) params.trace_id = traceId.value
  if (requestId.value) params.request_id = requestId.value
  // Status band → status_min / status_max pair.
  if (statusBand.value) {
    const range: Record<string, [number, number]> = {
      success: [200, 299],
      errors:  [400, 599],
      '4xx':   [400, 499],
      '5xx':   [500, 599],
    }
    const r = range[statusBand.value]
    if (r) { params.status_min = String(r[0]); params.status_max = String(r[1]) }
  }
  // Trim before sending — a search of spaces is semantically empty on
  // the server (case-insensitive substring ILIKE), and the spec
  // requires empty → absent.
  const q = search.value.trim()
  if (q) params.search = q
  if (fromDate.value) params.from = new Date(fromDate.value).toISOString()
  if (toDate.value) params.to = new Date(toDate.value).toISOString()
  if (sortKey.value) {
    params.sort_by = sortKey.value
    params.sort_dir = sortDir.value
  }
  return params
}

// Shared export machinery (useListExport). Column spec + fetchPage
// adapter + item noun is all that's view-specific.
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
} = useListExport<AuditLogEntry>({
  itemNoun: 'log entry',
  filenameStem: 'audit-logs',
  currentItems: entries,
  hasMore,
  nextCursor,
  fetchPage: async (cursor) => {
    const res = await listAuditLogs({ ...buildFilterParams(), cursor })
    return { items: res.logs, hasMore: !!res.has_more, nextCursor: res.next_cursor ?? '' }
  },
  columns: [
    { header: 'timestamp',     value: e => e.timestamp },
    { header: 'operation',     value: e => e.operation },
    { header: 'resource_type', value: e => e.resource_type },
    { header: 'resource_id',   value: e => e.resource_id },
    { header: 'tenant_id',     value: e => e.tenant_id },
    { header: 'key_id',        value: e => e.key_id },
    { header: 'status',        value: e => e.status },
    { header: 'error_code',    value: e => e.error_code },
    { header: 'request_id',    value: e => e.request_id },
    { header: 'trace_id',      value: e => e.trace_id ?? '' },
    { header: 'source_ip',     value: e => e.source_ip },
    { header: 'user_agent',    value: e => e.user_agent },
    { header: 'metadata',      value: e => e.metadata ? safeJsonStringify(e.metadata, 0) : '' },
  ],
})

// Surface export-composable errors through the view's existing error banner.
watch(exportError, (v) => { if (v) error.value = v })

async function query() {
  loading.value = true
  try {
    const res = await listAuditLogs(buildFilterParams())
    entries.value = res.logs
    hasMore.value = !!res.has_more
    nextCursor.value = res.next_cursor ?? ''
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
  finally { loading.value = false }
}

// Load-more: append the next cursor page to the visible list. Separate
// from the Export flow (which paginates silently through all pages into
// a Blob) — operators sometimes want to *scan* past page 1 on screen,
// not only export. Same append pattern as EventsView / TenantsView.
const loadingMore = ref(false)
async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return
  loadingMore.value = true
  try {
    const params = { ...buildFilterParams(), cursor: nextCursor.value }
    const res = await listAuditLogs(params)
    entries.value = [...entries.value, ...res.logs]
    hasMore.value = !!res.has_more
    nextCursor.value = res.next_cursor ?? ''
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
  finally { loadingMore.value = false }
}

// Every audit entry carries a log_id (the compliance-grade identifier
// that the search filter explicitly covers). Since the expand block
// surfaces log_id, every row is expandable — no conditional gate.
function hasDetail(_e: AuditLogEntry): boolean {
  return true
}

// v0.1.25.21 (#8): accept audit drill-down params from the URL. Lets
// "View activity" links from API key / tenant rows pre-fill the
// filters and auto-run the query, so ops doesn't have to copy-paste
// the key_id / tenant_id into the form.
const route = useRoute()
function applyQueryParams() {
  if (route.query.tenant_id) tenantId.value = String(route.query.tenant_id)
  if (route.query.key_id) keyId.value = String(route.query.key_id)
  if (route.query.operation) operation.value = String(route.query.operation)
  if (route.query.resource_type) resourceType.value = String(route.query.resource_type)
  if (route.query.resource_id) resourceId.value = String(route.query.resource_id)
  if (route.query.search) search.value = String(route.query.search)
  // v0.1.25.24: deep-links can pre-fill error_code / error_code_exclude
  // (both comma-lists) and status band. Used by OverviewView's Recent
  // Denials pill → /audit?error_code=X.
  if (route.query.error_code) errorCode.value = String(route.query.error_code)
  if (route.query.error_code_exclude) errorCodeExclude.value = String(route.query.error_code_exclude)
  // v0.1.25.39: trace_id + request_id deep-link. CorrelationIdChip pivots
  // from EventsView / WebhookDetailView land here via these params.
  traceId.value = route.query.trace_id ? String(route.query.trace_id) : ''
  requestId.value = route.query.request_id ? String(route.query.request_id) : ''
  const sb = route.query.status_band
  if (sb === 'success' || sb === 'errors' || sb === '4xx' || sb === '5xx') statusBand.value = sb
}
onMounted(() => {
  applyQueryParams()
  query()
})
// Watch in-place query changes too — same-route navigation (e.g. clicking
// an Activity link from a sidebar that's already on AuditView) won't
// remount the component, so the onMounted hook wouldn't fire. Without
// this watch, the URL would update but the form would stay on the
// previous filter values.
watch(() => route.query, () => {
  applyQueryParams()
  query()
})

// V1 virtualization (Phase 2c) — variable row heights via measureElement.
// Same pattern as EventsView: each virtualized item wraps the compact
// row plus (when expanded) the metadata + JSON detail block.
const scrollEl = ref<HTMLElement | null>(null)
const COLLAPSED_ROW_HEIGHT = 52
const virtualizer = useVirtualizer(computed(() => ({
  count: sortedEntries.value.length,
  getScrollElement: () => scrollEl.value,
  estimateSize: () => COLLAPSED_ROW_HEIGHT,
  overscan: 8,
  getItemKey: (index: number) => sortedEntries.value[index]?.log_id ?? index,
})))
const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalHeight = computed(() => virtualizer.value.getTotalSize())

// 7 columns: chevron (32) | time (160) | operation (flex) | resource (flex)
// | tenant (130) | key_id (150) | status (160). Status was 110px pre-fix
// but status + error_code ("401 UNAUTHORIZED") overflowed the track and
// forced the inner wrapper past its 950px min-width — the operator saw
// an extra horizontal scrollbar at certain viewport widths. 160px fits
// a 3-digit status + the longest canonical error_code comfortably, and
// the cell itself now clips with min-w-0 overflow-hidden as a belt-and-
// suspenders guard against any future error_code that still overflows.
const gridTemplate = 'minmax(32px,32px) 160px minmax(140px,1.5fr) minmax(180px,2fr) minmax(130px,1fr) 150px 160px'

function measureRow(el: Element | { $el?: Element } | null) {
  const node = (el as { $el?: Element })?.$el ?? (el as Element | null)
  if (node instanceof Element && virtualizer.value) {
    virtualizer.value.measureElement(node)
  }
}
</script>

<template>
  <!-- Phase 5 (table-layout unification): flex-fill root. Audit was
       the worst offender pre-fix — the outer shell's overflow-x-auto
       combined with <main>'s overflow-auto produced a double
       horizontal scrollbar on viewports < 900px. Now <main> is
       overflow-y-auto only; horizontal scroll lives on the shell so
       there's exactly one bar, localized to the table. -->
  <div class="h-full flex flex-col min-h-0">
    <PageHeader
      title="Audit Logs"
      item-noun="log entry"
      item-noun-plural="log entries"
      :loaded="entries.length"
      :has-more="hasMore"
    >
      <template #actions>
        <button @click="confirmExport('csv')" :disabled="loading || entries.length === 0" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 dark:hover:text-gray-200 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed">
          <DownloadIcon class="w-3.5 h-3.5" />
          Export CSV
        </button>
        <button @click="confirmExport('json')" :disabled="loading || entries.length === 0" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 dark:hover:text-gray-200 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed">
          <DownloadIcon class="w-3.5 h-3.5" />
          Export JSON
        </button>
      </template>
    </PageHeader>

    <InlineErrorBanner v-if="error" :message="error" @dismiss="error = ''" />

    <!-- Filter form: three 6-col rows at xl+, stacks to 2 cols below.
         Pre-v0.1.25.39 this was two rows, but adding Trace ID + Request
         ID pushed row 2 to 7 inputs + a span-2 Status cell (= 9 col-
         units into 6) which wrapped messily on resize. Splitting into
         three balanced rows of 6 lets the grid stay rigid at xl+ and
         stack cleanly to 2 cols below the breakpoint, eliminating the
         mid-width jitter entirely.
           Row 1 (xl, 6 cols): broad filters + when / who
             Search [span 2] | Time range | Tenant | Key | Resource Type
           Row 2 (xl, 6 cols): exact-match lookup — resource + ids + codes
             Resource ID | Operation | Error Code | Exclude codes | Trace ID | Request ID
           Row 3 (xl, 6 cols): outcome + submit
             Status [span 4] | Run Query [span 2, ml-auto] -->
    <form @submit.prevent="query" class="card p-4 mb-4 space-y-3">
      <!-- Row 1: broad filters + when / who -->
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-3 items-end">
        <div class="xl:col-span-2">
          <label for="audit-search" class="form-label">Search</label>
          <input id="audit-search" v-model="search" type="search" class="form-input" placeholder="resource_id, log_id, error_code, operation" aria-label="Free-text substring search across resource_id, log_id, error_code, and operation" />
        </div>
        <div>
          <label for="audit-time-range" class="form-label">Time range</label>
          <TimeRangePicker
            id="audit-time-range"
            v-model="timeRange"
            aria-label="Audit log time range"
          />
        </div>
        <div>
          <label for="audit-tenant" class="form-label">Tenant ID</label>
          <input id="audit-tenant" v-model="tenantId" class="form-input" placeholder="acme" />
        </div>
        <div>
          <label for="audit-key" class="form-label">Key ID</label>
          <input id="audit-key" v-model="keyId" class="form-input" placeholder="key_..." />
        </div>
        <div>
          <label for="audit-resource" class="form-label">Resource Type</label>
          <input
            id="audit-resource"
            v-model="resourceType"
            list="audit-resource-type-options"
            class="form-input"
            placeholder="tenant, budget"
            aria-label="Filter by resource_type. Comma-separated for IN-list (e.g. tenant, budget)."
          />
          <datalist id="audit-resource-type-options">
            <option v-for="r in KNOWN_RESOURCE_TYPES" :key="r" :value="r" />
          </datalist>
        </div>
      </div>

      <!-- Row 2: exact-match lookup filters. Six equal cols at xl+.
           Trace ID + Request ID use form-input-mono so the font-mono
           rendering of hex ids matches form-input's text-sm height
           (plain `font-mono text-xs` made the box visibly shorter
           than its siblings). -->
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-3 items-end">
        <div>
          <label for="audit-resource-id" class="form-label">Resource ID</label>
          <input id="audit-resource-id" v-model="resourceId" class="form-input" placeholder="key_abc123..." />
        </div>
        <div>
          <label for="audit-operation" class="form-label">Operation</label>
          <input
            id="audit-operation"
            v-model="operation"
            class="form-input"
            placeholder="createBudget, updatePolicy"
            aria-label="Filter by operation. Comma-separated for IN-list (e.g. createBudget, updatePolicy)."
          />
        </div>
        <div>
          <label for="audit-error-code" class="form-label">Error Code</label>
          <input
            id="audit-error-code"
            v-model="errorCode"
            list="audit-error-code-options"
            class="form-input"
            placeholder="BUDGET_EXCEEDED"
            aria-label="Filter by error_code. Comma-separated for IN-list (e.g. BUDGET_EXCEEDED, POLICY_VIOLATION)."
          />
          <datalist id="audit-error-code-options">
            <option v-for="c in ERROR_CODES" :key="c" :value="c" />
          </datalist>
        </div>
        <div>
          <label for="audit-error-code-exclude" class="form-label">Exclude codes</label>
          <input
            id="audit-error-code-exclude"
            v-model="errorCodeExclude"
            list="audit-error-code-options"
            class="form-input"
            placeholder="INTERNAL_ERROR, TIMEOUT"
            aria-label="Hide these error codes. Comma-separated (e.g. INTERNAL_ERROR, TIMEOUT). Success rows (no error_code) always pass this filter."
          />
        </div>
        <div>
          <label for="audit-trace-id" class="form-label">Trace ID</label>
          <input
            id="audit-trace-id"
            v-model="traceId"
            maxlength="32"
            class="form-input-mono"
            placeholder="32 hex chars"
            aria-label="Filter by W3C trace_id — 32 hex chars, exact match."
          />
        </div>
        <div>
          <label for="audit-request-id" class="form-label">Request ID</label>
          <input
            id="audit-request-id"
            v-model="requestId"
            class="form-input-mono"
            placeholder="request_id"
            aria-label="Filter by request_id — exact match."
          />
        </div>
      </div>

      <!-- Row 3: outcome band + submit. Status gets 4 cols (~730px at
           xl) which fits the 5 segmented chips on one line with room
           to spare; Run Query takes the trailing 2 cols and stays
           right-aligned via ml-auto. Below xl the row stacks cleanly
           in the 2-col grid — Status on its own half, Run Query on
           the next. -->
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-3 items-end">
        <div class="xl:col-span-4 min-w-0">
          <span class="form-label">Status</span>
          <!-- Segmented chip control. role=radiogroup + role=radio +
               aria-checked make this a screen-reader-equivalent of
               the prior <select>. data-band stays stable so tests
               target by semantic value rather than label. -->
          <div
            id="audit-status"
            role="radiogroup"
            aria-label="Filter by HTTP status band"
            class="inline-flex flex-wrap gap-0.5 rounded border border-gray-300 dark:border-gray-700 p-0.5 bg-gray-50 dark:bg-gray-800/40"
          >
            <button
              v-for="b in STATUS_BANDS"
              :key="b.value || 'all'"
              type="button"
              role="radio"
              :data-band="b.value"
              :aria-checked="statusBand === b.value"
              @click="statusBand = b.value"
              class="px-2.5 py-1 text-xs rounded cursor-pointer transition-colors"
              :class="statusBand === b.value
                ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'"
            >{{ b.label }}</button>
          </div>
        </div>
        <div class="xl:col-span-2 flex justify-end">
          <button type="submit" :disabled="loading" class="bg-gray-900 text-white px-4 py-1.5 rounded text-sm hover:bg-gray-800 disabled:opacity-50 cursor-pointer">
            {{ loading ? 'Querying...' : 'Run Query' }}
          </button>
        </div>
      </div>
    </form>

    <!-- V1 virtualized grid with measureElement (Phase 2c). Variable
         row heights let expand/collapse re-layout smoothly without
         flicker. Horizontal scroll engages on narrow viewports via
         the outer overflow-x-auto + inner min-width wrapper — both
         header and body scroll together because they share the shim
         parent. Shell is flex-1 min-h-0 flex-col so the scroll body
         below expands to fill viewport (phase 5). -->
    <!-- overflow-x-auto carries an implicit overflow-y:auto per the CSS
         overflow spec ("value other than visible or clip on one axis
         forces auto on the other axis"), which was creating a second
         vertical scrollbar on top of the inner scroll body's own
         overflow-y-auto. Pinning overflow-y:hidden here breaks the
         implicit promotion so exactly one vertical scrollbar remains,
         localized to the virtualized scroll body. -->
    <div
      class="bg-white rounded-lg shadow overflow-x-auto overflow-y-hidden text-sm flex-1 min-h-0 flex flex-col"
      role="table"
      :aria-rowcount="entries.length + 1"
      :aria-colcount="7"
    >
     <div style="min-width: 1000px" class="flex flex-col flex-1 min-h-0">
      <div role="rowgroup" class="table-header border-b border-gray-200 sticky top-0 z-10">
        <div role="row" class="grid text-xs font-bold uppercase tracking-wider" :style="{ gridTemplateColumns: gridTemplate }">
          <div role="columnheader" class="table-cell"></div>
          <SortHeader as="div" label="Time" column="timestamp" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Operation" column="operation" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Resource" column="resource_type" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Tenant" column="tenant_id" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Key ID" column="key_id" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Status" column="status" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
        </div>
      </div>

      <!-- overflow-x-hidden is load-bearing: `overflow-y: auto` alone
           promotes overflow-x to auto per the CSS spec, which would
           produce a SECOND horizontal scrollbar inside this scroll
           body on top of the outer card's overflow-x-auto when the
           viewport is narrower than the grid sum. Explicit hidden
           here keeps horizontal scroll owned entirely by the outer
           card. -->
      <div
        v-if="sortedEntries.length > 0"
        ref="scrollEl"
        role="rowgroup"
        class="flex-1 overflow-y-auto overflow-x-hidden min-h-[240px]"
      >
        <div role="presentation" :style="{ height: totalHeight + 'px', position: 'relative' }">
          <div
            v-for="v in virtualRows"
            :key="sortedEntries[v.index].log_id"
            :ref="measureRow"
            :data-index="v.index"
            role="row"
            :aria-rowindex="v.index + 2"
            class="absolute left-0 right-0 border-b border-gray-100"
            :style="{ transform: `translateY(${v.start}px)` }"
          >
            <!-- Compact row. Click anywhere on the row toggles the
                 detail expansion when it has detail data (hasDetail).
                 Rows without detail aren't clickable — their chevron
                 cell renders empty. -->
            <div
              class="grid table-row-hover items-center transition-colors"
              :class="hasDetail(sortedEntries[v.index]) ? 'cursor-pointer' : ''"
              :style="{ gridTemplateColumns: gridTemplate, minHeight: COLLAPSED_ROW_HEIGHT + 'px' }"
              @click="hasDetail(sortedEntries[v.index]) ? toggleExpanded(sortedEntries[v.index].log_id) : null"
            >
              <div role="cell" class="pl-3 muted">
                <button
                  v-if="hasDetail(sortedEntries[v.index])"
                  type="button"
                  :aria-expanded="expanded.has(sortedEntries[v.index].log_id)"
                  :aria-label="expanded.has(sortedEntries[v.index].log_id) ? 'Collapse audit details' : 'Expand audit details'"
                  class="p-0.5 -ml-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-400"
                  @click.stop="toggleExpanded(sortedEntries[v.index].log_id)"
                >
                  <ChevronRightIcon class="w-3.5 h-3.5 transition-transform" :class="expanded.has(sortedEntries[v.index].log_id) ? 'rotate-90' : ''" />
                </button>
              </div>
              <div role="cell" class="table-cell muted whitespace-nowrap text-xs" :title="new Date(sortedEntries[v.index].timestamp).toISOString()">{{ formatDateTime(sortedEntries[v.index].timestamp) }}</div>
              <div role="cell" class="table-cell font-mono text-xs truncate flex items-center gap-1.5 min-w-0" :title="sortedEntries[v.index].operation">
                <span class="truncate">{{ sortedEntries[v.index].operation }}</span>
                <span v-if="sortedEntries[v.index].operation === 'tenant_close_cascade'" class="bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 px-1.5 py-0.5 rounded text-[0.65rem] font-sans shrink-0" title="Emitted as part of a tenant-close cascade (spec v0.1.25.29 Rule 1)">cascade</span>
              </div>
              <div role="cell" class="table-cell text-xs truncate">
                <span v-if="sortedEntries[v.index].resource_type" class="bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded">{{ sortedEntries[v.index].resource_type }}</span>
                <span v-if="sortedEntries[v.index].resource_id" class="ml-1 font-mono muted" :title="sortedEntries[v.index].resource_id">{{ sortedEntries[v.index].resource_id }}</span>
                <span v-if="!sortedEntries[v.index].resource_type && !sortedEntries[v.index].resource_id" class="muted">-</span>
              </div>
              <div role="cell" class="table-cell muted-sm">
                <TenantLink v-if="sortedEntries[v.index].tenant_id" :tenant-id="sortedEntries[v.index].tenant_id!" />
                <span v-else class="muted-sm">-</span>
              </div>
              <div role="cell" class="table-cell">
                <MaskedValue v-if="sortedEntries[v.index].key_id" :value="sortedEntries[v.index].key_id!" />
                <span v-else class="muted-sm">-</span>
              </div>
              <div role="cell" class="table-cell min-w-0 overflow-hidden whitespace-nowrap" :title="sortedEntries[v.index].error_code ? `${sortedEntries[v.index].status} ${sortedEntries[v.index].error_code}` : String(sortedEntries[v.index].status)">
                <span class="px-1.5 py-0.5 rounded text-xs font-medium" :class="sortedEntries[v.index].status >= 400 ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'">{{ sortedEntries[v.index].status }}</span>
                <span v-if="sortedEntries[v.index].error_code" class="ml-1 text-xs text-red-700 font-mono">{{ sortedEntries[v.index].error_code }}</span>
              </div>
            </div>

            <!-- Expanded detail — rendered when this row's log_id is
                 in the `expanded` set. Multi-row open so reviewers can
                 compare entries (e.g. before/after of a permission
                 change). Adds ~160-280px depending on metadata.
                 log_id leads: it is the compliance identifier operators
                 cite in reports and the only field the `search` filter
                 hits that isn't otherwise visible in the row. -->
            <div v-if="expanded.has(sortedEntries[v.index].log_id)" class="relative bg-gray-50/70 dark:bg-gray-800/40 px-4 py-3 border-t border-gray-100 dark:border-gray-700">
              <button
                type="button"
                @click.stop="copyLogJson(sortedEntries[v.index])"
                class="absolute top-2 right-2 p-1.5 rounded muted hover:text-gray-700 hover:bg-gray-200/70 dark:hover:bg-gray-700 cursor-pointer focus:outline-none focus:ring-2 focus:ring-gray-400"
                :aria-label="`Copy full JSON for audit log ${sortedEntries[v.index].log_id}`"
                :title="copiedLogId === sortedEntries[v.index].log_id ? 'Copied!' : 'Copy row as JSON'"
              >
                <CopyJsonIcon :copied="copiedLogId === sortedEntries[v.index].log_id" />
                <span class="sr-only">{{ copiedLogId === sortedEntries[v.index].log_id ? 'Copied!' : 'Copy JSON' }}</span>
              </button>
              <div class="grid grid-cols-2 gap-x-6 gap-y-1 text-xs mb-3 pr-8">
                <div><span class="muted">Log ID:</span> <span class="font-mono">{{ sortedEntries[v.index].log_id }}</span></div>
                <div v-if="sortedEntries[v.index].trace_id">
                  <span class="muted">Trace ID:</span>
                  <CorrelationIdChip kind="trace" :value="sortedEntries[v.index].trace_id!" pivot="events" class="ml-1" @click.stop />
                </div>
                <div v-if="sortedEntries[v.index].request_id">
                  <span class="muted">Request ID:</span>
                  <CorrelationIdChip kind="request" :value="sortedEntries[v.index].request_id!" pivot="audit" class="ml-1" @click.stop />
                </div>
                <div v-if="sortedEntries[v.index].source_ip"><span class="muted">Source IP:</span> <span class="font-mono">{{ sortedEntries[v.index].source_ip }}</span></div>
                <div v-if="sortedEntries[v.index].user_agent"><span class="muted">User Agent:</span> {{ sortedEntries[v.index].user_agent }}</div>
                <div v-if="sortedEntries[v.index].error_code"><span class="muted">Error Code:</span> <span class="font-mono text-red-700">{{ sortedEntries[v.index].error_code }}</span></div>
                <div v-if="sortedEntries[v.index].resource_type"><span class="muted">Resource Type:</span> {{ sortedEntries[v.index].resource_type }}</div>
                <div v-if="sortedEntries[v.index].resource_id"><span class="muted">Resource ID:</span> <span class="font-mono">{{ sortedEntries[v.index].resource_id }}</span></div>
              </div>
              <!-- cycles-governance-admin v0.1.25.30: bulk-action audit
                   entries carry structured succeeded/failed/skipped
                   arrays + filter echo + duration. Render as a scannable
                   summary when present; collapse the raw JSON beneath
                   it. Non-bulk rows (and pre-.30 bulk rows that don't
                   carry the enriched keys) fall through to the raw
                   <pre> block so nothing regresses. -->
              <template v-if="sortedEntries[v.index].metadata && Object.keys(sortedEntries[v.index].metadata!).length > 0">
                <BulkActionAuditDetail
                  v-if="hasBulkAuditShape(sortedEntries[v.index].operation, sortedEntries[v.index].metadata)"
                  :operation="sortedEntries[v.index].operation"
                  :metadata="sortedEntries[v.index].metadata!"
                />
                <details
                  v-if="hasBulkAuditShape(sortedEntries[v.index].operation, sortedEntries[v.index].metadata)"
                  class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-3 text-xs"
                >
                  <summary class="muted font-sans cursor-pointer">Raw metadata</summary>
                  <pre class="whitespace-pre-wrap font-mono mt-2 overflow-auto max-h-48">{{ safeJsonStringify(sortedEntries[v.index].metadata) }}</pre>
                </details>
                <div
                  v-else
                  class="bg-white border border-gray-200 rounded p-3 text-xs font-mono overflow-auto max-h-48"
                >
                  <div class="muted mb-1 font-sans text-xs">Metadata</div>
                  <pre class="whitespace-pre-wrap">{{ safeJsonStringify(sortedEntries[v.index].metadata) }}</pre>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="!loading">
        <EmptyState message="No audit logs found" hint="Try a broader time range (e.g. Last 24h) or clear your filters" />
      </div>

      <!-- P1-H3: LoadingSkeleton replaces raw "Loading..." text so
           AuditView matches the cold-load pattern used in the detail
           views — consistent density, consistent motion. -->
      <div v-else-if="loading" class="px-4 py-6">
        <LoadingSkeleton />
      </div>
     </div>
    </div>

    <!-- Load more — outside the virtualized scroll region, mirrors
         the pattern used across EventsView / TenantsView / Webhooks.
         Exports still silently paginate through the full result set
         via fetchAllForExport; Load-more is for on-screen scanning. -->
    <div v-if="hasMore || loadingMore" class="mt-3 flex justify-end">
      <button @click="loadMore" :disabled="loadingMore" class="text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50 cursor-pointer">
        {{ loadingMore ? 'Loading…' : 'Load more' }}
      </button>
    </div>

    <ExportDialog
      :format="showExportConfirm"
      :loaded-count="entries.length"
      :has-more="hasMore"
      :max-rows="EXPORT_MAX_ROWS"
      item-noun-plural="log entries"
      warning="Exported files contain unmasked sensitive data (key IDs, IP addresses, metadata). Handle with care."
      @confirm="executeExport"
      @cancel="cancelExport"
    />
    <ExportProgressOverlay
      :open="exporting"
      :fetched="exportFetched"
      :cancellable="exportCancellable"
      item-noun-plural="log entries"
      @cancel="cancelRunningExport"
    />
  </div>
</template>

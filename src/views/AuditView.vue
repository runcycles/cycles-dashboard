<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useRoute } from 'vue-router'
import { listAuditLogs } from '../api/client'
import { useSort } from '../composables/useSort'
import { useListExport } from '../composables/useListExport'
import type { AuditLogEntry } from '../types'
import PageHeader from '../components/PageHeader.vue'
import MaskedValue from '../components/MaskedValue.vue'
import TenantLink from '../components/TenantLink.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import ExportDialog from '../components/ExportDialog.vue'
import ExportProgressOverlay from '../components/ExportProgressOverlay.vue'
import { formatDateTime } from '../utils/format'
import { toMessage } from '../utils/errors'
import { safeJsonStringify } from '../utils/safe'

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
const operation = ref('')
const resourceType = ref('')
const resourceId = ref('')
const fromDate = ref('')
const toDate = ref('')

// Pulls the non-cursor filter params out of the form. Shared between
// query() and the export loop so both see identical filter semantics —
// a drift here would produce exports that don't match what the operator
// sees on screen.
function buildFilterParams(): Record<string, string> {
  const params: Record<string, string> = {}
  if (tenantId.value) params.tenant_id = tenantId.value
  if (keyId.value) params.key_id = keyId.value
  if (operation.value) params.operation = operation.value
  if (resourceType.value) params.resource_type = resourceType.value
  if (resourceId.value) params.resource_id = resourceId.value
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

function setTimeRange(hours: number) {
  const now = new Date()
  const from = new Date(now.getTime() - hours * 3600_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  fromDate.value = fmt(from)
  toDate.value = fmt(now)
}

function hasDetail(e: AuditLogEntry): boolean {
  return !!(e.resource_type || e.resource_id || e.metadata || e.error_code || e.request_id || e.source_ip || e.user_agent)
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
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          Export CSV
        </button>
        <button @click="confirmExport('json')" :disabled="loading || entries.length === 0" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 dark:hover:text-gray-200 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          Export JSON
        </button>
      </template>
    </PageHeader>

    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg table-cell mb-4">{{ error }}</p>

    <form @submit.prevent="query" class="card p-4 mb-4">
      <div class="flex gap-3 flex-wrap items-end">
        <div>
          <label for="audit-tenant" class="form-label">Tenant ID</label>
          <input id="audit-tenant" v-model="tenantId" class="form-input w-32" placeholder="acme" />
        </div>
        <div>
          <label for="audit-key" class="form-label">Key ID</label>
          <input id="audit-key" v-model="keyId" class="form-input w-32" placeholder="key_..." />
        </div>
        <div>
          <label for="audit-operation" class="form-label">Operation</label>
          <input id="audit-operation" v-model="operation" class="form-input w-32" placeholder="createBudget" />
        </div>
        <div>
          <label for="audit-resource" class="form-label">Resource Type</label>
          <select id="audit-resource" v-model="resourceType" class="form-select">
            <option value="">All</option>
            <option>tenant</option><option>budget</option><option>api_key</option>
            <option>policy</option><option>webhook</option><option>config</option>
          </select>
        </div>
        <div>
          <label for="audit-resource-id" class="form-label">Resource ID</label>
          <input id="audit-resource-id" v-model="resourceId" class="form-input w-36" placeholder="key_abc123..." />
        </div>
        <div>
          <label for="audit-from" class="form-label">From</label>
          <input id="audit-from" v-model="fromDate" type="datetime-local" class="form-input" />
        </div>
        <div>
          <label for="audit-to" class="form-label">To</label>
          <input id="audit-to" v-model="toDate" type="datetime-local" class="form-input" />
        </div>
        <button type="submit" :disabled="loading" class="bg-gray-900 text-white px-4 py-1.5 rounded text-sm hover:bg-gray-800 disabled:opacity-50 cursor-pointer">
          {{ loading ? 'Querying...' : 'Run Query' }}
        </button>
      </div>
      <div class="flex gap-2 mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
        <span class="muted-sm py-1">Quick range:</span>
        <button v-for="h in [1, 6, 24, 168]" :key="h" type="button" @click="setTimeRange(h)"
          class="muted-sm hover:text-gray-700 dark:hover:text-gray-200 px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer">
          {{ h < 24 ? `${h}h` : `${h / 24}d` }}
        </button>
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
     <div style="min-width: 950px" class="flex flex-col flex-1 min-h-0">
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

      <div
        v-if="sortedEntries.length > 0"
        ref="scrollEl"
        role="rowgroup"
        class="flex-1 overflow-y-auto min-h-[240px]"
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
                  <svg class="w-3.5 h-3.5 transition-transform" :class="expanded.has(sortedEntries[v.index].log_id) ? 'rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
              <div role="cell" class="table-cell muted whitespace-nowrap text-xs" :title="new Date(sortedEntries[v.index].timestamp).toISOString()">{{ formatDateTime(sortedEntries[v.index].timestamp) }}</div>
              <div role="cell" class="table-cell font-mono text-xs truncate" :title="sortedEntries[v.index].operation">{{ sortedEntries[v.index].operation }}</div>
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
                <span v-if="sortedEntries[v.index].error_code" class="ml-1 text-xs text-red-500 font-mono">{{ sortedEntries[v.index].error_code }}</span>
              </div>
            </div>

            <!-- Expanded detail — rendered when this row's log_id is
                 in the `expanded` set. Multi-row open so reviewers can
                 compare entries (e.g. before/after of a permission
                 change). Adds ~160-280px depending on metadata. -->
            <div v-if="expanded.has(sortedEntries[v.index].log_id)" class="bg-gray-50/70 dark:bg-gray-800/40 px-4 py-3 border-t border-gray-100 dark:border-gray-700">
              <div class="grid grid-cols-2 gap-x-6 gap-y-1 text-xs mb-3">
                <div v-if="sortedEntries[v.index].request_id"><span class="muted">Request ID:</span> <span class="font-mono">{{ sortedEntries[v.index].request_id }}</span></div>
                <div v-if="sortedEntries[v.index].source_ip"><span class="muted">Source IP:</span> <span class="font-mono">{{ sortedEntries[v.index].source_ip }}</span></div>
                <div v-if="sortedEntries[v.index].user_agent"><span class="muted">User Agent:</span> {{ sortedEntries[v.index].user_agent }}</div>
                <div v-if="sortedEntries[v.index].error_code"><span class="muted">Error Code:</span> <span class="font-mono text-red-500">{{ sortedEntries[v.index].error_code }}</span></div>
                <div v-if="sortedEntries[v.index].resource_type"><span class="muted">Resource Type:</span> {{ sortedEntries[v.index].resource_type }}</div>
                <div v-if="sortedEntries[v.index].resource_id"><span class="muted">Resource ID:</span> <span class="font-mono">{{ sortedEntries[v.index].resource_id }}</span></div>
              </div>
              <div v-if="sortedEntries[v.index].metadata && Object.keys(sortedEntries[v.index].metadata!).length > 0" class="bg-white border border-gray-200 rounded p-3 text-xs font-mono overflow-auto max-h-48">
                <div class="muted mb-1 font-sans text-xs">Metadata</div>
                <pre class="whitespace-pre-wrap">{{ safeJsonStringify(sortedEntries[v.index].metadata) }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="!loading">
        <EmptyState message="No audit logs found" hint="Try a broader time range (e.g. Last 24h) or clear your filters" />
      </div>

      <div v-else-if="loading" class="px-4 py-12 text-center muted">Loading...</div>
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

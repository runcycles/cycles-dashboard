<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useRoute, useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { useSort } from '../composables/useSort'
import { useDebouncedRef } from '../composables/useDebouncedRef'
import { listEvents } from '../api/client'
import type { Event } from '../types'
import PageHeader from '../components/PageHeader.vue'
import TenantLink from '../components/TenantLink.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import { formatDateTime } from '../utils/format'
import { toMessage } from '../utils/errors'
import { csvEscape, safeJsonStringify } from '../utils/safe'

const route = useRoute()
const router = useRouter()

const events = ref<Event[]>([])
const hasMore = ref(false)
const nextCursor = ref('')
const loadingMore = ref(false)
const error = ref('')
const expanded = ref<string | null>(null)
const { sortKey, sortDir, toggle, sorted: sortedEvents } = useSort(events)

// Export state — mirrors AuditView's R3 pattern so compliance /
// forensics exports ship the complete filter-matching result set
// (not just page 1). confirmExport → dialog → executeExport →
// optional multi-page fetch with progress overlay → CSV/JSON blob
// download.
const showExportConfirm = ref<'csv' | 'json' | null>(null)
const exporting = ref(false)
const exportFetched = ref(0)
// 50k ceiling: same as AuditView. Above this, abort with an actionable
// message asking the operator to narrow filters (date range,
// correlation_id, tenant_id). Picked because typical compliance
// exports for one operator's workflow fit well under this, while
// a runaway unbounded export would OOM the browser and waste minutes.
const EXPORT_MAX_ROWS = 50_000

// Pre-R7: every 15s poll called load() which overwrote events.value,
// silently dropping any "Load more" pages the operator had accumulated.
// Post-R7: when extended (loadedMorePages=true), polls fetch page 1 and
// MERGE new events from the head via event_id dedup, preserving the
// loaded tail. Filter changes or an explicit Clear reset this flag.
const loadedMorePages = ref(false)

// V2 (scale-hardening): Copy JSON from expanded event detail. Complements
// the max-h-40 scroll cap by making the truncated view useful for triage
// — operators can pull the full data blob into their clipboard for
// grep/diff/pipe through jq rather than squinting at a capped viewport.
const copiedEventId = ref<string | null>(null)
let copiedResetTimer: ReturnType<typeof setTimeout> | null = null
async function copyEventData(e: Event) {
  try {
    await navigator.clipboard.writeText(safeJsonStringify(e.data))
    copiedEventId.value = e.event_id
    if (copiedResetTimer) clearTimeout(copiedResetTimer)
    copiedResetTimer = setTimeout(() => {
      if (copiedEventId.value === e.event_id) copiedEventId.value = null
    }, 2000)
  } catch {
    // Clipboard permission denied or insecure context — silently
    // fail rather than toast. The operator can still select-and-copy
    // from the pre element.
  }
}

const category = ref((route.query.category as string) || '')
const eventType = ref((route.query.type as string) || '')
const tenantId = ref((route.query.tenant_id as string) || '')
const scope = ref((route.query.scope as string) || '')
const correlationId = ref((route.query.correlation_id as string) || '')

function buildFilterParams(): Record<string, string> {
  const params: Record<string, string> = {}
  if (category.value) params.category = category.value
  if (eventType.value) params.event_type = eventType.value
  if (tenantId.value) params.tenant_id = tenantId.value
  if (scope.value) params.scope = scope.value
  if (correlationId.value) params.correlation_id = correlationId.value
  return params
}

async function load() {
  try {
    const res = await listEvents(buildFilterParams())
    if (loadedMorePages.value && events.value.length > 0) {
      // Extended view: merge page-1 results from the head, preserving
      // the already-loaded tail. Dedup by event_id — events are
      // immutable, so a repeated id is always a safe skip. Without
      // this, the poll would drop the tail and the operator's "Load
      // more" work would vanish every 15s.
      const known = new Set(events.value.map(e => e.event_id))
      const freshFromHead = res.events.filter(e => !known.has(e.event_id))
      if (freshFromHead.length > 0) {
        events.value = [...freshFromHead, ...events.value]
      }
      // Do NOT update hasMore/nextCursor here — they reflect the tail
      // cursor (from the user's last loadMore), not page 1's. Updating
      // them would break subsequent Load more clicks.
    } else {
      events.value = res.events
      hasMore.value = res.has_more
      nextCursor.value = res.next_cursor ?? ''
    }
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
}

function applyFilters() {
  router.replace({ query: {
    ...(category.value && { category: category.value }),
    ...(eventType.value && { type: eventType.value }),
    ...(tenantId.value && { tenant_id: tenantId.value }),
    ...(scope.value && { scope: scope.value }),
    ...(correlationId.value && { correlation_id: correlationId.value }),
  }})
  // Filter change resets the extended state — a new filter means the
  // previously-loaded tail is stale (events matching the OLD filter).
  loadedMorePages.value = false
  load()
}

function viewCorrelated(cid: string) {
  correlationId.value = cid
  applyFilters()
}

async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return
  loadingMore.value = true
  try {
    const params = { ...buildFilterParams(), cursor: nextCursor.value }
    const res = await listEvents(params)
    events.value = [...events.value, ...res.events]
    hasMore.value = res.has_more
    nextCursor.value = res.next_cursor ?? ''
    // Flip the flag so subsequent polls merge-from-head rather than
    // overwriting the tail we just loaded.
    loadedMorePages.value = true
  } catch (e) { error.value = toMessage(e) }
  finally { loadingMore.value = false }
}

function clearFilters() {
  category.value = ''; eventType.value = ''; tenantId.value = ''; scope.value = ''; correlationId.value = ''
  loadedMorePages.value = false
  applyFilters()
}

// Instant-apply on filter change. Best-practice UX (Linear / Notion /
// Jira filters) — operators shouldn't need to click a separate
// "Filter" button to see results; the select IS the action. For text
// inputs we debounce 300ms via useDebouncedRef so a 20-char
// correlation_id doesn't fire 20 fetches on the way in.
//
// Explicit applyFilters() remains wired to form@submit so pressing
// Enter in a text field still submits immediately.
const DEBOUNCE_MS = 300
const debouncedTenantId = useDebouncedRef(tenantId, DEBOUNCE_MS)
const debouncedScope = useDebouncedRef(scope, DEBOUNCE_MS)
const debouncedCorrelationId = useDebouncedRef(correlationId, DEBOUNCE_MS)
// Selects: apply instantly (no debounce). A select change is always
// intentional and finite — debouncing just adds perceived lag.
watch(category, () => applyFilters())
watch(eventType, () => applyFilters())
// Text inputs: applyFilters fires only after the debounced ref updates.
watch(debouncedTenantId, () => applyFilters())
watch(debouncedScope, () => applyFilters())
watch(debouncedCorrelationId, () => applyFilters())

// ─── Export (CSV / JSON) ──────────────────────────────────────────────
// Mirrors AuditView's flow — including the R3 correctness fix where
// exports MUST paginate through next_cursor (not just dump page 1).
// Fields: one column per shallow Event field, `data` serialized via
// safeJsonStringify so Excel/Sheets handle embedded newlines and the
// formula-injection guard (csvEscape) sanitizes cells that start with
// =, +, -, @, TAB, or CR (CWE-1236).

function doExportCsv(rows: Event[]) {
  const headers = [
    'timestamp', 'event_type', 'category', 'scope', 'tenant_id',
    'event_id', 'source', 'request_id', 'correlation_id',
    'actor_type', 'actor_key_id', 'data',
  ]
  const lines = rows.map(e => [
    e.timestamp, e.event_type, e.category, e.scope ?? '', e.tenant_id ?? '',
    e.event_id, e.source, e.request_id ?? '', e.correlation_id ?? '',
    e.actor?.type ?? '', e.actor?.key_id ?? '',
    e.data ? safeJsonStringify(e.data, 0) : '',
  ])
  const csv = [
    headers.map(csvEscape).join(','),
    ...lines.map(r => r.map(csvEscape).join(',')),
  ].join('\n')
  triggerDownload(csv, 'text/csv', 'csv')
}

function doExportJson(rows: Event[]) {
  triggerDownload(safeJsonStringify(rows, 2), 'application/json', 'json')
}

function triggerDownload(content: string, mime: string, ext: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `events-${new Date().toISOString().slice(0, 10)}.${ext}`
  a.click()
  URL.revokeObjectURL(url)
}

function confirmExport(format: 'csv' | 'json') {
  if (events.value.length === 0) return
  showExportConfirm.value = format
}

// Follow next_cursor until has_more=false OR we hit EXPORT_MAX_ROWS.
// Same safety caps as AuditView: 500-page iteration guard against a
// pathological tiny-page server, 50k row ceiling. Returns null when
// the ceiling is hit (sets a user-facing error).
async function fetchAllForExport(): Promise<Event[] | null> {
  const all: Event[] = [...events.value]
  exportFetched.value = all.length
  let cursor = nextCursor.value
  let hasMoreLocal = hasMore.value
  let pagesFetched = 1
  const MAX_PAGES = 500
  while (hasMoreLocal && cursor && all.length < EXPORT_MAX_ROWS && pagesFetched < MAX_PAGES) {
    const params = { ...buildFilterParams(), cursor }
    const res = await listEvents(params)
    all.push(...res.events)
    exportFetched.value = all.length
    hasMoreLocal = !!res.has_more
    cursor = res.next_cursor ?? ''
    pagesFetched++
  }
  if (all.length >= EXPORT_MAX_ROWS && hasMoreLocal) {
    error.value = `Export aborted: result set exceeds ${EXPORT_MAX_ROWS.toLocaleString()} rows. Narrow by date, correlation ID, or tenant before retrying.`
    return null
  }
  return all
}

async function executeExport() {
  const format = showExportConfirm.value
  if (!format) return
  showExportConfirm.value = null
  // Fast path — everything's on page 1 already.
  if (!hasMore.value) {
    if (format === 'csv') doExportCsv(events.value)
    else doExportJson(events.value)
    return
  }
  // Slow path — paginate through remaining pages. Blocking overlay so
  // operators don't close the tab mid-assembly (Blob only flushes once
  // every page is gathered).
  exporting.value = true
  exportFetched.value = events.value.length
  try {
    const all = await fetchAllForExport()
    if (!all) return
    if (format === 'csv') doExportCsv(all)
    else doExportJson(all)
  } catch (e) {
    error.value = toMessage(e)
  } finally {
    exporting.value = false
  }
}

const hasActiveFilters = computed(() => !!(category.value || eventType.value || tenantId.value || scope.value || correlationId.value))

const { refresh, isLoading, lastUpdated } = usePolling(load, 15000)

// V1 virtualization (Phase 2c) — variable row heights via measureElement.
// Collapsed rows are ~52px; expanded rows grow with metadata grid + JSON
// block (up to ~280px). Each virtualized item wraps BOTH the compact
// row and (when expanded) the detail block; measureElement observes the
// actual DOM height per index so the virtualizer can re-layout on
// expand/collapse smoothly.
const scrollEl = ref<HTMLElement | null>(null)
const COLLAPSED_ROW_HEIGHT = 52
const virtualizer = useVirtualizer(computed(() => ({
  count: sortedEvents.value.length,
  getScrollElement: () => scrollEl.value,
  estimateSize: () => COLLAPSED_ROW_HEIGHT,
  overscan: 8,
  // Stable key per index so reactivity across expand/collapse and
  // sort changes doesn't re-generate virtual item identities.
  getItemKey: (index: number) => sortedEvents.value[index]?.event_id ?? index,
})))
const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalHeight = computed(() => virtualizer.value.getTotalSize())

// Row template. Shared by header and body rows so column alignment is
// guaranteed. Chevron column fixed 32px; content columns sized to the
// longest realistic content (event_type: ~200px at mono text-xs;
// scope: flexible; timestamp: 160px for "MMM D, HH:mm:ss").
const gridTemplate = 'minmax(32px,32px) minmax(180px,1.5fr) 110px minmax(180px,2fr) minmax(130px,1fr) 160px'

// measureElement wrapper. TanStack's measureElement expects an Element
// reference — our `:ref` callback can receive Element | ComponentPublicInstance
// | null per Vue's typings. Narrow to Element before calling. Function is
// top-level (stable) so Vue doesn't re-register the ref callback every
// render (which would cause measure thrashing).
function measureRow(el: Element | { $el?: Element } | null) {
  const node = (el as { $el?: Element })?.$el ?? (el as Element | null)
  if (node instanceof Element && virtualizer.value) {
    virtualizer.value.measureElement(node)
  }
}
</script>

<template>
  <div>
    <PageHeader title="Events" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh" />

    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg table-cell mb-4">{{ error }}</p>

    <!-- Filters. Instant-apply on change (selects) or 300ms-debounced
         (text inputs) — no separate "Filter" button to click. Form
         still submits on Enter so pressing return in a text field
         applies immediately without waiting for the debounce. -->
    <form @submit.prevent="applyFilters" class="card p-4 mb-4">
      <div class="flex gap-3 flex-wrap items-end">
        <div>
          <label for="ev-category" class="form-label">Category</label>
          <select id="ev-category" v-model="category" class="form-select">
            <option value="">All</option>
            <option>budget</option><option>reservation</option><option>tenant</option>
            <option>api_key</option><option>policy</option><option>system</option>
          </select>
        </div>
        <div>
          <label for="ev-tenant" class="form-label">Tenant ID</label>
          <input id="ev-tenant" v-model="tenantId" placeholder="tenant id" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-32" />
        </div>
        <div>
          <label for="ev-scope" class="form-label">Scope</label>
          <input id="ev-scope" v-model="scope" placeholder="scope prefix" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-40" />
        </div>
        <div>
          <label for="ev-correlation" class="form-label">Correlation ID</label>
          <input id="ev-correlation" v-model="correlationId" placeholder="correlation_id" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-40" />
        </div>
        <button v-if="hasActiveFilters" type="button" @click="clearFilters" class="text-sm muted hover:text-gray-700 cursor-pointer ml-auto">Clear filters</button>
      </div>
    </form>

    <!-- Results count + export. Mirrors AuditView's toolbar so the
         two log-style views have a consistent export affordance.
         `(more available)` marker nudges operators that Export will
         paginate beyond what's currently on screen. -->
    <div v-if="events.length > 0" class="flex items-center justify-between mb-2">
      <p class="muted-sm">
        {{ events.length }} events
        <span v-if="hasMore" class="ml-1 text-amber-600" title="More events exist beyond this page — Export will paginate fully.">(more available)</span>
      </p>
      <div class="flex gap-2">
        <button @click="confirmExport('csv')" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          Export CSV
        </button>
        <button @click="confirmExport('json')" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          Export JSON
        </button>
      </div>
    </div>

    <!-- V1 virtualized grid with measureElement for variable row
         heights. Each virtualized item wraps compact-row + optional
         expanded-detail; TanStack's measureElement observes the
         real DOM height per index so expand/collapse re-layouts
         smoothly without flicker. Rows are keyed by event_id (via
         getItemKey) so Vue's reactivity doesn't destroy the measured
         element identity across sort or filter changes. -->
    <div
      class="bg-white rounded-lg shadow overflow-hidden text-sm"
      role="table"
      :aria-rowcount="events.length + 1"
      :aria-colcount="6"
    >
      <div role="rowgroup" class="table-header border-b border-gray-200 sticky top-0 z-10">
        <div role="row" class="grid text-xs font-bold uppercase tracking-wider" :style="{ gridTemplateColumns: gridTemplate }">
          <div role="columnheader" class="table-cell"></div>
          <SortHeader as="div" label="Type" column="event_type" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Category" column="category" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Scope" column="scope" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Tenant" column="tenant_id" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Time" column="timestamp" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
        </div>
      </div>

      <div
        v-if="sortedEvents.length > 0"
        ref="scrollEl"
        role="rowgroup"
        class="overflow-auto"
        style="max-height: calc(100vh - 380px); min-height: 240px;"
      >
        <div role="presentation" :style="{ height: totalHeight + 'px', position: 'relative' }">
          <div
            v-for="v in virtualRows"
            :key="sortedEvents[v.index].event_id"
            :ref="measureRow"
            :data-index="v.index"
            role="row"
            :aria-rowindex="v.index + 2"
            class="absolute left-0 right-0 border-b border-gray-100"
            :style="{ transform: `translateY(${v.start}px)` }"
          >
            <!-- Compact row — always rendered. The whole row is
                 mouse-clickable (consistent with pre-virt); the
                 chevron button provides keyboard access with its
                 own aria-expanded. -->
            <div
              class="grid table-row-hover items-center cursor-pointer transition-colors"
              :style="{ gridTemplateColumns: gridTemplate, minHeight: COLLAPSED_ROW_HEIGHT + 'px' }"
              @click="expanded = expanded === sortedEvents[v.index].event_id ? null : sortedEvents[v.index].event_id"
            >
              <div role="cell" class="pl-3 muted">
                <button
                  type="button"
                  :aria-expanded="expanded === sortedEvents[v.index].event_id"
                  :aria-label="expanded === sortedEvents[v.index].event_id ? 'Collapse event details' : 'Expand event details'"
                  class="p-0.5 -ml-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-400"
                  @click.stop="expanded = expanded === sortedEvents[v.index].event_id ? null : sortedEvents[v.index].event_id"
                >
                  <svg class="w-3.5 h-3.5 transition-transform" :class="expanded === sortedEvents[v.index].event_id ? 'rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
              <div role="cell" class="table-cell font-mono text-xs truncate" :title="sortedEvents[v.index].event_type">{{ sortedEvents[v.index].event_type }}</div>
              <div role="cell" class="table-cell"><span class="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-xs">{{ sortedEvents[v.index].category }}</span></div>
              <div role="cell" class="table-cell text-gray-700 font-mono text-xs truncate" :title="sortedEvents[v.index].scope">{{ sortedEvents[v.index].scope || '-' }}</div>
              <div role="cell" class="table-cell">
                <TenantLink v-if="sortedEvents[v.index].tenant_id" :tenant-id="sortedEvents[v.index].tenant_id" @click.stop />
              </div>
              <div role="cell" class="table-cell muted whitespace-nowrap text-xs" :title="new Date(sortedEvents[v.index].timestamp).toISOString()">{{ formatDateTime(sortedEvents[v.index].timestamp) }}</div>
            </div>

            <!-- Expanded detail. Only rendered when event_id matches
                 `expanded`. When present, it adds ~200-280px to the
                 row's total height — measureElement reports the new
                 height and the virtualizer re-lays out sibling rows
                 below on the next tick. -->
            <div v-if="expanded === sortedEvents[v.index].event_id" class="bg-gray-50/70 px-4 py-3 border-t border-gray-100">
              <div class="grid grid-cols-2 gap-x-6 gap-y-1 text-xs mb-3">
                <div><span class="muted">Event ID:</span> <span class="font-mono">{{ sortedEvents[v.index].event_id }}</span></div>
                <div><span class="muted">Source:</span> {{ sortedEvents[v.index].source }}</div>
                <div v-if="sortedEvents[v.index].request_id"><span class="muted">Request ID:</span> <span class="font-mono">{{ sortedEvents[v.index].request_id }}</span></div>
                <div v-if="sortedEvents[v.index].correlation_id">
                  <span class="muted">Correlation ID:</span>
                  <button @click.stop="viewCorrelated(sortedEvents[v.index].correlation_id!)" class="text-blue-600 hover:underline ml-1 font-mono cursor-pointer">{{ sortedEvents[v.index].correlation_id }}</button>
                </div>
                <div v-if="sortedEvents[v.index].actor"><span class="muted">Actor:</span> {{ sortedEvents[v.index].actor!.type }}<span v-if="sortedEvents[v.index].actor!.key_id" class="font-mono"> {{ sortedEvents[v.index].actor!.key_id }}</span></div>
              </div>
              <div v-if="sortedEvents[v.index].data" class="bg-white border border-gray-200 rounded text-xs font-mono">
                <div class="flex items-center justify-between px-3 py-1.5 border-b border-gray-100">
                  <span class="muted text-xs font-sans">Data</span>
                  <button
                    type="button"
                    @click.stop="copyEventData(sortedEvents[v.index])"
                    class="muted-sm hover:text-gray-700 cursor-pointer px-2 py-0.5 rounded hover:bg-gray-100"
                    :aria-label="`Copy data for event ${sortedEvents[v.index].event_id}`"
                  >
                    {{ copiedEventId === sortedEvents[v.index].event_id ? 'Copied!' : 'Copy' }}
                  </button>
                </div>
                <pre class="whitespace-pre-wrap p-3 overflow-auto max-h-40">{{ safeJsonStringify(sortedEvents[v.index].data) }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-else>
        <EmptyState :message="hasActiveFilters ? 'No events match your filters' : 'No events found'" :hint="hasActiveFilters ? undefined : 'Events will appear here as they occur'">
          <button v-if="hasActiveFilters" @click="clearFilters" class="mt-2 text-xs text-blue-600 hover:underline cursor-pointer">Clear filters</button>
        </EmptyState>
      </div>
    </div>

    <!-- Load more — outside the virtualized scroll region so it
         doesn't participate in row-height measurement. -->
    <div v-if="hasMore || loadingMore" class="mt-3 flex justify-end">
      <button @click="loadMore" :disabled="loadingMore" class="text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50 cursor-pointer">
        {{ loadingMore ? 'Loading…' : 'Load more events' }}
      </button>
    </div>

    <!-- Export confirmation dialog. Distinct copy for single-page vs
         multi-page export so operators know when an export will
         trigger additional network fetches. Backdrop click dismisses. -->
    <div v-if="showExportConfirm" class="fixed inset-0 bg-black/40 flex items-center justify-center z-50" @click.self="showExportConfirm = null">
      <div class="bg-white dark:bg-gray-900 dark:border dark:border-gray-700 rounded-lg shadow-lg p-6 max-w-sm mx-4">
        <h3 class="text-sm font-semibold text-gray-900 mb-2">Export events?</h3>
        <p v-if="!hasMore" class="text-sm text-gray-600 mb-1">This export contains <strong>{{ events.length }}</strong> events, including scope, tenant_id, actor, and event data.</p>
        <p v-else class="text-sm text-gray-600 mb-1">
          The current filter matches <strong>more than {{ events.length }}</strong> events. The export will paginate through all remaining results (up to {{ EXPORT_MAX_ROWS.toLocaleString() }}) before the download starts.
        </p>
        <p class="muted-sm mb-4">Exported files contain unmasked event data. Handle with care.</p>
        <div class="flex justify-end gap-2">
          <button @click="showExportConfirm = null" class="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 rounded hover:bg-gray-100 cursor-pointer">Cancel</button>
          <button @click="executeExport" class="px-3 py-1.5 text-sm bg-gray-900 text-white rounded hover:bg-gray-800 cursor-pointer">Export {{ showExportConfirm.toUpperCase() }}</button>
        </div>
      </div>
    </div>

    <!-- Export progress overlay for multi-page exports. Blocking so
         the operator doesn't close the tab mid-assembly — the browser
         only flushes the Blob once every page is fetched. -->
    <div v-if="exporting" class="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div class="bg-white dark:bg-gray-900 dark:border dark:border-gray-700 rounded-lg shadow-lg p-6 max-w-sm mx-4">
        <h3 class="text-sm font-semibold text-gray-900 mb-2">Assembling export…</h3>
        <p class="text-sm text-gray-600 mb-1">Fetched <strong>{{ exportFetched.toLocaleString() }}</strong> events so far.</p>
        <p class="muted-sm">Keep this tab open until the download begins.</p>
      </div>
    </div>
  </div>
</template>

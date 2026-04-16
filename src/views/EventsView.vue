<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useRoute, useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { useSort } from '../composables/useSort'
import { useDebouncedRef } from '../composables/useDebouncedRef'
import { useListExport } from '../composables/useListExport'
import { listEvents } from '../api/client'
import type { Event } from '../types'
import PageHeader from '../components/PageHeader.vue'
import TenantLink from '../components/TenantLink.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import ExportDialog from '../components/ExportDialog.vue'
import ExportProgressOverlay from '../components/ExportProgressOverlay.vue'
import { formatDateTime } from '../utils/format'
import { toMessage } from '../utils/errors'
import { safeJsonStringify } from '../utils/safe'

const route = useRoute()
const router = useRouter()

const events = ref<Event[]>([])
const hasMore = ref(false)
const nextCursor = ref('')
const loadingMore = ref(false)
const error = ref('')
const expanded = ref<string | null>(null)
const { sortKey, sortDir, toggle, sorted: sortedEvents } = useSort(events)


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

// Shared export (useListExport). CSV column spec + fetchPage adapter
// + filename stem is all that's view-specific.
const {
  showExportConfirm,
  exporting,
  exportFetched,
  exportError,
  maxRows: EXPORT_MAX_ROWS,
  confirmExport,
  cancelExport,
  executeExport,
} = useListExport<Event>({
  itemNoun: 'event',
  filenameStem: 'events',
  currentItems: events,
  hasMore,
  nextCursor,
  fetchPage: async (cursor) => {
    const res = await listEvents({ ...buildFilterParams(), cursor })
    return { items: res.events, hasMore: !!res.has_more, nextCursor: res.next_cursor ?? '' }
  },
  columns: [
    { header: 'timestamp',      value: e => e.timestamp },
    { header: 'event_type',     value: e => e.event_type },
    { header: 'category',       value: e => e.category },
    { header: 'scope',          value: e => e.scope ?? '' },
    { header: 'tenant_id',      value: e => e.tenant_id ?? '' },
    { header: 'event_id',       value: e => e.event_id },
    { header: 'source',         value: e => e.source },
    { header: 'request_id',     value: e => e.request_id ?? '' },
    { header: 'correlation_id', value: e => e.correlation_id ?? '' },
    { header: 'actor_type',     value: e => e.actor?.type ?? '' },
    { header: 'actor_key_id',   value: e => e.actor?.key_id ?? '' },
    { header: 'data',           value: e => e.data ? safeJsonStringify(e.data, 0) : '' },
  ],
})

watch(exportError, (v) => { if (v) error.value = v })

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
    <PageHeader
      title="Events"
      item-noun="event"
      :loaded="events.length"
      :has-more="hasMore"
      :loading="isLoading"
      :last-updated="lastUpdated"
      @refresh="refresh"
    />

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

    <!-- Export toolbar. The row count + "(more available)" marker
         that lived here pre-V6 was moved into PageHeader's count
         line — the two were displaying the same info; duplicating
         it read as a bug. Export buttons stay as the only toolbar
         action. -->
    <div v-if="events.length > 0" class="flex justify-end gap-2 mb-2">
      <button @click="confirmExport('csv')" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
        Export CSV
      </button>
      <button @click="confirmExport('json')" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
        Export JSON
      </button>
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
        <EmptyState
          item-noun="event"
          :has-active-filter="hasActiveFilters"
          :hint="hasActiveFilters ? undefined : 'Events will appear here as they occur'"
        >
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

    <ExportDialog
      :format="showExportConfirm"
      :loaded-count="events.length"
      :has-more="hasMore"
      :max-rows="EXPORT_MAX_ROWS"
      item-noun-plural="events"
      warning="Exported files contain unmasked event data. Handle with care."
      @confirm="executeExport"
      @cancel="cancelExport"
    />
    <ExportProgressOverlay
      :open="exporting"
      :fetched="exportFetched"
      item-noun-plural="events"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useRoute, useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { POLL_EVENTS_MS } from '../composables/pollingConstants'
import { useSort } from '../composables/useSort'
import { useDebouncedRef } from '../composables/useDebouncedRef'
import { useListExport } from '../composables/useListExport'
import { listEvents } from '../api/client'
import type { Event } from '../types'
import { EVENT_TYPES, EVENT_CATEGORIES } from '../types'
import PageHeader from '../components/PageHeader.vue'
import CopyJsonIcon from '../components/icons/CopyJsonIcon.vue'
import DownloadIcon from '../components/icons/DownloadIcon.vue'
import ChevronRightIcon from '../components/icons/ChevronRightIcon.vue'
import TenantLink from '../components/TenantLink.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import LoadingSkeleton from '../components/LoadingSkeleton.vue'
import InlineErrorBanner from '../components/InlineErrorBanner.vue'
import ExportDialog from '../components/ExportDialog.vue'
import ExportProgressOverlay from '../components/ExportProgressOverlay.vue'
import TimeRangePicker from '../components/TimeRangePicker.vue'
import CorrelationIdChip from '../components/CorrelationIdChip.vue'
import { formatDateTime } from '../utils/format'
import { toMessage } from '../utils/errors'
import { safeJsonStringify } from '../utils/safe'

const route = useRoute()
const router = useRouter()

const events = ref<Event[]>([])
// P1-H3: gates the cold-load skeleton. Flipped true after the first
// successful poll resolves.
const initialLoadDone = ref(false)
const hasMore = ref(false)
const nextCursor = ref('')
const loadingMore = ref(false)
const error = ref('')
// Multi-row expansion — operators compare events side-by-side during
// triage (correlation_id walk, payload diff across two requests), so
// keeping multiple rows open at once is the more useful default.
const expanded = ref(new Set<string>())
function toggleExpanded(id: string) {
  if (expanded.value.has(id)) expanded.value.delete(id)
  else expanded.value.add(id)
}
// V4 stage 2: server-side sort. Columns (event_type, category, scope,
// tenant_id, timestamp) map onto listEvents sort_by. onChange must reset
// `loadedMorePages` because a new sort order invalidates the tail
// cursor — page 1 under the new order is a different tuple and the
// merge-from-head dedup wouldn't know about the displaced rows.
const { sortKey, sortDir, toggle, sorted: sortedEvents } = useSort(
  events,
  undefined,
  'asc',
  undefined,
  {
    serverSide: true,
    onChange: () => {
      loadedMorePages.value = false
      load()
    },
  },
)


// Pre-R7: every 15s poll called load() which overwrote events.value,
// silently dropping any "Load more" pages the operator had accumulated.
// Post-R7: when extended (loadedMorePages=true), polls fetch page 1 and
// MERGE new events from the head via event_id dedup, preserving the
// loaded tail. Filter changes or an explicit Clear reset this flag.
const loadedMorePages = ref(false)

// Copy the full event as JSON. Row-level triage affordance — operators
// grab the whole entry (metadata, actor, request_id, correlation_id, data)
// in one click to paste into a ticket or pipe through jq. Copies the
// full Event object, not just the `data` field.
const copiedEventId = ref<string | null>(null)
let copiedResetTimer: ReturnType<typeof setTimeout> | null = null
async function copyEventJson(e: Event) {
  try {
    await navigator.clipboard.writeText(safeJsonStringify(e))
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
// cycles-server-admin v0.1.25.31 / protocol v0.1.25.28: W3C Trace Context
// cross-surface correlation. `trace_id` (32-hex) is auto-populated on
// every HTTP-originated event; `request_id` is the per-request id.
// Exact-match server-side filters on listEvents.
const traceId = ref((route.query.trace_id as string) || '')
const requestId = ref((route.query.request_id as string) || '')
// cycles-governance-admin v0.1.25.21: free-text `search` query param
// on listEvents (case-insensitive substring match on correlation_id +
// scope). Sits alongside the existing correlation_id and scope
// exact/prefix filters for the case where the operator has only a
// partial id. Debounced via the shared 300ms cadence.
const search = ref((route.query.search as string) || '')
// Spec: listEvents accepts `from` / `to` as RFC 3339 date-time.
// TimeRangePicker emits datetime-local strings (YYYY-MM-DDTHH:MM,
// local tz) which the server normalizes — matches what AuditView
// already sends.
const fromDate = ref((route.query.from as string) || '')
const toDate = ref((route.query.to as string) || '')
const timeRange = computed({
  get: () => ({ from: fromDate.value, to: toDate.value }),
  set: (v: { from: string; to: string }) => { fromDate.value = v.from; toDate.value = v.to },
})

function buildFilterParams(): Record<string, string> {
  const params: Record<string, string> = {}
  if (category.value) params.category = category.value
  if (eventType.value) params.event_type = eventType.value
  if (tenantId.value) params.tenant_id = tenantId.value
  if (scope.value) params.scope = scope.value
  if (correlationId.value) params.correlation_id = correlationId.value
  if (traceId.value) params.trace_id = traceId.value
  if (requestId.value) params.request_id = requestId.value
  // Trim before sending — a search of spaces is semantically empty on
  // the server, and the spec requires empty → absent.
  const q = search.value.trim()
  if (q) params.search = q
  // datetime-local emits 'YYYY-MM-DDTHH:MM' with no seconds or tz;
  // the spec's `from`/`to` are RFC 3339 date-time, which the server
  // validates strictly. new Date(...).toISOString() normalizes the
  // local-time input to UTC ISO 8601 — matches AuditView's wire format.
  if (fromDate.value) params.from = new Date(fromDate.value).toISOString()
  if (toDate.value) params.to = new Date(toDate.value).toISOString()
  if (sortKey.value) {
    params.sort_by = sortKey.value
    params.sort_dir = sortDir.value
  }
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
    initialLoadDone.value = true
  } catch (e) { error.value = toMessage(e) }
}

function applyFilters() {
  router.replace({ query: {
    ...(category.value && { category: category.value }),
    ...(eventType.value && { type: eventType.value }),
    ...(tenantId.value && { tenant_id: tenantId.value }),
    ...(scope.value && { scope: scope.value }),
    ...(correlationId.value && { correlation_id: correlationId.value }),
    ...(traceId.value && { trace_id: traceId.value }),
    ...(requestId.value && { request_id: requestId.value }),
    ...(search.value.trim() && { search: search.value.trim() }),
    ...(fromDate.value && { from: fromDate.value }),
    ...(toDate.value && { to: toDate.value }),
  }})
  // Filter change resets the extended state — a new filter means the
  // previously-loaded tail is stale (events matching the OLD filter).
  loadedMorePages.value = false
  load()
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
  category.value = ''; eventType.value = ''; tenantId.value = ''; scope.value = ''; correlationId.value = ''; search.value = ''
  traceId.value = ''; requestId.value = ''
  fromDate.value = ''; toDate.value = ''
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
const debouncedTraceId = useDebouncedRef(traceId, DEBOUNCE_MS)
const debouncedRequestId = useDebouncedRef(requestId, DEBOUNCE_MS)
const debouncedSearch = useDebouncedRef(search, DEBOUNCE_MS)
// Selects: apply instantly (no debounce). A select change is always
// intentional and finite — debouncing just adds perceived lag.
watch(category, () => applyFilters())
watch(eventType, () => applyFilters())
// Text inputs: applyFilters fires only after the debounced ref updates.
watch(debouncedTenantId, () => applyFilters())
watch(debouncedScope, () => applyFilters())
watch(debouncedCorrelationId, () => applyFilters())
watch(debouncedTraceId, () => applyFilters())
watch(debouncedRequestId, () => applyFilters())
watch(debouncedSearch, () => applyFilters())
// TimeRangePicker: emits only on explicit preset-click or custom
// Apply, so no debounce is needed — each change is already a
// committed intent.
watch(fromDate, () => applyFilters())
watch(toDate, () => applyFilters())

// Route-query watcher: CorrelationIdChip pivots that land on /events
// with a different query (e.g. another EventsView row's request_id chip
// click, or a back-nav) need to re-sync refs so the filter form reflects
// the URL. Ref watchers above then fire applyFilters() → load(). The
// router.replace inside applyFilters() becomes a no-op when the URL
// already matches, so there's no loop.
watch(() => route.query, (q) => {
  if ((q.trace_id as string || '') !== traceId.value) traceId.value = (q.trace_id as string) || ''
  if ((q.request_id as string || '') !== requestId.value) requestId.value = (q.request_id as string) || ''
  if ((q.correlation_id as string || '') !== correlationId.value) correlationId.value = (q.correlation_id as string) || ''
})

// Shared export (useListExport). CSV column spec + fetchPage adapter
// + filename stem is all that's view-specific.
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
    { header: 'trace_id',       value: e => e.trace_id ?? '' },
    { header: 'actor_type',     value: e => e.actor?.type ?? '' },
    { header: 'actor_key_id',   value: e => e.actor?.key_id ?? '' },
    { header: 'data',           value: e => e.data ? safeJsonStringify(e.data, 0) : '' },
  ],
})

watch(exportError, (v) => { if (v) error.value = v })

const hasActiveFilters = computed(() => !!(category.value || eventType.value || tenantId.value || scope.value || correlationId.value || traceId.value || requestId.value || search.value || fromDate.value || toDate.value))

const { refresh, isLoading, lastSuccessAt } = usePolling(load, POLL_EVENTS_MS)

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
  <!-- Phase 5 (table-layout unification): flex-fill so the table
       body grows with viewport height. -->
  <div class="h-full flex flex-col min-h-0">
    <PageHeader
      title="Events"
      item-noun="event"
      :loaded="events.length"
      :has-more="hasMore"
      :loading="isLoading"
      :last-updated-at="lastSuccessAt"
      @refresh="refresh"
    >
      <template #actions>
        <button @click="confirmExport('csv')" :disabled="events.length === 0" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 dark:hover:text-gray-200 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed">
          <DownloadIcon class="w-3.5 h-3.5" />
          Export CSV
        </button>
        <button @click="confirmExport('json')" :disabled="events.length === 0" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 dark:hover:text-gray-200 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed">
          <DownloadIcon class="w-3.5 h-3.5" />
          Export JSON
        </button>
      </template>
    </PageHeader>

    <InlineErrorBanner v-if="error" :message="error" @dismiss="error = ''" />

    <!-- Filters. Instant-apply on change (selects) or 300ms-debounced
         (text inputs) — no separate "Filter" button to click. Form
         still submits on Enter so pressing return in a text field
         applies immediately without waiting for the debounce.
         Two-row grid (xl+: 6 cols, sm: 2 cols) mirrors AuditView's
         layout so the two list views scan identically. Row 1 carries
         the primary filters (category/type/tenant/scope/search/time);
         row 2 groups the three correlation-id filters together with
         a Clear filters affordance on the right. -->
    <form @submit.prevent="applyFilters" class="card p-4 mb-4 space-y-3">
      <!-- Two 5-col rows at xl+, stacks to 2 cols below. Balanced
           split groups the primary filters (when + what + who) on row
           1 and the text/id lookup (free-text search + three
           correlation-id tiers) on row 2. `.form-select` doesn't carry
           an intrinsic w-full (unlike .form-input), so Category gets
           an explicit w-full to fill its grid cell — without it the
           <select> sizes to its longest option and the row looks
           ragged as neighbours expand/contract on resize. -->

      <!-- Row 1: when + what + who -->
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3 items-end">
        <div>
          <label for="ev-time-range" class="form-label">Time range</label>
          <TimeRangePicker
            id="ev-time-range"
            v-model="timeRange"
            aria-label="Event stream time range"
          />
        </div>
        <div>
          <label for="ev-category" class="form-label">Category</label>
          <!-- v0.1.25.59: render options from EVENT_CATEGORIES instead
               of the hardcoded list we used to carry. Pre-fix the enum
               and the dropdown drifted: spec v0.1.25.34 added `webhook`
               to EventCategory and this dropdown silently omitted it
               (types.ts updated, dropdown wasn't), so operators couldn't
               filter on the 6 new webhook.* lifecycle events. Driving
               from the const array keeps future additions in one place. -->
          <select id="ev-category" v-model="category" class="form-select w-full">
            <option value="">All</option>
            <option v-for="c in EVENT_CATEGORIES" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
        <div>
          <!-- Type filter. Surfaces the `?type=` URL param (e.g. set by
               Overview "Recent Denials → View all" deep-link) as a
               visible, clearable input. Datalist typeahead offers all
               spec EventType enum values (types.ts:EVENT_TYPES); free-
               text entry is still accepted so `custom.*` prefixed
               types (per spec extensibility rule) remain filterable. -->
          <label for="ev-type" class="form-label">Type</label>
          <input
            id="ev-type"
            v-model="eventType"
            list="ev-type-options"
            placeholder="reservation.denied"
            class="form-input"
          />
          <datalist id="ev-type-options">
            <option v-for="t in EVENT_TYPES" :key="t" :value="t" />
          </datalist>
        </div>
        <div>
          <label for="ev-tenant" class="form-label">Tenant ID</label>
          <input id="ev-tenant" v-model="tenantId" placeholder="tenant id" class="form-input" />
        </div>
        <div>
          <label for="ev-scope" class="form-label">Scope</label>
          <input id="ev-scope" v-model="scope" placeholder="scope prefix" class="form-input" />
        </div>
      </div>

      <!-- Row 2: text / id lookup. Search is broad substring; the
           three W3C Trace Context tiers (correlation_id / trace_id /
           request_id) are exact-match. Clear filters lives in the
           last col when any filter is active so it's always right-
           aligned below the input grid. -->
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3 items-end">
        <div>
          <label for="ev-search" class="form-label">Search</label>
          <input id="ev-search" v-model="search" type="search" placeholder="correlation_id or scope" class="form-input" aria-label="Search by correlation_id or scope substring" />
        </div>
        <div>
          <label for="ev-correlation" class="form-label">Correlation ID</label>
          <input id="ev-correlation" v-model="correlationId" placeholder="correlation_id" class="form-input font-mono text-xs" />
        </div>
        <div>
          <label for="ev-trace" class="form-label">Trace ID</label>
          <input id="ev-trace" v-model="traceId" maxlength="32" placeholder="32 hex chars" class="form-input font-mono text-xs" />
        </div>
        <div>
          <label for="ev-request" class="form-label">Request ID</label>
          <input id="ev-request" v-model="requestId" placeholder="request_id" class="form-input font-mono text-xs" />
        </div>
        <div v-if="hasActiveFilters" class="flex justify-end">
          <button type="button" @click="clearFilters" class="text-sm muted hover:text-gray-700 cursor-pointer">Clear filters</button>
        </div>
      </div>
    </form>

    <!-- V1 virtualized grid with measureElement for variable row
         heights. Each virtualized item wraps compact-row + optional
         expanded-detail; TanStack's measureElement observes the
         real DOM height per index so expand/collapse re-layouts
         smoothly without flicker. Rows are keyed by event_id (via
         getItemKey) so Vue's reactivity doesn't destroy the measured
         element identity across sort or filter changes. -->
    <div
      class="bg-white rounded-lg shadow overflow-hidden text-sm flex-1 min-h-0 flex flex-col"
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
        class="flex-1 overflow-auto min-h-[240px]"
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
              @click="toggleExpanded(sortedEvents[v.index].event_id)"
            >
              <div role="cell" class="pl-3 muted">
                <button
                  type="button"
                  :aria-expanded="expanded.has(sortedEvents[v.index].event_id)"
                  :aria-label="expanded.has(sortedEvents[v.index].event_id) ? 'Collapse event details' : 'Expand event details'"
                  class="p-0.5 -ml-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-400"
                  @click.stop="toggleExpanded(sortedEvents[v.index].event_id)"
                >
                  <ChevronRightIcon class="w-3.5 h-3.5 transition-transform" :class="expanded.has(sortedEvents[v.index].event_id) ? 'rotate-90' : ''" />
                </button>
              </div>
              <div role="cell" class="table-cell font-mono text-xs truncate" :title="sortedEvents[v.index].event_type">{{ sortedEvents[v.index].event_type }}</div>
              <div role="cell" class="table-cell"><span class="bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded text-xs">{{ sortedEvents[v.index].category }}</span></div>
              <div role="cell" class="table-cell text-gray-700 font-mono text-xs truncate" :title="sortedEvents[v.index].scope">{{ sortedEvents[v.index].scope || '-' }}</div>
              <div role="cell" class="table-cell">
                <TenantLink v-if="sortedEvents[v.index].tenant_id" :tenant-id="sortedEvents[v.index].tenant_id" @click.stop />
              </div>
              <div role="cell" class="table-cell muted whitespace-nowrap text-xs" :title="new Date(sortedEvents[v.index].timestamp).toISOString()">{{ formatDateTime(sortedEvents[v.index].timestamp) }}</div>
            </div>

            <!-- Expanded detail. Rendered when the row's event_id is
                 in the `expanded` set — multi-row open so operators
                 can compare events side-by-side during triage. When
                 present, it adds ~200-280px to the row's total
                 height; measureElement reports the new height and
                 the virtualizer re-lays out sibling rows below on
                 the next tick. -->
            <div v-if="expanded.has(sortedEvents[v.index].event_id)" class="relative bg-gray-50/70 dark:bg-gray-800/40 px-4 py-3 border-t border-gray-100 dark:border-gray-700">
              <button
                type="button"
                @click.stop="copyEventJson(sortedEvents[v.index])"
                class="absolute top-2 right-2 p-1.5 rounded muted hover:text-gray-700 hover:bg-gray-200/70 dark:hover:bg-gray-700 cursor-pointer focus:outline-none focus:ring-2 focus:ring-gray-400"
                :aria-label="`Copy full JSON for event ${sortedEvents[v.index].event_id}`"
                :title="copiedEventId === sortedEvents[v.index].event_id ? 'Copied!' : 'Copy row as JSON'"
              >
                <CopyJsonIcon :copied="copiedEventId === sortedEvents[v.index].event_id" />
                <span class="sr-only">{{ copiedEventId === sortedEvents[v.index].event_id ? 'Copied!' : 'Copy JSON' }}</span>
              </button>
              <div class="grid grid-cols-2 gap-x-6 gap-y-1 text-xs mb-3 pr-8">
                <div><span class="muted">Event ID:</span> <span class="font-mono">{{ sortedEvents[v.index].event_id }}</span></div>
                <div><span class="muted">Source:</span> {{ sortedEvents[v.index].source }}</div>
                <div v-if="sortedEvents[v.index].trace_id">
                  <span class="muted">Trace ID:</span>
                  <CorrelationIdChip kind="trace" :value="sortedEvents[v.index].trace_id!" pivot="audit" class="ml-1" @click.stop />
                </div>
                <div v-if="sortedEvents[v.index].request_id">
                  <span class="muted">Request ID:</span>
                  <CorrelationIdChip kind="request" :value="sortedEvents[v.index].request_id!" pivot="events" class="ml-1" @click.stop />
                </div>
                <div v-if="sortedEvents[v.index].correlation_id">
                  <span class="muted">Correlation ID:</span>
                  <CorrelationIdChip kind="correlation" :value="sortedEvents[v.index].correlation_id!" pivot="events" class="ml-1" @click.stop />
                </div>
                <div v-if="sortedEvents[v.index].actor"><span class="muted">Actor:</span> {{ sortedEvents[v.index].actor!.type }}<span v-if="sortedEvents[v.index].actor!.key_id" class="font-mono"> {{ sortedEvents[v.index].actor!.key_id }}</span></div>
              </div>
              <div v-if="sortedEvents[v.index].data" class="bg-white border border-gray-200 rounded text-xs font-mono">
                <div class="flex items-center justify-between px-3 py-1.5 border-b border-gray-100">
                  <span class="muted text-xs font-sans">Data</span>
                </div>
                <pre class="whitespace-pre-wrap p-3 overflow-auto max-h-40">{{ safeJsonStringify(sortedEvents[v.index].data) }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- P1-H3: cold-load skeleton. -->
      <div v-else-if="!initialLoadDone && !error" class="px-4 py-6">
        <LoadingSkeleton />
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
        {{ loadingMore ? 'Loading…' : 'Load more' }}
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
      :cancellable="exportCancellable"
      item-noun-plural="events"
      @cancel="cancelRunningExport"
    />
  </div>
</template>

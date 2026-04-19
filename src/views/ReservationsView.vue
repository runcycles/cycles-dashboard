<script setup lang="ts">
/**
 * Reservations admin view. Surfaces the runtime-plane dual-auth
 * endpoints added in cycles-protocol revision 2026-04-13 and cycles-server
 * v0.1.25.8. Primary ops use case: find a hung reservation (ACTIVE past
 * its grace window) and force-release it so the held budget capacity
 * returns to the tenant.
 *
 * Scoping: list requires a tenant filter per spec (admin has no
 * effective tenant). No "show reservations across all tenants" view —
 * cross-tenant scans are expensive and the ops use case is always
 * anchored on a known tenant (they got paged because tenant X's
 * reservation is stuck).
 */
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { usePolling } from '../composables/usePolling'
import { useSort } from '../composables/useSort'
import { useListExport } from '../composables/useListExport'
import { listReservations, releaseReservation, listTenants } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { ReservationSummary, Tenant } from '../types'
import { RESERVATION_STATUSES } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import ExportDialog from '../components/ExportDialog.vue'
import ExportProgressOverlay from '../components/ExportProgressOverlay.vue'
import FormDialog from '../components/FormDialog.vue'
import RowActionsMenu from '../components/RowActionsMenu.vue'
import { writeClipboardJson } from '../utils/clipboard'
import { formatDateTime, formatRelative } from '../utils/format'
import { useToast } from '../composables/useToast'
import { toMessage } from '../utils/errors'

const toast = useToast()
const route = useRoute()
const auth = useAuthStore()
// No `manage_reservations` capability flag in the current introspect
// response — default to allow. Older admin servers surface 401/403 at
// call time if the key lacks access; that path is already handled by
// the ApiError flow.
const canManage = computed(() => auth.capabilities?.manage_reservations !== false)

// Scoping. Server rejects listReservations under admin auth without
// a tenant; we mirror that at the form level so the user can't submit
// an empty filter. Default the first tenant in the list once tenants
// are loaded so the view has something to show without manual picking.
const tenants = ref<Tenant[]>([])
const tenantFilter = ref('')
// Accept ?status= from the URL so Overview-style drill-downs and shared
// links land on the right filter. Falls back to 'ACTIVE' when absent or
// invalid (the operationally-interesting default — active reservations
// past grace are the "stuck" ones that ops force-releases).
const statusFromQuery = computed<string | null>(() => {
  const s = route.query.status
  if (typeof s !== 'string') return null
  return (RESERVATION_STATUSES as readonly string[]).includes(s) ? s : null
})
const statusFilter = ref<string>(statusFromQuery.value ?? 'ACTIVE')
watch(statusFromQuery, s => {
  if (s && statusFilter.value !== s) statusFilter.value = s
})
const reservations = ref<ReservationSummary[]>([])
const error = ref('')
const loadingList = ref(false)
const loadingMore = ref(false)
// Pagination. Pre-R4, the view hardcoded limit=100 and discarded the
// server's cursor — tenants with >100 matching reservations silently
// truncated. Load-more follows next_cursor; polling replays page 1 and
// drops any loaded tail (documented on the Load more button).
const PAGE_SIZE = 100
const hasMore = ref(false)
const nextCursor = ref('')

// Server-side sort — cycles-server v0.1.25.12+ supports sort_by/sort_dir
// on GET /v1/reservations with a stable reservation_id tie-breaker so
// cursor pagination stays deterministic under ties. Default created_at_ms
// desc (newest first): common workflow is "what did my agents do most
// recently". Click the Created header once to flip to ascending for the
// oldest-stuck-first view.
//
// The SortHeader accessors for `reserved` are no longer strictly needed
// (server sorts by amount via the `reserved` enum key) but kept for the
// fallback path — if a future view opts back to client-side sort we
// don't want `[object Object]` surprises.
const { sortKey, sortDir, toggle, sorted: sortedReservations } = useSort(
  reservations,
  'created_at_ms',
  'desc',
  { reserved: (r) => r.reserved.amount },
  { serverSide: true, onChange: () => { loadReservations() } },
)

async function loadTenants() {
  try {
    const res = await listTenants()
    tenants.value = res.tenants
    // Default the tenant filter to the first ACTIVE tenant so the view
    // has something to show on first render. Suspended/closed tenants
    // typically have no live reservations — picking one by accident
    // renders an empty table that looks broken. Fall back to the
    // first tenant of any status if none are ACTIVE.
    if (!tenantFilter.value && tenants.value.length > 0) {
      const firstActive = tenants.value.find((t) => t.status === 'ACTIVE')
      tenantFilter.value = (firstActive ?? tenants.value[0]).tenant_id
    }
  } catch (e) { error.value = toMessage(e) }
}

async function loadReservations() {
  if (!tenantFilter.value) {
    reservations.value = []
    hasMore.value = false
    nextCursor.value = ''
    return
  }
  loadingList.value = true
  // Reset pagination state up-front — same rationale as BudgetsView:
  // if the user clicks "Load more" between the watcher firing and the
  // fetch returning, without this reset we'd send a stale cursor
  // scoped to the previous filter.
  nextCursor.value = ''
  hasMore.value = false
  try {
    const params: {
      status?: string
      limit?: number
      sort_by?: string
      sort_dir?: 'asc' | 'desc'
    } = {
      limit: PAGE_SIZE,
      sort_by: sortKey.value || undefined,
      sort_dir: sortKey.value ? sortDir.value : undefined,
    }
    if (statusFilter.value) params.status = statusFilter.value
    const res = await listReservations(tenantFilter.value, params)
    reservations.value = res.reservations
    hasMore.value = !!res.has_more
    nextCursor.value = res.next_cursor ?? ''
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
  finally { loadingList.value = false }
}

async function loadMore() {
  if (!nextCursor.value || loadingMore.value || !tenantFilter.value) return
  loadingMore.value = true
  try {
    // Pass the same sort tuple the server validates against the cursor.
    // Omitting sort params on page 2+ under a sorted cursor would 400
    // with INVALID_REQUEST (cursor-tuple mismatch per v0.1.25.12 spec).
    const params: {
      status?: string
      limit?: number
      cursor?: string
      sort_by?: string
      sort_dir?: 'asc' | 'desc'
    } = {
      limit: PAGE_SIZE,
      cursor: nextCursor.value,
      sort_by: sortKey.value || undefined,
      sort_dir: sortKey.value ? sortDir.value : undefined,
    }
    if (statusFilter.value) params.status = statusFilter.value
    const res = await listReservations(tenantFilter.value, params)
    reservations.value = [...reservations.value, ...res.reservations]
    hasMore.value = !!res.has_more
    nextCursor.value = res.next_cursor ?? ''
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
  finally { loadingMore.value = false }
}

// Export. Server-side filter (tenant + status) — the fetchPage passes
// the same filter params so cursor pages stay consistent. No filterFn
// needed since filtering is already server-side.
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
} = useListExport<ReservationSummary>({
  itemNoun: 'reservation',
  filenameStem: 'reservations',
  currentItems: reservations,
  hasMore,
  nextCursor,
  fetchPage: async (cursor) => {
    if (!tenantFilter.value) return { items: [], hasMore: false, nextCursor: '' }
    // Export pages must pass the same sort tuple bound to the cursor —
    // the server validates the cursor's filter_hash against the current
    // (sort_by, sort_dir, filters) tuple and 400s on mismatch.
    const params: {
      status?: string
      limit?: number
      cursor?: string
      sort_by?: string
      sort_dir?: 'asc' | 'desc'
    } = {
      limit: PAGE_SIZE,
      cursor,
      sort_by: sortKey.value || undefined,
      sort_dir: sortKey.value ? sortDir.value : undefined,
    }
    if (statusFilter.value) params.status = statusFilter.value
    const res = await listReservations(tenantFilter.value, params)
    return { items: res.reservations, hasMore: !!res.has_more, nextCursor: res.next_cursor ?? '' }
  },
  columns: [
    { header: 'reservation_id',   value: r => r.reservation_id },
    { header: 'scope_path',       value: r => r.scope_path },
    { header: 'status',           value: r => r.status },
    { header: 'reserved_amount',  value: r => r.reserved.amount },
    { header: 'reserved_unit',    value: r => r.reserved.unit },
    { header: 'created_at_ms',    value: r => r.created_at_ms },
    { header: 'expires_at_ms',    value: r => r.expires_at_ms },
  ],
})

watch(exportError, (v) => { if (v) error.value = v })

// Re-query on filter change. Polling keeps the list fresh on a 30s
// cadence — reservations turn over quickly and a stale list is actively
// misleading (an operator could "force-release" one that already
// expired).
watch([tenantFilter, statusFilter], () => { loadReservations() })

const { refresh, isLoading, lastUpdated } = usePolling(async () => {
  try {
    if (tenants.value.length === 0) await loadTenants()
    await loadReservations()
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
}, 30_000)

// ─── Force-release flow ─────────────────────────────────────────────
// Mirrors the budget-freeze confirm pattern: dialog shows scope +
// reserved amount + reason field. Spec SHOULD-guidance: users
// populate `reason` with a structured tag for grep-ability in the
// audit log. Pre-fill the tag so the common case is one click.
const pendingRelease = ref<ReservationSummary | null>(null)
const releaseReason = ref('')
const releaseLoading = ref(false)
const releaseError = ref('')

function openRelease(r: ReservationSummary) {
  pendingRelease.value = r
  releaseReason.value = '[INCIDENT_FORCE_RELEASE] '
  releaseError.value = ''
}

async function copyReservationId(id: string) {
  try {
    await navigator.clipboard.writeText(id)
    toast.success('Reservation ID copied')
  } catch {
    toast.error('Copy failed — clipboard unavailable')
  }
}

async function copyReservationJson(r: ReservationSummary) {
  if (await writeClipboardJson(r)) toast.success('Reservation JSON copied')
  else toast.error('Copy failed — clipboard unavailable')
}

async function submitRelease() {
  if (!pendingRelease.value || releaseLoading.value) return
  releaseError.value = ''
  releaseLoading.value = true
  // Idempotency key is required on every release even admin-driven;
  // server returns the same response on replay with the same key.
  // We use a throwaway UUID per click — no retry coalescing needed
  // because the dialog disables the button during in-flight.
  const idempotencyKey = crypto.randomUUID()
  try {
    await releaseReservation(
      pendingRelease.value.reservation_id,
      idempotencyKey,
      releaseReason.value.trim() || undefined,
    )
    toast.success(`Reservation ${pendingRelease.value.reservation_id} released`)
    pendingRelease.value = null
    await loadReservations()
  } catch (e) {
    releaseError.value = toMessage(e)
  } finally {
    releaseLoading.value = false
  }
}

function ageLabel(r: ReservationSummary): string {
  // Created-at as a relative string so ops can spot "stuck for 3h"
  // faster than parsing an absolute timestamp.
  return formatRelative(new Date(r.created_at_ms).toISOString())
}

function isExpired(r: ReservationSummary): boolean {
  return r.expires_at_ms <= Date.now()
}

// V1 (scale-hardening phase 2b): virtualized row rendering via
// @tanstack/vue-virtual. Pre-fix, every loaded reservation rendered as a
// DOM row; a tenant with 5k+ reservations (rare but possible during a
// stuck-queue incident) meant a multi-second layout stall. Post-fix,
// only the rows in the viewport + overscan are in the DOM.
//
// Trade-off: the semantic <table> becomes an ARIA grid of <div>s because
// we absolute-position rows inside a sized container, which HTML's table
// layout algorithm can't model. SortHeader's `as="div"` prop exists for
// this use — the role="columnheader" ARIA stays intact.
const scrollEl = ref<HTMLElement | null>(null)
// 52px is a reasonable starting point for a single-line reservation row
// (table-cell padding × 2 + text-sm line-height). We pin the height
// on each rendered row so the estimate holds exactly — no re-measuring
// flicker. Variable-height rows would need virtualizer.measureElement.
const ROW_HEIGHT_ESTIMATE = 52
// Wrap the entire options object in a computed so the virtualizer
// re-reads `count` whenever the sorted list length changes. Passing
// a per-field computed doesn't work — @tanstack/vue-virtual accepts
// MaybeRef<options> but each option field is read as a raw value.
const virtualizer = useVirtualizer(computed(() => ({
  count: sortedReservations.value.length,
  getScrollElement: () => scrollEl.value,
  estimateSize: () => ROW_HEIGHT_ESTIMATE,
  overscan: 8, // render 8 extra rows outside the viewport for smooth scroll
})))
const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalHeight = computed(() => virtualizer.value.getTotalSize())

// Grid template shared by the sticky header and each virtualized row.
// Inline style (not a Tailwind arbitrary class) so we're immune to the
// JIT scanner missing the pattern. Column 7 (actions) is 120px, not
// 96px (the original <th class="w-24">), because "Force release" at
// text-xs is ~75px and px-4 takes 32px of the cell — 96 was cutting it.
const gridTemplate = computed(() =>
  canManage.value
    ? 'minmax(180px,1.5fr) minmax(200px,2fr) 110px 140px 140px 140px 120px'
    : 'minmax(180px,1.5fr) minmax(200px,2fr) 110px 140px 140px 140px',
)
</script>

<template>
  <!-- Phase 5 (table-layout unification): flex-fill so the table body
       grows to fill remaining viewport height. No per-view
       calc(100vh - Npx) math; resize the browser and the table adapts
       naturally. Header, filter toolbar, and Load-more footer take
       their natural (shrink-0) height; the virtualized scroll body
       is flex-1 min-h-0 overflow-auto. -->
  <div class="h-full flex flex-col min-h-0">
    <PageHeader
      title="Reservations"
      subtitle="Force-release hung reservations during incident response"
      item-noun="reservation"
      :loaded="reservations.length"
      :has-more="hasMore"
      :loading="isLoading"
      :last-updated="lastUpdated"
      @refresh="refresh"
    >
      <template #actions>
        <button @click="confirmExport('csv')" :disabled="reservations.length === 0" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          Export CSV
        </button>
        <button @click="confirmExport('json')" :disabled="reservations.length === 0" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          Export JSON
        </button>
      </template>
    </PageHeader>
    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg table-cell mb-4">{{ error }}</p>

    <!-- Filters. Tenant is required; the server rejects admin list
         without it, so we enforce client-side too. Status defaults to
         ACTIVE because that's the operationally-interesting set.
         Wrapped in card to match the toolbars in other list views. -->
    <div class="card p-4 mb-4">
      <div class="flex gap-3 flex-wrap items-end">
        <div>
          <label for="res-tenant" class="form-label">Tenant *</label>
          <select id="res-tenant" v-model="tenantFilter" class="form-select">
            <option value="" disabled>— pick a tenant —</option>
            <option v-for="t in tenants" :key="t.tenant_id" :value="t.tenant_id">{{ t.name || t.tenant_id }}</option>
          </select>
        </div>
        <div>
          <label for="res-status" class="form-label">Status</label>
          <select id="res-status" v-model="statusFilter" class="form-select">
            <option value="">All</option>
            <option v-for="s in RESERVATION_STATUSES" :key="s" :value="s">{{ s }}</option>
          </select>
        </div>
        <p class="muted-sm flex-1 min-w-[16rem]">
          Default sort is Created (newest first). Click the Created header to flip
          to ascending — reservations past their grace window but still ACTIVE rise
          to the top, which is the fast way to find "hung" ones.
        </p>
      </div>
    </div>

    <!-- V1 virtualized grid. Structure: role="table" wrapper with a
         role="rowgroup" sticky header and a role="rowgroup" scroll
         container. CSS Grid gives each row a consistent column template
         without HTML <table>'s layout algorithm, which can't coexist
         with the absolute-positioned virtualized rows. Shell is
         flex-1 min-h-0 flex-col so the scroll body below expands to
         fill remaining viewport. -->
    <div
      class="bg-white rounded-lg shadow overflow-hidden text-sm flex-1 min-h-0 flex flex-col"
      role="table"
      :aria-rowcount="reservations.length + 1"
      :aria-colcount="canManage ? 7 : 6"
    >
      <div role="rowgroup" class="table-header border-b border-gray-200 sticky top-0 z-10">
        <div
          role="row"
          class="grid text-xs font-bold uppercase tracking-wider"
          :style="{ gridTemplateColumns: gridTemplate }"
        >
          <SortHeader as="div" label="Reservation ID" column="reservation_id" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Scope" column="scope_path" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Status" column="status" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Reserved" column="reserved" :active-column="sortKey" :direction="sortDir" @sort="toggle" align="right" />
          <SortHeader as="div" label="Created" column="created_at_ms" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Expires" column="expires_at_ms" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <div v-if="canManage" role="columnheader" class="table-cell" data-column="action"></div>
        </div>
      </div>

      <!-- Virtualized body. flex-1 min-h-0 overflow-auto lets the
           body fill whatever space is left in the flex-col shell —
           the virtualizer reads clientHeight and re-computes which
           rows intersect, so resize ticks naturally. min-h-[200px]
           keeps the body usable on tiny viewports where "flex-1"
           would otherwise collapse to near-zero (e.g. if the filter
           toolbar wrapped to many rows). -->
      <div
        v-if="sortedReservations.length > 0"
        ref="scrollEl"
        role="rowgroup"
        class="flex-1 overflow-auto min-h-[200px]"
      >
        <div role="presentation" :style="{ height: totalHeight + 'px', position: 'relative' }">
          <div
            v-for="v in virtualRows"
            :key="sortedReservations[v.index].reservation_id"
            role="row"
            :aria-rowindex="v.index + 2"
            class="grid table-row-hover border-b border-gray-100 absolute left-0 right-0 items-center"
            :style="{ gridTemplateColumns: gridTemplate, transform: `translateY(${v.start}px)`, height: ROW_HEIGHT_ESTIMATE + 'px' }"
          >
            <div role="cell" class="table-cell font-mono text-xs truncate" :title="sortedReservations[v.index].reservation_id">{{ sortedReservations[v.index].reservation_id }}</div>
            <div role="cell" class="table-cell font-mono text-xs text-gray-600 truncate" :title="sortedReservations[v.index].scope_path">{{ sortedReservations[v.index].scope_path }}</div>
            <div role="cell" class="table-cell"><StatusBadge :status="sortedReservations[v.index].status" /></div>
            <div role="cell" class="table-cell text-right tabular-nums">
              {{ sortedReservations[v.index].reserved.amount.toLocaleString() }}
              <span class="muted-sm">{{ sortedReservations[v.index].reserved.unit }}</span>
            </div>
            <div role="cell" class="table-cell muted-sm" :title="formatDateTime(new Date(sortedReservations[v.index].created_at_ms).toISOString())">
              {{ ageLabel(sortedReservations[v.index]) }}
            </div>
            <div role="cell" class="table-cell text-xs" :class="isExpired(sortedReservations[v.index]) && sortedReservations[v.index].status === 'ACTIVE' ? 'text-red-600 font-medium' : 'muted'">
              {{ formatRelative(new Date(sortedReservations[v.index].expires_at_ms).toISOString()) }}
              <span v-if="isExpired(sortedReservations[v.index]) && sortedReservations[v.index].status === 'ACTIVE'" class="ml-1" title="Past expiry — this reservation is overdue for cleanup">⚠</span>
            </div>
            <div v-if="canManage" role="cell" class="table-cell">
              <!-- Every state always shows Activity + Copy ID so the kebab
                   never renders a single-action menu. Force release is
                   gated on ACTIVE; COMMITTED / RELEASED / EXPIRED are
                   terminal and only expose the read-only pair.
                   Activity drills via resource_id alone because the
                   audit resource_type enum has no 'reservation' value. -->
              <RowActionsMenu
                :aria-label="`Actions for reservation ${sortedReservations[v.index].reservation_id}`"
                :items="[
                  { label: 'Activity', to: { name: 'audit', query: { resource_id: sortedReservations[v.index].reservation_id } } },
                  { label: 'Copy reservation ID', onClick: () => copyReservationId(sortedReservations[v.index].reservation_id) },
                  { label: 'Copy as JSON', onClick: () => copyReservationJson(sortedReservations[v.index]) },
                  { separator: true },
                  { label: 'Force release', onClick: () => openRelease(sortedReservations[v.index]), danger: true, hidden: sortedReservations[v.index].status !== 'ACTIVE' },
                ]"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- Empty state lives outside the virtualized body — the virtualizer
           only understands row-indexed content. -->
      <div v-else-if="!loadingList">
        <EmptyState
          :message="tenantFilter
            ? (statusFilter ? `No ${statusFilter} reservations for this tenant` : 'No reservations for this tenant')
            : 'Pick a tenant to list reservations'"
          :hint="tenantFilter ? undefined : 'Reservations are listed per-tenant — the runtime spec requires scoping.'"
        />
      </div>
    </div>

    <!-- Load more. Pre-R4 the view hardcoded limit=100 and silently
         truncated. Polling replays page 1, so the loaded tail is
         dropped every 30s — operators who want to scan deeper should
         narrow the filter (status, tenant) rather than paginate. -->
    <div v-if="hasMore || loadingMore" class="mt-3 flex items-center justify-between">
      <p class="muted-sm">Showing {{ reservations.length.toLocaleString() }}. Polling refreshes page 1 every 30s, discarding any additional pages loaded below.</p>
      <button
        @click="loadMore"
        :disabled="loadingMore || !nextCursor"
        class="text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50 cursor-pointer"
      >
        {{ loadingMore ? 'Loading…' : 'Load more' }}
      </button>
    </div>

    <!-- Force-release form. FormDialog (not ConfirmAction) because we
         need a user-editable reason input. Spec SHOULD-guidance:
         callers populate `reason` with a structured prefix for
         grep-ability in the audit log — pre-filled so the common
         case is one click. -->
    <FormDialog
      v-if="pendingRelease"
      title="Force release this reservation?"
      submit-label="Force release"
      :loading="releaseLoading"
      :error="releaseError"
      @submit="submitRelease"
      @cancel="pendingRelease = null"
    >
      <p class="text-sm text-gray-600">
        Releases <strong class="font-semibold">{{ pendingRelease.reserved.amount.toLocaleString() }} {{ pendingRelease.reserved.unit }}</strong>
        back to the tenant's budget. Scope
        <code class="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded">{{ pendingRelease.scope_path }}</code>
        will be available for new reservations immediately.
      </p>
      <p class="muted-sm">
        Audit log records <code class="font-mono">actor_type=admin_on_behalf_of</code> so this action is traceable
        via the Audit tab.
      </p>
      <div>
        <label for="release-reason" class="form-label">Reason (for audit log)</label>
        <input
          id="release-reason"
          v-model="releaseReason"
          maxlength="256"
          class="border border-gray-300 rounded px-2 py-1 text-sm w-full"
          placeholder="[INCIDENT_FORCE_RELEASE] hung after redis restart"
        />
        <p class="muted-sm mt-0.5">
          Stored on the audit-log entry. Structured prefix like
          <code class="font-mono">[INCIDENT_FORCE_RELEASE]</code> makes later grep easier.
        </p>
      </div>
    </FormDialog>

    <ExportDialog
      :format="showExportConfirm"
      :loaded-count="reservations.length"
      :has-more="hasMore"
      :max-rows="EXPORT_MAX_ROWS"
      item-noun-plural="reservations"
      @confirm="executeExport"
      @cancel="cancelExport"
    />
    <ExportProgressOverlay
      :open="exporting"
      :fetched="exportFetched"
      :cancellable="exportCancellable"
      item-noun-plural="reservations"
      @cancel="cancelRunningExport"
    />
  </div>
</template>

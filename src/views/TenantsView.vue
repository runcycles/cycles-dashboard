<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { useSort } from '../composables/useSort'
import { useDebouncedRef } from '../composables/useDebouncedRef'
import { useListExport } from '../composables/useListExport'
import { listTenants, createTenant, updateTenantStatus } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { Tenant } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import ExportDialog from '../components/ExportDialog.vue'
import ExportProgressOverlay from '../components/ExportProgressOverlay.vue'
import FormDialog from '../components/FormDialog.vue'
import ConfirmAction from '../components/ConfirmAction.vue'
import { formatDate } from '../utils/format'
import { useToast } from '../composables/useToast'
import { toMessage } from '../utils/errors'

const toast = useToast()

const router = useRouter()
const auth = useAuthStore()
const canManage = computed(() => auth.capabilities?.manage_tenants !== false)

const tenants = ref<Tenant[]>([])
const error = ref('')
const search = ref('')
const parentFilter = ref('')

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
  if (debouncedSearch.value) {
    const q = debouncedSearch.value.toLowerCase()
    out = out.filter(t => t.tenant_id.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
  }
  return out
})
// Default sort: newest tenants first. created_at is an ISO-8601 string,
// which sorts lexicographically in chronological order, so 'desc' ==
// newest first. Click any header to switch to that column's natural order.
const { sortKey, sortDir, toggle, sorted: sortedTenants } = useSort(filteredTenants, 'created_at', 'desc')

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
watch([search, parentFilter], () => { selected.value = new Set() })
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
const bulkCancelRequested = ref(false)

function openBulk(action: 'SUSPENDED' | 'ACTIVE') {
  bulkAction.value = action
}
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
  bulkCancelRequested.value = false
  for (const t of targets) {
    if (bulkCancelRequested.value) break
    try {
      await updateTenantStatus(t.tenant_id, action)
    } catch (e) {
      bulkProgress.value.failed++
      // Don't toast per failure — one summary at the end is less noisy.
      console.warn(`bulk ${action} failed on ${t.tenant_id}:`, toMessage(e))
    }
    bulkProgress.value.done++
  }
  bulkRunning.value = false
  const summary = `${bulkProgress.value.done - bulkProgress.value.failed}/${bulkProgress.value.total} tenants ${action === 'SUSPENDED' ? 'suspended' : 'reactivated'}`
  if (bulkProgress.value.failed > 0) {
    toast.error(`${summary}, ${bulkProgress.value.failed} failed — check console for details`)
  } else if (bulkCancelRequested.value) {
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
    bulkCancelRequested.value = true
  } else {
    bulkAction.value = null
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

const { refresh, isLoading, lastUpdated } = usePolling(async () => {
  try {
    const res = await listTenants()
    tenants.value = res.tenants
    hasMore.value = !!res.has_more
    nextCursor.value = res.next_cursor ?? ''
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
}, 60000)

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
  maxRows: EXPORT_MAX_ROWS,
  confirmExport,
  cancelExport,
  executeExport,
} = useListExport<Tenant>({
  itemNoun: 'tenant',
  filenameStem: 'tenants',
  currentItems: filteredTenants,
  hasMore,
  nextCursor,
  fetchPage: async (cursor) => {
    const res = await listTenants({ cursor })
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
    const res = await listTenants({ cursor: nextCursor.value })
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
  <div>
    <PageHeader
      title="Tenants"
      item-noun="tenant"
      :loaded="filteredTenants.length"
      :has-more="hasMore"
      :loading="isLoading"
      :last-updated="lastUpdated"
      @refresh="refresh"
    >
      <template #actions>
        <button @click="confirmExport('csv')" :disabled="filteredTenants.length === 0" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          Export CSV
        </button>
        <button @click="confirmExport('json')" :disabled="filteredTenants.length === 0" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          Export JSON
        </button>
        <button v-if="canManage" @click="openCreate" class="text-xs bg-blue-600 text-white hover:bg-blue-700 rounded px-3 py-1.5 cursor-pointer transition-colors">Create Tenant</button>
      </template>
    </PageHeader>
    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg table-cell mb-4">{{ error }}</p>

    <!-- Search + parent filter -->
    <div class="mb-4 flex gap-3 flex-wrap items-center">
      <input v-model="search" placeholder="Search by ID or name..." class="border border-gray-300 rounded px-3 py-1.5 text-sm max-w-xs flex-1 min-w-[14rem]" />
      <select v-model="parentFilter" aria-label="Filter by parent tenant" class="form-select">
        <option value="">All tenants</option>
        <option value="__root__">(root-level only)</option>
        <option v-for="p in parentOptions" :key="p.tenant_id" :value="p.tenant_id">Children of: {{ p.name || p.tenant_id }}</option>
      </select>
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
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      </Transition>
    </Teleport>

    <!-- V1 virtualized grid. Pattern established in ReservationsView:
         role="table" outer, sticky role="rowgroup" header, scroll
         container with absolute-positioned virtualized rows. -->
    <div
      class="bg-white rounded-lg shadow overflow-hidden text-sm"
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
        class="overflow-auto"
        style="max-height: calc(100vh - 360px); min-height: 200px;"
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
              <button v-if="sortedTenants[v.index].status === 'ACTIVE'" @click="pendingStatusAction = { tenantId: sortedTenants[v.index].tenant_id, name: sortedTenants[v.index].name, action: 'SUSPENDED' }" class="btn-row-danger">Suspend</button>
              <button v-if="sortedTenants[v.index].status === 'SUSPENDED'" @click="pendingStatusAction = { tenantId: sortedTenants[v.index].tenant_id, name: sortedTenants[v.index].name, action: 'ACTIVE' }" class="btn-row-success">Reactivate</button>
            </div>
          </div>
        </div>
      </div>

      <div v-else>
        <EmptyState
          item-noun="tenant"
          :has-active-filter="!!(search || parentFilter)"
          :hint="search || parentFilter ? undefined : 'Tenants will appear here once created'"
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
      item-noun-plural="tenants"
    />
  </div>
</template>

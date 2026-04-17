<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { usePolling } from '../composables/usePolling'
import { useSort } from '../composables/useSort'
import { useListExport } from '../composables/useListExport'
import { listTenants, listApiKeys, revokeApiKey, createApiKey, updateApiKey } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { Tenant, ApiKey, ApiKeyCreateResponse } from '../types'
import { PERMISSIONS } from '../types'
import PermissionPicker from '../components/PermissionPicker.vue'
import StatusBadge from '../components/StatusBadge.vue'
import MaskedValue from '../components/MaskedValue.vue'
import PageHeader from '../components/PageHeader.vue'
import TenantLink from '../components/TenantLink.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import ConfirmAction from '../components/ConfirmAction.vue'
import FormDialog from '../components/FormDialog.vue'
import SecretReveal from '../components/SecretReveal.vue'
import ExportDialog from '../components/ExportDialog.vue'
import ExportProgressOverlay from '../components/ExportProgressOverlay.vue'
import { formatDateTime } from '../utils/format'
import { useToast } from '../composables/useToast'
import { toMessage } from '../utils/errors'

const toast = useToast()

interface KeyWithTenant extends ApiKey {
  tenant_name?: string
}

const auth = useAuthStore()
const canManage = computed(() => auth.capabilities?.manage_api_keys !== false)
const keys = ref<KeyWithTenant[]>([])
const error = ref('')
const filterStatus = ref('')
const filterTenant = ref('')
const tenants = ref<Tenant[]>([])
const pendingRevoke = ref<KeyWithTenant | null>(null)

// R1 wire-up (cycles-server-admin v0.1.25.22+). The /admin/api-keys
// endpoint now accepts admin-key auth without a tenant_id filter and
// returns rows across every tenant with a composite cursor
// `{tenantId}|{keyId}`. One request per page replaces the old
// per-tenant fan-out; filterTenant === '' takes the cross-tenant path,
// filterTenant === '<id>' still scopes to that tenant server-side.
const PAGE_SIZE = 100
const hasMore = ref(false)
const nextCursor = ref('')
const loadingMore = ref(false)
// Tenant lookup map — O(1) resolution of tenant_name per row instead
// of Array.find scanning N tenants on every render pass.
const tenantsById = computed(() => {
  const m = new Map<string, Tenant>()
  for (const t of tenants.value) m.set(t.tenant_id, t)
  return m
})

async function executeRevoke() {
  if (!pendingRevoke.value) return
  try {
    await revokeApiKey(pendingRevoke.value.key_id, 'Revoked via admin dashboard')
    toast.success('API key revoked')
    await refresh()
  } catch (e) {
    const msg = toMessage(e)
    error.value = msg
    toast.error(`Revoke failed: ${msg}`)
  }
  finally { pendingRevoke.value = null }
}

// Create API key
const showCreate = ref(false)
const createLoading = ref(false)
const createError = ref('')
const createForm = ref({ tenant_id: '', name: '', permissions: [] as string[], scope_filter: '', expires_at: '' })
const createdSecret = ref<ApiKeyCreateResponse | null>(null)

async function submitCreate() {
  createError.value = ''
  createLoading.value = true
  try {
    const body: Record<string, unknown> = { tenant_id: createForm.value.tenant_id, name: createForm.value.name }
    if (createForm.value.permissions.length) body.permissions = createForm.value.permissions
    if (createForm.value.scope_filter) body.scope_filter = createForm.value.scope_filter.split(',').map(s => s.trim()).filter(Boolean)
    if (createForm.value.expires_at) body.expires_at = new Date(createForm.value.expires_at).toISOString()
    const res = await createApiKey(body as any)
    createdSecret.value = res
    showCreate.value = false
  } catch (e) { createError.value = toMessage(e) }
  finally { createLoading.value = false }
}

function openCreate() {
  createForm.value = { tenant_id: tenants.value[0]?.tenant_id || '', name: '', permissions: [], scope_filter: '', expires_at: '' }
  createError.value = ''
  showCreate.value = true
}

// Edit API key
const editingKey = ref<KeyWithTenant | null>(null)
const editLoading = ref(false)
const editError = ref('')
const editForm = ref({ name: '', permissions: [] as string[], scope_filter: '' })

function openEdit(k: KeyWithTenant) {
  // Filter out any stored permission that isn't in the canonical PERMISSIONS
  // set. Unknown values (legacy records like `decide`, typos from direct
  // Redis writes, values that predate the current spec) have no checkbox in
  // the UI and, if left in the form's `permissions` array, would ride along
  // in every PATCH body — the admin server then rejects the whole request
  // with 400 "Unrecognized permission: <value>". Filtering here means the
  // operator can edit the key; saving the form implicitly drops the bad
  // value. Warn them so the drop isn't silent.
  const allowed = new Set<string>(PERMISSIONS as readonly string[])
  const stored = k.permissions || []
  const dropped = stored.filter(p => !allowed.has(p))
  const kept = stored.filter(p => allowed.has(p))
  editForm.value = {
    name: k.name || '',
    permissions: kept,
    scope_filter: k.scope_filter?.join(', ') || '',
  }
  editError.value = ''
  editingKey.value = k
  if (dropped.length) {
    toast.error(`Unrecognized permissions will be removed on save: ${dropped.join(', ')}`)
  }
}

// Deep-compare two string arrays as sets — order-insensitive equality for
// permission / scope_filter diffs. Same length and same member set means
// no change from the operator's perspective.
function sameStringSet(a: string[] | undefined, b: string[] | undefined): boolean {
  const aa = a || []
  const bb = b || []
  if (aa.length !== bb.length) return false
  const sa = new Set(aa)
  for (const v of bb) if (!sa.has(v)) return false
  return true
}

// Pending-changes summary for the edit dialog. Shows what the operator
// will add / remove on Save, so the picker's state-change intent is
// visible at a glance before the PATCH goes out. Also catches the
// openEdit-time legacy-perm filter (e.g. `decide` shows up as a
// pending removal alongside the toast) which makes the cleanup
// behavior explicit rather than implicit.
const pendingPermAdds = computed<string[]>(() => {
  if (!editingKey.value) return []
  const orig = new Set(editingKey.value.permissions || [])
  return editForm.value.permissions.filter(p => !orig.has(p))
})
const pendingPermRemoves = computed<string[]>(() => {
  if (!editingKey.value) return []
  const curr = new Set(editForm.value.permissions)
  return (editingKey.value.permissions || []).filter(p => !curr.has(p))
})

async function submitEdit() {
  if (!editingKey.value) return
  editError.value = ''
  editLoading.value = true
  try {
    // Only send fields the user actually changed. Round-tripping unchanged
    // permissions was triggering spurious 400s when a stored key carried any
    // permission value that differs from the current server's closed enum
    // (legacy records, schema drift). The server-side fix now returns a
    // descriptive error if validation fails; this change avoids triggering
    // it at all for the common "rename" case.
    const body: Record<string, unknown> = {}
    const original = editingKey.value
    if (editForm.value.name !== (original.name || '')) {
      body.name = editForm.value.name
    }
    if (!sameStringSet(editForm.value.permissions, original.permissions)) {
      body.permissions = editForm.value.permissions
    }
    const scopes = editForm.value.scope_filter
      ? editForm.value.scope_filter.split(',').map(s => s.trim()).filter(Boolean)
      : []
    if (!sameStringSet(scopes, original.scope_filter)) {
      body.scope_filter = scopes
    }
    if (Object.keys(body).length === 0) {
      // Nothing to submit — close the dialog quietly.
      editingKey.value = null
      return
    }
    await updateApiKey(original.key_id, body as any)
    toast.success('API key updated')
    editingKey.value = null
    await refresh()
  } catch (e) { editError.value = toMessage(e) }
  finally { editLoading.value = false }
}

const filteredKeys = computed(() => {
  let result = keys.value
  if (filterStatus.value) result = result.filter(k => k.status === filterStatus.value)
  if (filterTenant.value) result = result.filter(k => k.tenant_id === filterTenant.value)
  return result
})
// Default sort: newest keys first. created_at is an ISO-8601 string, which
// sorts lexicographically in chronological order, so 'desc' == newest first.
//
// V4 stage 2: server-side sort on admin-plane listApiKeys (columns
// key_id, name, tenant_id, status, created_at, expires_at). onChange
// re-fetches page 1 via refresh() so the cursor tuple stays consistent
// with the new (sort_by, sort_dir) pair. Client-side status filter
// still runs on top of the server-sorted page.
const { sortKey, sortDir, toggle, sorted: sortedKeys } = useSort(
  filteredKeys,
  'created_at',
  'desc',
  undefined,
  { serverSide: true, onChange: () => { refresh() } },
)

const statusCounts = computed(() => {
  const counts: Record<string, number> = {}
  for (const k of keys.value) {
    counts[k.status] = (counts[k.status] || 0) + 1
  }
  return counts
})

const hasActiveFilters = computed(() => !!(filterStatus.value || filterTenant.value))
function clearFilters() { filterStatus.value = ''; filterTenant.value = '' }

function decorate(list: ApiKey[]): KeyWithTenant[] {
  return list.map((k) => ({ ...k, tenant_name: tenantsById.value.get(k.tenant_id)?.name }))
}

async function fetchKeysPage(cursor?: string): Promise<{
  keys: KeyWithTenant[]
  hasMore: boolean
  nextCursor: string
}> {
  const params: Record<string, string> = { limit: String(PAGE_SIZE) }
  if (filterTenant.value) params.tenant_id = filterTenant.value
  if (cursor) params.cursor = cursor
  if (sortKey.value) {
    params.sort_by = sortKey.value
    params.sort_dir = sortDir.value
  }
  const res = await listApiKeys(params)
  return {
    keys: decorate(res.keys),
    hasMore: !!res.has_more,
    nextCursor: res.next_cursor ?? '',
  }
}

const { refresh, isLoading, lastUpdated } = usePolling(async () => {
  try {
    const tRes = await listTenants()
    tenants.value = tRes.tenants
    // Single cross-tenant listApiKeys — no per-tenant fan-out. Polling
    // always refetches page 1 and drops any accumulated "Load more"
    // pages; tenants' key sets change infrequently enough that this
    // is the right trade-off (fresh data > accumulated scroll state).
    const first = await fetchKeysPage()
    keys.value = first.keys
    hasMore.value = first.hasMore
    nextCursor.value = first.nextCursor
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
}, 60000)

async function loadMore() {
  if (loadingMore.value || !nextCursor.value) return
  loadingMore.value = true
  try {
    const res = await fetchKeysPage(nextCursor.value)
    keys.value = [...keys.value, ...res.keys]
    hasMore.value = res.hasMore
    nextCursor.value = res.nextCursor
  } catch (e) { error.value = toMessage(e) }
  finally { loadingMore.value = false }
}

// Refresh on filter change so we restart page-1 scoped to the new tenant.
watch(filterTenant, () => { refresh() })

// Export. ApiKeysView is a cross-tenant aggregation (no cursor
// endpoint) — since the server now exposes cursor-paginated cross-tenant
// listApiKeys, the export can walk the full result set honestly. The
// composable drives pages via fetchPage(cursor); each page is appended
// up to the EXPORT_MAX_ROWS guardrail inside useListExport.
const {
  showExportConfirm,
  exporting,
  exportFetched,
  exportError,
  maxRows: EXPORT_MAX_ROWS,
  confirmExport,
  cancelExport,
  executeExport,
} = useListExport<KeyWithTenant>({
  itemNoun: 'api key',
  filenameStem: 'api-keys',
  currentItems: filteredKeys,
  hasMore,
  nextCursor,
  fetchPage: async (cursor) => {
    const r = await fetchKeysPage(cursor)
    return { items: r.keys, hasMore: r.hasMore, nextCursor: r.nextCursor }
  },
  columns: [
    { header: 'key_id',       value: k => k.key_id },
    { header: 'name',         value: k => k.name ?? '' },
    { header: 'tenant_id',    value: k => k.tenant_id },
    { header: 'tenant_name',  value: k => k.tenant_name ?? '' },
    { header: 'status',       value: k => k.status },
    { header: 'permissions',  value: k => (k.permissions ?? []).join('|') },
    { header: 'scope_filter', value: k => (k.scope_filter ?? []).join('|') },
    { header: 'created_at',   value: k => k.created_at },
    { header: 'expires_at',   value: k => k.expires_at ?? '' },
  ],
})

watch(exportError, (v) => { if (v) error.value = v })

// V1 virtualization.
const scrollEl = ref<HTMLElement | null>(null)
// 76px accommodates two rows of permission chips (chip ~28px × 2 +
// gap + cell padding). Trades a little vertical density for the ability
// to preview 4 perms (2 per row) instead of 2 inline — the operators
// asked for this explicitly, scanning 4 perms at a glance beats
// opening the dialog for every key with > 2 perms.
const ROW_HEIGHT_ESTIMATE = 76
const virtualizer = useVirtualizer(computed(() => ({
  count: sortedKeys.value.length,
  getScrollElement: () => scrollEl.value,
  estimateSize: () => ROW_HEIGHT_ESTIMATE,
  overscan: 8,
})))
const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalHeight = computed(() => virtualizer.value.getTotalSize())

// 9-column grid when canManage, 8 without. Wide total minimum
// (~1380px) so horizontal scroll engages on smaller viewports; same
// behavior as the pre-virt `min-w-[900px]` table. Permissions column
// widened (260px min, 2.5fr) so more chips fit before the +N counter
// kicks in — common keys have 2-4 perms which now render inline.
const gridTemplate = computed(() =>
  canManage.value
    ? '180px minmax(120px,1fr) minmax(120px,1fr) 100px minmax(260px,2.5fr) minmax(140px,1fr) 160px 140px 160px'
    : '180px minmax(120px,1fr) minmax(120px,1fr) 100px minmax(260px,2.5fr) minmax(140px,1fr) 160px 140px',
)

// Permissions cell compromise: show a single pill "N permissions"
// that's always-visible and click-expandable. The pre-fix "N inline
// chips + N hidden" approach fought the overflow-hidden boundary —
// on narrow viewports the +N counter disappeared into the clipped
// region and operators had no discoverable escape hatch. Now the
// pill is fixed-width, doesn't depend on the chip row's measured
// width, and clicking it opens a full-permissions dialog.
const viewingPermsFor = ref<KeyWithTenant | null>(null)
function openPermsViewer(k: KeyWithTenant) { viewingPermsFor.value = k }
function closePermsViewer() { viewingPermsFor.value = null }
</script>

<template>
  <!-- Phase 5 (table-layout unification): flex-fill root. ApiKeys
       also has the outer overflow-x-auto + inner min-width shim
       pattern; with <main> now overflow-y-auto only, the shell's
       x-scrollbar is the single horizontal scroll (no more double
       bar on viewports < 1220/1380px). -->
  <div class="h-full flex flex-col min-h-0">
    <PageHeader
      title="API Keys"
      item-noun="key"
      :loaded="filteredKeys.length"
      :loading="isLoading"
      :last-updated="lastUpdated"
      @refresh="refresh"
    >
      <template #actions>
        <button @click="confirmExport('csv')" :disabled="filteredKeys.length === 0" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          Export CSV
        </button>
        <button @click="confirmExport('json')" :disabled="filteredKeys.length === 0" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          Export JSON
        </button>
        <button v-if="canManage" @click="openCreate" class="text-xs bg-blue-600 text-white hover:bg-blue-700 rounded px-3 py-1.5 cursor-pointer transition-colors">Create API Key</button>
      </template>
    </PageHeader>

    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg table-cell mb-4">{{ error }}</p>

    <!-- Summary -->
    <div v-if="keys.length > 0" class="flex gap-3 mb-4">
      <div v-for="(count, status) in statusCounts" :key="status" class="bg-white rounded-lg shadow px-4 py-2 flex items-center gap-2">
        <StatusBadge :status="String(status)" />
        <span class="text-sm font-medium text-gray-700">{{ count }}</span>
      </div>
    </div>

    <!-- Filters -->
    <div class="card p-4 mb-4">
      <div class="flex gap-3 flex-wrap items-end">
        <div>
          <label for="keys-tenant" class="form-label">Tenant</label>
          <select id="keys-tenant" v-model="filterTenant" class="form-select">
            <option value="">All tenants</option>
            <option v-for="t in tenants" :key="t.tenant_id" :value="t.tenant_id">{{ t.name || t.tenant_id }}</option>
          </select>
        </div>
        <div>
          <label for="keys-status" class="form-label">Status</label>
          <select id="keys-status" v-model="filterStatus" class="form-select">
            <option value="">All</option>
            <option>ACTIVE</option>
            <option>REVOKED</option>
            <option>EXPIRED</option>
          </select>
        </div>
        <button v-if="hasActiveFilters" @click="clearFilters" class="muted-sm hover:text-gray-700 cursor-pointer">Clear</button>
        <div v-if="isLoading" class="flex items-center">
          <svg class="w-4 h-4 muted animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
        </div>
      </div>
    </div>

    <p v-if="filteredKeys.length > 0" class="muted-sm mb-2">{{ filteredKeys.length }} key{{ filteredKeys.length !== 1 ? 's' : '' }}</p>

    <!-- V1 virtualized grid. Wide minimum width — horizontal scroll
         engages on narrower viewports, same behavior as pre-virt
         `min-w-[900px]` <table>.
         Structure: OUTER container owns the single horizontal-scroll
         (overflow-x-auto). An INNER wrapper enforces the min-width
         so both header and virtualized body share the same column
         bounds. The scroll container below only handles vertical
         scroll (overflow-y-auto). Having min-width on both header
         and body divs AND overflow-x on the outer created two
         separate horizontal scrollbars that fought each other on
         resize — now there's one. -->
    <div
      class="bg-white rounded-lg shadow overflow-x-auto text-sm flex-1 min-h-0 flex flex-col"
      role="table"
      :aria-rowcount="filteredKeys.length + 1"
      :aria-colcount="canManage ? 9 : 8"
    >
     <div :style="{ minWidth: canManage ? '1380px' : '1220px' }" class="flex flex-col flex-1 min-h-0">
      <div role="rowgroup" class="table-header border-b border-gray-200 sticky top-0 z-10">
        <div role="row" class="grid text-xs font-bold uppercase tracking-wider" :style="{ gridTemplateColumns: gridTemplate }">
          <SortHeader as="div" label="Key ID" column="key_id" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Name" column="name" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Tenant" column="tenant_id" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Status" column="status" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <div role="columnheader" class="table-cell text-left">Permissions</div>
          <div role="columnheader" class="table-cell text-left">Scope Filter</div>
          <SortHeader as="div" label="Created" column="created_at" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <SortHeader as="div" label="Expires" column="expires_at" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          <div v-if="canManage" role="columnheader" class="table-cell" data-column="action"></div>
        </div>
      </div>

      <div
        v-if="sortedKeys.length > 0"
        ref="scrollEl"
        role="rowgroup"
        class="flex-1 overflow-y-auto min-h-[200px]"
      >
        <div role="presentation" :style="{ height: totalHeight + 'px', position: 'relative' }">
          <div
            v-for="v in virtualRows"
            :key="sortedKeys[v.index].key_id"
            role="row"
            :aria-rowindex="v.index + 2"
            class="grid table-row-hover border-b border-gray-100 absolute left-0 right-0 items-center"
            :style="{ gridTemplateColumns: gridTemplate, transform: `translateY(${v.start}px)`, height: ROW_HEIGHT_ESTIMATE + 'px' }"
          >
            <div role="cell" class="table-cell"><MaskedValue :value="sortedKeys[v.index].key_id" /></div>
            <div role="cell" class="table-cell text-gray-700 truncate">{{ sortedKeys[v.index].name || '-' }}</div>
            <div role="cell" class="table-cell">
              <TenantLink :tenant-id="sortedKeys[v.index].tenant_id" />
            </div>
            <div role="cell" class="table-cell"><StatusBadge :status="sortedKeys[v.index].status" /></div>
            <div role="cell" class="table-cell muted-sm">
              <!-- Preview 4 chips (wraps 2-per-line inside the column
                   width) + always-visible "N perms" pill for the full
                   list. Row height is 76px to fit two chip rows.
                   - Chips sit in a flex-wrap min-w-0 container on the
                     left; at typical column widths this wraps to 2x2.
                   - Pill on the right, flex-shrink-0, self-start so it
                     anchors to the top even when chips wrap.
                   - If a key has > 4 permissions the pill's count (e.g.
                     "6 perms") signals there's more; click to open. -->
              <div v-if="(sortedKeys[v.index].permissions?.length ?? 0) > 0" class="flex gap-2 items-start">
                <div class="flex flex-wrap gap-1 min-w-0 flex-1">
                  <span
                    v-for="p in (sortedKeys[v.index].permissions ?? []).slice(0, 4)"
                    :key="p"
                    class="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded whitespace-nowrap"
                  >{{ p }}</span>
                </div>
                <button
                  type="button"
                  @click.prevent="openPermsViewer(sortedKeys[v.index])"
                  class="inline-flex items-center gap-1 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded px-2 py-0.5 cursor-pointer transition-colors flex-shrink-0"
                  :aria-label="`View all ${sortedKeys[v.index].permissions!.length} permissions for ${sortedKeys[v.index].name || sortedKeys[v.index].key_id}`"
                  :title="`View all ${sortedKeys[v.index].permissions!.length} permissions`"
                >
                  <span class="tabular-nums font-medium">{{ sortedKeys[v.index].permissions!.length }}</span>
                  <span class="text-xs">perm{{ sortedKeys[v.index].permissions!.length === 1 ? '' : 's' }}</span>
                  <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                  </svg>
                </button>
              </div>
              <span v-else class="text-gray-400">—</span>
            </div>
            <div role="cell" class="table-cell muted-sm font-mono truncate" :title="sortedKeys[v.index].scope_filter?.join(', ')">{{ sortedKeys[v.index].scope_filter?.join(', ') || '-' }}</div>
            <div role="cell" class="table-cell muted-sm whitespace-nowrap">{{ formatDateTime(sortedKeys[v.index].created_at) }}</div>
            <div role="cell" class="table-cell text-xs muted whitespace-nowrap">
              {{ sortedKeys[v.index].expires_at ? formatDateTime(sortedKeys[v.index].expires_at) : 'Never' }}
            </div>
            <div v-if="canManage" role="cell" class="table-cell">
              <div class="flex gap-2">
                <!-- One-click drill into audit log pre-filtered by this
                     key. Available regardless of status — investigating
                     revoked keys is the most common reason to want
                     their history. -->
                <router-link :to="{ name: 'audit', query: { key_id: sortedKeys[v.index].key_id } }" class="text-xs text-gray-600 hover:text-gray-800 cursor-pointer hover:underline">Activity</router-link>
                <button v-if="sortedKeys[v.index].status === 'ACTIVE'" @click="openEdit(sortedKeys[v.index])" class="btn-row-primary">Edit</button>
                <button v-if="sortedKeys[v.index].status === 'ACTIVE'" @click="pendingRevoke = sortedKeys[v.index]" class="btn-row-danger">Revoke</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-else>
        <EmptyState
          item-noun="API key"
          :has-active-filter="keys.length > 0"
          :hint="keys.length === 0 ? 'API keys will appear here once created' : undefined"
        />
      </div>
     </div>
    </div>

    <!-- Load-more footer — mirrors BudgetsView / TenantsView pattern. -->
    <div v-if="hasMore || loadingMore" class="mt-3 flex justify-end">
      <button @click="loadMore" :disabled="loadingMore" class="text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50 cursor-pointer">
        {{ loadingMore ? 'Loading...' : 'Load more' }}
      </button>
    </div>

    <!-- Create API Key dialog -->
    <FormDialog v-if="showCreate" title="Create API Key" submit-label="Create Key" :loading="createLoading" :error="createError" @submit="submitCreate" @cancel="showCreate = false">
      <div>
        <label for="ck-tenant" class="form-label">Tenant</label>
        <select id="ck-tenant" v-model="createForm.tenant_id" required class="form-select w-full">
          <option v-for="t in tenants" :key="t.tenant_id" :value="t.tenant_id">{{ t.name || t.tenant_id }}</option>
        </select>
      </div>
      <div>
        <label for="ck-name" class="form-label">Name</label>
        <input id="ck-name" v-model="createForm.name" required class="form-input" placeholder="my-service-key" />
      </div>
      <div>
        <label class="form-label">Permissions</label>
        <PermissionPicker v-model="createForm.permissions" />
      </div>
      <div>
        <label for="ck-scope" class="form-label">Scope filter (comma-separated, optional)</label>
        <input id="ck-scope" v-model="createForm.scope_filter" class="form-input-mono" placeholder="tenant:acme, tenant:acme/*" />
      </div>
      <div>
        <label for="ck-expires" class="form-label">Expires at (optional)</label>
        <input id="ck-expires" v-model="createForm.expires_at" type="datetime-local" class="border border-gray-300 rounded px-2 py-1.5 text-sm" />
      </div>
    </FormDialog>

    <!-- Secret reveal after creation -->
    <SecretReveal v-if="createdSecret" title="API Key Created" :secret="createdSecret.key_secret" label="API Key Secret" @close="createdSecret = null; refresh()" />

    <!-- Edit API Key dialog -->
    <FormDialog v-if="editingKey" title="Edit API Key" submit-label="Save Changes" :loading="editLoading" :error="editError" @submit="submitEdit" @cancel="editingKey = null">
      <div>
        <label for="ek-name" class="form-label">Name</label>
        <input id="ek-name" v-model="editForm.name" required class="form-input" />
      </div>
      <div>
        <label class="form-label">Permissions</label>
        <PermissionPicker v-model="editForm.permissions" />
        <!--
          Pending-changes summary. Rendered only when there's actually a
          diff — avoids visual noise on rename-only edits. Adds in green,
          removes in red; flex-wrap keeps the chip list tidy on narrow
          dialogs. aria-live so screen readers catch a newly-meaningful
          change as checkboxes toggle.
        -->
        <div
          v-if="pendingPermAdds.length || pendingPermRemoves.length"
          class="mt-2 text-xs flex flex-wrap gap-1 items-center"
          aria-live="polite"
        >
          <template v-if="pendingPermAdds.length">
            <span class="text-green-700 font-medium">Adding:</span>
            <span
              v-for="p in pendingPermAdds"
              :key="'add:' + p"
              class="bg-green-50 text-green-700 border border-green-200 rounded px-1.5 py-0.5 font-mono"
            >+{{ p }}</span>
          </template>
          <template v-if="pendingPermRemoves.length">
            <span class="text-red-700 font-medium" :class="pendingPermAdds.length ? 'ml-3' : ''">Removing:</span>
            <span
              v-for="p in pendingPermRemoves"
              :key="'rem:' + p"
              class="bg-red-50 text-red-700 border border-red-200 rounded px-1.5 py-0.5 font-mono"
            >−{{ p }}</span>
          </template>
        </div>
      </div>
      <div>
        <label for="ek-scope" class="form-label">Scope filter (comma-separated)</label>
        <input id="ek-scope" v-model="editForm.scope_filter" class="form-input-mono" />
      </div>
    </FormDialog>

    <ConfirmAction
      v-if="pendingRevoke"
      title="Revoke this API key?"
      :message="`Revoking key '${pendingRevoke.name || pendingRevoke.key_id}' (tenant: ${pendingRevoke.tenant_id}) will immediately invalidate it. Any services using this key will lose access. This cannot be undone.`"
      confirm-label="Revoke Key"
      :danger="true"
      @confirm="executeRevoke"
      @cancel="pendingRevoke = null"
    />

    <!-- Permissions viewer. Lightweight read-only modal — full
         permissions list with scope_filter for context. Opens when
         operators click the compact pill in the permissions column.
         Intentionally distinct from the Edit dialog (this is a
         view-only affordance; Edit is a separate click-through). -->
    <div
      v-if="viewingPermsFor"
      class="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      @click.self="closePermsViewer"
      @keyup.esc="closePermsViewer"
    >
      <div class="bg-white dark:bg-gray-900 dark:border dark:border-gray-700 rounded-lg shadow-lg p-5 max-w-md w-full mx-4 max-h-[80vh] flex flex-col">
        <div class="flex items-start justify-between mb-3">
          <div>
            <h3 class="text-sm font-semibold text-gray-900">Permissions</h3>
            <p class="muted-sm font-mono break-all">{{ viewingPermsFor.name || viewingPermsFor.key_id }}</p>
          </div>
          <button @click="closePermsViewer" aria-label="Close" class="muted hover:text-gray-700 cursor-pointer p-1 -mt-1 -mr-1 rounded hover:bg-gray-100">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div class="flex-1 overflow-y-auto">
          <p class="muted-sm mb-2">{{ viewingPermsFor.permissions?.length ?? 0 }} permission{{ (viewingPermsFor.permissions?.length ?? 0) === 1 ? '' : 's' }}</p>
          <div class="flex flex-wrap gap-1 mb-4">
            <span
              v-for="p in viewingPermsFor.permissions ?? []"
              :key="p"
              class="bg-gray-100 text-gray-700 font-mono text-xs px-2 py-1 rounded"
            >{{ p }}</span>
          </div>

          <template v-if="viewingPermsFor.scope_filter && viewingPermsFor.scope_filter.length > 0">
            <p class="muted-sm mb-2">Scope filter ({{ viewingPermsFor.scope_filter.length }})</p>
            <div class="flex flex-wrap gap-1">
              <span
                v-for="s in viewingPermsFor.scope_filter"
                :key="s"
                class="bg-blue-50 text-blue-800 font-mono text-xs px-2 py-1 rounded"
              >{{ s }}</span>
            </div>
          </template>
        </div>

        <div class="flex justify-end gap-2 mt-4 pt-3 border-t border-gray-100">
          <button @click="closePermsViewer" class="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 rounded hover:bg-gray-100 cursor-pointer">Close</button>
          <button
            v-if="canManage && viewingPermsFor.status === 'ACTIVE'"
            @click="() => { const k = viewingPermsFor; closePermsViewer(); if (k) openEdit(k) }"
            class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 cursor-pointer"
          >Edit permissions</button>
        </div>
      </div>
    </div>

    <ExportDialog
      :format="showExportConfirm"
      :loaded-count="filteredKeys.length"
      :has-more="hasMore"
      :max-rows="EXPORT_MAX_ROWS"
      item-noun-plural="API keys"
      warning="Exported files include permissions and scope filters for each key. Signing secrets are never exported."
      @confirm="executeExport"
      @cancel="cancelExport"
    />
    <ExportProgressOverlay
      :open="exporting"
      :fetched="exportFetched"
      item-noun-plural="API keys"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { usePolling } from '../composables/usePolling'
import { useSort } from '../composables/useSort'
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

// R1 mitigation (scale-hardening). The /admin/api-keys endpoint currently
// requires a tenant_id filter, so the view iterates all tenants and issues
// one listApiKeys() per tenant — O(N tenants) per 60s poll. Without this
// cap, a 1k-tenant deployment fires 1k sequential requests per minute
// from every open dashboard tab.
//
// The real fix is a tenant-agnostic /admin/api-keys (server spec change,
// tracked separately). Until then we cap the loop + parallelize in small
// batches + surface a banner so operators know the list may be truncated.
const TENANT_FANOUT_CAP = 100
const TENANT_FANOUT_CONCURRENCY = 4
const tenantsExamined = ref(0)
const tenantsTotal = ref(0)
const fanoutTruncated = computed(() => tenantsTotal.value > tenantsExamined.value)

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
const { sortKey, sortDir, toggle, sorted: sortedKeys } = useSort(filteredKeys, 'created_at', 'desc')

const statusCounts = computed(() => {
  const counts: Record<string, number> = {}
  for (const k of keys.value) {
    counts[k.status] = (counts[k.status] || 0) + 1
  }
  return counts
})

const hasActiveFilters = computed(() => !!(filterStatus.value || filterTenant.value))
function clearFilters() { filterStatus.value = ''; filterTenant.value = '' }

const { refresh, isLoading, lastUpdated } = usePolling(async () => {
  try {
    const tRes = await listTenants()
    tenants.value = tRes.tenants
    tenantsTotal.value = tRes.tenants.length

    // Fast path: tenant filter set. Fetch only that tenant's keys —
    // avoids the fan-out entirely AND guarantees the view shows the
    // right tenant even if it's past position TENANT_FANOUT_CAP in
    // the broader tenant list (correctness, not just performance).
    if (filterTenant.value) {
      const t = tRes.tenants.find((x) => x.tenant_id === filterTenant.value)
      if (t) {
        const kRes = await listApiKeys({ tenant_id: t.tenant_id })
        keys.value = kRes.keys.map((k) => ({ ...k, tenant_name: t.name }))
        tenantsExamined.value = 1
      } else {
        keys.value = []
        tenantsExamined.value = 0
      }
      error.value = ''
      return
    }

    // Cap the per-tenant fan-out. See TENANT_FANOUT_CAP comment for the
    // full rationale — summary: the API endpoint forces per-tenant
    // fetches, so we can't paginate the aggregate; best we can do until
    // the server exposes a tenant-agnostic list is bound the request
    // count and surface the truncation to operators.
    const targets = tRes.tenants.slice(0, TENANT_FANOUT_CAP)
    tenantsExamined.value = targets.length
    // Bounded-concurrency fan-out. Sequential was 2–3s at 1k tenants
    // and pegged backend rate-limits; Promise.all on everything would
    // DDoS the admin tier. 4 is a conservative middle ground —
    // Chrome's per-host connection limit is 6, and we want headroom
    // for the user's concurrent nav clicks.
    const allKeys: KeyWithTenant[] = []
    for (let i = 0; i < targets.length; i += TENANT_FANOUT_CONCURRENCY) {
      const batch = targets.slice(i, i + TENANT_FANOUT_CONCURRENCY)
      const results = await Promise.all(
        batch.map(async (t) => {
          const kRes = await listApiKeys({ tenant_id: t.tenant_id })
          return kRes.keys.map((k) => ({ ...k, tenant_name: t.name }))
        }),
      )
      for (const chunk of results) allKeys.push(...chunk)
    }
    keys.value = allKeys
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
}, 60000)

// When the tenant filter changes to a tenant outside the fan-out window,
// we'd otherwise be stuck showing "no keys" for a tenant that genuinely
// has keys. Refresh on filter change so the fast-path above picks it up.
watch(filterTenant, () => { refresh() })

// V1 virtualization.
const scrollEl = ref<HTMLElement | null>(null)
// 56px (vs 52 on other views) — accommodates the permissions chip row
// at text-xs line-height without clipping. Permissions still render
// flex-wrap but overflow-hidden caps at one row visually; operators
// can see the full list in the Edit dialog.
const ROW_HEIGHT_ESTIMATE = 56
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

// How many permission chips to render inline before collapsing the
// rest into a "+N" counter. Tuned against common keys (2-4 perms)
// on a 260px-min column: at text-xs font-mono, a chip like
// "budgets:read" is ~80px, so 3 chips typically fit comfortably.
// Keys with more permissions get "+N more" with the full list on
// the badge's title tooltip + on the row Edit dialog.
const MAX_VISIBLE_PERMS = 3
function hiddenPermsCount(perms: readonly string[] | undefined): number {
  return Math.max(0, (perms?.length ?? 0) - MAX_VISIBLE_PERMS)
}
</script>

<template>
  <div>
    <PageHeader title="API Keys" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh">
      <template #actions>
        <button v-if="canManage" @click="openCreate" class="text-xs bg-blue-600 text-white hover:bg-blue-700 rounded px-3 py-1.5 cursor-pointer transition-colors">Create API Key</button>
      </template>
    </PageHeader>

    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg table-cell mb-4">{{ error }}</p>

    <!-- R1 mitigation: surface the per-tenant fan-out cap. Banner appears
         only when the truncation is active, so small deployments see
         nothing. Points operators at the tenant filter as the workaround
         until the tenant-agnostic server endpoint ships. -->
    <p
      v-if="fanoutTruncated"
      class="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-4 py-2 mb-4"
      role="status"
    >
      Showing keys for the first <strong>{{ tenantsExamined.toLocaleString() }}</strong> of
      <strong>{{ tenantsTotal.toLocaleString() }}</strong> tenants. Use the
      tenant filter to narrow to a specific tenant beyond this window.
    </p>

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
      class="bg-white rounded-lg shadow overflow-x-auto text-sm"
      role="table"
      :aria-rowcount="filteredKeys.length + 1"
      :aria-colcount="canManage ? 9 : 8"
    >
     <div :style="{ minWidth: canManage ? '1380px' : '1220px' }">
      <div role="rowgroup" class="table-header border-b border-gray-200 sticky top-0 z-10">
        <div role="row" class="grid text-xs font-bold uppercase tracking-wider" :style="{ gridTemplateColumns: gridTemplate }">
          <div role="columnheader" class="table-cell text-left">Key ID</div>
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
        class="overflow-y-auto"
        style="max-height: calc(100vh - 400px); min-height: 200px;"
      >
        <div :style="{ height: totalHeight + 'px', position: 'relative' }">
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
            <div role="cell" class="table-cell muted-sm overflow-hidden">
              <div class="flex gap-1 flex-nowrap overflow-hidden" :title="sortedKeys[v.index].permissions?.join(', ')">
                <!-- Show first MAX_VISIBLE_PERMS chips inline; collapse
                     the rest into a "+N" counter. Title attr on both
                     the wrapper (all perms) and the counter (just the
                     hidden ones) so operators can hover either to see
                     the full list. Full permission editing remains in
                     the Edit dialog. -->
                <span
                  v-for="p in (sortedKeys[v.index].permissions ?? []).slice(0, MAX_VISIBLE_PERMS)"
                  :key="p"
                  class="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded whitespace-nowrap"
                >{{ p }}</span>
                <span
                  v-if="hiddenPermsCount(sortedKeys[v.index].permissions) > 0"
                  class="bg-gray-200 text-gray-700 px-1.5 py-0.5 rounded whitespace-nowrap font-medium"
                  :title="`Also: ${(sortedKeys[v.index].permissions ?? []).slice(MAX_VISIBLE_PERMS).join(', ')}`"
                >+{{ hiddenPermsCount(sortedKeys[v.index].permissions) }}</span>
              </div>
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

      <div v-else role="row">
        <EmptyState :message="keys.length === 0 ? 'No API keys found' : 'No keys match filters'" :hint="keys.length === 0 ? 'API keys will appear here once created' : undefined" />
      </div>
     </div>
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
  </div>
</template>

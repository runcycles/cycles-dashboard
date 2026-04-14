<script setup lang="ts">
import { ref, computed } from 'vue'
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
    const allKeys: KeyWithTenant[] = []
    for (const t of tRes.tenants) {
      const kRes = await listApiKeys({ tenant_id: t.tenant_id })
      for (const k of kRes.keys) {
        allKeys.push({ ...k, tenant_name: t.name })
      }
    }
    keys.value = allKeys
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
}, 60000)
</script>

<template>
  <div>
    <PageHeader title="API Keys" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh">
      <template #actions>
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
        <button v-if="hasActiveFilters" @click="clearFilters" class="text-xs text-gray-600 dark:text-gray-500 hover:text-gray-700 cursor-pointer">Clear</button>
        <div v-if="isLoading" class="flex items-center">
          <svg class="w-4 h-4 text-gray-600 dark:text-gray-400 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
        </div>
      </div>
    </div>

    <p v-if="filteredKeys.length > 0" class="text-xs text-gray-600 dark:text-gray-400 mb-2">{{ filteredKeys.length }} key{{ filteredKeys.length !== 1 ? 's' : '' }}</p>

    <div class="card-table">
      <table class="w-full text-sm min-w-[900px]">
        <thead class="table-header">
          <tr>
            <th class="table-cell text-left">Key ID</th>
            <SortHeader label="Name" column="name" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Tenant" column="tenant_id" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Status" column="status" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <th class="table-cell text-left">Permissions</th>
            <th class="table-cell text-left">Scope Filter</th>
            <SortHeader label="Created" column="created_at" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Expires" column="expires_at" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <th v-if="canManage" class="table-cell w-20"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="k in sortedKeys" :key="k.key_id" class="table-row-hover">
            <td class="table-cell"><MaskedValue :value="k.key_id" /></td>
            <td class="table-cell text-gray-700">{{ k.name || '-' }}</td>
            <td class="table-cell">
              <TenantLink :tenant-id="k.tenant_id" />
            </td>
            <td class="table-cell"><StatusBadge :status="k.status" /></td>
            <td class="table-cell text-xs text-gray-600 dark:text-gray-500">
              <div class="flex flex-wrap gap-1">
                <span v-for="p in k.permissions" :key="p" class="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{{ p }}</span>
              </div>
            </td>
            <td class="table-cell text-xs text-gray-600 dark:text-gray-500 font-mono">{{ k.scope_filter?.join(', ') || '-' }}</td>
            <td class="table-cell text-gray-600 dark:text-gray-400 text-xs whitespace-nowrap">{{ formatDateTime(k.created_at) }}</td>
            <td class="table-cell text-xs whitespace-nowrap" :class="k.expires_at ? 'text-gray-600 dark:text-gray-500' : 'text-gray-600 dark:text-gray-400'">
              {{ k.expires_at ? formatDateTime(k.expires_at) : 'Never' }}
            </td>
            <td v-if="canManage" class="table-cell">
              <div class="flex gap-2">
                <!-- v0.1.25.21 (#8): one-click drill into audit log
                     pre-filtered by this key. Available regardless of
                     status — investigating revoked keys is the most
                     common reason to want their history. -->
                <router-link :to="{ name: 'audit', query: { key_id: k.key_id } }" class="text-xs text-gray-600 hover:text-gray-800 cursor-pointer hover:underline">Activity</router-link>
                <button v-if="k.status === 'ACTIVE'" @click="openEdit(k)" class="text-xs text-blue-600 hover:text-blue-800 cursor-pointer hover:underline">Edit</button>
                <button v-if="k.status === 'ACTIVE'" @click="pendingRevoke = k" class="text-xs text-red-600 hover:text-red-800 cursor-pointer hover:underline">Revoke</button>
              </div>
            </td>
          </tr>
          <tr v-if="filteredKeys.length === 0">
            <td :colspan="canManage ? 9 : 8">
              <EmptyState :message="keys.length === 0 ? 'No API keys found' : 'No keys match filters'" :hint="keys.length === 0 ? 'API keys will appear here once created' : undefined" />
            </td>
          </tr>
        </tbody>
      </table>
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

<script setup lang="ts">
import { ref, computed } from 'vue'
import { usePolling } from '../composables/usePolling'
import { useSort } from '../composables/useSort'
import { listTenants, listApiKeys, revokeApiKey, createApiKey, updateApiKey } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { Tenant, ApiKey, ApiKeyCreateResponse } from '../types'
import { PERMISSIONS } from '../types'
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
    await refresh()
  } catch (e: any) { error.value = e.message }
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
  } catch (e: any) { createError.value = e.message }
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
  editForm.value = { name: k.name || '', permissions: [...k.permissions], scope_filter: k.scope_filter?.join(', ') || '' }
  editError.value = ''
  editingKey.value = k
}

async function submitEdit() {
  if (!editingKey.value) return
  editError.value = ''
  editLoading.value = true
  try {
    const body: Record<string, unknown> = { name: editForm.value.name }
    body.permissions = editForm.value.permissions
    if (editForm.value.scope_filter) body.scope_filter = editForm.value.scope_filter.split(',').map(s => s.trim()).filter(Boolean)
    else body.scope_filter = []
    await updateApiKey(editingKey.value.key_id, body as any)
    editingKey.value = null
    await refresh()
  } catch (e: any) { editError.value = e.message }
  finally { editLoading.value = false }
}

const filteredKeys = computed(() => {
  let result = keys.value
  if (filterStatus.value) result = result.filter(k => k.status === filterStatus.value)
  if (filterTenant.value) result = result.filter(k => k.tenant_id === filterTenant.value)
  return result
})
const { sortKey, sortDir, toggle, sorted: sortedKeys } = useSort(filteredKeys)

const statusCounts = computed(() => {
  const counts: Record<string, number> = {}
  for (const k of keys.value) {
    counts[k.status] = (counts[k.status] || 0) + 1
  }
  return counts
})

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
  } catch (e: any) { error.value = e.message }
}, 60000)
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <PageHeader title="API Keys" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh" />
      <button v-if="canManage" @click="openCreate" class="text-xs text-blue-600 hover:text-blue-800 border border-blue-200 rounded px-3 py-1.5 hover:bg-blue-50 cursor-pointer transition-colors">Create API Key</button>
    </div>

    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">{{ error }}</p>

    <!-- Summary -->
    <div v-if="keys.length > 0" class="flex gap-3 mb-4">
      <div v-for="(count, status) in statusCounts" :key="status" class="bg-white rounded-lg shadow px-4 py-2 flex items-center gap-2">
        <StatusBadge :status="String(status)" />
        <span class="text-sm font-medium text-gray-700">{{ count }}</span>
      </div>
    </div>

    <!-- Filters -->
    <div class="bg-white rounded-lg shadow p-4 mb-4">
      <div class="flex gap-3 flex-wrap items-end">
        <div>
          <label for="keys-tenant" class="block text-xs text-gray-500 mb-1">Tenant</label>
          <select id="keys-tenant" v-model="filterTenant" class="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white">
            <option value="">All tenants</option>
            <option v-for="t in tenants" :key="t.tenant_id" :value="t.tenant_id">{{ t.name || t.tenant_id }}</option>
          </select>
        </div>
        <div>
          <label for="keys-status" class="block text-xs text-gray-500 mb-1">Status</label>
          <select id="keys-status" v-model="filterStatus" class="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white">
            <option value="">All</option>
            <option>ACTIVE</option>
            <option>REVOKED</option>
            <option>EXPIRED</option>
          </select>
        </div>
        <div v-if="isLoading" class="flex items-center">
          <svg class="w-4 h-4 text-gray-400 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
        </div>
      </div>
    </div>

    <p v-if="filteredKeys.length > 0" class="text-xs text-gray-400 mb-2">{{ filteredKeys.length }} key{{ filteredKeys.length !== 1 ? 's' : '' }}</p>

    <div class="bg-white rounded-lg shadow overflow-hidden overflow-x-auto">
      <table class="w-full text-sm min-w-[900px]">
        <thead class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
          <tr>
            <th class="px-4 py-3 text-left">Key ID</th>
            <SortHeader label="Name" column="name" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Tenant" column="tenant_id" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Status" column="status" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <th class="px-4 py-3 text-left">Permissions</th>
            <th class="px-4 py-3 text-left">Scope Filter</th>
            <SortHeader label="Created" column="created_at" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Expires" column="expires_at" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <th v-if="canManage" class="px-4 py-3 w-20"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="k in sortedKeys" :key="k.key_id" class="hover:bg-gray-50 transition-colors">
            <td class="px-4 py-3"><MaskedValue :value="k.key_id" /></td>
            <td class="px-4 py-3 text-gray-700">{{ k.name || '-' }}</td>
            <td class="px-4 py-3">
              <TenantLink :tenant-id="k.tenant_id" />
            </td>
            <td class="px-4 py-3"><StatusBadge :status="k.status" /></td>
            <td class="px-4 py-3 text-xs text-gray-500">
              <div class="flex flex-wrap gap-1">
                <span v-for="p in k.permissions" :key="p" class="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{{ p }}</span>
              </div>
            </td>
            <td class="px-4 py-3 text-xs text-gray-500 font-mono">{{ k.scope_filter?.join(', ') || '-' }}</td>
            <td class="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{{ formatDateTime(k.created_at) }}</td>
            <td class="px-4 py-3 text-xs whitespace-nowrap" :class="k.expires_at ? 'text-gray-500' : 'text-gray-400'">
              {{ k.expires_at ? formatDateTime(k.expires_at) : 'Never' }}
            </td>
            <td v-if="canManage" class="px-4 py-3">
              <div class="flex gap-2">
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
        <label for="ck-tenant" class="block text-xs text-gray-500 mb-1">Tenant</label>
        <select id="ck-tenant" v-model="createForm.tenant_id" required class="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white w-full">
          <option v-for="t in tenants" :key="t.tenant_id" :value="t.tenant_id">{{ t.name || t.tenant_id }}</option>
        </select>
      </div>
      <div>
        <label for="ck-name" class="block text-xs text-gray-500 mb-1">Name</label>
        <input id="ck-name" v-model="createForm.name" required class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full" placeholder="my-service-key" />
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">Permissions</label>
        <div class="grid grid-cols-2 gap-1 max-h-40 overflow-y-auto border border-gray-200 rounded p-2">
          <label v-for="p in PERMISSIONS" :key="p" class="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" :value="p" v-model="createForm.permissions" class="rounded" />
            {{ p }}
          </label>
        </div>
      </div>
      <div>
        <label for="ck-scope" class="block text-xs text-gray-500 mb-1">Scope filter (comma-separated, optional)</label>
        <input id="ck-scope" v-model="createForm.scope_filter" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full font-mono" placeholder="tenant:acme, tenant:acme/*" />
      </div>
      <div>
        <label for="ck-expires" class="block text-xs text-gray-500 mb-1">Expires at (optional)</label>
        <input id="ck-expires" v-model="createForm.expires_at" type="datetime-local" class="border border-gray-300 rounded px-2 py-1.5 text-sm" />
      </div>
    </FormDialog>

    <!-- Secret reveal after creation -->
    <SecretReveal v-if="createdSecret" title="API Key Created" :secret="createdSecret.key_secret" label="API Key Secret" @close="createdSecret = null; refresh()" />

    <!-- Edit API Key dialog -->
    <FormDialog v-if="editingKey" title="Edit API Key" submit-label="Save Changes" :loading="editLoading" :error="editError" @submit="submitEdit" @cancel="editingKey = null">
      <div>
        <label for="ek-name" class="block text-xs text-gray-500 mb-1">Name</label>
        <input id="ek-name" v-model="editForm.name" required class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full" />
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">Permissions</label>
        <div class="grid grid-cols-2 gap-1 max-h-40 overflow-y-auto border border-gray-200 rounded p-2">
          <label v-for="p in PERMISSIONS" :key="p" class="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" :value="p" v-model="editForm.permissions" class="rounded" />
            {{ p }}
          </label>
        </div>
      </div>
      <div>
        <label for="ek-scope" class="block text-xs text-gray-500 mb-1">Scope filter (comma-separated)</label>
        <input id="ek-scope" v-model="editForm.scope_filter" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full font-mono" />
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

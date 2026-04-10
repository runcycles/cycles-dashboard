<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { getTenant, listBudgets, listApiKeys, listPolicies, updateTenantStatus, updateTenant, revokeApiKey, createApiKey } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { Tenant, BudgetLedger, ApiKey, Policy, ApiKeyCreateResponse } from '../types'
import { PERMISSIONS } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import MaskedValue from '../components/MaskedValue.vue'
import EmptyState from '../components/EmptyState.vue'
import ConfirmAction from '../components/ConfirmAction.vue'
import FormDialog from '../components/FormDialog.vue'
import SecretReveal from '../components/SecretReveal.vue'
import { useToast } from '../composables/useToast'
import { toMessage } from '../utils/errors'

const toast = useToast()

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const id = route.params.id as string
const canManageTenants = computed(() => auth.capabilities?.manage_tenants !== false)
const canManageKeys = computed(() => auth.capabilities?.manage_api_keys !== false)

const tenant = ref<Tenant | null>(null)
const budgets = ref<BudgetLedger[]>([])
const apiKeys = ref<ApiKey[]>([])
const policies = ref<Policy[]>([])
const error = ref('')
const tab = ref<'budgets' | 'keys' | 'policies'>('budgets')

// Tenant status action
const pendingTenantAction = ref<'SUSPENDED' | 'ACTIVE' | 'CLOSED' | null>(null)
const closeConfirmInput = ref('')

async function executeTenantAction() {
  if (!pendingTenantAction.value) return
  try {
    await updateTenantStatus(id, pendingTenantAction.value)
    const labels: Record<string, string> = { SUSPENDED: 'Tenant suspended', ACTIVE: 'Tenant reactivated', CLOSED: 'Tenant permanently closed' }
    toast.success(labels[pendingTenantAction.value])
    tenant.value = await getTenant(id)
  } catch (e) {
    const msg = toMessage(e)
    error.value = msg
    toast.error(`Tenant status change failed: ${msg}`)
  }
  finally { pendingTenantAction.value = null }
}

// API key revoke action
const pendingKeyRevoke = ref<ApiKey | null>(null)

async function executeKeyRevoke() {
  if (!pendingKeyRevoke.value) return
  try {
    await revokeApiKey(pendingKeyRevoke.value.key_id, 'Revoked via admin dashboard')
    toast.success('API key revoked')
    const kRes = await listApiKeys({ tenant_id: id })
    apiKeys.value = kRes.keys
  } catch (e) {
    const msg = toMessage(e)
    error.value = msg
    toast.error(`Revoke failed: ${msg}`)
  }
  finally { pendingKeyRevoke.value = null }
}

// Edit tenant
const showEditTenant = ref(false)
const editTenantLoading = ref(false)
const editTenantError = ref('')
const editTenantForm = ref({ name: '', default_commit_overage_policy: '', default_reservation_ttl_ms: '', max_reservation_ttl_ms: '' })

function openEditTenant() {
  const t = tenant.value
  editTenantForm.value = {
    name: t?.name || '',
    default_commit_overage_policy: (t as any)?.default_commit_overage_policy || '',
    default_reservation_ttl_ms: (t as any)?.default_reservation_ttl_ms ? String((t as any).default_reservation_ttl_ms) : '',
    max_reservation_ttl_ms: (t as any)?.max_reservation_ttl_ms ? String((t as any).max_reservation_ttl_ms) : '',
  }
  editTenantError.value = ''
  showEditTenant.value = true
}

async function submitEditTenant() {
  editTenantError.value = ''
  editTenantLoading.value = true
  try {
    const body: Record<string, unknown> = { name: editTenantForm.value.name }
    if (editTenantForm.value.default_commit_overage_policy) body.default_commit_overage_policy = editTenantForm.value.default_commit_overage_policy
    if (editTenantForm.value.default_reservation_ttl_ms) body.default_reservation_ttl_ms = Number(editTenantForm.value.default_reservation_ttl_ms)
    if (editTenantForm.value.max_reservation_ttl_ms) body.max_reservation_ttl_ms = Number(editTenantForm.value.max_reservation_ttl_ms)
    await updateTenant(id, body as any)
    toast.success('Tenant updated')
    tenant.value = await getTenant(id)
    showEditTenant.value = false
  } catch (e) { editTenantError.value = toMessage(e) }
  finally { editTenantLoading.value = false }
}

// Create API key for this tenant
const showCreateKey = ref(false)
const createKeyLoading = ref(false)
const createKeyError = ref('')
const createKeyForm = ref({ name: '', permissions: [] as string[], scope_filter: '', expires_at: '' })
const createdKeySecret = ref<ApiKeyCreateResponse | null>(null)

function openCreateKey() {
  createKeyForm.value = { name: '', permissions: [], scope_filter: '', expires_at: '' }
  createKeyError.value = ''
  showCreateKey.value = true
}

async function submitCreateKey() {
  createKeyError.value = ''
  createKeyLoading.value = true
  try {
    const body: Record<string, unknown> = { tenant_id: id, name: createKeyForm.value.name }
    if (createKeyForm.value.permissions.length) body.permissions = createKeyForm.value.permissions
    if (createKeyForm.value.scope_filter) body.scope_filter = createKeyForm.value.scope_filter.split(',').map(s => s.trim()).filter(Boolean)
    if (createKeyForm.value.expires_at) body.expires_at = new Date(createKeyForm.value.expires_at).toISOString()
    const res = await createApiKey(body as any)
    createdKeySecret.value = res
    showCreateKey.value = false
  } catch (e) { createKeyError.value = toMessage(e) }
  finally { createKeyLoading.value = false }
}

const { refresh, isLoading, lastUpdated } = usePolling(async () => {
  try {
    tenant.value = await getTenant(id)
    const [bRes, kRes, pRes] = await Promise.all([
      listBudgets({ tenant_id: id }),
      listApiKeys({ tenant_id: id }),
      listPolicies({ tenant_id: id }),
    ])
    budgets.value = bRes.ledgers
    apiKeys.value = kRes.keys
    policies.value = pRes.policies
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
}, 60000)
</script>

<template>
  <div>
    <PageHeader title="Tenant Detail" :subtitle="tenant?.tenant_id" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh">
      <template #back>
        <button @click="router.push('/tenants')" aria-label="Back to tenants" class="text-gray-400 hover:text-gray-700 cursor-pointer">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
        </button>
      </template>
    </PageHeader>
    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">{{ error }}</p>

    <template v-if="tenant">
      <div class="bg-white rounded-lg shadow p-6 mb-4">
        <div class="flex items-center gap-3 mb-2 flex-wrap">
          <h2 class="text-lg font-medium text-gray-900">{{ tenant.name }}</h2>
          <StatusBadge :status="tenant.status" />
          <span class="flex-1" />
          <div v-if="canManageTenants" class="flex gap-2">
            <button @click="openEditTenant" class="text-xs text-gray-600 hover:text-gray-800 border border-gray-200 rounded px-2.5 py-1 hover:bg-gray-100 cursor-pointer transition-colors">Edit</button>
            <button v-if="tenant.status === 'ACTIVE'" @click="pendingTenantAction = 'SUSPENDED'" class="text-xs text-red-600 hover:text-red-800 border border-red-200 rounded px-2.5 py-1 hover:bg-red-50 cursor-pointer transition-colors">Suspend</button>
            <button v-if="tenant.status === 'SUSPENDED'" @click="pendingTenantAction = 'ACTIVE'" class="text-xs text-green-700 hover:text-green-900 border border-green-200 rounded px-2.5 py-1 hover:bg-green-50 cursor-pointer transition-colors">Reactivate</button>
            <button v-if="tenant.status !== 'CLOSED'" @click="pendingTenantAction = 'CLOSED'" class="text-xs text-red-600 hover:text-red-800 border border-red-200 rounded px-2.5 py-1 hover:bg-red-50 cursor-pointer transition-colors">Close</button>
          </div>
        </div>
        <p class="text-sm text-gray-500 font-mono">{{ tenant.tenant_id }}</p>
        <p v-if="tenant.parent_tenant_id" class="text-sm text-gray-400 mt-1">Parent: <router-link :to="{ name: 'tenant-detail', params: { id: tenant.parent_tenant_id } }" class="text-blue-600 hover:underline">{{ tenant.parent_tenant_id }}</router-link></p>
      </div>

      <!-- Tabs -->
      <div class="flex border-b border-gray-200 mb-4">
        <button v-for="t in (['budgets', 'keys', 'policies'] as const)" :key="t"
          @click="tab = t"
          :class="tab === t ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-700'"
          class="px-4 py-2 text-sm font-medium border-b-2 -mb-px cursor-pointer transition-colors">
          {{ t === 'keys' ? 'API Keys' : t.charAt(0).toUpperCase() + t.slice(1) }}
          <span class="ml-1 text-xs text-gray-400">({{ t === 'budgets' ? budgets.length : t === 'keys' ? apiKeys.length : policies.length }})</span>
        </button>
      </div>

      <!-- Budgets tab -->
      <div v-if="tab === 'budgets'" class="bg-white rounded-lg shadow overflow-hidden overflow-x-auto">
        <table class="w-full text-sm min-w-[520px]">
          <thead class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
            <tr><th class="px-4 py-3 text-left">Scope</th><th class="px-4 py-3 text-left">Unit</th><th class="px-4 py-3 text-left">Status</th><th class="px-4 py-3 text-right">Allocated</th></tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="b in budgets" :key="b.ledger_id" class="hover:bg-gray-50 transition-colors">
              <td class="px-4 py-3"><router-link :to="{ name: 'budgets', query: { scope: b.scope, unit: b.unit } }" class="text-blue-600 hover:underline font-mono text-xs">{{ b.scope }}</router-link></td>
              <td class="px-4 py-3 text-gray-500">{{ b.unit }}</td>
              <td class="px-4 py-3"><StatusBadge :status="b.status" /></td>
              <td class="px-4 py-3 text-right text-gray-500 tabular-nums">{{ b.allocated.amount.toLocaleString() }}</td>
            </tr>
            <tr v-if="budgets.length === 0"><td colspan="4"><EmptyState message="No budgets" hint="Budgets will appear here once allocated" /></td></tr>
          </tbody>
        </table>
      </div>

      <!-- API Keys tab -->
      <div v-if="tab === 'keys' && canManageKeys" class="flex justify-end mb-2">
        <button @click="openCreateKey" class="text-xs bg-blue-600 text-white hover:bg-blue-700 rounded px-3 py-1.5 cursor-pointer transition-colors">Create API Key</button>
      </div>
      <div v-if="tab === 'keys'" class="bg-white rounded-lg shadow overflow-hidden overflow-x-auto">
        <table class="w-full text-sm min-w-[520px]">
          <thead class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
            <tr><th class="px-4 py-3 text-left">Key ID</th><th class="px-4 py-3 text-left">Name</th><th class="px-4 py-3 text-left">Status</th><th class="px-4 py-3 text-left">Permissions</th><th v-if="canManageKeys" class="px-4 py-3 w-20"></th></tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="k in apiKeys" :key="k.key_id" class="hover:bg-gray-50 transition-colors">
              <td class="px-4 py-3"><MaskedValue :value="k.key_id" /></td>
              <td class="px-4 py-3 text-gray-700">{{ k.name || '-' }}</td>
              <td class="px-4 py-3"><StatusBadge :status="k.status" /></td>
              <td class="px-4 py-3 text-xs text-gray-500">{{ k.permissions.join(', ') }}</td>
              <td v-if="canManageKeys" class="px-4 py-3">
                <button v-if="k.status === 'ACTIVE'" @click="pendingKeyRevoke = k" class="text-xs text-red-600 hover:text-red-800 cursor-pointer hover:underline">Revoke</button>
              </td>
            </tr>
            <tr v-if="apiKeys.length === 0"><td :colspan="canManageKeys ? 5 : 4"><EmptyState message="No API keys" hint="API keys will appear here once created" /></td></tr>
          </tbody>
        </table>
      </div>

      <!-- Policies tab -->
      <div v-if="tab === 'policies'" class="bg-white rounded-lg shadow overflow-hidden overflow-x-auto">
        <table class="w-full text-sm min-w-[520px]">
          <thead class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
            <tr><th class="px-4 py-3 text-left">Policy ID</th><th class="px-4 py-3 text-left">Name</th><th class="px-4 py-3 text-left">Scope</th><th class="px-4 py-3 text-left">Status</th></tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="p in policies" :key="p.policy_id" class="hover:bg-gray-50 transition-colors">
              <td class="px-4 py-3 font-mono text-xs">{{ p.policy_id }}</td>
              <td class="px-4 py-3 text-gray-700">{{ p.name }}</td>
              <td class="px-4 py-3 text-gray-500 font-mono text-xs">{{ p.scope_pattern }}</td>
              <td class="px-4 py-3"><StatusBadge :status="p.status" /></td>
            </tr>
            <tr v-if="policies.length === 0"><td colspan="4"><EmptyState message="No policies" hint="Policies will appear here once configured" /></td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <ConfirmAction
      v-if="pendingTenantAction && pendingTenantAction !== 'CLOSED'"
      :title="pendingTenantAction === 'SUSPENDED' ? 'Suspend this tenant?' : 'Reactivate this tenant?'"
      :message="pendingTenantAction === 'SUSPENDED'
        ? `Suspending '${tenant?.name || id}' will block all API access for this tenant and its keys. Budgets and webhooks will be unaffected but unusable until reactivated.`
        : `Reactivating '${tenant?.name || id}' will restore API access for this tenant.`"
      :confirm-label="pendingTenantAction === 'SUSPENDED' ? 'Suspend Tenant' : 'Reactivate Tenant'"
      :danger="pendingTenantAction === 'SUSPENDED'"
      @confirm="executeTenantAction"
      @cancel="pendingTenantAction = null"
    />

    <!-- Close tenant — requires typing tenant name -->
    <div v-if="pendingTenantAction === 'CLOSED'" class="fixed inset-0 bg-black/40 flex items-center justify-center z-50" @click.self="pendingTenantAction = null">
      <div class="bg-white dark:bg-gray-900 dark:border dark:border-gray-700 rounded-lg shadow-lg p-6 max-w-sm mx-4" role="dialog" aria-modal="true" aria-label="Close tenant permanently">
        <h3 class="text-sm font-semibold text-red-600 mb-2">Permanently close this tenant?</h3>
        <p class="text-sm text-gray-600 mb-3">This action is <strong>irreversible</strong>. Closing <strong>{{ tenant?.name || id }}</strong> will permanently archive this tenant. All API access, keys, budgets, and webhooks will become unusable and cannot be restored.</p>
        <p class="text-sm text-gray-600 mb-2">To confirm, type the tenant name below:</p>
        <input v-model="closeConfirmInput" type="text" :placeholder="tenant?.name || id" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full mb-4 font-mono" autocomplete="off" />
        <div class="flex justify-end gap-2">
          <button @click="pendingTenantAction = null; closeConfirmInput = ''" class="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 rounded hover:bg-gray-100 cursor-pointer">Cancel</button>
          <button @click="executeTenantAction(); closeConfirmInput = ''" :disabled="closeConfirmInput !== (tenant?.name || id)" class="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">Close Permanently</button>
        </div>
      </div>
    </div>

    <ConfirmAction
      v-if="pendingKeyRevoke"
      title="Revoke this API key?"
      :message="`Revoking key '${pendingKeyRevoke.name || pendingKeyRevoke.key_id}' will immediately invalidate it. Any services using this key will lose access. This cannot be undone.`"
      confirm-label="Revoke Key"
      :danger="true"
      @confirm="executeKeyRevoke"
      @cancel="pendingKeyRevoke = null"
    />

    <!-- Edit tenant dialog -->
    <FormDialog v-if="showEditTenant" title="Edit Tenant" submit-label="Save Changes" :loading="editTenantLoading" :error="editTenantError" @submit="submitEditTenant" @cancel="showEditTenant = false">
      <div>
        <label for="et-name" class="block text-xs text-gray-500 mb-1">Display Name</label>
        <input id="et-name" v-model="editTenantForm.name" required maxlength="256" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full" />
      </div>
      <div>
        <label for="et-overage" class="block text-xs text-gray-500 mb-1">Default Commit Overage Policy</label>
        <select id="et-overage" v-model="editTenantForm.default_commit_overage_policy" class="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white w-full">
          <option value="">Inherit</option>
          <option value="REJECT">Reject</option>
          <option value="ALLOW_IF_AVAILABLE">Allow if available</option>
          <option value="ALLOW_WITH_OVERDRAFT">Allow with overdraft</option>
        </select>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label for="et-ttl" class="block text-xs text-gray-500 mb-1">Default Reservation TTL (ms)</label>
          <input id="et-ttl" v-model="editTenantForm.default_reservation_ttl_ms" type="number" min="1000" max="86400000" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full" placeholder="60000" />
        </div>
        <div>
          <label for="et-max-ttl" class="block text-xs text-gray-500 mb-1">Max Reservation TTL (ms)</label>
          <input id="et-max-ttl" v-model="editTenantForm.max_reservation_ttl_ms" type="number" min="1000" max="86400000" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full" placeholder="3600000" />
        </div>
      </div>
    </FormDialog>

    <!-- Create API key for this tenant -->
    <FormDialog v-if="showCreateKey" title="Create API Key" submit-label="Create Key" :loading="createKeyLoading" :error="createKeyError" @submit="submitCreateKey" @cancel="showCreateKey = false">
      <div>
        <label for="ck2-name" class="block text-xs text-gray-500 mb-1">Name</label>
        <input id="ck2-name" v-model="createKeyForm.name" required class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full" placeholder="my-service-key" />
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">Permissions</label>
        <div class="grid grid-cols-2 gap-1 max-h-40 overflow-y-auto border border-gray-200 rounded p-2">
          <label v-for="p in PERMISSIONS" :key="p" class="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" :value="p" v-model="createKeyForm.permissions" class="rounded" />
            {{ p }}
          </label>
        </div>
      </div>
      <div>
        <label for="ck2-scope" class="block text-xs text-gray-500 mb-1">Scope filter (comma-separated, optional)</label>
        <input id="ck2-scope" v-model="createKeyForm.scope_filter" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full font-mono" />
      </div>
      <div>
        <label for="ck2-expires" class="block text-xs text-gray-500 mb-1">Expires at (optional)</label>
        <input id="ck2-expires" v-model="createKeyForm.expires_at" type="datetime-local" class="border border-gray-300 rounded px-2 py-1.5 text-sm" />
      </div>
    </FormDialog>

    <SecretReveal v-if="createdKeySecret" title="API Key Created" :secret="createdKeySecret.key_secret" label="API Key Secret" @close="createdKeySecret = null; refresh()" />
  </div>
</template>

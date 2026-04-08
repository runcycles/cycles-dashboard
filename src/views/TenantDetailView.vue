<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { getTenant, listBudgets, listApiKeys, listPolicies, updateTenantStatus, updateApiKeyStatus } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { Tenant, BudgetLedger, ApiKey, Policy } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import MaskedValue from '../components/MaskedValue.vue'
import EmptyState from '../components/EmptyState.vue'
import ConfirmAction from '../components/ConfirmAction.vue'

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
const pendingTenantAction = ref<'SUSPENDED' | 'ACTIVE' | null>(null)

async function executeTenantAction() {
  if (!pendingTenantAction.value) return
  try {
    await updateTenantStatus(id, pendingTenantAction.value)
    tenant.value = await getTenant(id)
  } catch (e: any) { error.value = e.message }
  finally { pendingTenantAction.value = null }
}

// API key revoke action
const pendingKeyRevoke = ref<ApiKey | null>(null)

async function executeKeyRevoke() {
  if (!pendingKeyRevoke.value) return
  try {
    await updateApiKeyStatus(pendingKeyRevoke.value.key_id, 'REVOKED')
    const kRes = await listApiKeys({ tenant_id: id })
    apiKeys.value = kRes.keys
  } catch (e: any) { error.value = e.message }
  finally { pendingKeyRevoke.value = null }
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
  } catch (e: any) { error.value = e.message }
}, 60000)
</script>

<template>
  <div>
    <PageHeader title="Tenant Detail" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh">
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
        <div class="flex items-center gap-3 mb-2">
          <h2 class="text-lg font-medium text-gray-900">{{ tenant.name }}</h2>
          <StatusBadge :status="tenant.status" />
          <span class="flex-1" />
          <button v-if="canManageTenants && tenant.status === 'ACTIVE'" @click="pendingTenantAction = 'SUSPENDED'" class="text-xs text-red-600 hover:text-red-800 border border-red-200 rounded px-2.5 py-1 hover:bg-red-50 cursor-pointer transition-colors">Suspend</button>
          <button v-if="canManageTenants && tenant.status === 'SUSPENDED'" @click="pendingTenantAction = 'ACTIVE'" class="text-xs text-green-700 hover:text-green-900 border border-green-200 rounded px-2.5 py-1 hover:bg-green-50 cursor-pointer transition-colors">Reactivate</button>
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
      v-if="pendingTenantAction"
      :title="pendingTenantAction === 'SUSPENDED' ? 'Suspend this tenant?' : 'Reactivate this tenant?'"
      :message="pendingTenantAction === 'SUSPENDED'
        ? `Suspending '${tenant?.name || id}' will block all API access for this tenant and its keys. Budgets and webhooks will be unaffected but unusable until reactivated.`
        : `Reactivating '${tenant?.name || id}' will restore API access for this tenant.`"
      :confirm-label="pendingTenantAction === 'SUSPENDED' ? 'Suspend Tenant' : 'Reactivate Tenant'"
      :danger="pendingTenantAction === 'SUSPENDED'"
      @confirm="executeTenantAction"
      @cancel="pendingTenantAction = null"
    />

    <ConfirmAction
      v-if="pendingKeyRevoke"
      title="Revoke this API key?"
      :message="`Revoking key '${pendingKeyRevoke.name || pendingKeyRevoke.key_id}' will immediately invalidate it. Any services using this key will lose access. This cannot be undone.`"
      confirm-label="Revoke Key"
      :danger="true"
      @confirm="executeKeyRevoke"
      @cancel="pendingKeyRevoke = null"
    />
  </div>
</template>

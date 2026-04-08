<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { getTenant, listBudgets, listApiKeys, listPolicies } from '../api/client'
import type { Tenant, BudgetLedger, ApiKey, Policy } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import MaskedValue from '../components/MaskedValue.vue'
import EmptyState from '../components/EmptyState.vue'

const route = useRoute()
const router = useRouter()
const id = route.params.id as string

const tenant = ref<Tenant | null>(null)
const budgets = ref<BudgetLedger[]>([])
const apiKeys = ref<ApiKey[]>([])
const policies = ref<Policy[]>([])
const error = ref('')
const tab = ref<'budgets' | 'keys' | 'policies'>('budgets')

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
            <tr><th class="px-4 py-3 text-left">Key ID</th><th class="px-4 py-3 text-left">Name</th><th class="px-4 py-3 text-left">Status</th><th class="px-4 py-3 text-left">Permissions</th></tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="k in apiKeys" :key="k.key_id" class="hover:bg-gray-50 transition-colors">
              <td class="px-4 py-3"><MaskedValue :value="k.key_id" /></td>
              <td class="px-4 py-3 text-gray-700">{{ k.name || '-' }}</td>
              <td class="px-4 py-3"><StatusBadge :status="k.status" /></td>
              <td class="px-4 py-3 text-xs text-gray-500">{{ k.permissions.join(', ') }}</td>
            </tr>
            <tr v-if="apiKeys.length === 0"><td colspan="4"><EmptyState message="No API keys" hint="API keys will appear here once created" /></td></tr>
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
  </div>
</template>

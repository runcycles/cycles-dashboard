<script setup lang="ts">
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { getTenant, listBudgets, listApiKeys, listPolicies } from '../api/client'
import type { Tenant, BudgetLedger, ApiKey, Policy } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import RefreshButton from '../components/RefreshButton.vue'

const route = useRoute()
const id = route.params.id as string

const tenant = ref<Tenant | null>(null)
const budgets = ref<BudgetLedger[]>([])
const apiKeys = ref<ApiKey[]>([])
const policies = ref<Policy[]>([])
const error = ref('')
const tab = ref<'budgets' | 'keys' | 'policies'>('budgets')

const { refresh, isLoading } = usePolling(async () => {
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
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-semibold text-gray-900">Tenant Detail</h1>
      <RefreshButton :loading="isLoading" @click="refresh" />
    </div>
    <p v-if="error" class="text-red-600 text-sm mb-4">{{ error }}</p>

    <template v-if="tenant">
      <div class="bg-white rounded-lg shadow p-6 mb-4">
        <div class="flex items-center gap-3 mb-2">
          <h2 class="text-lg font-medium text-gray-900">{{ tenant.name }}</h2>
          <StatusBadge :status="tenant.status" />
        </div>
        <p class="text-sm text-gray-500">ID: {{ tenant.tenant_id }}</p>
        <p v-if="tenant.parent_tenant_id" class="text-sm text-gray-500">Parent: {{ tenant.parent_tenant_id }}</p>
      </div>

      <!-- Tabs -->
      <div class="flex border-b border-gray-200 mb-4">
        <button v-for="t in (['budgets', 'keys', 'policies'] as const)" :key="t"
          @click="tab = t"
          :class="tab === t ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-700'"
          class="px-4 py-2 text-sm font-medium border-b-2 -mb-px">
          {{ t === 'keys' ? 'API Keys' : t.charAt(0).toUpperCase() + t.slice(1) }} ({{ t === 'budgets' ? budgets.length : t === 'keys' ? apiKeys.length : policies.length }})
        </button>
      </div>

      <!-- Budgets tab -->
      <div v-if="tab === 'budgets'" class="bg-white rounded-lg shadow overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-gray-500 text-xs uppercase">
            <tr><th class="px-4 py-3 text-left">Scope</th><th class="px-4 py-3 text-left">Unit</th><th class="px-4 py-3 text-left">Status</th><th class="px-4 py-3 text-left">Allocated</th></tr>
          </thead>
          <tbody>
            <tr v-for="b in budgets" :key="b.ledger_id" class="border-t border-gray-100">
              <td class="px-4 py-3"><router-link :to="{ name: 'budgets', query: { scope: b.scope, unit: b.unit } }" class="text-blue-600 hover:underline">{{ b.scope }}</router-link></td>
              <td class="px-4 py-3 text-gray-500">{{ b.unit }}</td>
              <td class="px-4 py-3"><StatusBadge :status="b.status" /></td>
              <td class="px-4 py-3 text-gray-500">{{ b.allocated.amount.toLocaleString() }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- API Keys tab -->
      <div v-if="tab === 'keys'" class="bg-white rounded-lg shadow overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-gray-500 text-xs uppercase">
            <tr><th class="px-4 py-3 text-left">Key ID</th><th class="px-4 py-3 text-left">Name</th><th class="px-4 py-3 text-left">Status</th><th class="px-4 py-3 text-left">Permissions</th></tr>
          </thead>
          <tbody>
            <tr v-for="k in apiKeys" :key="k.key_id" class="border-t border-gray-100">
              <td class="px-4 py-3 font-mono text-xs">{{ k.key_id }}</td>
              <td class="px-4 py-3 text-gray-700">{{ k.name || '-' }}</td>
              <td class="px-4 py-3"><StatusBadge :status="k.status" /></td>
              <td class="px-4 py-3 text-xs text-gray-500">{{ k.permissions.join(', ') }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Policies tab -->
      <div v-if="tab === 'policies'" class="bg-white rounded-lg shadow overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-gray-500 text-xs uppercase">
            <tr><th class="px-4 py-3 text-left">Policy ID</th><th class="px-4 py-3 text-left">Name</th><th class="px-4 py-3 text-left">Scope</th><th class="px-4 py-3 text-left">Status</th></tr>
          </thead>
          <tbody>
            <tr v-for="p in policies" :key="p.policy_id" class="border-t border-gray-100">
              <td class="px-4 py-3 font-mono text-xs">{{ p.policy_id }}</td>
              <td class="px-4 py-3 text-gray-700">{{ p.name }}</td>
              <td class="px-4 py-3 text-gray-500">{{ p.scope_pattern }}</td>
              <td class="px-4 py-3"><StatusBadge :status="p.status" /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { listBudgets, lookupBudget, listTenants, listEvents } from '../api/client'
import type { BudgetLedger, Tenant, Event } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import UtilizationBar from '../components/UtilizationBar.vue'
import RefreshButton from '../components/RefreshButton.vue'

const route = useRoute()

// Detail mode when both scope and unit are present
const isDetail = computed(() => !!route.query.scope && !!route.query.unit)

// Tenant selector
const tenants = ref<Tenant[]>([])
const selectedTenant = ref('')

// List state
const budgets = ref<BudgetLedger[]>([])
const hasMore = ref(false)
const error = ref('')

// Detail state
const detail = ref<BudgetLedger | null>(null)
const detailEvents = ref<Event[]>([])

// Filters
const filterStatus = ref((route.query.status as string) || '')
const filterUnit = ref('')
const filterScope = ref('')

async function loadTenants() {
  try {
    const res = await listTenants()
    tenants.value = res.tenants
    if (!selectedTenant.value && tenants.value.length > 0) {
      selectedTenant.value = tenants.value[0].tenant_id
    }
  } catch {}
}

async function loadList() {
  if (!selectedTenant.value) return
  try {
    const params: Record<string, string> = { tenant_id: selectedTenant.value }
    if (filterStatus.value) params.status = filterStatus.value
    if (filterUnit.value) params.unit = filterUnit.value
    if (filterScope.value) params.scope_prefix = filterScope.value
    const res = await listBudgets(params)
    budgets.value = res.ledgers
    hasMore.value = res.has_more
    error.value = ''
  } catch (e: any) { error.value = e.message }
}

async function loadDetail() {
  const scope = route.query.scope as string
  const unit = route.query.unit as string
  try {
    detail.value = await lookupBudget(scope, unit)
    const evRes = await listEvents({ scope, limit: '20' })
    detailEvents.value = evRes.events.filter(e => e.scope === scope)
    error.value = ''
  } catch (e: any) { error.value = e.message }
}

async function tick() {
  if (isDetail.value) await loadDetail()
  else { await loadTenants(); await loadList() }
}

const { refresh, isLoading } = usePolling(tick, 60000)

watch(selectedTenant, loadList)
watch(() => route.query, () => { if (isDetail.value) loadDetail() })
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-semibold text-gray-900">{{ isDetail ? 'Budget Detail' : 'Budgets' }}</h1>
      <RefreshButton :loading="isLoading" @click="refresh" />
    </div>

    <p v-if="error" class="text-red-600 text-sm mb-4">{{ error }}</p>

    <!-- Detail mode -->
    <template v-if="isDetail && detail">
      <div class="bg-white rounded-lg shadow p-6 mb-4">
        <div class="flex items-center gap-3 mb-4">
          <h2 class="text-lg font-medium text-gray-900">{{ detail.scope }}</h2>
          <StatusBadge :status="detail.status" />
          <span class="text-sm text-gray-500">{{ detail.unit }}</span>
          <span v-if="detail.is_over_limit" class="bg-red-100 text-red-700 px-2 py-0.5 rounded text-xs font-medium">OVER LIMIT</span>
        </div>
        <div class="grid grid-cols-3 gap-4 text-sm">
          <div><span class="text-gray-500">Allocated:</span> {{ detail.allocated.amount.toLocaleString() }}</div>
          <div><span class="text-gray-500">Remaining:</span> {{ detail.remaining.amount.toLocaleString() }}</div>
          <div><span class="text-gray-500">Reserved:</span> {{ detail.reserved?.amount.toLocaleString() || '0' }}</div>
          <div><span class="text-gray-500">Spent:</span> {{ detail.spent?.amount.toLocaleString() || '0' }}</div>
          <div><span class="text-gray-500">Debt:</span> {{ detail.debt?.amount.toLocaleString() || '0' }}</div>
          <div><span class="text-gray-500">Overdraft limit:</span> {{ detail.overdraft_limit?.amount.toLocaleString() || '0' }}</div>
        </div>
        <div class="mt-4">
          <UtilizationBar :used="detail.allocated.amount - detail.remaining.amount" :total="detail.allocated.amount" />
        </div>
        <div v-if="detail.debt && detail.debt.amount > 0 && detail.overdraft_limit" class="mt-2">
          <UtilizationBar :used="detail.debt.amount" :total="detail.overdraft_limit.amount" label="Debt utilization" />
        </div>
      </div>

      <div class="bg-white rounded-lg shadow p-4">
        <h3 class="text-sm font-medium text-gray-700 mb-3">Event Timeline</h3>
        <div v-if="detailEvents.length === 0" class="text-sm text-gray-400">No events</div>
        <div v-for="e in detailEvents" :key="e.event_id" class="flex justify-between py-1.5 border-b border-gray-100 last:border-0 text-sm">
          <span class="text-gray-700">{{ e.event_type }}</span>
          <span class="text-gray-400">{{ new Date(e.timestamp).toLocaleString() }}</span>
        </div>
      </div>
    </template>

    <!-- List mode -->
    <template v-else>
      <div class="flex gap-3 mb-4 flex-wrap items-end">
        <div>
          <label class="block text-xs text-gray-500 mb-1">Tenant</label>
          <select v-model="selectedTenant" @change="loadList" class="border border-gray-300 rounded px-2 py-1.5 text-sm">
            <option v-for="t in tenants" :key="t.tenant_id" :value="t.tenant_id">{{ t.name || t.tenant_id }}</option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">Status</label>
          <select v-model="filterStatus" @change="loadList" class="border border-gray-300 rounded px-2 py-1.5 text-sm">
            <option value="">All</option>
            <option>ACTIVE</option><option>FROZEN</option><option>CLOSED</option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">Unit</label>
          <select v-model="filterUnit" @change="loadList" class="border border-gray-300 rounded px-2 py-1.5 text-sm">
            <option value="">All</option>
            <option>USD_MICROCENTS</option><option>TOKENS</option><option>CREDITS</option><option>RISK_POINTS</option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">Scope prefix</label>
          <input v-model="filterScope" @change="loadList" placeholder="tenant:acme" class="border border-gray-300 rounded px-2 py-1.5 text-sm" />
        </div>
      </div>

      <div class="bg-white rounded-lg shadow overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-gray-500 text-xs uppercase">
            <tr>
              <th class="px-4 py-3 text-left">Scope</th>
              <th class="px-4 py-3 text-left">Unit</th>
              <th class="px-4 py-3 text-left">Status</th>
              <th class="px-4 py-3 text-left">Utilization</th>
              <th class="px-4 py-3 text-left">Debt</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in budgets" :key="b.ledger_id" class="border-t border-gray-100 hover:bg-gray-50">
              <td class="px-4 py-3">
                <router-link :to="{ name: 'budgets', query: { scope: b.scope, unit: b.unit } }" class="text-blue-600 hover:underline">{{ b.scope }}</router-link>
                <span v-if="b.is_over_limit" class="ml-1 bg-red-100 text-red-700 px-1 py-0.5 rounded text-xs">OVER</span>
              </td>
              <td class="px-4 py-3 text-gray-500">{{ b.unit }}</td>
              <td class="px-4 py-3"><StatusBadge :status="b.status" /></td>
              <td class="px-4 py-3 w-40">
                <UtilizationBar :used="b.allocated.amount - b.remaining.amount" :total="b.allocated.amount" />
              </td>
              <td class="px-4 py-3 text-gray-500">{{ b.debt?.amount || 0 }}</td>
            </tr>
            <tr v-if="budgets.length === 0">
              <td colspan="5" class="px-4 py-8 text-center text-gray-400">No budgets found</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

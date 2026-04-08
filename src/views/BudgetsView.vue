<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { useSort } from '../composables/useSort'
import { listBudgets, lookupBudget, listTenants, listEvents, fundBudget } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { BudgetLedger, Tenant, Event } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import UtilizationBar from '../components/UtilizationBar.vue'
import PageHeader from '../components/PageHeader.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import { formatDateTime } from '../utils/format'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const canManage = computed(() => auth.capabilities?.manage_budgets !== false)

const isDetail = computed(() => !!route.query.scope && !!route.query.unit)
const activeFilter = computed(() => (route.query.filter as string) || '')
const isCrossTenantFilter = computed(() => activeFilter.value === 'over_limit' || activeFilter.value === 'has_debt')

const tenants = ref<Tenant[]>([])
const selectedTenant = ref('')
const budgets = ref<BudgetLedger[]>([])
const hasMore = ref(false)
const nextCursor = ref('')
const loadingMore = ref(false)
const error = ref('')
const { sortKey, sortDir, toggle, sorted: sortedBudgets } = useSort(budgets)
const detail = ref<BudgetLedger | null>(null)
const detailEvents = ref<Event[]>([])

const filterStatus = ref((route.query.status as string) || '')
const filterUnit = ref('')
const filterScope = ref('')

const pageTitle = computed(() => {
  if (isDetail.value) return 'Budget Detail'
  if (activeFilter.value === 'over_limit') return 'Over-limit Budgets'
  if (activeFilter.value === 'has_debt') return 'Budgets with Debt'
  return 'Budgets'
})

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
  try {
    if (isCrossTenantFilter.value) {
      // Cross-tenant: load budgets from ALL tenants and filter client-side
      const allBudgets: BudgetLedger[] = []
      for (const t of tenants.value) {
        const res = await listBudgets({ tenant_id: t.tenant_id })
        allBudgets.push(...res.ledgers)
      }
      if (activeFilter.value === 'over_limit') {
        budgets.value = allBudgets.filter(b => b.is_over_limit)
      } else if (activeFilter.value === 'has_debt') {
        budgets.value = allBudgets.filter(b => (b.debt?.amount ?? 0) > 0)
      }
      hasMore.value = false
      nextCursor.value = ''
    } else {
      if (!selectedTenant.value) return
      const params: Record<string, string> = { tenant_id: selectedTenant.value }
      if (filterStatus.value) params.status = filterStatus.value
      if (filterUnit.value) params.unit = filterUnit.value
      if (filterScope.value) params.scope_prefix = filterScope.value
      const res = await listBudgets(params)
      budgets.value = res.ledgers
      hasMore.value = res.has_more
      nextCursor.value = res.next_cursor ?? ''
    }
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

async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return
  loadingMore.value = true
  try {
    const params: Record<string, string> = { tenant_id: selectedTenant.value, cursor: nextCursor.value }
    if (filterStatus.value) params.status = filterStatus.value
    if (filterUnit.value) params.unit = filterUnit.value
    if (filterScope.value) params.scope_prefix = filterScope.value
    const res = await listBudgets(params)
    budgets.value = [...budgets.value, ...res.ledgers]
    hasMore.value = res.has_more
    nextCursor.value = res.next_cursor ?? ''
  } catch (e: any) { error.value = e.message }
  finally { loadingMore.value = false }
}

function clearFilter() {
  router.push({ name: 'budgets' })
}

async function tick() {
  if (isDetail.value) await loadDetail()
  else { await loadTenants(); await loadList() }
}

const { refresh, isLoading, lastUpdated } = usePolling(tick, 60000)

// Budget allocation adjustment
const showAdjustForm = ref(false)
const adjustAmount = ref('')
const adjustLoading = ref(false)

function openAdjustForm() {
  adjustAmount.value = String(detail.value?.allocated.amount ?? '')
  showAdjustForm.value = true
}

async function submitAdjustment() {
  if (!detail.value || !adjustAmount.value) return
  const newAmount = Number(adjustAmount.value)
  if (isNaN(newAmount) || newAmount < 0) { error.value = 'Invalid amount'; return }
  adjustLoading.value = true
  try {
    const idempotencyKey = `dashboard-reset-${detail.value.scope}-${Date.now()}`
    await fundBudget(detail.value.scope, detail.value.unit, 'RESET', newAmount, idempotencyKey, 'Allocation adjusted via admin dashboard')
    await loadDetail()
    showAdjustForm.value = false
  } catch (e: any) { error.value = e.message }
  finally { adjustLoading.value = false }
}

watch(selectedTenant, () => { if (!isCrossTenantFilter.value) loadList() })
watch(() => route.query, () => {
  if (isDetail.value) loadDetail()
  else loadList()
})
</script>

<template>
  <div>
    <PageHeader :title="pageTitle" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh">
      <template #back>
        <button v-if="isDetail" @click="router.push('/budgets')" aria-label="Back to budgets" class="text-gray-400 hover:text-gray-700 cursor-pointer">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
        </button>
      </template>
    </PageHeader>

    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">{{ error }}</p>

    <!-- Detail mode -->
    <template v-if="isDetail && detail">
      <div class="bg-white rounded-lg shadow p-6 mb-4">
        <div class="flex items-center gap-3 mb-4">
          <h2 class="text-lg font-medium text-gray-900 font-mono">{{ detail.scope }}</h2>
          <StatusBadge :status="detail.status" />
          <span class="bg-gray-100 text-gray-600 px-2 py-0.5 rounded text-xs font-medium">{{ detail.unit }}</span>
          <span v-if="detail.is_over_limit" class="bg-red-100 text-red-700 px-2 py-0.5 rounded text-xs font-medium">OVER LIMIT</span>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
          <div class="bg-gray-50 rounded p-3"><span class="text-gray-500 block text-xs mb-1">Allocated</span><span class="font-semibold">{{ detail.allocated.amount.toLocaleString() }}</span></div>
          <div class="bg-gray-50 rounded p-3"><span class="text-gray-500 block text-xs mb-1">Remaining</span><span class="font-semibold">{{ detail.remaining.amount.toLocaleString() }}</span></div>
          <div class="bg-gray-50 rounded p-3"><span class="text-gray-500 block text-xs mb-1">Reserved</span><span class="font-semibold">{{ detail.reserved?.amount.toLocaleString() || '0' }}</span></div>
          <div class="bg-gray-50 rounded p-3"><span class="text-gray-500 block text-xs mb-1">Spent</span><span class="font-semibold">{{ detail.spent?.amount.toLocaleString() || '0' }}</span></div>
          <div class="bg-gray-50 rounded p-3"><span class="text-gray-500 block text-xs mb-1">Debt</span><span class="font-semibold" :class="detail.debt && detail.debt.amount > 0 ? 'text-red-600' : ''">{{ detail.debt?.amount.toLocaleString() || '0' }}</span></div>
          <div class="bg-gray-50 rounded p-3"><span class="text-gray-500 block text-xs mb-1">Overdraft Limit</span><span class="font-semibold">{{ detail.overdraft_limit?.amount.toLocaleString() || '0' }}</span></div>
        </div>
        <div class="mt-4">
          <UtilizationBar :remaining="detail.remaining.amount" :allocated="detail.allocated.amount" />
        </div>
        <div v-if="detail.debt && detail.debt.amount > 0 && detail.overdraft_limit" class="mt-2">
          <UtilizationBar :remaining="detail.overdraft_limit.amount - detail.debt.amount" :allocated="detail.overdraft_limit.amount" label="Debt utilization" />
        </div>

        <!-- Adjust allocation -->
        <div v-if="canManage && detail.status === 'ACTIVE'" class="mt-4 pt-4 border-t border-gray-200">
          <div v-if="!showAdjustForm" class="flex items-center justify-between">
            <span class="text-xs text-gray-500">Need to adjust the allocation?</span>
            <button @click="openAdjustForm" class="text-xs text-blue-600 hover:text-blue-800 border border-blue-200 rounded px-2.5 py-1 hover:bg-blue-50 cursor-pointer transition-colors">Adjust Allocation</button>
          </div>
          <form v-else @submit.prevent="submitAdjustment" class="flex items-end gap-3 flex-wrap">
            <div class="flex-1 min-w-[200px]">
              <label for="adjust-amount" class="block text-xs text-gray-500 mb-1">New allocated amount ({{ detail.unit }})</label>
              <input id="adjust-amount" v-model="adjustAmount" type="number" min="0" step="1" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full font-mono" autofocus />
            </div>
            <div class="flex gap-2">
              <button type="submit" :disabled="adjustLoading" class="bg-gray-900 text-white px-3 py-1.5 rounded text-sm hover:bg-gray-800 disabled:opacity-50 cursor-pointer">{{ adjustLoading ? 'Saving...' : 'Save' }}</button>
              <button type="button" @click="showAdjustForm = false" class="text-sm text-gray-500 hover:text-gray-700 cursor-pointer">Cancel</button>
            </div>
          </form>
        </div>
      </div>

      <div class="bg-white rounded-lg shadow p-4">
        <h3 class="text-sm font-medium text-gray-700 mb-3">Event Timeline</h3>
        <div v-if="detailEvents.length === 0" class="text-sm text-gray-400 py-6 text-center">No events for this scope</div>
        <div v-for="e in detailEvents" :key="e.event_id" class="flex justify-between items-center py-2 border-b border-gray-100 last:border-0 text-sm">
          <span class="text-gray-700 font-mono text-xs">{{ e.event_type }}</span>
          <span class="text-gray-400 text-xs" :title="new Date(e.timestamp).toISOString()">{{ formatDateTime(e.timestamp) }}</span>
        </div>
      </div>
    </template>

    <!-- List mode -->
    <template v-else>
      <!-- Active filter banner -->
      <div v-if="isCrossTenantFilter" class="flex items-center gap-2 mb-4 px-4 py-2.5 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
        <span>Showing {{ activeFilter === 'over_limit' ? 'over-limit' : 'budgets with debt' }} across all tenants</span>
        <button @click="clearFilter" class="ml-auto text-xs text-blue-600 hover:underline cursor-pointer">Clear filter</button>
      </div>

      <div v-if="!isCrossTenantFilter" class="bg-white rounded-lg shadow p-4 mb-4">
        <div class="flex gap-3 flex-wrap items-end">
          <div>
            <label for="budget-tenant" class="block text-xs text-gray-500 mb-1">Tenant</label>
            <select id="budget-tenant" v-model="selectedTenant" @change="loadList" class="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white">
              <option v-for="t in tenants" :key="t.tenant_id" :value="t.tenant_id">{{ t.name || t.tenant_id }}</option>
            </select>
          </div>
          <div>
            <label for="budget-status" class="block text-xs text-gray-500 mb-1">Status</label>
            <select id="budget-status" v-model="filterStatus" @change="loadList" class="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white">
              <option value="">All</option>
              <option>ACTIVE</option><option>FROZEN</option><option>CLOSED</option>
            </select>
          </div>
          <div>
            <label for="budget-unit" class="block text-xs text-gray-500 mb-1">Unit</label>
            <select id="budget-unit" v-model="filterUnit" @change="loadList" class="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white">
              <option value="">All</option>
              <option>USD_MICROCENTS</option><option>TOKENS</option><option>CREDITS</option><option>RISK_POINTS</option>
            </select>
          </div>
          <div>
            <label for="budget-scope" class="block text-xs text-gray-500 mb-1">Scope prefix</label>
            <input id="budget-scope" v-model="filterScope" @change="loadList" @keyup.enter="loadList" placeholder="tenant:acme" class="border border-gray-300 rounded px-2 py-1.5 text-sm" />
          </div>
          <div v-if="isLoading" class="flex items-center">
            <svg class="w-4 h-4 text-gray-400 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
          </div>
        </div>
      </div>

      <div class="bg-white rounded-lg shadow overflow-hidden overflow-x-auto">
        <table class="w-full text-sm min-w-[600px]">
          <thead class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
            <tr>
              <SortHeader label="Scope" column="scope" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
              <SortHeader label="Unit" column="unit" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
              <SortHeader label="Status" column="status" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
              <th class="px-4 py-3 text-left w-44">Utilization</th>
              <th class="px-4 py-3 text-right">Debt</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="b in sortedBudgets" :key="b.ledger_id" class="hover:bg-gray-50 transition-colors">
              <td class="px-4 py-3">
                <router-link :to="{ name: 'budgets', query: { scope: b.scope, unit: b.unit } }" class="text-blue-600 hover:underline font-mono text-xs">{{ b.scope }}</router-link>
                <span v-if="b.is_over_limit" class="ml-1.5 bg-red-100 text-red-700 px-1 py-0.5 rounded text-xs font-medium">OVER</span>
              </td>
              <td class="px-4 py-3 text-gray-500">{{ b.unit }}</td>
              <td class="px-4 py-3"><StatusBadge :status="b.status" /></td>
              <td class="px-4 py-3">
                <UtilizationBar :remaining="b.remaining.amount" :allocated="b.allocated.amount" />
              </td>
              <td class="px-4 py-3 text-right tabular-nums" :class="(b.debt?.amount ?? 0) > 0 ? 'text-red-600 font-medium' : 'text-gray-400'">{{ (b.debt?.amount ?? 0).toLocaleString() }}</td>
            </tr>
            <tr v-if="budgets.length === 0">
              <td colspan="5">
                <EmptyState message="No budgets found" :hint="!selectedTenant ? 'Select a tenant to view budgets' : undefined" />
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="hasMore" class="px-4 py-3 border-t border-gray-100 text-center">
          <button @click="loadMore" :disabled="loadingMore" class="text-xs text-blue-600 hover:text-blue-800 cursor-pointer disabled:opacity-50">
            {{ loadingMore ? 'Loading...' : 'Load more results' }}
          </button>
        </div>
      </div>
    </template>

  </div>
</template>

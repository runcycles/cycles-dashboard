<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { useSort } from '../composables/useSort'
import { listBudgets, lookupBudget, listTenants, listEvents, fundBudget, freezeBudget, unfreezeBudget, updateBudgetConfig } from '../api/client'
import { COMMIT_OVERAGE_POLICIES } from '../types'
import { tenantFromScope, parsePositiveAmount } from '../utils/safe'
import { useAuthStore } from '../stores/auth'
import type { BudgetLedger, Tenant, Event } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import UtilizationBar from '../components/UtilizationBar.vue'
import PageHeader from '../components/PageHeader.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import EventTimeline from '../components/EventTimeline.vue'
import ConfirmAction from '../components/ConfirmAction.vue'
import FormDialog from '../components/FormDialog.vue'
import { useToast } from '../composables/useToast'
import { toMessage } from '../utils/errors'

const toast = useToast()

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
const { sortKey, sortDir, toggle, sorted: sortedBudgets } = useSort(budgets, undefined, 'asc', {
  utilization: (b: BudgetLedger) => b.allocated.amount > 0 ? (b.allocated.amount - b.remaining.amount) / b.allocated.amount : 0,
  debt: (b: BudgetLedger) => b.debt?.amount ?? 0,
})
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

const tenantsError = ref('')
async function loadTenants() {
  try {
    const res = await listTenants()
    tenants.value = res.tenants
    tenantsError.value = ''
  } catch (e) {
    tenantsError.value = `Could not load tenant list: ${toMessage(e)}`
  }
}

function applyClientFilters(items: BudgetLedger[], extra?: (b: BudgetLedger) => boolean): BudgetLedger[] {
  let result = items
  if (filterStatus.value) result = result.filter(b => b.status === filterStatus.value)
  if (filterUnit.value) result = result.filter(b => b.unit === filterUnit.value)
  if (filterScope.value) result = result.filter(b => b.scope.startsWith(filterScope.value))
  if (extra) result = result.filter(extra)
  return result
}

async function loadAllTenantBudgets(filterFn?: (b: BudgetLedger) => boolean) {
  const allBudgets: BudgetLedger[] = []
  for (const t of tenants.value) {
    const res = await listBudgets({ tenant_id: t.tenant_id })
    allBudgets.push(...res.ledgers)
  }
  budgets.value = applyClientFilters(allBudgets, filterFn)
  hasMore.value = false
  nextCursor.value = ''
}

async function loadList() {
  // Reset pagination state up-front. Without this, a filter change that
  // refetches page-1 still leaves the OLD nextCursor live; if the user
  // clicks "Load more" between the watcher firing and the fetch returning,
  // we'd send a cursor scoped to the previous filter — server may return
  // misaligned results or a stale-cursor error.
  nextCursor.value = ''
  hasMore.value = false
  try {
    if (isCrossTenantFilter.value) {
      if (activeFilter.value === 'over_limit') {
        await loadAllTenantBudgets(b => !!b.is_over_limit)
      } else if (activeFilter.value === 'has_debt') {
        await loadAllTenantBudgets(b => (b.debt?.amount ?? 0) > 0)
      }
    } else if (!selectedTenant.value) {
      await loadAllTenantBudgets()
    } else {
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
  } catch (e) { error.value = toMessage(e) }
}

async function loadDetail() {
  const scope = route.query.scope as string
  const unit = route.query.unit as string
  try {
    detail.value = await lookupBudget(scope, unit)
    const evRes = await listEvents({ scope, limit: '20' })
    detailEvents.value = evRes.events.filter(e => e.scope === scope)
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
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
  } catch (e) { error.value = toMessage(e) }
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

// Budget freeze/unfreeze
const pendingAction = ref<{ action: 'freeze' | 'unfreeze'; scope: string; unit: string } | null>(null)

function requestFreeze(scope: string, unit: string, action: 'freeze' | 'unfreeze') {
  pendingAction.value = { action, scope, unit }
}

async function executeBudgetAction() {
  if (!pendingAction.value) return
  const { action, scope, unit } = pendingAction.value
  try {
    if (action === 'freeze') {
      await freezeBudget(scope, unit, 'Frozen via admin dashboard')
    } else {
      await unfreezeBudget(scope, unit, 'Unfrozen via admin dashboard')
    }
    if (isDetail.value) await loadDetail()
    else await loadList()
    toast.success(action === 'freeze' ? 'Budget frozen' : 'Budget unfrozen')
  } catch (e) {
    const msg = toMessage(e)
    error.value = msg
    toast.error(`${action === 'freeze' ? 'Freeze' : 'Unfreeze'} failed: ${msg}`)
  }
  finally { pendingAction.value = null }
}

// Budget fund operations
const showFund = ref(false)
// `amount` is typed as `number | string` because Vue 3 v-model on
// `<input type="number">` writes back a number after user input, but we
// initialize with an empty string so the field starts blank rather than
// pre-filled with 0. Any consumer must coerce via Number() and validate.
const fundForm = ref<{ operation: string; amount: number | string; reason: string }>({
  operation: 'CREDIT',
  amount: '',
  reason: '',
})
const fundLoading = ref(false)
const fundError = ref('')

const fundHints: Record<string, string> = {
  CREDIT: 'Adds funds to allocated and remaining balance.',
  DEBIT: 'Removes funds. Fails if remaining would go negative.',
  RESET: 'Sets allocated to exact amount, recalculates remaining.',
  REPAY_DEBT: 'Reduces outstanding debt by this amount.',
}

function openFund() {
  fundForm.value = { operation: 'CREDIT', amount: '', reason: '' }
  fundError.value = ''
  showFund.value = true
}

async function submitFund() {
  if (!detail.value) return
  // Reset error up-front so a stale "Invalid amount" doesn't flash on retry.
  fundError.value = ''
  // parsePositiveAmount handles the string-or-number ambiguity caused by
  // Vue 3 v-model on type="number" inputs. Returns null for empty / 0 /
  // negative / NaN / non-numeric. See utils/safe.ts for why this isn't
  // inlined.
  const amount = parsePositiveAmount(fundForm.value.amount)
  if (amount === null) {
    fundError.value = 'Amount must be a positive number'
    return
  }
  // Prefer the dropdown selection; otherwise derive from the ledger scope.
  // Previously this silently returned when selectedTenant was '' — users
  // arriving at a budget via drill-down saw the Execute button do nothing.
  const tenantId = selectedTenant.value || tenantFromScope(detail.value.scope)
  if (!tenantId) {
    fundError.value = `Cannot determine tenant for scope "${detail.value.scope}". Expected a "tenant:<id>" prefix.`
    return
  }
  if (fundLoading.value) return // double-submit guard (defense in depth alongside :disabled)
  fundLoading.value = true
  try {
    // Date.now() alone collides if the user double-clicks within the same
    // millisecond. Mix in 64 bits of crypto randomness so each Execute is
    // a distinct idempotency key and the server treats them as separate
    // operations (or rejects the second as a true duplicate when intended).
    const rand = crypto.getRandomValues(new Uint8Array(8))
    const suffix = Array.from(rand, b => b.toString(16).padStart(2, '0')).join('')
    const idempotencyKey = `dashboard-${fundForm.value.operation.toLowerCase()}-${detail.value.scope}-${Date.now()}-${suffix}`
    await fundBudget(tenantId, detail.value.scope, detail.value.unit, fundForm.value.operation, amount, idempotencyKey, fundForm.value.reason || `${fundForm.value.operation} via admin dashboard`)
    await loadDetail()
    showFund.value = false
    const labels: Record<string, string> = { CREDIT: 'Budget credited', DEBIT: 'Budget debited', RESET: 'Budget allocation reset', REPAY_DEBT: 'Debt repaid' }
    toast.success(labels[fundForm.value.operation] || 'Budget updated')
  } catch (e) { fundError.value = toMessage(e) }
  finally { fundLoading.value = false }
}

// Edit budget config (overdraft_limit, commit_overage_policy)
const showEditBudget = ref(false)
const editBudgetLoading = ref(false)
const editBudgetError = ref('')
const editBudgetForm = ref({ overdraft_limit: '', commit_overage_policy: '' })

function openEditBudget() {
  if (!detail.value) return
  editBudgetForm.value = {
    overdraft_limit: String(detail.value.overdraft_limit?.amount ?? '0'),
    commit_overage_policy: detail.value.commit_overage_policy || '',
  }
  editBudgetError.value = ''
  showEditBudget.value = true
}

async function submitEditBudget() {
  if (!detail.value) return
  editBudgetError.value = ''
  editBudgetLoading.value = true
  try {
    const body: Record<string, unknown> = {}
    const odLimit = Number(editBudgetForm.value.overdraft_limit)
    if (!isNaN(odLimit) && odLimit >= 0) body.overdraft_limit = { unit: detail.value.unit, amount: odLimit }
    if (editBudgetForm.value.commit_overage_policy) body.commit_overage_policy = editBudgetForm.value.commit_overage_policy
    await updateBudgetConfig(detail.value.scope, detail.value.unit, body)
    await loadDetail()
    showEditBudget.value = false
    toast.success('Budget config updated')
  } catch (e) { editBudgetError.value = toMessage(e) }
  finally { editBudgetLoading.value = false }
}

watch(selectedTenant, () => { if (!isCrossTenantFilter.value && !isDetail.value) loadList() })
watch(() => route.query, () => {
  if (isDetail.value) loadDetail()
  else loadList()
})
</script>

<template>
  <div>
    <PageHeader :title="pageTitle" :subtitle="isDetail && detail ? `${detail.scope} · ${detail.unit}` : undefined" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh">
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
          <span class="flex-1" />
          <button v-if="canManage" @click="openEditBudget" class="text-xs text-gray-600 hover:text-gray-800 border border-gray-200 rounded px-2.5 py-1 hover:bg-gray-100 cursor-pointer transition-colors">Edit</button>
          <button v-if="canManage && detail.status === 'ACTIVE'" @click="requestFreeze(detail.scope, detail.unit, 'freeze')" class="text-xs text-red-600 hover:text-red-800 border border-red-200 rounded px-2.5 py-1 hover:bg-red-50 cursor-pointer transition-colors">Freeze</button>
          <button v-if="canManage && detail.status === 'FROZEN'" @click="requestFreeze(detail.scope, detail.unit, 'unfreeze')" class="text-xs text-green-700 hover:text-green-900 border border-green-200 rounded px-2.5 py-1 hover:bg-green-50 cursor-pointer transition-colors">Unfreeze</button>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
          <div class="bg-gray-50 rounded p-3"><span class="text-gray-500 block text-xs mb-1">Allocated</span><span class="font-semibold">{{ detail.allocated.amount.toLocaleString() }}</span></div>
          <div class="bg-gray-50 rounded p-3"><span class="text-gray-500 block text-xs mb-1">Remaining</span><span class="font-semibold">{{ detail.remaining.amount.toLocaleString() }}</span></div>
          <div class="bg-gray-50 rounded p-3"><span class="text-gray-500 block text-xs mb-1">Reserved</span><span class="font-semibold">{{ detail.reserved?.amount.toLocaleString() || '0' }}</span></div>
          <div class="bg-gray-50 rounded p-3"><span class="text-gray-500 block text-xs mb-1">Spent</span><span class="font-semibold">{{ detail.spent?.amount.toLocaleString() || '0' }}</span></div>
          <div class="bg-gray-50 rounded p-3"><span class="text-gray-500 block text-xs mb-1">Debt</span><span class="font-semibold" :class="detail.debt && detail.debt.amount > 0 ? 'text-red-600' : ''">{{ detail.debt?.amount.toLocaleString() || '0' }}</span></div>
          <div class="bg-gray-50 rounded p-3"><span class="text-gray-500 block text-xs mb-1">Overdraft Limit</span><span class="font-semibold">{{ detail.overdraft_limit?.amount.toLocaleString() || '0' }}</span></div>
          <div class="bg-gray-50 rounded p-3"><span class="text-gray-500 block text-xs mb-1">Overage Policy</span><span class="font-semibold text-xs">{{ detail.commit_overage_policy || 'Inherit' }}</span></div>
        </div>
        <div class="mt-4">
          <UtilizationBar :remaining="detail.remaining.amount" :allocated="detail.allocated.amount" />
        </div>
        <div v-if="detail.debt && detail.debt.amount > 0 && detail.overdraft_limit" class="mt-2">
          <UtilizationBar :remaining="detail.overdraft_limit.amount - detail.debt.amount" :allocated="detail.overdraft_limit.amount" label="Debt utilization" />
        </div>

        <!-- Fund budget -->
        <div v-if="canManage && detail.status === 'ACTIVE'" class="mt-4 pt-4 border-t border-gray-200 flex items-center justify-between">
          <span class="text-xs text-gray-500">Credit, debit, reset allocation, or repay debt</span>
          <button @click="openFund" class="text-xs text-blue-600 hover:text-blue-800 border border-blue-200 rounded px-2.5 py-1 hover:bg-blue-50 cursor-pointer transition-colors">Fund Budget</button>
        </div>
      </div>

      <div class="bg-white rounded-lg shadow p-4">
        <h3 class="text-sm font-medium text-gray-700 mb-3">Event Timeline</h3>
        <EventTimeline :events="detailEvents" />
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
              <option value="">All tenants</option>
              <option v-for="t in tenants" :key="t.tenant_id" :value="t.tenant_id">{{ t.name || t.tenant_id }}</option>
            </select>
            <p v-if="tenantsError" class="text-xs text-red-600 mt-1" role="alert">{{ tenantsError }}</p>
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
              <SortHeader label="Utilization" column="utilization" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
              <SortHeader label="Debt" column="debt" :active-column="sortKey" :direction="sortDir" @sort="toggle" align="right" />
              <th v-if="canManage" class="px-4 py-3 w-20"></th>
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
              <td v-if="canManage" class="px-4 py-3">
                <button v-if="b.status === 'ACTIVE'" @click.prevent="requestFreeze(b.scope, b.unit, 'freeze')" class="text-xs text-red-600 hover:text-red-800 cursor-pointer hover:underline">Freeze</button>
                <button v-if="b.status === 'FROZEN'" @click.prevent="requestFreeze(b.scope, b.unit, 'unfreeze')" class="text-xs text-green-700 hover:text-green-900 cursor-pointer hover:underline">Unfreeze</button>
              </td>
            </tr>
            <tr v-if="budgets.length === 0">
              <td :colspan="canManage ? 6 : 5">
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

    <ConfirmAction
      v-if="pendingAction"
      :title="pendingAction.action === 'freeze' ? 'Freeze this budget?' : 'Unfreeze this budget?'"
      :message="pendingAction.action === 'freeze'
        ? `Freezing will immediately block all reservations, commits, and fund operations against scope '${pendingAction.scope}'. This can be reversed by unfreezing.`
        : `Unfreezing will re-enable reservations, commits, and fund operations against scope '${pendingAction.scope}'.`"
      :confirm-label="pendingAction.action === 'freeze' ? 'Freeze Budget' : 'Unfreeze Budget'"
      :danger="pendingAction.action === 'freeze'"
      @confirm="executeBudgetAction"
      @cancel="pendingAction = null"
    />

    <FormDialog v-if="showFund" title="Fund Budget" submit-label="Execute" :loading="fundLoading" :error="fundError" @submit="submitFund" @cancel="showFund = false">
      <div class="bg-gray-50 rounded p-3 text-xs grid grid-cols-3 gap-2 mb-1">
        <div><span class="text-gray-400 block">Allocated</span><span class="font-semibold">{{ detail?.allocated.amount.toLocaleString() }}</span></div>
        <div><span class="text-gray-400 block">Remaining</span><span class="font-semibold">{{ detail?.remaining.amount.toLocaleString() }}</span></div>
        <div><span class="text-gray-400 block">Debt</span><span class="font-semibold" :class="(detail?.debt?.amount ?? 0) > 0 ? 'text-red-600' : ''">{{ (detail?.debt?.amount ?? 0).toLocaleString() }}</span></div>
      </div>
      <div>
        <label for="fund-op" class="block text-xs text-gray-500 mb-1">Operation</label>
        <select id="fund-op" v-model="fundForm.operation" required class="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white w-full">
          <option value="CREDIT">Credit — add funds</option>
          <option value="DEBIT">Debit — remove funds</option>
          <option value="RESET">Reset — set exact amount</option>
          <option value="REPAY_DEBT">Repay Debt — reduce debt</option>
        </select>
        <p class="text-xs text-gray-400 mt-0.5">{{ fundHints[fundForm.operation] }}</p>
      </div>
      <div>
        <label for="fund-amount" class="block text-xs text-gray-500 mb-1">Amount ({{ detail?.unit }})</label>
        <input id="fund-amount" v-model="fundForm.amount" type="number" min="0" step="1" required class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full font-mono" />
      </div>
      <div>
        <label for="fund-reason" class="block text-xs text-gray-500 mb-1">Reason (optional, for audit trail)</label>
        <input id="fund-reason" v-model="fundForm.reason" maxlength="512" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full" placeholder="Emergency top-up for production" />
      </div>
    </FormDialog>

    <FormDialog v-if="showEditBudget" title="Edit Budget Config" submit-label="Save Changes" :loading="editBudgetLoading" :error="editBudgetError" @submit="submitEditBudget" @cancel="showEditBudget = false">
      <p class="text-xs text-gray-500">Edit overdraft limit and commit overage policy for <span class="font-mono">{{ detail?.scope }}</span> ({{ detail?.unit }}).</p>
      <div>
        <label for="eb-overdraft" class="block text-xs text-gray-500 mb-1">Overdraft Limit ({{ detail?.unit }})</label>
        <input id="eb-overdraft" v-model="editBudgetForm.overdraft_limit" type="number" min="0" step="1" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full font-mono" />
        <p class="text-xs text-gray-400 mt-0.5">Maximum debt allowed. Set to 0 to disable overdraft.</p>
      </div>
      <div>
        <label for="eb-overage" class="block text-xs text-gray-500 mb-1">Commit Overage Policy</label>
        <select id="eb-overage" v-model="editBudgetForm.commit_overage_policy" class="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white w-full">
          <option value="">Inherit from tenant</option>
          <option v-for="p in COMMIT_OVERAGE_POLICIES" :key="p" :value="p">{{ p }}</option>
        </select>
      </div>
    </FormDialog>
  </div>
</template>

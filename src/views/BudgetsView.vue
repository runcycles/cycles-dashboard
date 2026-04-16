<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useRoute, useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { useSort } from '../composables/useSort'
import { useDebouncedRef } from '../composables/useDebouncedRef'
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
// Default sort: highest utilization first. Operators triaging budgets
// care about "which scopes are closest to running dry", not when a
// ledger was provisioned — the near-exhausted rows are the actionable
// ones. Clicking any header switches to that column's natural order.
const { sortKey, sortDir, toggle, sorted: sortedBudgets } = useSort(budgets, 'utilization', 'desc', {
  utilization: (b: BudgetLedger) => b.allocated.amount > 0 ? (b.allocated.amount - b.remaining.amount) / b.allocated.amount : 0,
  debt: (b: BudgetLedger) => b.debt?.amount ?? 0,
})
const detail = ref<BudgetLedger | null>(null)
const detailEvents = ref<Event[]>([])
// R8 (scale-hardening): paginate the budget-detail event timeline.
// Pre-fix hardcoded limit='20' with no Load-more — a budget with more
// than 20 historical events showed only the latest 20, no signal.
const DETAIL_EVENTS_PAGE_SIZE = 20
const detailEventsCursor = ref('')
const detailEventsHasMore = ref(false)
const detailEventsLoadingMore = ref(false)

const filterStatus = ref((route.query.status as string) || '')
const filterUnit = ref('')
const filterScope = ref('')
// v0.1.25.21 (#9): utilization range filter. Captures the common ops
// query "show me budgets at >X%" without the user having to eyeball
// the utilization bars row by row.
//
// Type is `number | string` because Vue 3's v-model on
// `<input type="number">` auto-coerces user input to a number once
// they type — even when initialized as ''. Initial empty string ('')
// stays a string until they touch the input. Per the v0.1.25.19
// `Fund Budget Execute` regression: never call string methods on a
// v-model'd number-input value. We treat both at consumption.
const filterUtilMin = ref<number | string>('')
const filterUtilMax = ref<number | string>('')

// V5 (Phase 3): debounced refs so filter auto-applies 300ms after
// the operator stops typing. Pre-fix, the form relied on @change
// (fires only on blur) + @keyup.enter — meaning a typo'd filter
// that the operator then clicks-off-of would fire a stale request,
// or the list wouldn't update at all until explicit submit. Debounced
// watchers give the same zero-click-submit behavior for all three
// text/numeric inputs.
const DEBOUNCE_MS = 300
const debouncedFilterScope = useDebouncedRef(filterScope, DEBOUNCE_MS)
const debouncedFilterUtilMin = useDebouncedRef(filterUtilMin, DEBOUNCE_MS)
const debouncedFilterUtilMax = useDebouncedRef(filterUtilMax, DEBOUNCE_MS)

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

function utilizationPercent(b: BudgetLedger): number {
  // Utilization = (allocated - remaining) / allocated * 100. Matches
  // what UtilizationBar renders. allocated <= 0 is treated as 0%
  // (no capacity to be utilized).
  if (b.allocated.amount <= 0) return 0
  return Math.round(((b.allocated.amount - b.remaining.amount) / b.allocated.amount) * 100)
}

function applyClientFilters(items: BudgetLedger[], extra?: (b: BudgetLedger) => boolean): BudgetLedger[] {
  let result = items
  if (filterStatus.value) result = result.filter(b => b.status === filterStatus.value)
  if (filterUnit.value) result = result.filter(b => b.unit === filterUnit.value)
  if (filterScope.value) result = result.filter(b => b.scope.startsWith(filterScope.value))
  // Utilization range. Empty string (initial / cleared) means
  // "no bound on this side." Vue v-model on type=number coerces to
  // number once the user types, so the value is `number | string` at
  // runtime. Coerce defensively at consumption (Number(undefined)→NaN,
  // Number('')→0, Number(null)→0; we only apply the filter when at
  // least one side has a finite parsed value).
  const rawMin = filterUtilMin.value
  const rawMax = filterUtilMax.value
  const minSet = rawMin !== '' && rawMin !== null && rawMin !== undefined
  const maxSet = rawMax !== '' && rawMax !== null && rawMax !== undefined
  if (minSet || maxSet) {
    const min = minSet ? Number(rawMin) : 0
    const max = maxSet ? Number(rawMax) : Number.POSITIVE_INFINITY
    if (Number.isFinite(min) && (Number.isFinite(max) || max === Number.POSITIVE_INFINITY)) {
      result = result.filter(b => {
        const u = utilizationPercent(b)
        return u >= min && u <= max
      })
    }
  }
  if (extra) result = result.filter(extra)
  return result
}

// R2 mitigation (scale-hardening). Pre-fix: iterated tenants and
// issued ONE listBudgets() per tenant, keeping only page 1 — so the
// over_limit / has_debt filters silently missed matching budgets on
// pages 2+ within each tenant. That was a correctness bug, not just
// performance: an over-limit budget ranked past its tenant's first
// page never surfaced in the cross-tenant filter at all.
//
// Post-mitigation: cap the tenant fan-out (bounded request count),
// parallelize at 4 concurrent, and follow next_cursor within each
// tenant so over_limit / has_debt see every match. Still O(N) in
// tenants (hence CROSS_TENANT_FANOUT_CAP); the real fix is a
// tenant-agnostic /admin/budgets endpoint with server-side
// over_limit / utilization filters — tracked as a cycles-server-admin
// spec change.
const CROSS_TENANT_FANOUT_CAP = 100
const CROSS_TENANT_CONCURRENCY = 4
const CROSS_TENANT_PER_TENANT_PAGE_CAP = 10 // safety: don't spin forever on one tenant
const budgetsTenantsExamined = ref(0)
const budgetsFanoutTruncated = computed(
  () => tenants.value.length > budgetsTenantsExamined.value,
)

async function fetchAllBudgetsForTenant(tenantId: string): Promise<BudgetLedger[]> {
  const all: BudgetLedger[] = []
  let cursor: string | undefined = undefined
  let pages = 0
  do {
    const params: Record<string, string> = { tenant_id: tenantId }
    if (cursor) params.cursor = cursor
    const res = await listBudgets(params)
    all.push(...res.ledgers)
    cursor = res.has_more ? res.next_cursor : undefined
    pages++
  } while (cursor && pages < CROSS_TENANT_PER_TENANT_PAGE_CAP)
  return all
}

async function loadAllTenantBudgets(filterFn?: (b: BudgetLedger) => boolean) {
  const targets = tenants.value.slice(0, CROSS_TENANT_FANOUT_CAP)
  budgetsTenantsExamined.value = targets.length
  const allBudgets: BudgetLedger[] = []
  for (let i = 0; i < targets.length; i += CROSS_TENANT_CONCURRENCY) {
    const batch = targets.slice(i, i + CROSS_TENANT_CONCURRENCY)
    const results = await Promise.all(
      batch.map((t) => fetchAllBudgetsForTenant(t.tenant_id)),
    )
    for (const chunk of results) allBudgets.push(...chunk)
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
    detailEventsCursor.value = ''
    detailEventsHasMore.value = false
    const evRes = await listEvents({ scope, limit: String(DETAIL_EVENTS_PAGE_SIZE) })
    // Server already filters by scope via the query param but we also
    // filter client-side because listEvents' scope param is a prefix
    // match on some server versions; the precise-match belt-and-suspenders
    // keeps unrelated child-scope events out of the timeline.
    detailEvents.value = evRes.events.filter(e => e.scope === scope)
    detailEventsHasMore.value = !!evRes.has_more
    detailEventsCursor.value = evRes.next_cursor ?? ''
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
}

async function loadMoreDetailEvents() {
  if (!detailEventsCursor.value || detailEventsLoadingMore.value) return
  const scope = route.query.scope as string
  detailEventsLoadingMore.value = true
  try {
    const evRes = await listEvents({
      scope,
      limit: String(DETAIL_EVENTS_PAGE_SIZE),
      cursor: detailEventsCursor.value,
    })
    const filtered = evRes.events.filter(e => e.scope === scope)
    detailEvents.value = [...detailEvents.value, ...filtered]
    detailEventsHasMore.value = !!evRes.has_more
    detailEventsCursor.value = evRes.next_cursor ?? ''
  } catch (e) { error.value = toMessage(e) }
  finally { detailEventsLoadingMore.value = false }
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
    // v0.1.25.21: apply client-side filters (utilization range #9) to
    // the newly-appended page too. Without this, "Load more" would
    // bypass the in-memory filter and dump unfiltered rows into the
    // visible list — the user would see budgets outside their
    // utilization range mysteriously appearing on page 2+.
    budgets.value = [...budgets.value, ...applyClientFilters(res.ledgers)]
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
// v0.1.25.27: `spent` field is optional and only sent when operation =
// RESET_SPENT (cycles-server-admin 0.1.25.18+). When left blank on a
// RESET_SPENT submit, the server resets `spent` to zero (pure rollover).
const fundForm = ref<{ operation: string; amount: number | string; reason: string; spent: number | string }>({
  operation: 'CREDIT',
  amount: '',
  reason: '',
  spent: '',
})
const fundLoading = ref(false)
const fundError = ref('')

const fundHints: Record<string, string> = {
  CREDIT: 'Adds funds to allocated and remaining balance.',
  DEBIT: 'Removes funds. Fails if remaining would go negative.',
  RESET: 'Sets allocated to exact amount, recalculates remaining.',
  RESET_SPENT: 'Billing-period rollover — sets allocated for the new period AND resets spent (default 0, override optional). Pre-filled with current allocated; change it to start the new period at a different allocation. Reserved + debt are preserved across the boundary (requires cycles-server-admin 0.1.25.18+).',
  REPAY_DEBT: 'Reduces outstanding debt by this amount.',
}

function openFund() {
  fundForm.value = { operation: 'CREDIT', amount: '', reason: '', spent: '' }
  fundError.value = ''
  showFund.value = true
}

// When the operator switches operation, prefill `amount` with the current
// allocated for RESET_SPENT (the common "rollover, keep allocation" case).
// For other operations, clear it back to blank so the prior RESET_SPENT
// prefill doesn't bleed into a CREDIT/DEBIT submission.
watch(() => fundForm.value.operation, (op, prevOp) => {
  if (op === 'RESET_SPENT' && prevOp !== 'RESET_SPENT') {
    const current = detail.value?.allocated?.amount
    fundForm.value.amount = typeof current === 'number' ? current : ''
  } else if (op !== 'RESET_SPENT' && prevOp === 'RESET_SPENT') {
    fundForm.value.amount = ''
    fundForm.value.spent = ''
  }
})

async function submitFund() {
  if (!detail.value) return
  // Reset error up-front so a stale "Invalid amount" doesn't flash on retry.
  fundError.value = ''
  // parsePositiveAmount handles the string-or-number ambiguity caused by
  // Vue 3 v-model on type="number" inputs. Returns null for empty / 0 /
  // negative / NaN / non-numeric. See utils/safe.ts for why this isn't
  // inlined.
  // RESET_SPENT semantics (cycles-server-admin 0.1.25.18 BudgetRepository
  // FUND_LUA): server sets allocated = amount AND sets spent = override
  // (default 0). The dashboard pre-fills `amount` with the budget's
  // current allocated when opening the Fund dialog for RESET_SPENT, so
  // a "pure rollover" submit keeps allocated unchanged. Operators wanting
  // to change the allocation for the new billing period edit the field.
  const isResetSpent = fundForm.value.operation === 'RESET_SPENT'
  // Allocated = 0 is a legal request for RESET_SPENT (rare but valid —
  // closes a budget into the new period at zero). Other operations still
  // require strictly positive.
  let amount: number | null
  if (isResetSpent) {
    const parsedAmt = Number(fundForm.value.amount)
    if (!Number.isFinite(parsedAmt) || parsedAmt < 0) {
      fundError.value = 'Allocated must be zero or a positive number'
      return
    }
    amount = parsedAmt
  } else {
    amount = parsePositiveAmount(fundForm.value.amount)
    if (amount === null) {
      fundError.value = 'Amount must be a positive number'
      return
    }
  }
  // Optional spent override — blank means reset-to-zero on the server.
  let spent: number | undefined
  if (isResetSpent && fundForm.value.spent !== '' && fundForm.value.spent !== null) {
    const parsed = Number(fundForm.value.spent)
    if (!Number.isFinite(parsed) || parsed < 0) {
      fundError.value = 'Spent override must be zero or a positive number'
      return
    }
    spent = parsed
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
    await fundBudget(tenantId, detail.value.scope, detail.value.unit, fundForm.value.operation, amount, idempotencyKey, fundForm.value.reason || `${fundForm.value.operation} via admin dashboard`, spent)
    await loadDetail()
    showFund.value = false
    const labels: Record<string, string> = { CREDIT: 'Budget credited', DEBIT: 'Budget debited', RESET: 'Budget allocation reset', RESET_SPENT: 'Budget spent reset', REPAY_DEBT: 'Debt repaid' }
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

// V5 debounce auto-apply on text/numeric filter changes. scope_prefix
// is server-side (re-fetches via loadList), util min/max are client-
// side (apply via applyClientFilters on the next render anyway —
// the watcher still fires loadList so the range constraint takes
// effect against the full fetched page 1 result).
watch(debouncedFilterScope, () => { if (!isDetail.value) loadList() })
watch(debouncedFilterUtilMin, () => { if (!isDetail.value) loadList() })
watch(debouncedFilterUtilMax, () => { if (!isDetail.value) loadList() })

// V1 virtualization — list mode only (not the detail card, which
// embeds EventTimeline and is naturally bounded by DETAIL_EVENTS_PAGE_SIZE).
const scrollEl = ref<HTMLElement | null>(null)
// 56px — UtilizationBar is ~32px tall (label + bar + gap); with
// table-cell py-3 padding a single row fits comfortably. Too much
// lower and the bar clips at zoom levels above 100%.
const ROW_HEIGHT_ESTIMATE = 56
const virtualizer = useVirtualizer(computed(() => ({
  count: sortedBudgets.value.length,
  getScrollElement: () => scrollEl.value,
  estimateSize: () => ROW_HEIGHT_ESTIMATE,
  overscan: 8,
})))
const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalHeight = computed(() => virtualizer.value.getTotalSize())

// 7 columns when canManage, 6 without.
// Column widths tuned against real data:
// - Scope: 2fr (the most variable width — tenant/...)
// - Unit: 130px fixed. 80 was overlapping USD_MICROCENTS (12 chars + padding).
// - Status / Overage: fixed widths large enough for the longest enum
//   label ("PAYG_NO_CREDIT" for commit_overage_policy).
// - Utilization: 1fr (not 2fr — on wide viewports 2fr was making
//   the bar stretch ugly past what's useful).
// - Debt: right-aligned tabular numbers, 140px fits 6 digits with
//   thousands separators plus sign.
// - Action: 96px fits "Freeze" / "Unfreeze" at text-xs.
const gridTemplate = computed(() =>
  canManage.value
    ? 'minmax(220px,2fr) 130px 110px 150px minmax(180px,1fr) 140px 96px'
    : 'minmax(220px,2fr) 130px 110px 150px minmax(180px,1fr) 140px',
)
</script>

<template>
  <div>
    <PageHeader :title="pageTitle" :subtitle="isDetail && detail ? `${detail.scope} · ${detail.unit}` : undefined" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh">
      <template #back>
        <button v-if="isDetail" @click="router.push('/budgets')" aria-label="Back to budgets" class="muted hover:text-gray-700 cursor-pointer">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
        </button>
      </template>
    </PageHeader>

    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg table-cell mb-4">{{ error }}</p>

    <!-- R2 mitigation: cross-tenant fan-out cap banner. Shown only
         when the truncation is active AND the view is in a mode that
         actually fans out (over_limit / has_debt / all-tenants). The
         single-tenant view paginates normally so the banner is
         irrelevant there. -->
    <p
      v-if="budgetsFanoutTruncated && (isCrossTenantFilter || (!isDetail && !selectedTenant))"
      class="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-4 py-2 mb-4"
      role="status"
    >
      Scanned the first <strong>{{ budgetsTenantsExamined.toLocaleString() }}</strong> of
      <strong>{{ tenants.length.toLocaleString() }}</strong> tenants.
      Budgets on tenants outside this window are not shown. Narrow by tenant to see those.
    </p>

    <!-- Detail mode -->
    <template v-if="isDetail && detail">
      <div class="bg-white rounded-lg shadow p-6 mb-4">
        <div class="flex items-center gap-3 mb-4">
          <h2 class="text-lg font-medium text-gray-900 font-mono">{{ detail.scope }}</h2>
          <StatusBadge :status="detail.status" />
          <span class="bg-gray-100 text-gray-600 px-2 py-0.5 rounded text-xs font-medium">{{ detail.unit }}</span>
          <span
            class="bg-gray-50 text-gray-500 border border-gray-200 px-2 py-0.5 rounded text-xs font-medium"
            :title="detail.commit_overage_policy ? 'Commit overage policy (budget-level override)' : 'Commit overage policy (inherited from tenant)'"
          >
            Overage: <span class="font-mono">{{ detail.commit_overage_policy || 'Inherit' }}</span>
          </span>
          <span v-if="detail.is_over_limit" class="bg-red-100 text-red-700 px-2 py-0.5 rounded text-xs font-medium">OVER LIMIT</span>
          <span class="flex-1" />
          <button v-if="canManage" @click="openEditBudget" class="btn-pill-secondary">Edit</button>
          <button v-if="canManage && detail.status === 'ACTIVE'" @click="requestFreeze(detail.scope, detail.unit, 'freeze')" class="btn-pill-danger">Freeze</button>
          <button v-if="canManage && detail.status === 'FROZEN'" @click="requestFreeze(detail.scope, detail.unit, 'unfreeze')" class="btn-pill-success">Unfreeze</button>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
          <div class="info-panel"><span class="form-label">Allocated</span><span class="font-semibold">{{ detail.allocated.amount.toLocaleString() }}</span></div>
          <div class="info-panel"><span class="form-label">Remaining</span><span class="font-semibold">{{ detail.remaining.amount.toLocaleString() }}</span></div>
          <div class="info-panel"><span class="form-label">Reserved</span><span class="font-semibold">{{ detail.reserved?.amount.toLocaleString() || '0' }}</span></div>
          <div class="info-panel"><span class="form-label">Spent</span><span class="font-semibold">{{ detail.spent?.amount.toLocaleString() || '0' }}</span></div>
          <div class="info-panel"><span class="form-label">Debt</span><span class="font-semibold" :class="detail.debt && detail.debt.amount > 0 ? 'text-red-600' : ''">{{ detail.debt?.amount.toLocaleString() || '0' }}</span></div>
          <div class="info-panel"><span class="form-label">Overdraft Limit</span><span class="font-semibold">{{ detail.overdraft_limit?.amount.toLocaleString() || '0' }}</span></div>
        </div>
        <div class="mt-4">
          <UtilizationBar :remaining="detail.remaining.amount" :allocated="detail.allocated.amount" />
        </div>
        <div v-if="detail.debt && detail.debt.amount > 0 && detail.overdraft_limit" class="mt-2">
          <UtilizationBar :remaining="detail.overdraft_limit.amount - detail.debt.amount" :allocated="detail.overdraft_limit.amount" label="Debt utilization" />
        </div>

        <!-- Fund budget -->
        <div v-if="canManage && detail.status === 'ACTIVE'" class="mt-4 pt-4 border-t border-gray-200 flex items-center justify-between">
          <span class="muted-sm">Credit, debit, reset allocation, or repay debt</span>
          <button @click="openFund" class="btn-pill-primary">Fund Budget</button>
        </div>
      </div>

      <div class="card p-4">
        <h3 class="text-sm font-medium text-gray-700 mb-3">Event Timeline</h3>
        <EventTimeline :events="detailEvents" />
        <!-- R8: Load-more for historical event timelines. Pre-fix the
             view was capped at 20 events with no escape hatch; budgets
             with long activity histories (chatty agents, long lifetime)
             showed only the tail of the tail. -->
        <div v-if="detailEventsHasMore || detailEventsLoadingMore" class="mt-3 flex items-center justify-end">
          <button
            @click="loadMoreDetailEvents"
            :disabled="detailEventsLoadingMore || !detailEventsCursor"
            class="text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50 cursor-pointer"
          >
            {{ detailEventsLoadingMore ? 'Loading…' : 'Load older events' }}
          </button>
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

      <div v-if="!isCrossTenantFilter" class="card p-4 mb-4">
        <div class="flex gap-3 flex-wrap items-end">
          <div>
            <label for="budget-tenant" class="form-label">Tenant</label>
            <select id="budget-tenant" v-model="selectedTenant" @change="loadList" class="form-select">
              <option value="">All tenants</option>
              <option v-for="t in tenants" :key="t.tenant_id" :value="t.tenant_id">{{ t.name || t.tenant_id }}</option>
            </select>
            <p v-if="tenantsError" class="text-xs text-red-600 mt-1" role="alert">{{ tenantsError }}</p>
          </div>
          <div>
            <label for="budget-status" class="form-label">Status</label>
            <select id="budget-status" v-model="filterStatus" @change="loadList" class="form-select">
              <option value="">All</option>
              <option>ACTIVE</option><option>FROZEN</option><option>CLOSED</option>
            </select>
          </div>
          <div>
            <label for="budget-unit" class="form-label">Unit</label>
            <select id="budget-unit" v-model="filterUnit" @change="loadList" class="form-select">
              <option value="">All</option>
              <option>USD_MICROCENTS</option><option>TOKENS</option><option>CREDITS</option><option>RISK_POINTS</option>
            </select>
          </div>
          <div>
            <label for="budget-scope" class="form-label">Scope prefix</label>
            <input id="budget-scope" v-model="filterScope" placeholder="tenant:acme" class="border border-gray-300 rounded px-2 py-1.5 text-sm" />
          </div>
          <!-- v0.1.25.21 (#9): utilization range. Pure client-side
               filter on the loaded result set; doesn't refetch. -->
          <div>
            <label for="budget-util-min" class="form-label">Utilization %</label>
            <div class="flex items-center gap-1">
              <input id="budget-util-min" v-model="filterUtilMin" type="number" min="0" max="100" placeholder="min" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-16" aria-label="Minimum utilization percent" />
              <span class="muted-sm">to</span>
              <input id="budget-util-max" v-model="filterUtilMax" type="number" min="0" max="100" placeholder="max" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-16" aria-label="Maximum utilization percent" />
            </div>
          </div>
          <div v-if="isLoading" class="flex items-center">
            <svg class="w-4 h-4 muted animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
          </div>
        </div>
      </div>

      <!-- V1 virtualized list-mode grid. Detail mode is above inside
           the v-if="isDetail" branch and stays as-is (bounded by
           DETAIL_EVENTS_PAGE_SIZE, no scale concern).
           text-sm on the container: the original <table class="text-sm">
           made every cell inherit 14px. Without that on the grid
           wrapper, cells with no explicit size class (e.g. Unit)
           fall back to the document default 16px, break their grid
           column width, and overflow into neighbors. -->
      <div
        class="bg-white rounded-lg shadow overflow-hidden text-sm"
        role="table"
        :aria-rowcount="sortedBudgets.length + 1"
        :aria-colcount="canManage ? 7 : 6"
      >
        <div role="rowgroup" class="table-header border-b border-gray-200 sticky top-0 z-10">
          <div role="row" class="grid text-xs font-bold uppercase tracking-wider" :style="{ gridTemplateColumns: gridTemplate }">
            <SortHeader as="div" label="Scope" column="scope" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader as="div" label="Unit" column="unit" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader as="div" label="Status" column="status" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <div role="columnheader" class="table-cell text-left">Overage</div>
            <SortHeader as="div" label="Utilization" column="utilization" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader as="div" label="Debt" column="debt" :active-column="sortKey" :direction="sortDir" @sort="toggle" align="right" />
            <div v-if="canManage" role="columnheader" class="table-cell" data-column="action"></div>
          </div>
        </div>

        <div
          v-if="sortedBudgets.length > 0"
          ref="scrollEl"
          role="rowgroup"
          class="overflow-auto"
          style="max-height: calc(100vh - 420px); min-height: 240px;"
        >
          <div role="presentation" :style="{ height: totalHeight + 'px', position: 'relative' }">
            <div
              v-for="v in virtualRows"
              :key="sortedBudgets[v.index].ledger_id"
              role="row"
              :aria-rowindex="v.index + 2"
              class="grid table-row-hover border-b border-gray-100 absolute left-0 right-0 items-center"
              :style="{ gridTemplateColumns: gridTemplate, transform: `translateY(${v.start}px)`, height: ROW_HEIGHT_ESTIMATE + 'px' }"
            >
              <div role="cell" class="table-cell min-w-0">
                <router-link :to="{ name: 'budgets', query: { scope: sortedBudgets[v.index].scope, unit: sortedBudgets[v.index].unit } }" class="text-blue-600 hover:underline font-mono text-xs truncate inline-block max-w-full align-middle">{{ sortedBudgets[v.index].scope }}</router-link>
                <span v-if="sortedBudgets[v.index].is_over_limit" class="ml-1.5 bg-red-100 text-red-700 px-1 py-0.5 rounded text-xs font-medium">OVER</span>
              </div>
              <div role="cell" class="table-cell font-mono text-xs muted">{{ sortedBudgets[v.index].unit }}</div>
              <div role="cell" class="table-cell"><StatusBadge :status="sortedBudgets[v.index].status" /></div>
              <div
                role="cell"
                class="table-cell font-mono text-xs"
                :class="sortedBudgets[v.index].commit_overage_policy ? 'text-gray-700' : 'text-gray-500'"
                :title="sortedBudgets[v.index].commit_overage_policy ? 'Budget-level override' : 'Inherited from tenant'"
              >{{ sortedBudgets[v.index].commit_overage_policy || 'Inherit' }}</div>
              <div role="cell" class="table-cell">
                <UtilizationBar :remaining="sortedBudgets[v.index].remaining.amount" :allocated="sortedBudgets[v.index].allocated.amount" />
              </div>
              <div role="cell" class="table-cell text-right tabular-nums" :class="(sortedBudgets[v.index].debt?.amount ?? 0) > 0 ? 'text-red-600 font-medium' : 'muted'">{{ (sortedBudgets[v.index].debt?.amount ?? 0).toLocaleString() }}</div>
              <div v-if="canManage" role="cell" class="table-cell">
                <button v-if="sortedBudgets[v.index].status === 'ACTIVE'" @click.prevent="requestFreeze(sortedBudgets[v.index].scope, sortedBudgets[v.index].unit, 'freeze')" class="btn-row-danger">Freeze</button>
                <button v-if="sortedBudgets[v.index].status === 'FROZEN'" @click.prevent="requestFreeze(sortedBudgets[v.index].scope, sortedBudgets[v.index].unit, 'unfreeze')" class="btn-row-success">Unfreeze</button>
              </div>
            </div>
          </div>
        </div>

        <div v-else>
          <EmptyState message="No budgets found" :hint="!selectedTenant ? 'Select a tenant to view budgets' : undefined" />
        </div>
      </div>

      <!-- Load-more footer lives outside the virtualized scroll container
           — same pattern as TenantsView / WebhooksView. -->
      <div v-if="hasMore || loadingMore" class="mt-3 flex justify-end">
        <button @click="loadMore" :disabled="loadingMore" class="text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50 cursor-pointer">
          {{ loadingMore ? 'Loading...' : 'Load more results' }}
        </button>
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
      <div class="info-panel text-xs grid grid-cols-3 gap-2 mb-1">
        <div><span class="muted block">Allocated</span><span class="font-semibold">{{ detail?.allocated.amount.toLocaleString() }}</span></div>
        <div><span class="muted block">Remaining</span><span class="font-semibold">{{ detail?.remaining.amount.toLocaleString() }}</span></div>
        <div><span class="muted block">Debt</span><span class="font-semibold" :class="(detail?.debt?.amount ?? 0) > 0 ? 'text-red-600' : ''">{{ (detail?.debt?.amount ?? 0).toLocaleString() }}</span></div>
      </div>
      <div>
        <label for="fund-op" class="form-label">Operation</label>
        <select id="fund-op" v-model="fundForm.operation" required class="form-select w-full">
          <option value="CREDIT">Credit — add funds</option>
          <option value="DEBIT">Debit — remove funds</option>
          <option value="RESET">Reset — set exact amount</option>
          <option value="RESET_SPENT">Reset Spent — billing-period rollover</option>
          <option value="REPAY_DEBT">Repay Debt — reduce debt</option>
        </select>
        <p class="muted-sm mt-0.5">{{ fundHints[fundForm.operation] }}</p>
      </div>
      <div>
        <label for="fund-amount" class="form-label">
          {{ fundForm.operation === 'RESET_SPENT' ? `Allocated for new period (${detail?.unit})` : `Amount (${detail?.unit})` }}
        </label>
        <input id="fund-amount" v-model="fundForm.amount" type="number" :min="fundForm.operation === 'RESET_SPENT' ? 0 : 0" step="1" required class="form-input-mono" />
        <p v-if="fundForm.operation === 'RESET_SPENT'" class="muted-sm mt-0.5">Pre-filled with current allocated. Change to start the new billing period at a different allocation.</p>
      </div>
      <div v-if="fundForm.operation === 'RESET_SPENT'">
        <label for="fund-spent" class="form-label">Spent override ({{ detail?.unit }}, optional)</label>
        <input id="fund-spent" v-model="fundForm.spent" type="number" min="0" step="1" class="form-input-mono" placeholder="Leave blank to reset to zero" />
        <p class="muted-sm mt-0.5">Blank = reset spent to 0. Provide a value to set an exact starting spent for the new billing period.</p>
      </div>
      <div>
        <label for="fund-reason" class="form-label">Reason (optional, for audit trail)</label>
        <input id="fund-reason" v-model="fundForm.reason" maxlength="512" class="form-input" placeholder="Emergency top-up for production" />
      </div>
    </FormDialog>

    <FormDialog v-if="showEditBudget" title="Edit Budget Config" submit-label="Save Changes" :loading="editBudgetLoading" :error="editBudgetError" @submit="submitEditBudget" @cancel="showEditBudget = false">
      <p class="muted-sm">Edit overdraft limit and commit overage policy for <span class="font-mono">{{ detail?.scope }}</span> ({{ detail?.unit }}).</p>
      <div>
        <label for="eb-overdraft" class="form-label">Overdraft Limit ({{ detail?.unit }})</label>
        <input id="eb-overdraft" v-model="editBudgetForm.overdraft_limit" type="number" min="0" step="1" class="form-input-mono" />
        <p class="muted-sm mt-0.5">Maximum debt allowed. Set to 0 to disable overdraft.</p>
      </div>
      <div>
        <label for="eb-overage" class="form-label">Commit Overage Policy</label>
        <select id="eb-overage" v-model="editBudgetForm.commit_overage_policy" class="form-select w-full">
          <option value="">Inherit from tenant</option>
          <option v-for="p in COMMIT_OVERAGE_POLICIES" :key="p" :value="p">{{ p }}</option>
        </select>
      </div>
    </FormDialog>
  </div>
</template>

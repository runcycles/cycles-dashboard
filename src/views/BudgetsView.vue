<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useRoute, useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { POLL_SLOW_MS } from '../composables/pollingConstants'
import { useSort } from '../composables/useSort'
import { useDebouncedRef } from '../composables/useDebouncedRef'
import { useTerminalAwareList } from '../composables/useTerminalAwareList'
import { useListExport } from '../composables/useListExport'
import { listBudgets, lookupBudget, listTenants, listEvents, fundBudget, freezeBudget, unfreezeBudget, updateBudgetConfig, bulkActionBudgets, ApiError } from '../api/client'
import { COMMIT_OVERAGE_POLICIES } from '../types'
import { tenantFromScope, parsePositiveAmount } from '../utils/safe'
import { useAuthStore } from '../stores/auth'
import type { BudgetLedger, Tenant, Event, BudgetBulkAction, BudgetBulkFilter, BudgetBulkActionRequest, BudgetBulkActionResponse } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import UtilizationBar from '../components/UtilizationBar.vue'
import PageHeader from '../components/PageHeader.vue'
import SortHeader from '../components/SortHeader.vue'
import TenantLink from '../components/TenantLink.vue'
import EmptyState from '../components/EmptyState.vue'
import InlineErrorBanner from '../components/InlineErrorBanner.vue'
import ExportDialog from '../components/ExportDialog.vue'
import ExportProgressOverlay from '../components/ExportProgressOverlay.vue'
import DownloadIcon from '../components/icons/DownloadIcon.vue'
import CloseIcon from '../components/icons/CloseIcon.vue'
import BackArrowIcon from '../components/icons/BackArrowIcon.vue'
import Spinner from '../components/icons/Spinner.vue'
import EventTimeline from '../components/EventTimeline.vue'
import ConfirmAction from '../components/ConfirmAction.vue'
import FormDialog from '../components/FormDialog.vue'
import RowActionsMenu from '../components/RowActionsMenu.vue'
import { writeClipboardJson } from '../utils/clipboard'
import BulkActionPreviewDialog from '../components/BulkActionPreviewDialog.vue'
import BulkActionResultDialog from '../components/BulkActionResultDialog.vue'
import { useBulkActionPreview } from '../composables/useBulkActionPreview'
import { formatBulkRequestError } from '../utils/errorCodeMessages'
import { generateIdempotencyKey } from '../utils/idempotencyKey'
import { rateLimitedBatch } from '../utils/rateLimitedBatch'
import { synthesizeRowSelectBulkResult } from '../utils/rowSelectBulkResult'
import type { RowSelectBulkResponse } from '../utils/rowSelectBulkResult'
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
// Hydrate from ?tenant_id=<id> so deep-links from BulkActionResultDialog's
// "View budget" link land on the right tenant's budget list (per-row
// triage from a bulk-action result → specific ledger row). Query key
// is `tenant_id` for consistency with AuditView's filter deep-links.
const selectedTenant = ref((route.query.tenant_id as string) || '')
const budgets = ref<BudgetLedger[]>([])
const hasMore = ref(false)
const nextCursor = ref('')
const loadingMore = ref(false)
const error = ref('')
// Default sort: highest utilization first. Operators triaging budgets
// care about "which scopes are closest to running dry", not when a
// ledger was provisioned — the near-exhausted rows are the actionable
// ones. Clicking any header switches to that column's natural order.
// V4 stage 2: server-side sort. All sort columns map cleanly to the
// admin-plane spec's listBudgets sort_by enum
// (tenant_id, scope, unit, status, commit_overage_policy, utilization,
// debt). onChange re-fetches page 1 because the cursor is bound to the
// (sort_by, sort_dir, filters) tuple — reusing a cursor under a new sort
// order returns 400 CURSOR_SORT_MISMATCH on 0.1.25.12+.
const { sortKey, sortDir, toggle, sorted: columnSortedBudgets } = useSort(
  budgets,
  'utilization',
  'desc',
  {
    utilization: (b: BudgetLedger) => b.allocated.amount > 0 ? (b.allocated.amount - b.remaining.amount) / b.allocated.amount : 0,
    debt: (b: BudgetLedger) => b.debt?.amount ?? 0,
    tenant_id: (b: BudgetLedger) => b.tenant_id || '',
  },
  { serverSide: true, onChange: () => { loadList() } },
)

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

// v0.1.25.46: hide CLOSED budgets by default. Under the utilization-desc
// default sort, a freshly-closed budget was pinned at the top of the
// list — no operator action remaining (CLOSED is terminal) but visually
// indistinguishable from a high-util ACTIVE one that does need attention.
// Toggle state mirrors to the URL. Picking status=CLOSED explicitly
// auto-shows closed budgets even with the toggle off.
const {
  includeTerminal,
  visibleRows: sortedBudgets,
  terminalCount: hiddenTerminalCount,
  terminalVerb,
} = useTerminalAwareList<BudgetLedger>({
  kind: 'budget',
  source: columnSortedBudgets,
  statusOf: b => b.status,
  explicitStatus: filterStatus,
  route,
  router,
})
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
// Hydrate from ?utilization_min=<pct>&utilization_max=<pct>. URL
// contract is integer percent (0–100) for operator readability —
// matches the input placeholder "min"/"max" labels and lets the
// Overview utilization donut's drill-down land on a pre-filtered
// list. Sanitized: only finite values in [0, 100] seed the filter.
function parseUtilPct(v: unknown): number | string {
  if (v === undefined || v === null || v === '') return ''
  const n = Number(v)
  if (!Number.isFinite(n)) return ''
  return Math.max(0, Math.min(100, n))
}
const filterUtilMin = ref<number | string>(parseUtilPct(route.query.utilization_min))
const filterUtilMax = ref<number | string>(parseUtilPct(route.query.utilization_max))
// cycles-governance-admin v0.1.25.21: free-text `search` query param
// on listBudgets (case-insensitive substring match on tenant_id +
// scope). Distinct from `scope_prefix` (kept as-is) — scope_prefix is
// a PREFIX match bound to scope only; search is a SUBSTRING match
// across tenant_id + scope together. Both combine with AND on the
// server when set. Debounced with the existing 300ms cadence so a
// 20-char filter doesn't fire 20 fetches.
//
// Hydrate from ?search=<scope> so BulkActionResultDialog's "View
// budget" deep-link lands on the matching row. The server's search
// matches tenant_id + scope only (NOT ledger_id — verified against
// BudgetListFilters.java#search), so the dialog passes the scope
// label from labelById as the search term, not the opaque UUID.
const search = ref((route.query.search as string) || '')

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
const debouncedSearch = useDebouncedRef(search, DEBOUNCE_MS)

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

// R2/W2 wire-up (cycles-server-admin v0.1.25.22+). /admin/budgets
// now accepts admin-key auth without a tenant_id filter and exposes
// server-side filter params: over_limit, has_debt, utilization_min,
// utilization_max. Pagination uses a composite cursor
// `{tenantId}|{ledgerId}` for cross-tenant mode, `{ledgerId}` for
// per-tenant mode. One listBudgets() call replaces the old fan-out.
//
// filterUtilMin / filterUtilMax are operator-facing PERCENTAGES (0-100)
// but the server expects RATIOS (0.0-1.0). Coerce at the wire boundary.
const PAGE_SIZE = 100

function buildListParams(extra: Record<string, string> = {}): Record<string, string> {
  const params: Record<string, string> = { limit: String(PAGE_SIZE), ...extra }
  if (selectedTenant.value) params.tenant_id = selectedTenant.value
  if (filterStatus.value) params.status = filterStatus.value
  if (filterUnit.value) params.unit = filterUnit.value
  if (filterScope.value) params.scope_prefix = filterScope.value
  // Trim before sending — a search param of spaces is semantically
  // empty on the server (case-insensitive substring ILIKE), and the
  // spec requires empty → absent. Trim here so the server doesn't
  // have to.
  const q = debouncedSearch.value.trim()
  if (q) params.search = q
  if (activeFilter.value === 'over_limit') params.over_limit = 'true'
  if (activeFilter.value === 'has_debt') params.has_debt = 'true'
  const rawMin = filterUtilMin.value
  const rawMax = filterUtilMax.value
  const minSet = rawMin !== '' && rawMin !== null && rawMin !== undefined
  const maxSet = rawMax !== '' && rawMax !== null && rawMax !== undefined
  if (minSet) {
    const n = Number(rawMin)
    if (Number.isFinite(n)) params.utilization_min = String(Math.max(0, Math.min(1, n / 100)))
  }
  if (maxSet) {
    const n = Number(rawMax)
    if (Number.isFinite(n)) params.utilization_max = String(Math.max(0, Math.min(1, n / 100)))
  }
  if (sortKey.value) {
    params.sort_by = sortKey.value
    params.sort_dir = sortDir.value
  }
  return params
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
    const res = await listBudgets(buildListParams())
    budgets.value = res.ledgers
    hasMore.value = !!res.has_more
    nextCursor.value = res.next_cursor ?? ''
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
  if (loadingMore.value || !nextCursor.value) return
  loadingMore.value = true
  try {
    const res = await listBudgets(buildListParams({ cursor: nextCursor.value }))
    budgets.value = [...budgets.value, ...res.ledgers]
    hasMore.value = !!res.has_more
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

const { refresh, isLoading, lastSuccessAt } = usePolling(tick, POLL_SLOW_MS)

// Budget freeze/unfreeze
const pendingAction = ref<{ action: 'freeze' | 'unfreeze'; scope: string; unit: string } | null>(null)

function requestFreeze(scope: string, unit: string, action: 'freeze' | 'unfreeze') {
  pendingAction.value = { action, scope, unit }
}

async function copyScope(scope: string) {
  try {
    await navigator.clipboard.writeText(scope)
    toast.success('Scope copied')
  } catch {
    toast.error('Copy failed — clipboard unavailable')
  }
}

async function copyBudgetJson(b: BudgetLedger) {
  if (await writeClipboardJson(b)) toast.success('Budget JSON copied')
  else toast.error('Copy failed — clipboard unavailable')
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
// `fundTarget` is the budget being funded. In detail mode it mirrors
// `detail.value`; in list mode the row's kebab Fund action passes the row
// directly so the dialog can operate on a budget that isn't the active
// detail. submitFund / the dialog header read from this, not detail.
const fundTarget = ref<BudgetLedger | null>(null)
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

function openFund(target?: BudgetLedger) {
  const t = target ?? detail.value
  if (!t) return
  fundTarget.value = t
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
    const current = fundTarget.value?.allocated?.amount
    fundForm.value.amount = typeof current === 'number' ? current : ''
  } else if (op !== 'RESET_SPENT' && prevOp === 'RESET_SPENT') {
    fundForm.value.amount = ''
    fundForm.value.spent = ''
  }
})

async function submitFund() {
  if (!fundTarget.value) return
  const target = fundTarget.value
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
  const tenantId = selectedTenant.value || tenantFromScope(target.scope)
  if (!tenantId) {
    fundError.value = `Cannot determine tenant for scope "${target.scope}". Expected a "tenant:<id>" prefix.`
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
    const idempotencyKey = `dashboard-${fundForm.value.operation.toLowerCase()}-${target.scope}-${Date.now()}-${suffix}`
    await fundBudget(tenantId, target.scope, target.unit, fundForm.value.operation, amount, idempotencyKey, fundForm.value.reason || `${fundForm.value.operation} via admin dashboard`, spent)
    if (isDetail.value) await loadDetail()
    else await loadList()
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

// ─── Filter-apply bulk action (cycles-governance-admin v0.1.25.26,
//     admin-server v0.1.25.29). Sibling of TenantsView / WebhooksView
//     filter-apply paths, with one structural twist: the budget endpoint
//     requires BudgetBulkFilter.tenant_id, so the entry button is
//     disabled whenever no tenant is selected — including the cross-
//     tenant list modes (?filter=over_limit / ?filter=has_debt) where
//     operators are scanning an incident fleet-wide. They still need to
//     pick a tenant before arming a mutation.
//
// Flow: (1) openBulkSetup() renders a FormDialog to collect action +
// amount/spent/reason; (2) submitBulkSetup() validates and opens the
// shared BulkActionPreviewDialog with a count walk; (3) executeFilterBulk()
// submits the request and, on any non-succeeded rows, opens
// BulkActionResultDialog with the per-row codes + messages.
const showBulkSetup = ref(false)
const bulkSetupForm = ref<{ action: BudgetBulkAction; unit: string; amount: number | string; spent: number | string; reason: string }>({
  action: 'CREDIT',
  unit: 'USD_MICROCENTS',
  amount: '',
  spent: '',
  reason: '',
})
const bulkSetupError = ref('')

// Mirrors the single-row fundHints map so operators see the same
// per-action copy in the bulk setup form as in the one-off Fund dialog.
const bulkActionHints: Record<BudgetBulkAction, string> = {
  CREDIT: 'Adds funds to each matching budget\'s allocated and remaining balance.',
  DEBIT: 'Removes funds from each matching budget. Rows whose remaining would go negative fail per-row with BUDGET_EXCEEDED.',
  RESET: 'Sets each matching budget\'s allocated to the exact amount; remaining is recalculated.',
  RESET_SPENT: 'Billing-period rollover — resets each matching budget\'s spent counter to the override (default 0). Allocated and reserved are preserved.',
  REPAY_DEBT: 'Reduces outstanding debt on each matching budget by this amount.',
}

// Per-action eligibility mirrors the single-row Fund action's server-side
// behaviour: CREDIT / DEBIT / REPAY_DEBT require status==='ACTIVE', otherwise
// the server would return INVALID_TRANSITION per-row. Client-side filtering
// keeps the preview count honest. RESET / RESET_SPENT run against all
// statuses — used for billing rollover that must touch FROZEN budgets too.
function bulkActionEligibleStatus(action: BudgetBulkAction): string | null {
  if (action === 'CREDIT' || action === 'DEBIT' || action === 'REPAY_DEBT') return 'ACTIVE'
  return null
}

// Preview state — values captured from the setup form when the preview
// opens. Kept on separate refs (not a single object) so the FormDialog
// can close and release its props cleanly before the PreviewDialog renders.
const filterBulkAction = ref<BudgetBulkAction | null>(null)
// Scalar magnitudes captured from the setup form. Wrapped as
// {unit, amount} Amount objects at send-time per spec v0.1.25.26.
const filterBulkAmount = ref<number | undefined>(undefined)
const filterBulkSpent = ref<number | undefined>(undefined)
const filterBulkUnit = ref<string>('')
const filterBulkReason = ref<string>('')
const filterBulkRunning = ref(false)
const filterBulkSubmitError = ref('')
// Per-row result dialog — opens after submit iff failed[] or skipped[]
// is non-empty.
const bulkResult = ref<{
  actionVerb: string
  response: BudgetBulkActionResponse | RowSelectBulkResponse
  labelById: Record<string, string>
  // Tenant the bulk ran on — forwarded to BulkActionResultDialog so
  // each enumerated row can deep-link "View budget" / "View audit".
  // Empty string when the row-select path spans multiple tenants
  // (cross-tenant listings like over_limit / has_debt); the dialog
  // suppresses triage links when tenantId is falsy.
  tenantId: string
} | null>(null)

// ─── Row-select bulk path (v0.1.25.36). Sibling of the filter-apply
//     path above. Freeze / Unfreeze aren't in the server-side
//     BUDGET_BULK_ACTIONS enum (spec v0.1.25.26 limits that enum to
//     the 5 balance-mutation actions), so bulk freeze/unfreeze fans out
//     over the per-row freezeBudget / unfreezeBudget wrappers via
//     rateLimitedBatch (bounded concurrency + 429 backoff). Pattern
//     mirrors TenantsView / WebhooksView row-select exactly.
const selected = ref<Set<string>>(new Set())
// Clear selection when any filter changes so a now-hidden row can't
// stay selected and get bulk-acted on. Watch the RAW (non-debounced)
// refs so the selection clears the instant the operator types, not
// after the 300ms debounce.
watch(
  [selectedTenant, filterStatus, filterUnit, filterScope, search, filterUtilMin, filterUtilMax],
  () => { selected.value = new Set() },
)
// P1-M4: route.query.filter drives the server-side `over_limit` /
// `has_debt` params (see buildListParams). Pre-fix, this watcher only
// cleared the selection — the nextCursor stayed live, still scoped to
// the previous filter. A subsequent Load-more click would send the old
// cursor against the new filter, which the server rejects with a
// filter-hash mismatch (and on lenient servers appends rows from the
// wrong filter). Re-running loadList resets nextCursor/hasMore
// up-front and re-fetches page 1 under the new filter.
watch(() => route.query.filter, () => {
  selected.value = new Set()
  if (!isDetail.value) void loadList()
})

function toggleSelect(ledgerId: string) {
  const next = new Set(selected.value)
  next.has(ledgerId) ? next.delete(ledgerId) : next.add(ledgerId)
  selected.value = next
}
function toggleSelectAll() {
  if (selectedVisibleAll.value) {
    selected.value = new Set()
  } else {
    selected.value = new Set(sortedBudgets.value.map(b => b.ledger_id))
  }
}
const selectedVisibleAll = computed(() =>
  sortedBudgets.value.length > 0 &&
  sortedBudgets.value.every(b => selected.value.has(b.ledger_id)),
)
const selectedVisibleCount = computed(() =>
  sortedBudgets.value.filter(b => selected.value.has(b.ledger_id)).length,
)

// Bulk freeze / unfreeze state machine. Same shape as TenantsView's
// bulkAction/bulkProgress/bulkRunning.
const bulkStatusAction = ref<'freeze' | 'unfreeze' | null>(null)
const bulkStatusProgress = ref({ done: 0, total: 0, failed: 0 })
const bulkStatusRunning = ref(false)
let bulkStatusAbort: AbortController | null = null

function openBulkStatus(action: 'freeze' | 'unfreeze') {
  bulkStatusAction.value = action
}

// Filter the selection to rows whose current status allows the transition
// BEFORE arming the confirm dialog. Freeze needs ACTIVE, unfreeze needs
// FROZEN. Anything else (already in the target state, or CLOSED terminal)
// is skipped — avoids noisy 409s and keeps the progress count honest.
// Used by the confirm dialog's count AND by executeBulkStatus.
function bulkStatusTargets(): BudgetLedger[] {
  if (!bulkStatusAction.value) return []
  const required = bulkStatusAction.value === 'freeze' ? 'ACTIVE' : 'FROZEN'
  return budgets.value.filter(b =>
    selected.value.has(b.ledger_id) && b.status === required,
  )
}

async function executeBulkStatus() {
  if (!bulkStatusAction.value || bulkStatusRunning.value) return
  const action = bulkStatusAction.value
  const targets = bulkStatusTargets()
  bulkStatusProgress.value = { done: 0, total: targets.length, failed: 0 }
  bulkStatusRunning.value = true
  bulkStatusAbort = new AbortController()
  // Capture settled-successful indices for synthesizeRowSelectBulkResult —
  // rateLimitedBatch only tracks failures natively.
  const settledSucceeded: number[] = []
  const result = await rateLimitedBatch(
    targets,
    async (b, i) => {
      if (action === 'freeze') {
        await freezeBudget(b.scope, b.unit, 'Frozen via admin dashboard (bulk)')
      } else {
        await unfreezeBudget(b.scope, b.unit, 'Unfrozen via admin dashboard (bulk)')
      }
      settledSucceeded.push(i)
    },
    {
      signal: bulkStatusAbort.signal,
      onProgress: (done, total, failed) => { bulkStatusProgress.value = { done, total, failed } },
    },
  )
  bulkStatusRunning.value = false
  bulkStatusAbort = null
  const succeeded = result.done - result.failed
  const verb = action === 'freeze' ? 'frozen' : 'unfrozen'
  const summary = `${succeeded}/${bulkStatusProgress.value.total} budgets ${verb}`
  if (result.failed > 0) {
    toast.error(`${summary}, ${result.failed} failed — see details`)
  } else if (result.cancelled) {
    toast.success(`${summary} (cancelled by user)`)
  } else {
    toast.success(summary)
  }
  bulkStatusAction.value = null
  selected.value = new Set()
  if (result.failed > 0 || result.cancelled) {
    // Row-select budgets can span multiple tenants (over_limit / has_debt
    // cross-tenant listings), so each row's id is ledger_id and the
    // dialog's "View budget" triage link uses search by scope — supply
    // a per-row label map keyed by ledger_id. Set tenantId only when
    // the selection came from a tenant-scoped list; otherwise the
    // dialog suppresses triage links (showTriageLinks requires tenantId).
    const labels: Record<string, string> = {}
    for (const b of targets) labels[b.ledger_id] = `${b.scope} (${b.unit})`
    const singleTenant = new Set(targets.map(t => t.tenant_id)).size === 1
      ? targets[0]?.tenant_id ?? ''
      : ''
    bulkResult.value = {
      actionVerb: action === 'freeze' ? 'Freeze' : 'Unfreeze',
      response: synthesizeRowSelectBulkResult({
        targets,
        result,
        succeededIndices: settledSucceeded,
        idOf: b => b.ledger_id,
      }),
      labelById: labels,
      tenantId: singleTenant,
    }
  }
  await loadList()
}

function cancelBulkStatus() {
  if (bulkStatusRunning.value) {
    bulkStatusAbort?.abort()
  } else {
    bulkStatusAction.value = null
  }
}

// Spec v0.1.25.26: BudgetBulkFilter.tenant_id is REQUIRED. Cross-tenant
// list modes (`?filter=over_limit`, `?filter=has_debt`) show budgets
// across every tenant, so a bulk action from that mode would have no
// valid tenant_id to send. Disable the entry point there; the operator
// must first navigate to the specific tenant they want to act on.
function canBulkAct(): boolean {
  return !!selectedTenant.value && !isCrossTenantFilter.value
}

// Walk listBudgets with the SAME server-side filter the bulk submit will
// use — tenant_id, scope_prefix, unit, status, search, utilization range
// are all server-filterable, so the client-side filterFn below only has
// to add the action-derived status gate for actions that require ACTIVE.
const filterBulkPreview = useBulkActionPreview<BudgetLedger>({
  fetchPage: async (cursor) => {
    const params = buildListParams(cursor ? { cursor } : {})
    const res = await listBudgets(params)
    return { items: res.ledgers, hasMore: !!res.has_more, nextCursor: res.next_cursor ?? '' }
  },
  filterFn: (b) => {
    if (!filterBulkAction.value) return false
    const required = bulkActionEligibleStatus(filterBulkAction.value)
    if (required && b.status !== required) return false
    return true
  },
  toSample: (b) => ({
    id: b.ledger_id,
    primary: b.scope,
    sublabel: b.unit,
    status: b.status,
  }),
  // Budget ledger_ids are opaque UUIDs — scope is what operators
  // recognize. Collect a full id→scope map during the preview walk so
  // BulkActionResultDialog can render scope alongside the UUID on every
  // succeeded/failed/skipped row. Without this, a partial-failure result
  // shows only UUIDs and the operator has to cross-reference back to
  // the preview to identify which budget failed.
  labelFn: (b) => ({ id: b.ledger_id, label: b.scope }),
})

function openBulkSetup() {
  if (!canBulkAct()) return
  // Seed unit from the list filter when set — the operator already
  // scoped their filter to that unit, so we default to the same.
  // Otherwise fall back to the most common admin unit.
  bulkSetupForm.value = {
    action: 'CREDIT',
    unit: filterUnit.value || 'USD_MICROCENTS',
    amount: '',
    spent: '',
    reason: '',
  }
  bulkSetupError.value = ''
  showBulkSetup.value = true
}

function cancelBulkSetup() {
  showBulkSetup.value = false
  bulkSetupError.value = ''
}

function submitBulkSetup() {
  bulkSetupError.value = ''
  const action = bulkSetupForm.value.action
  const unit = bulkSetupForm.value.unit
  if (!unit) {
    bulkSetupError.value = 'Unit is required'
    return
  }
  // Spec v0.1.25.26: amount is required for ALL five actions including
  // RESET_SPENT (that action sets allocated to `amount`; `spent` is the
  // optional counter override that defaults to 0).
  const n = Number(bulkSetupForm.value.amount)
  if (!Number.isFinite(n) || n <= 0) {
    bulkSetupError.value = 'Amount must be a positive number'
    return
  }
  filterBulkAmount.value = n
  if (action === 'RESET_SPENT') {
    if (bulkSetupForm.value.spent === '' || bulkSetupForm.value.spent === null) {
      filterBulkSpent.value = undefined
    } else {
      const s = Number(bulkSetupForm.value.spent)
      if (!Number.isFinite(s) || s < 0) {
        bulkSetupError.value = 'Spent override must be zero or a positive number'
        return
      }
      filterBulkSpent.value = s
    }
  } else {
    filterBulkSpent.value = undefined
  }
  filterBulkUnit.value = unit
  filterBulkReason.value = bulkSetupForm.value.reason.trim()
  filterBulkAction.value = action
  filterBulkSubmitError.value = ''
  showBulkSetup.value = false
  void filterBulkPreview.startPreview()
}

// Human-readable summary of the filter the preview+submit will send. Mirrors
// the server-side fields that buildListParams forwards, but adds the action-
// derived status gate when the operator hasn't set filterStatus themselves,
// so the summary reflects what the server will actually match.
const filterBulkSummary = computed<string>(() => {
  const parts: string[] = []
  if (selectedTenant.value) parts.push(`tenant_id=${selectedTenant.value}`)
  if (filterStatus.value) parts.push(`status=${filterStatus.value}`)
  else if (filterBulkAction.value) {
    const s = bulkActionEligibleStatus(filterBulkAction.value)
    if (s) parts.push(`status=${s}`)
  }
  if (filterUnit.value) parts.push(`unit=${filterUnit.value}`)
  if (filterScope.value) parts.push(`scope_prefix=${filterScope.value}`)
  const q = debouncedSearch.value.trim()
  if (q) parts.push(`search="${q}"`)
  const rawMin = filterUtilMin.value
  const rawMax = filterUtilMax.value
  if (rawMin !== '' && rawMin !== null && rawMin !== undefined) parts.push(`utilization_min=${Number(rawMin) / 100}`)
  if (rawMax !== '' && rawMax !== null && rawMax !== undefined) parts.push(`utilization_max=${Number(rawMax) / 100}`)
  return parts.join(' AND ')
})

// Title-cased action verb for dialog headers: CREDIT → "Credit",
// RESET_SPENT → "Reset spent".
function actionVerb(action: BudgetBulkAction): string {
  const lower = action.toLowerCase().replace('_', ' ')
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function cancelFilterBulk() {
  if (filterBulkRunning.value) return
  filterBulkPreview.cancelPreview()
  filterBulkPreview.resetPreview()
  filterBulkAction.value = null
  filterBulkAmount.value = undefined
  filterBulkSpent.value = undefined
  filterBulkUnit.value = ''
  filterBulkReason.value = ''
  filterBulkSubmitError.value = ''
}

async function executeFilterBulk() {
  if (!filterBulkAction.value || filterBulkRunning.value) return
  if (filterBulkPreview.previewLoading.value) return
  if (filterBulkPreview.previewCount.value === 0) return
  if (filterBulkPreview.cappedAtMax.value) return

  const action = filterBulkAction.value
  // Defense-in-depth: server rejects missing tenant_id with 400. The
  // disabled-state on the entry button already enforces this but a
  // programmatic confirm (test harness, browser devtools) could slip past.
  const tenantId = selectedTenant.value
  if (!tenantId) {
    filterBulkSubmitError.value = 'Select a tenant before submitting a bulk action.'
    return
  }
  const filter: BudgetBulkFilter = { tenant_id: tenantId }
  if (filterStatus.value) filter.status = filterStatus.value
  else {
    const required = bulkActionEligibleStatus(action)
    if (required) filter.status = required
  }
  if (filterUnit.value) filter.unit = filterUnit.value
  if (filterScope.value) filter.scope_prefix = filterScope.value
  const q = debouncedSearch.value.trim()
  if (q) filter.search = q
  const rawMin = filterUtilMin.value
  const rawMax = filterUtilMax.value
  if (rawMin !== '' && rawMin !== null && rawMin !== undefined) {
    const n = Number(rawMin)
    if (Number.isFinite(n)) filter.utilization_min = Math.max(0, Math.min(1, n / 100))
  }
  if (rawMax !== '' && rawMax !== null && rawMax !== undefined) {
    const n = Number(rawMax)
    if (Number.isFinite(n)) filter.utilization_max = Math.max(0, Math.min(1, n / 100))
  }

  filterBulkRunning.value = true
  filterBulkSubmitError.value = ''
  try {
    const body: BudgetBulkActionRequest = {
      filter,
      action,
      idempotency_key: generateIdempotencyKey(),
    }
    // Spec v0.1.25.26: amount and spent are Amount objects ({unit, amount}),
    // not scalar numbers. Scalar send ⇒ server 400 INVALID_REQUEST.
    const unit = filterBulkUnit.value
    if (filterBulkAmount.value !== undefined) {
      body.amount = { unit, amount: filterBulkAmount.value }
    }
    if (filterBulkSpent.value !== undefined) {
      body.spent = { unit, amount: filterBulkSpent.value }
    }
    if (filterBulkReason.value) body.reason = filterBulkReason.value
    // Only send expected_count when the preview walk completed naturally.
    // A partial (capped) count would guarantee COUNT_MISMATCH against the
    // server's true total. Same rule as TenantsView / WebhooksView.
    if (filterBulkPreview.reachedEnd.value) {
      body.expected_count = filterBulkPreview.previewCount.value
    }
    const res = await bulkActionBudgets(body)
    const pastTense: Record<BudgetBulkAction, string> = {
      CREDIT: 'credited',
      DEBIT: 'debited',
      RESET: 'allocation reset',
      RESET_SPENT: 'spent reset',
      REPAY_DEBT: 'debt repaid',
    }
    const summaryParts = [`${res.succeeded.length}/${res.total_matched} budgets ${pastTense[action]}`]
    if (res.skipped.length) summaryParts.push(`${res.skipped.length} skipped`)
    if (res.failed.length) summaryParts.push(`${res.failed.length} failed`)
    const summary = summaryParts.join(', ')
    if (res.failed.length) toast.error(`${summary} — see details`)
    else toast.success(summary)
    // Snapshot the label map BEFORE resetPreview() clears it — the
    // result dialog needs it to render scope alongside each row's
    // ledger-id (opaque UUID on its own).
    const labels = { ...filterBulkPreview.previewLabels.value }
    // Close the preview first; the result dialog opens as a separate overlay.
    filterBulkAction.value = null
    filterBulkAmount.value = undefined
    filterBulkSpent.value = undefined
    filterBulkUnit.value = ''
    filterBulkReason.value = ''
    filterBulkPreview.resetPreview()
    if (res.failed.length || res.skipped.length) {
      bulkResult.value = { actionVerb: actionVerb(action), response: res, labelById: labels, tenantId }
    }
  } catch (e) {
    if (e instanceof ApiError && (e.errorCode === 'LIMIT_EXCEEDED' || e.errorCode === 'COUNT_MISMATCH')) {
      filterBulkSubmitError.value = formatBulkRequestError(e.errorCode, 'budgets', 500, e.details as Record<string, unknown> | undefined) ?? `Bulk ${action} failed: ${toMessage(e)}`
    } else {
      filterBulkSubmitError.value = `Bulk ${action} failed: ${toMessage(e)}`
    }
  } finally {
    filterBulkRunning.value = false
    await loadList()
  }
}

watch(selectedTenant, () => { if (!isCrossTenantFilter.value && !isDetail.value) loadList() })
watch(() => route.query, (q) => {
  // BulkActionResultDialog's View-budget link and the Overview
  // utilization donut's drill-down both navigate to the same /budgets
  // route with different query params — Vue Router keeps the component
  // mounted, so the setup-time hydration above doesn't re-run. Sync
  // the refs explicitly when URL-driven filters change.
  const nextTenant = (q.tenant_id as string) || ''
  if (nextTenant !== selectedTenant.value) selectedTenant.value = nextTenant
  const nextSearch = (q.search as string) || ''
  if (nextSearch !== search.value) search.value = nextSearch
  const nextUtilMin = parseUtilPct(q.utilization_min)
  if (nextUtilMin !== filterUtilMin.value) filterUtilMin.value = nextUtilMin
  const nextUtilMax = parseUtilPct(q.utilization_max)
  if (nextUtilMax !== filterUtilMax.value) filterUtilMax.value = nextUtilMax
  if (isDetail.value) loadDetail()
  else loadList()
})

// V5 debounce auto-apply on text/numeric filter changes. All three
// now push their values to the server (scope_prefix, utilization_min,
// utilization_max) so the watcher just re-runs loadList() and the new
// server-filtered page-1 replaces the current list.
watch(debouncedFilterScope, () => { if (!isDetail.value) loadList() })
watch(debouncedFilterUtilMin, () => { if (!isDetail.value) loadList() })
watch(debouncedFilterUtilMax, () => { if (!isDetail.value) loadList() })
watch(debouncedSearch, () => { if (!isDetail.value) loadList() })

// Export — list-mode only (detail mode is a single scope + event
// timeline, no list to export). The server exposes cursor-paginated
// cross-tenant list with the same filter set, so the composable can
// walk the full result honestly in every mode.
const {
  showExportConfirm,
  exporting,
  exportFetched,
  exportError,
  exportCancellable,
  maxRows: EXPORT_MAX_ROWS,
  confirmExport,
  cancelExport,
  cancelRunningExport,
  executeExport,
} = useListExport<BudgetLedger>({
  itemNoun: 'budget',
  filenameStem: 'budgets',
  currentItems: sortedBudgets,
  hasMore,
  nextCursor,
  fetchPage: async (cursor) => {
    const res = await listBudgets(buildListParams({ cursor }))
    return { items: res.ledgers, hasMore: !!res.has_more, nextCursor: res.next_cursor ?? '' }
  },
  columns: [
    { header: 'tenant_id',             value: b => b.tenant_id ?? '' },
    { header: 'scope',                 value: b => b.scope },
    { header: 'unit',                  value: b => b.unit },
    { header: 'status',                value: b => b.status },
    { header: 'allocated_amount',      value: b => b.allocated.amount },
    { header: 'remaining_amount',      value: b => b.remaining.amount },
    { header: 'spent_amount',          value: b => b.spent?.amount ?? 0 },
    { header: 'debt_amount',           value: b => b.debt?.amount ?? 0 },
    { header: 'is_over_limit',         value: b => String(!!b.is_over_limit) },
    { header: 'commit_overage_policy', value: b => b.commit_overage_policy ?? '' },
    { header: 'created_at',            value: b => b.created_at ?? '' },
  ],
})

watch(exportError, (v) => { if (v) error.value = v })

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
// +Tenant column (minmax(140px,1fr)) as leftmost — cross-tenant
// mode is now first-class; operators triaging "over_limit across the
// fleet" need per-row tenant context to act.
const gridTemplate = computed(() =>
  canManage.value
    ? '40px minmax(140px,1fr) minmax(220px,2fr) 130px 110px 150px minmax(180px,1fr) 140px 96px'
    : 'minmax(140px,1fr) minmax(220px,2fr) 130px 110px 150px minmax(180px,1fr) 140px',
)

// Display-side tenant resolver. Prefers the wire-level tenant_id (new in
// v0.1.25.23), falls back to parsing the scope string for pre-upgrade
// servers or legacy ledgers. tenantFromScope returns '' on malformed
// scopes — the row shows an em-dash placeholder in that case.
function rowTenantId(b: BudgetLedger): string {
  return b.tenant_id || tenantFromScope(b.scope) || ''
}
</script>

<template>
  <!-- Phase 5 (table-layout unification): flex-fill root. Dual-mode:
       detail branch lays out as natural block flow (cards stack),
       list branch uses its own flex-col wrapper to flex-fill the
       virtualized table. -->
  <div class="h-full flex flex-col min-h-0">
    <PageHeader
      :title="pageTitle"
      :subtitle="isDetail && detail ? `${detail.scope} · ${detail.unit}` : undefined"
      item-noun="budget"
      :loaded="!isDetail ? sortedBudgets.length : undefined"
      :has-more="!isDetail ? hasMore : undefined"
      :loading="isLoading"
      :last-updated-at="lastSuccessAt"
      @refresh="refresh"
    >
      <template #back>
        <button v-if="isDetail" @click="router.push({ name: 'budgets' })" aria-label="Back to budgets" class="muted hover:text-gray-700 cursor-pointer">
          <BackArrowIcon class="w-5 h-5" />
        </button>
      </template>
      <template v-if="!isDetail" #actions>
        <button @click="confirmExport('csv')" :disabled="sortedBudgets.length === 0" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">
          <DownloadIcon class="w-3.5 h-3.5" />
          Export CSV
        </button>
        <button @click="confirmExport('json')" :disabled="sortedBudgets.length === 0" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">
          <DownloadIcon class="w-3.5 h-3.5" />
          Export JSON
        </button>
      </template>
    </PageHeader>

    <InlineErrorBanner v-if="error" :message="error" @dismiss="error = ''" />


    <!-- Detail mode -->
    <template v-if="isDetail && detail">
      <div class="bg-white rounded-lg shadow p-6 mb-4">
        <div class="flex items-center gap-3 mb-4 flex-wrap">
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
          <!-- Fund Budget leads the action row — it is the most-used
               operator action on this view (credit/debit/reset/repay
               all live behind the same dialog). btn-pill-primary keeps
               the emphasis the bordered middle-of-card section used to
               provide. -->
          <button v-if="canManage && detail.status === 'ACTIVE'" @click="openFund()" class="btn-pill-primary">Fund Budget</button>
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

      </div>

      <!-- Event timeline card flex-fills the remaining viewport so
           the virtualized list inside EventTimeline has a bounded
           scroll container — parity with the list-view Phase 5
           pattern. Header (h3) and footer (Load more) take natural
           height; the timeline itself flexes. -->
      <div class="card p-4 flex-1 min-h-0 flex flex-col">
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
            {{ detailEventsLoadingMore ? 'Loading…' : 'Load more' }}
          </button>
        </div>
      </div>
    </template>

    <!-- List mode. Wrap the list-mode subtree in its own flex-col so
         the virtualized table below can flex-fill without polluting
         the detail-mode (natural block flow) layout. -->
    <div v-else class="flex flex-col flex-1 min-h-0">
      <!-- Active filter banner -->
      <div v-if="isCrossTenantFilter" class="flex items-center gap-2 mb-4 px-4 py-2.5 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
        <span>Showing {{ activeFilter === 'over_limit' ? 'over-limit' : 'budgets with debt' }} across all tenants</span>
        <button @click="clearFilter" class="ml-auto text-xs text-blue-600 hover:underline cursor-pointer">Clear filter</button>
      </div>

      <!-- P1-M5: surfaces "all tenants" scope when no tenant is selected
           and no cross-tenant filter is active. Prevents the soft
           failure mode where an operator thinks they're looking at one
           tenant's budgets but is actually seeing every tenant's —
           per-row actions still auto-scope by budget, but bulk actions
           are gated on tenant_id so this banner also explains why bulk
           is disabled in this state. -->
      <div
        v-if="!isCrossTenantFilter && !selectedTenant && !isDetail"
        class="flex items-center gap-2 mb-4 px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-600 dark:bg-gray-900 dark:border-gray-800 dark:text-gray-300"
        data-testid="budgets-all-tenants-scope"
      >
        <span>Viewing budgets across all tenants. Pick a tenant to enable bulk actions.</span>
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
          <div>
            <label for="budget-search" class="form-label">Search</label>
            <input id="budget-search" v-model="search" type="search" placeholder="tenant_id or scope" class="border border-gray-300 rounded px-2 py-1.5 text-sm" aria-label="Search by tenant_id or scope substring" />
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
          <!-- v0.1.25.46: terminal-row toggle. CLOSED budgets are hidden
               by default so a freshly-closed ledger doesn't pin to the top
               of the utilization-desc list. Explicit status=CLOSED filter
               auto-shows them. -->
          <div>
            <label class="form-label opacity-0" aria-hidden="true">spacer</label>
            <label class="text-sm flex items-center gap-1.5 text-gray-700 dark:text-gray-200 whitespace-nowrap py-1.5">
              <input v-model="includeTerminal" type="checkbox" :aria-label="`Show ${terminalVerb} budgets`" />
              Show {{ terminalVerb }}<span v-if="hiddenTerminalCount > 0 && !includeTerminal" class="muted-sm">&nbsp;({{ hiddenTerminalCount }})</span>
            </label>
          </div>
          <div v-if="isLoading" class="flex items-center">
            <Spinner class="w-4 h-4 muted" />
          </div>
          <!-- Filter-apply bulk action. BudgetBulkFilter.tenant_id is
               required by spec, so the button is disabled until an
               operator has selected a tenant; the tooltip explains why.
               Placed at the end of the filter row so operators move
               left-to-right through filter fields and land on the
               action. Styled as a secondary button, not inline with the
               filters, so it reads as "act on the current filter" rather
               than as another filter field. -->
          <div
            v-if="canManage"
            role="group"
            aria-label="Apply action to all budgets matching the current filter"
            class="inline-flex items-center gap-2 flex-wrap self-end"
          >
            <div class="w-px h-5 bg-gray-200 dark:bg-gray-700" aria-hidden="true"></div>
            <button
              @click="openBulkSetup"
              :disabled="!canBulkAct() || filterBulkRunning"
              :title="canBulkAct() ? 'Apply an action to every budget matching the current filter' : ''"
              class="text-xs text-gray-800 dark:text-gray-200 hover:text-gray-900 dark:hover:text-white border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 rounded px-2.5 py-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >{{ canBulkAct() ? 'Bulk action…' : 'Select a tenant to bulk-act' }}</button>
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
        class="bg-white rounded-lg shadow overflow-hidden text-sm flex-1 min-h-0 flex flex-col"
        role="table"
        :aria-rowcount="sortedBudgets.length + 1"
        :aria-colcount="canManage ? 9 : 7"
      >
        <div role="rowgroup" class="table-header border-b border-gray-200 sticky top-0 z-10">
          <div role="row" class="grid text-xs font-bold uppercase tracking-wider" :style="{ gridTemplateColumns: gridTemplate }">
            <div v-if="canManage" role="columnheader" class="table-cell">
              <input type="checkbox" :checked="selectedVisibleAll" @change="toggleSelectAll" aria-label="Select all visible budgets" />
            </div>
            <SortHeader as="div" label="Tenant" column="tenant_id" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader as="div" label="Scope" column="scope" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader as="div" label="Unit" column="unit" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader as="div" label="Status" column="status" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader as="div" label="Overage" column="commit_overage_policy" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader as="div" label="Utilization" column="utilization" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader as="div" label="Debt" column="debt" :active-column="sortKey" :direction="sortDir" @sort="toggle" align="right" />
            <div v-if="canManage" role="columnheader" class="table-cell" data-column="action"></div>
          </div>
        </div>

        <div
          v-if="sortedBudgets.length > 0"
          ref="scrollEl"
          role="rowgroup"
          class="flex-1 overflow-auto min-h-[240px]"
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
              <div v-if="canManage" role="cell" class="table-cell">
                <input
                  type="checkbox"
                  :checked="selected.has(sortedBudgets[v.index].ledger_id)"
                  @change="toggleSelect(sortedBudgets[v.index].ledger_id)"
                  :aria-label="`Select budget ${sortedBudgets[v.index].scope}`"
                />
              </div>
              <div role="cell" class="table-cell min-w-0">
                <TenantLink v-if="rowTenantId(sortedBudgets[v.index])" :tenant-id="rowTenantId(sortedBudgets[v.index])" />
                <span v-else class="muted-sm">—</span>
              </div>
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
                <!-- Activity + Copy scope are always shown so even
                     CLOSED budgets (which gate every other action off)
                     still expose a 2-item kebab. Activity drills the
                     audit log pre-filtered to this budget scope. -->
                <RowActionsMenu
                  :aria-label="`Actions for budget ${sortedBudgets[v.index].scope}`"
                  :items="[
                    { label: 'Activity', to: { name: 'audit', query: { resource_type: 'budget', resource_id: sortedBudgets[v.index].scope } } },
                    { label: 'Copy scope', onClick: () => copyScope(sortedBudgets[v.index].scope) },
                    { label: 'Copy as JSON', onClick: () => copyBudgetJson(sortedBudgets[v.index]) },
                    { label: 'Fund', onClick: () => openFund(sortedBudgets[v.index]), hidden: sortedBudgets[v.index].status !== 'ACTIVE' },
                    { label: 'Unfreeze', onClick: () => requestFreeze(sortedBudgets[v.index].scope, sortedBudgets[v.index].unit, 'unfreeze'), hidden: sortedBudgets[v.index].status !== 'FROZEN' },
                    { separator: true },
                    { label: 'Freeze', onClick: () => requestFreeze(sortedBudgets[v.index].scope, sortedBudgets[v.index].unit, 'freeze'), danger: true, hidden: sortedBudgets[v.index].status !== 'ACTIVE' },
                  ]"
                />
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
          {{ loadingMore ? 'Loading...' : 'Load more' }}
        </button>
      </div>
    </div>

    <!-- Row-select bulk toolbar (v0.1.25.36). Floating, teleported to
         body so it stays pinned to the viewport while the virtualized
         table scrolls. Mirrors TenantsView / WebhooksView pattern:
         pill-shaped, top-center, visible only when selectedVisibleCount
         > 0, Transition on mount/unmount. Actions are Freeze / Unfreeze
         via rateLimitedBatch over per-row endpoints (no server-side
         BUDGET_BULK_ACTIONS entry for these verbs in spec v0.1.25.26). -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="opacity-0 -translate-y-4"
        enter-to-class="opacity-100 translate-y-0"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="opacity-100 translate-y-0"
        leave-to-class="opacity-0 -translate-y-4"
      >
        <div
          v-if="canManage && selectedVisibleCount > 0"
          role="toolbar"
          aria-label="Bulk budget actions"
          class="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-white dark:bg-gray-900 dark:border dark:border-gray-700 border-2 border-blue-400 shadow-2xl rounded-lg px-4 py-2.5 flex items-center gap-3 max-w-[90vw]"
        >
          <span class="text-sm font-semibold text-blue-900 dark:text-blue-300 tabular-nums">{{ selectedVisibleCount }} selected</span>
          <div class="w-px h-5 bg-gray-200 dark:bg-gray-700" aria-hidden="true"></div>
          <button @click="openBulkStatus('freeze')" class="text-xs text-red-700 hover:text-red-900 border border-red-300 bg-white rounded px-2.5 py-1 cursor-pointer">Freeze</button>
          <button @click="openBulkStatus('unfreeze')" class="text-xs text-green-700 hover:text-green-900 border border-green-300 bg-white rounded px-2.5 py-1 cursor-pointer">Unfreeze</button>
          <button
            @click="selected = new Set()"
            aria-label="Clear selection"
            class="muted hover:text-gray-700 cursor-pointer p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <CloseIcon class="w-4 h-4" />
          </button>
        </div>
      </Transition>
    </Teleport>

    <!-- Bulk freeze/unfreeze confirm. Reuses the pattern from
         TenantsView's bulkAction ConfirmAction: during execution the
         message slot shows live progress (done/total/failed), cancel
         mid-run aborts at the next rateLimitedBatch iteration
         boundary. Targets are filtered to the eligible status before
         the count is shown so operators see the real row count that
         will be acted on. -->
    <ConfirmAction
      v-if="bulkStatusAction"
      :title="bulkStatusAction === 'freeze'
        ? `Freeze ${bulkStatusRunning ? bulkStatusProgress.total : bulkStatusTargets().length} budgets?`
        : `Unfreeze ${bulkStatusRunning ? bulkStatusProgress.total : bulkStatusTargets().length} budgets?`"
      :message="bulkStatusRunning
        ? `Working… ${bulkStatusProgress.done}/${bulkStatusProgress.total} processed${bulkStatusProgress.failed ? ` (${bulkStatusProgress.failed} failed)` : ''}.`
        : bulkStatusAction === 'freeze'
          ? `This will block all reservations, commits, and fund operations against each selected ACTIVE budget. Already-FROZEN and CLOSED budgets in the selection will be skipped. Reversible by unfreezing.`
          : `This will re-enable reservations, commits, and fund operations against each selected FROZEN budget. Already-ACTIVE and CLOSED budgets in the selection will be skipped.`"
      :confirm-label="bulkStatusRunning ? 'Working…' : bulkStatusAction === 'freeze' ? 'Freeze all' : 'Unfreeze all'"
      :danger="bulkStatusAction === 'freeze'"
      :loading="bulkStatusRunning"
      @confirm="executeBulkStatus"
      @cancel="cancelBulkStatus"
    />

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
      <p v-if="fundTarget" class="muted-sm mb-1">Funding <span class="font-mono">{{ fundTarget.scope }}</span> ({{ fundTarget.unit }}).</p>
      <div class="info-panel text-xs grid grid-cols-3 gap-2 mb-1">
        <div><span class="muted block">Allocated</span><span class="font-semibold">{{ fundTarget?.allocated.amount.toLocaleString() }}</span></div>
        <div><span class="muted block">Remaining</span><span class="font-semibold">{{ fundTarget?.remaining.amount.toLocaleString() }}</span></div>
        <div><span class="muted block">Debt</span><span class="font-semibold" :class="(fundTarget?.debt?.amount ?? 0) > 0 ? 'text-red-600' : ''">{{ (fundTarget?.debt?.amount ?? 0).toLocaleString() }}</span></div>
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
          {{ fundForm.operation === 'RESET_SPENT' ? `Allocated for new period (${fundTarget?.unit})` : `Amount (${fundTarget?.unit})` }}
        </label>
        <input id="fund-amount" v-model="fundForm.amount" type="number" :min="fundForm.operation === 'RESET_SPENT' ? 0 : 0" step="1" required class="form-input-mono" />
        <p v-if="fundForm.operation === 'RESET_SPENT'" class="muted-sm mt-0.5">Pre-filled with current allocated. Change to start the new billing period at a different allocation.</p>
      </div>
      <div v-if="fundForm.operation === 'RESET_SPENT'">
        <label for="fund-spent" class="form-label">Spent override ({{ fundTarget?.unit }}, optional)</label>
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

    <ExportDialog
      :format="showExportConfirm"
      :loaded-count="sortedBudgets.length"
      :has-more="hasMore"
      :max-rows="EXPORT_MAX_ROWS"
      item-noun-plural="budgets"
      @confirm="executeExport"
      @cancel="cancelExport"
    />
    <ExportProgressOverlay
      :open="exporting"
      :fetched="exportFetched"
      :cancellable="exportCancellable"
      item-noun-plural="budgets"
      @cancel="cancelRunningExport"
    />

    <!-- Bulk-action setup (step 1). Collects action + amount/spent/reason
         before the preview walk. Split from the preview because the
         shared BulkActionPreviewDialog is filter-agnostic and doesn't
         render numeric fields — and budget bulk actions all need at
         least one numeric input (amount, or spent for RESET_SPENT). -->
    <FormDialog
      v-if="showBulkSetup"
      title="Bulk budget action"
      submit-label="Preview"
      :error="bulkSetupError"
      @submit="submitBulkSetup"
      @cancel="cancelBulkSetup"
    >
      <p class="muted-sm">Will apply to every budget matching the current filter for tenant <span class="font-mono">{{ selectedTenant }}</span>.</p>
      <div>
        <label for="bulk-op" class="form-label">Action</label>
        <select id="bulk-op" v-model="bulkSetupForm.action" required class="form-select w-full">
          <option value="CREDIT">Credit — add funds</option>
          <option value="DEBIT">Debit — remove funds</option>
          <option value="RESET">Reset — set exact allocated</option>
          <option value="RESET_SPENT">Reset spent — billing-period rollover</option>
          <option value="REPAY_DEBT">Repay debt — reduce debt</option>
        </select>
        <p class="muted-sm mt-0.5">{{ bulkActionHints[bulkSetupForm.action] }}</p>
      </div>
      <div>
        <label for="bulk-unit" class="form-label">Unit</label>
        <select id="bulk-unit" v-model="bulkSetupForm.unit" required class="form-select w-full">
          <option>USD_MICROCENTS</option>
          <option>TOKENS</option>
          <option>CREDITS</option>
          <option>RISK_POINTS</option>
        </select>
        <p class="muted-sm mt-0.5">Rows whose budget unit differs fail per-row with INVALID_TRANSITION — the bulk op does not abort.</p>
      </div>
      <div>
        <label for="bulk-amount" class="form-label">
          {{ bulkSetupForm.action === 'RESET_SPENT' ? 'Amount (new allocated)' : 'Amount' }}
        </label>
        <input id="bulk-amount" v-model="bulkSetupForm.amount" type="number" min="0" step="1" required class="form-input-mono" />
        <p class="muted-sm mt-0.5">
          {{ bulkSetupForm.action === 'RESET_SPENT'
              ? 'Sets each matching budget\'s allocated to this value. Spec requires amount for RESET_SPENT.'
              : 'Applied to every matching budget in the configured unit.' }}
        </p>
      </div>
      <div v-if="bulkSetupForm.action === 'RESET_SPENT'">
        <label for="bulk-spent" class="form-label">Spent override (optional)</label>
        <input id="bulk-spent" v-model="bulkSetupForm.spent" type="number" min="0" step="1" class="form-input-mono" placeholder="Leave blank to reset to zero" />
        <p class="muted-sm mt-0.5">Blank = reset spent to 0 on every matching budget.</p>
      </div>
      <div>
        <label for="bulk-reason" class="form-label">Reason (optional, for audit trail)</label>
        <input id="bulk-reason" v-model="bulkSetupForm.reason" maxlength="512" class="form-input" placeholder="Q2 billing-period rollover" />
      </div>
    </FormDialog>

    <!-- Bulk-action preview (step 2). Shared BulkActionPreviewDialog —
         walks listBudgets with the same server-side filter as the bulk
         submit and renders count + first-10 sample rows before arming
         Confirm. expected_count is sent on submit when the walk reached
         an exact total so COUNT_MISMATCH catches drift between preview
         and submit. DEBIT is visually marked as destructive (red
         Confirm). -->
    <BulkActionPreviewDialog
      v-if="filterBulkAction"
      :action-verb="actionVerb(filterBulkAction)"
      item-noun-plural="budgets"
      :filter-description="filterBulkSummary"
      :loading="filterBulkPreview.previewLoading.value"
      :count="filterBulkPreview.previewCount.value"
      :samples="filterBulkPreview.previewSamples.value"
      :capped-at-max="filterBulkPreview.cappedAtMax.value"
      :capped-at-pages="filterBulkPreview.cappedAtPages.value"
      :reached-end="filterBulkPreview.reachedEnd.value"
      :error="filterBulkPreview.previewError.value"
      :submit-error="filterBulkSubmitError"
      :submitting="filterBulkRunning"
      :confirm-danger="filterBulkAction === 'DEBIT'"
      @confirm="executeFilterBulk"
      @cancel="cancelFilterBulk"
    />

    <!-- Bulk-action result (step 3). Opens iff any row failed or was
         skipped — surfaces per-row error_code + message so operators
         can triage without tailing the browser console. Routes through
         the shared Slice-B BulkActionResultDialog. -->
    <BulkActionResultDialog
      v-if="bulkResult"
      :action-verb="bulkResult.actionVerb"
      item-noun-plural="budgets"
      :response="bulkResult.response"
      :label-by-id="bulkResult.labelById"
      :tenant-id="bulkResult.tenantId"
      @close="bulkResult = null"
    />
  </div>
</template>

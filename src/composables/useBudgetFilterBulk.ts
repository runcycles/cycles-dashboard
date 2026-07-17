import { computed, ref } from 'vue'
import {
  ApiError,
  bulkActionBudgets as bulkActionBudgetsDefault,
  listBudgets as listBudgetsDefault,
} from '../api/client'
import type {
  BudgetBulkAction,
  BudgetBulkActionRequest,
  BudgetBulkActionResponse,
  BudgetBulkFilter,
  BudgetLedger,
} from '../types'
import { formatBulkRequestError } from '../utils/errorCodeMessages'
import { toMessage } from '../utils/errors'
import { generateIdempotencyKey } from '../utils/idempotencyKey'
import { useBulkActionPreview } from './useBulkActionPreview'

export interface BudgetFilterBulkForm {
  action: BudgetBulkAction
  unit: string
  amount: number | string
  spent: number | string
  reason: string
}

export interface BudgetFilterBulkResult {
  actionVerb: string
  response: BudgetBulkActionResponse
  labelById: Record<string, string>
  tenantId: string
}

export const BUDGET_FILTER_BULK_HINTS: Record<BudgetBulkAction, string> = {
  CREDIT: 'Adds funds to each matching budget\'s allocated and remaining balance.',
  DEBIT: 'Removes funds from each matching budget. Rows whose remaining would go negative fail per-row with BUDGET_EXCEEDED.',
  RESET: 'Sets EVERY matching budget\'s allocated to this one amount — budgets with differing allocations are all overwritten to the same value. FROZEN budgets matched by the filter fail per-row; unfreeze first.',
  RESET_SPENT: 'Billing-period rollover — sets EVERY matching budget\'s allocated to this one amount AND resets its spent counter to the override (default 0). Budgets with differing allocations are all overwritten to the same value; reserved and debt carry over. FROZEN budgets matched by the filter fail per-row; unfreeze first.',
  REPAY_DEBT: 'Reduces outstanding debt on each matching budget by this amount.',
}

const PAST_TENSE: Record<BudgetBulkAction, string> = {
  CREDIT: 'credited',
  DEBIT: 'debited',
  RESET: 'allocation reset',
  RESET_SPENT: 'spent reset',
  REPAY_DEBT: 'debt repaid',
}

type ListBudgetsFn = typeof listBudgetsDefault
type BulkActionBudgetsFn = typeof bulkActionBudgetsDefault

export interface UseBudgetFilterBulkOptions {
  /** Returns the current list's complete server query without a cursor. */
  getListParams: () => Record<string, string>
  refresh: () => Promise<unknown>
  onResult: (result: BudgetFilterBulkResult) => void
  onSuccess?: (message: string) => void
  onError?: (message: string) => void
  /** Focused dependency seams for deterministic protocol tests. */
  list?: ListBudgetsFn
  submit?: BulkActionBudgetsFn
  createIdempotencyKey?: () => string
}

function emptyForm(): BudgetFilterBulkForm {
  return {
    action: 'CREDIT',
    unit: 'USD_MICROCENTS',
    amount: '',
    spent: '',
    reason: '',
  }
}

function eligibleStatus(action: BudgetBulkAction): string | null {
  if (action === 'CREDIT' || action === 'DEBIT' || action === 'REPAY_DEBT') return 'ACTIVE'
  return null
}

export function formatBudgetBulkActionVerb(action: BudgetBulkAction): string {
  const lower = action.toLowerCase().replace('_', ' ')
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function isCrossTenant(params: Readonly<Record<string, string>>): boolean {
  return params.over_limit === 'true' || params.has_debt === 'true'
}

function finiteRatio(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : undefined
}

function buildBulkFilter(
  params: Readonly<Record<string, string>>,
  action: BudgetBulkAction,
): BudgetBulkFilter {
  const filter: BudgetBulkFilter = { tenant_id: params.tenant_id ?? '' }
  if (params.status) filter.status = params.status
  else {
    const required = eligibleStatus(action)
    if (required) filter.status = required
  }
  if (params.unit) filter.unit = params.unit
  if (params.scope_prefix) filter.scope_prefix = params.scope_prefix
  if (params.search) filter.search = params.search
  const utilizationMin = finiteRatio(params.utilization_min)
  const utilizationMax = finiteRatio(params.utilization_max)
  if (utilizationMin !== undefined) filter.utilization_min = utilizationMin
  if (utilizationMax !== undefined) filter.utilization_max = utilizationMax
  return filter
}

/**
 * Owns BudgetsView's filter-apply balance mutation protocol.
 *
 * One immutable list-parameter snapshot is captured when Preview opens and is
 * reused for every cursor page, the human-readable summary, and the eventual
 * bulk request. Draft filter or route changes therefore cannot pair a new
 * filter with an old cursor/count. The owning view retains list/filter state,
 * row-selection mutations, routing, polling, and presentation.
 */
export function useBudgetFilterBulk(options: UseBudgetFilterBulkOptions) {
  const isSetupOpen = ref(false)
  const setupForm = ref<BudgetFilterBulkForm>(emptyForm())
  const setupError = ref('')

  const action = ref<BudgetBulkAction | null>(null)
  const amount = ref<number | undefined>(undefined)
  const spent = ref<number | undefined>(undefined)
  const unit = ref('')
  const reason = ref('')
  const running = ref(false)
  const submitError = ref('')
  const frozenCount = ref(0)
  const listParamsSnapshot = ref<Readonly<Record<string, string>> | null>(null)

  const createKey = options.createIdempotencyKey ?? generateIdempotencyKey

  const preview = useBulkActionPreview<BudgetLedger>({
    fetchPage: async (cursor) => {
      const snapshot = listParamsSnapshot.value
      if (!snapshot) return { items: [], hasMore: false, nextCursor: '' }
      const res = await (options.list ?? listBudgetsDefault)({
        ...snapshot,
        ...(cursor ? { cursor } : {}),
      })
      return {
        items: res.ledgers,
        hasMore: !!res.has_more,
        nextCursor: res.next_cursor ?? '',
      }
    },
    filterFn: (budget) => {
      if (!action.value) return false
      const required = eligibleStatus(action.value)
      if (required && budget.status !== required) return false
      // RESET and RESET_SPENT retain FROZEN rows in the exact count because
      // the server matches them before reporting per-row failures.
      if (budget.status === 'FROZEN') frozenCount.value++
      return true
    },
    toSample: (budget) => ({
      id: budget.ledger_id,
      primary: budget.scope,
      sublabel: budget.unit,
      status: budget.status,
    }),
    labelFn: (budget) => ({ id: budget.ledger_id, label: budget.scope }),
  })

  const frozenWarning = computed(() => {
    const count = frozenCount.value
    if (count === 0) return ''
    return `${count} FROZEN budget${count === 1 ? '' : 's'} in this selection will fail per-row — unfreeze ${count === 1 ? 'it' : 'them'} first. ${count === 1 ? 'It is' : 'They are'} still included in the count above (the server matches by filter regardless of status).`
  })

  const summary = computed(() => {
    const params = listParamsSnapshot.value
    if (!params) return ''
    const parts: string[] = []
    if (params.tenant_id) parts.push(`tenant_id=${params.tenant_id}`)
    if (params.status) parts.push(`status=${params.status}`)
    else if (action.value) {
      const required = eligibleStatus(action.value)
      if (required) parts.push(`status=${required}`)
    }
    if (params.unit) parts.push(`unit=${params.unit}`)
    if (params.scope_prefix) parts.push(`scope_prefix=${params.scope_prefix}`)
    if (params.search) parts.push(`search="${params.search}"`)
    if (params.utilization_min) parts.push(`utilization_min=${params.utilization_min}`)
    if (params.utilization_max) parts.push(`utilization_max=${params.utilization_max}`)
    return parts.join(' AND ')
  })

  function canOpen(): boolean {
    const params = options.getListParams()
    return !!params.tenant_id && !isCrossTenant(params)
  }

  function openSetup(): void {
    if (!canOpen() || running.value) return
    const currentUnit = options.getListParams().unit
    setupForm.value = { ...emptyForm(), unit: currentUnit || 'USD_MICROCENTS' }
    setupError.value = ''
    isSetupOpen.value = true
  }

  function cancelSetup(): void {
    isSetupOpen.value = false
    setupError.value = ''
  }

  function submitSetup(): void {
    setupError.value = ''
    const nextAction = setupForm.value.action
    const nextUnit = setupForm.value.unit
    if (!nextUnit) {
      setupError.value = 'Unit is required'
      return
    }

    const allowZero = nextAction === 'RESET' || nextAction === 'RESET_SPENT'
    const nextAmount = Number(setupForm.value.amount)
    if (!Number.isFinite(nextAmount) || (allowZero ? nextAmount < 0 : nextAmount <= 0)) {
      setupError.value = allowZero
        ? 'Amount must be zero or a positive number'
        : 'Amount must be a positive number'
      return
    }

    let nextSpent: number | undefined
    if (nextAction === 'RESET_SPENT' && setupForm.value.spent !== '' && setupForm.value.spent !== null) {
      const parsed = Number(setupForm.value.spent)
      if (!Number.isFinite(parsed) || parsed < 0) {
        setupError.value = 'Spent override must be zero or a positive number'
        return
      }
      nextSpent = parsed
    }

    const snapshot = { ...options.getListParams() }
    if (!snapshot.tenant_id || isCrossTenant(snapshot)) {
      setupError.value = 'Select a tenant before submitting a bulk action.'
      return
    }

    action.value = nextAction
    amount.value = nextAmount
    spent.value = nextSpent
    unit.value = nextUnit
    reason.value = setupForm.value.reason.trim()
    submitError.value = ''
    frozenCount.value = 0
    listParamsSnapshot.value = Object.freeze(snapshot)
    isSetupOpen.value = false
    void preview.startPreview()
  }

  function resetArmedState(): void {
    action.value = null
    amount.value = undefined
    spent.value = undefined
    unit.value = ''
    reason.value = ''
    submitError.value = ''
    frozenCount.value = 0
    listParamsSnapshot.value = null
  }

  function cancelPreview(): void {
    if (running.value) return
    preview.cancelPreview()
    preview.resetPreview()
    resetArmedState()
  }

  async function execute(): Promise<boolean> {
    if (!action.value || running.value) return false
    if (preview.previewLoading.value || preview.previewCount.value === 0 || preview.cappedAtMax.value) return false

    const snapshot = listParamsSnapshot.value
    const tenantId = snapshot?.tenant_id ?? ''
    if (!snapshot || !tenantId) {
      submitError.value = 'Select a tenant before submitting a bulk action.'
      return false
    }

    const submittedAction = action.value
    running.value = true
    submitError.value = ''
    try {
      const body: BudgetBulkActionRequest = {
        filter: buildBulkFilter(snapshot, submittedAction),
        action: submittedAction,
        idempotency_key: createKey(),
      }
      if (amount.value !== undefined) body.amount = { unit: unit.value, amount: amount.value }
      if (spent.value !== undefined) body.spent = { unit: unit.value, amount: spent.value }
      if (reason.value) body.reason = reason.value
      if (preview.reachedEnd.value) body.expected_count = preview.previewCount.value

      const response = await (options.submit ?? bulkActionBudgetsDefault)(body)
      const summaryParts = [`${response.succeeded.length}/${response.total_matched} budgets ${PAST_TENSE[submittedAction]}`]
      if (response.skipped.length) summaryParts.push(`${response.skipped.length} skipped`)
      if (response.failed.length) summaryParts.push(`${response.failed.length} failed`)
      const outcome = summaryParts.join(', ')
      if (response.failed.length) options.onError?.(`${outcome} — see details`)
      else options.onSuccess?.(outcome)

      const labels = { ...preview.previewLabels.value }
      preview.resetPreview()
      resetArmedState()
      if (response.failed.length || response.skipped.length) {
        options.onResult({
          actionVerb: formatBudgetBulkActionVerb(submittedAction),
          response,
          labelById: labels,
          tenantId,
        })
      }
      return true
    } catch (cause) {
      if (cause instanceof ApiError && (cause.errorCode === 'LIMIT_EXCEEDED' || cause.errorCode === 'COUNT_MISMATCH')) {
        submitError.value = formatBulkRequestError(
          cause.errorCode,
          'budgets',
          500,
          cause.details as Record<string, unknown> | undefined,
        ) ?? `Bulk ${submittedAction} failed: ${toMessage(cause)}`
      } else {
        submitError.value = `Bulk ${submittedAction} failed: ${toMessage(cause)}`
      }
      return false
    } finally {
      running.value = false
      await options.refresh()
    }
  }

  return {
    isSetupOpen,
    setupForm,
    setupError,
    hints: BUDGET_FILTER_BULK_HINTS,
    action,
    running,
    submitError,
    frozenWarning,
    summary,
    preview,
    canOpen,
    openSetup,
    cancelSetup,
    submitSetup,
    cancelPreview,
    execute,
    formatActionVerb: formatBudgetBulkActionVerb,
  }
}

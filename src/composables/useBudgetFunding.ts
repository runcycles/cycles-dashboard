import { ref, watch, type Ref } from 'vue'
import { fundBudget } from '../api/client'
import type { BudgetFundingResponse, BudgetLedger } from '../types'
import { toMessage } from '../utils/errors'
import { generateIdempotencyKey } from '../utils/idempotencyKey'
import { parsePositiveAmount, tenantFromScope } from '../utils/safe'

export const BUDGET_FUNDING_OPERATIONS = [
  'CREDIT',
  'DEBIT',
  'RESET',
  'RESET_SPENT',
  'REPAY_DEBT',
] as const

export type BudgetFundingOperation = typeof BUDGET_FUNDING_OPERATIONS[number]

export interface BudgetFundingForm {
  operation: BudgetFundingOperation
  amount: number | string
  reason: string
  spent: number | string
}

export const BUDGET_FUNDING_HINTS: Record<BudgetFundingOperation, string> = {
  CREDIT: 'Adds funds to allocated and remaining balance.',
  DEBIT: 'Removes funds. Fails if remaining would go negative.',
  RESET: 'Sets allocated to exact amount, recalculates remaining.',
  RESET_SPENT: 'Billing-period rollover — sets allocated for the new period AND resets spent (default 0, override optional). Pre-filled with current allocated; change it to start the new period at a different allocation. Reserved + debt are preserved across the boundary (requires cycles-server-admin 0.1.25.18+).',
  REPAY_DEBT: 'Reduces outstanding debt by this amount.',
}

export const BUDGET_FUNDING_SUCCESS: Record<BudgetFundingOperation, string> = {
  CREDIT: 'Budget credited',
  DEBIT: 'Budget debited',
  RESET: 'Budget allocation reset',
  RESET_SPENT: 'Budget spent reset',
  REPAY_DEBT: 'Debt repaid',
}

type FundBudgetFn = (
  tenantId: string,
  scope: string,
  unit: string,
  operation: string,
  amount: number,
  idempotencyKey: string,
  reason?: string,
  spent?: number,
) => Promise<BudgetFundingResponse>

export interface UseBudgetFundingOptions {
  selectedTenant: Ref<string>
  refresh: () => Promise<unknown>
  onSuccess?: (operation: BudgetFundingOperation) => void
  /** Dependency seams keep domain tests focused and deterministic. */
  fund?: FundBudgetFn
  createIdempotencyKey?: () => string
}

function emptyForm(): BudgetFundingForm {
  return { operation: 'CREDIT', amount: '', reason: '', spent: '' }
}

/**
 * Funding-domain state shared by Budgets list and detail entry points.
 *
 * The composable owns validation, tenant resolution, idempotency, mutation
 * state, and refresh-before-close behavior. The parent owns only how its
 * current list/detail mode refreshes and how a successful operation is
 * announced. This keeps polling, cursor, URL, and presentation concerns out of
 * the mutation protocol.
 */
export function useBudgetFunding(options: UseBudgetFundingOptions) {
  const isOpen = ref(false)
  const target = ref<BudgetLedger | null>(null)
  const form = ref<BudgetFundingForm>(emptyForm())
  const loading = ref(false)
  const error = ref('')
  const createKey = options.createIdempotencyKey ?? generateIdempotencyKey

  function open(nextTarget: BudgetLedger | null | undefined): void {
    if (!nextTarget) return
    target.value = nextTarget
    form.value = emptyForm()
    error.value = ''
    isOpen.value = true
  }

  function close(): void {
    if (loading.value) return
    isOpen.value = false
  }

  // RESET_SPENT's server operation always assigns `allocated = amount`.
  // Prefill the current allocation for the common pure-rollover case; clear it
  // when leaving so the value cannot bleed into a different operation.
  watch(() => form.value.operation, (operation, previous) => {
    if (operation === 'RESET_SPENT' && previous !== 'RESET_SPENT') {
      const allocated = target.value?.allocated?.amount
      form.value.amount = typeof allocated === 'number' ? allocated : ''
    } else if (operation !== 'RESET_SPENT' && previous === 'RESET_SPENT') {
      form.value.amount = ''
      form.value.spent = ''
    }
  })

  async function submit(): Promise<boolean> {
    // Defense in depth: FormDialog disables submit while loading, but callers
    // and tests can invoke submit directly. Guard before any state mutation.
    if (loading.value || !target.value) return false

    const budget = target.value
    const operation = form.value.operation
    error.value = ''

    let amount: number | null
    if (operation === 'RESET_SPENT') {
      const parsed = Number(form.value.amount)
      if (!Number.isFinite(parsed) || parsed < 0) {
        error.value = 'Allocated must be zero or a positive number'
        return false
      }
      amount = parsed
    } else {
      amount = parsePositiveAmount(form.value.amount)
      if (amount === null) {
        error.value = 'Amount must be a positive number'
        return false
      }
    }

    let spent: number | undefined
    if (operation === 'RESET_SPENT' && form.value.spent !== '' && form.value.spent !== null) {
      const parsed = Number(form.value.spent)
      if (!Number.isFinite(parsed) || parsed < 0) {
        error.value = 'Spent override must be zero or a positive number'
        return false
      }
      spent = parsed
    }

    // Preserve the existing precedence: a selected list tenant owns the
    // mutation; detail/deep-link entry points derive it from the scope.
    const tenantId = options.selectedTenant.value || tenantFromScope(budget.scope)
    if (!tenantId) {
      error.value = `Cannot determine tenant for scope "${budget.scope}". Expected a "tenant:<id>" prefix.`
      return false
    }

    loading.value = true
    try {
      // Resolve the production dependency only when a mutation is submitted.
      // Capability/layout tests intentionally provide partial API mocks and
      // should be able to mount BudgetsView without defining an unused writer.
      await (options.fund ?? fundBudget)(
        tenantId,
        budget.scope,
        budget.unit,
        operation,
        amount,
        createKey(),
        form.value.reason || `${operation} via admin dashboard`,
        spent,
      )
      // Keep the existing truthfulness rule: close and announce only after the
      // owning list/detail view has refreshed its server state.
      await options.refresh()
      isOpen.value = false
      options.onSuccess?.(operation)
      return true
    } catch (cause) {
      error.value = toMessage(cause)
      return false
    } finally {
      loading.value = false
    }
  }

  return {
    isOpen,
    target,
    form,
    loading,
    error,
    open,
    close,
    submit,
  }
}

import { nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BudgetFundingResponse, BudgetLedger } from '../types'
import {
  BUDGET_FUNDING_REFRESH_WARNING,
  BUDGET_FUNDING_SUCCESS,
  useBudgetFunding,
  type BudgetFundingOperation,
} from '../composables/useBudgetFunding'

function ledger(overrides: Partial<BudgetLedger> = {}): BudgetLedger {
  return {
    ledger_id: 'ledger-1',
    scope: 'tenant:acme/workspace:prod',
    unit: 'USD_MICROCENTS',
    allocated: { unit: 'USD_MICROCENTS', amount: 1000 },
    remaining: { unit: 'USD_MICROCENTS', amount: 800 },
    status: 'ACTIVE',
    created_at: '2026-07-16T00:00:00Z',
    ...overrides,
  }
}

const response = {} as BudgetFundingResponse

describe('useBudgetFunding', () => {
  const fund = vi.fn().mockResolvedValue(response)
  const refresh = vi.fn().mockResolvedValue(undefined)
  const onSuccess = vi.fn()
  const onRefreshFailure = vi.fn()
  const createIdempotencyKey = vi.fn(() => '00000000-0000-4000-8000-000000000001')
  const selectedTenant = ref('')

  function create() {
    return useBudgetFunding({
      selectedTenant,
      fund,
      refresh,
      onSuccess,
      onRefreshFailure,
      createIdempotencyKey,
    })
  }

  beforeEach(() => {
    fund.mockReset().mockResolvedValue(response)
    refresh.mockReset().mockResolvedValue(undefined)
    onSuccess.mockReset()
    onRefreshFailure.mockReset()
    createIdempotencyKey.mockClear()
    selectedTenant.value = ''
  })

  it.each<{
    operation: BudgetFundingOperation
    input: number
    expectedSpent?: number
  }>([
    { operation: 'CREDIT', input: 100 },
    { operation: 'DEBIT', input: 101 },
    { operation: 'RESET', input: 102 },
    { operation: 'RESET_SPENT', input: 103, expectedSpent: 7 },
    { operation: 'REPAY_DEBT', input: 104 },
  ])('builds and executes the $operation request', async ({ operation, input, expectedSpent }) => {
    const funding = create()
    funding.open(ledger())
    funding.form.value.operation = operation
    await nextTick()
    funding.form.value.amount = input
    funding.form.value.reason = 'operator reason'
    if (expectedSpent !== undefined) funding.form.value.spent = expectedSpent

    await expect(funding.submit()).resolves.toBe(true)

    expect(fund).toHaveBeenCalledWith(
      'acme',
      'tenant:acme/workspace:prod',
      'USD_MICROCENTS',
      operation,
      input,
      '00000000-0000-4000-8000-000000000001',
      'operator reason',
      expectedSpent,
    )
    expect(refresh).toHaveBeenCalledOnce()
    expect(onSuccess).toHaveBeenCalledWith(operation)
    expect(onRefreshFailure).not.toHaveBeenCalled()
    expect(BUDGET_FUNDING_SUCCESS[operation]).toBeTruthy()
    expect(funding.isOpen.value).toBe(false)
  })

  it('prefers the selected tenant and supplies the default audit reason', async () => {
    selectedTenant.value = 'selected-tenant'
    const funding = create()
    funding.open(ledger())
    funding.form.value.amount = 25

    await funding.submit()

    expect(fund.mock.calls[0][0]).toBe('selected-tenant')
    expect(fund.mock.calls[0][6]).toBe('CREDIT via admin dashboard')
  })

  it('ignores open and submit calls without a target', async () => {
    const funding = create()
    funding.open(undefined)
    expect(funding.isOpen.value).toBe(false)
    await expect(funding.submit()).resolves.toBe(false)
    expect(fund).not.toHaveBeenCalled()
  })

  it('prefills RESET_SPENT with current allocated and clears rollover-only fields when leaving', async () => {
    const funding = create()
    funding.open(ledger())
    funding.form.value.operation = 'RESET_SPENT'
    await nextTick()
    expect(funding.form.value.amount).toBe(1000)

    funding.form.value.spent = 9
    funding.form.value.operation = 'CREDIT'
    await nextTick()
    expect(funding.form.value.amount).toBe('')
    expect(funding.form.value.spent).toBe('')
  })

  it.each([0, -1, 'not-a-number'])('rejects non-positive ordinary amount %s', async (amount) => {
    const funding = create()
    funding.open(ledger())
    funding.form.value.amount = amount

    await expect(funding.submit()).resolves.toBe(false)
    expect(funding.error.value).toBe('Amount must be a positive number')
    expect(fund).not.toHaveBeenCalled()
  })

  it('allows zero allocated for RESET_SPENT and omits a blank spent override', async () => {
    const funding = create()
    funding.open(ledger())
    funding.form.value.operation = 'RESET_SPENT'
    await nextTick()
    funding.form.value.amount = 0
    funding.form.value.spent = ''

    await expect(funding.submit()).resolves.toBe(true)
    expect(fund.mock.calls[0][4]).toBe(0)
    expect(fund.mock.calls[0][7]).toBeUndefined()
  })

  it.each([
    ['allocated', -1, '', 'Allocated must be zero or a positive number'],
    ['spent', 100, -1, 'Spent override must be zero or a positive number'],
  ])('rejects invalid RESET_SPENT %s', async (_, amount, spent, message) => {
    const funding = create()
    funding.open(ledger())
    funding.form.value.operation = 'RESET_SPENT'
    await nextTick()
    funding.form.value.amount = amount
    funding.form.value.spent = spent

    await expect(funding.submit()).resolves.toBe(false)
    expect(funding.error.value).toBe(message)
    expect(fund).not.toHaveBeenCalled()
  })

  it('reports an unresolvable tenant instead of silently doing nothing', async () => {
    const funding = create()
    funding.open(ledger({ scope: 'system:global' }))
    funding.form.value.amount = 10

    await expect(funding.submit()).resolves.toBe(false)
    expect(funding.error.value).toContain('Cannot determine tenant for scope "system:global"')
    expect(fund).not.toHaveBeenCalled()
  })

  it('prevents duplicate submissions while the mutation is in flight', async () => {
    let resolveFund!: (value: BudgetFundingResponse) => void
    fund.mockReturnValue(new Promise((resolve) => { resolveFund = resolve }))
    const funding = create()
    funding.open(ledger())
    funding.form.value.amount = 10

    const first = funding.submit()
    expect(funding.loading.value).toBe(true)
    funding.close()
    expect(funding.isOpen.value).toBe(true)
    await expect(funding.submit()).resolves.toBe(false)
    expect(fund).toHaveBeenCalledOnce()

    resolveFund(response)
    await expect(first).resolves.toBe(true)
  })

  it('keeps the dialog open and exposes mutation failures', async () => {
    fund.mockRejectedValue(new Error('funding unavailable'))
    const funding = create()
    funding.open(ledger())
    funding.form.value.amount = 10

    await expect(funding.submit()).resolves.toBe(false)

    expect(funding.error.value).toBe('funding unavailable')
    expect(funding.isOpen.value).toBe(true)
    expect(refresh).not.toHaveBeenCalled()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(funding.loading.value).toBe(false)
  })

  it('does not touch the funding dependency merely by opening the dialog', () => {
    const funding = create()
    funding.open(ledger())
    expect(fund).not.toHaveBeenCalled()
  })

  it.each([
    ['returns false', () => refresh.mockResolvedValue(false)],
    ['throws', () => refresh.mockRejectedValue(new Error('refresh failed'))],
  ])('treats the mutation as committed when refresh %s', async (_, failRefresh) => {
    failRefresh()
    const funding = create()
    funding.open(ledger())
    funding.form.value.amount = 10

    await expect(funding.submit()).resolves.toBe(true)

    expect(fund).toHaveBeenCalledOnce()
    expect(funding.error.value).toBe('')
    expect(funding.isOpen.value).toBe(false)
    expect(funding.loading.value).toBe(false)
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onRefreshFailure).toHaveBeenCalledWith('CREDIT')

    // The committed operation is terminal even though the refresh did not
    // succeed. A direct caller cannot replay it under a fresh key.
    await expect(funding.submit()).resolves.toBe(false)
    expect(fund).toHaveBeenCalledOnce()
    expect(createIdempotencyKey).toHaveBeenCalledOnce()
  })

  it('exports concise operator copy for post-commit refresh failures', () => {
    expect(BUDGET_FUNDING_REFRESH_WARNING).toBe(
      'Budget updated, but the latest data could not be loaded. Refresh to verify.',
    )
  })

  it('keeps the dialog non-repeatable after a successful refresh', async () => {
    const funding = create()
    funding.open(ledger())
    funding.form.value.amount = 10

    await expect(funding.submit()).resolves.toBe(true)
    await expect(funding.submit()).resolves.toBe(false)

    expect(fund).toHaveBeenCalledOnce()
    expect(createIdempotencyKey).toHaveBeenCalledOnce()
  })

  it('closes at the commit boundary while the owning view is still refreshing', async () => {
    let resolveRefresh!: () => void
    refresh.mockReturnValue(new Promise<void>((resolve) => { resolveRefresh = resolve }))
    const funding = create()
    funding.open(ledger())
    funding.form.value.amount = 10

    const pending = funding.submit()
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())

    expect(funding.isOpen.value).toBe(false)
    expect(funding.target.value).toBeNull()
    expect(funding.loading.value).toBe(true)
    await expect(funding.submit()).resolves.toBe(false)
    funding.open(ledger({ ledger_id: 'ledger-2' }))
    expect(funding.isOpen.value).toBe(false)
    expect(fund).toHaveBeenCalledOnce()

    resolveRefresh()
    await expect(pending).resolves.toBe(true)
    expect(funding.loading.value).toBe(false)
  })
})

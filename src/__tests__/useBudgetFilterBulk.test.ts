import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import {
  useBudgetFilterBulk,
  type UseBudgetFilterBulkOptions,
} from '../composables/useBudgetFilterBulk'
import type { BudgetBulkActionResponse, BudgetLedger } from '../types'

type ListFn = NonNullable<UseBudgetFilterBulkOptions['list']>
type SubmitFn = NonNullable<UseBudgetFilterBulkOptions['submit']>

function ledger(id: string, status = 'ACTIVE'): BudgetLedger {
  return {
    ledger_id: id,
    tenant_id: 'acme',
    scope: `tenant:acme/${id}`,
    unit: 'USD_MICROCENTS',
    status,
    allocated: { unit: 'USD_MICROCENTS', amount: 100 },
    spent: { unit: 'USD_MICROCENTS', amount: 25 },
    remaining: { unit: 'USD_MICROCENTS', amount: 75 },
    debt: { unit: 'USD_MICROCENTS', amount: 0 },
    overdraft_limit: { unit: 'USD_MICROCENTS', amount: 0 },
    is_over_limit: false,
    created_at: '2026-07-17T00:00:00Z',
  }
}

function response(
  overrides: Partial<BudgetBulkActionResponse> = {},
): BudgetBulkActionResponse {
  return {
    action: 'CREDIT',
    total_matched: 1,
    succeeded: [{ id: 'one' }],
    failed: [],
    skipped: [],
    idempotency_key: 'idem-1',
    ...overrides,
  }
}

function createHarness(initialParams: Record<string, string> = { limit: '100', tenant_id: 'acme' }) {
  let params = initialParams
  const list = vi.fn<ListFn>().mockResolvedValue({ ledgers: [ledger('one')], has_more: false })
  const submit = vi.fn<SubmitFn>().mockResolvedValue(response())
  const refresh = vi.fn<() => Promise<unknown>>().mockResolvedValue(true)
  const onResult = vi.fn()
  const onSuccess = vi.fn()
  const onError = vi.fn()
  const bulk = useBudgetFilterBulk({
    getListParams: () => params,
    refresh,
    onResult,
    onSuccess,
    onError,
    list,
    submit,
    createIdempotencyKey: () => 'idem-fixed',
  })

  async function preview(): Promise<void> {
    bulk.openSetup()
    bulk.setupForm.value.amount = 25
    bulk.submitSetup()
    await vi.waitFor(() => expect(bulk.preview.previewLoading.value).toBe(false))
  }

  return {
    bulk,
    list,
    submit,
    refresh,
    onResult,
    onSuccess,
    onError,
    setParams: (next: Record<string, string>) => { params = next },
    preview,
  }
}

describe('useBudgetFilterBulk', () => {
  it('does not access preview or mutation callables during setup', () => {
    const options: UseBudgetFilterBulkOptions = {
      getListParams: () => ({ limit: '100', tenant_id: 'acme' }),
      refresh: async () => true,
      onResult: vi.fn(),
    }
    Object.defineProperties(options, {
      list: { get: () => { throw new Error('list resolved eagerly') } },
      submit: { get: () => { throw new Error('writer resolved eagerly') } },
    })

    let bulk: ReturnType<typeof useBudgetFilterBulk> | undefined
    expect(() => { bulk = useBudgetFilterBulk(options) }).not.toThrow()
    expect(() => bulk?.openSetup()).not.toThrow()
    bulk?.cancelSetup()
  })

  it('gates setup to one tenant and seeds the operation unit from the list filter', () => {
    const h = createHarness({ limit: '100' })
    expect(h.bulk.canOpen()).toBe(false)
    h.bulk.openSetup()
    expect(h.bulk.isSetupOpen.value).toBe(false)

    h.setParams({ limit: '100', tenant_id: 'acme', over_limit: 'true' })
    expect(h.bulk.canOpen()).toBe(false)

    h.setParams({ limit: '100', tenant_id: 'acme', unit: 'TOKENS' })
    expect(h.bulk.canOpen()).toBe(true)
    h.bulk.openSetup()
    expect(h.bulk.isSetupOpen.value).toBe(true)
    expect(h.bulk.setupForm.value.unit).toBe('TOKENS')
  })

  it('keeps zero invalid for CREDIT but accepts it for RESET and RESET_SPENT', async () => {
    const h = createHarness()
    h.bulk.openSetup()
    h.bulk.setupForm.value.amount = 0
    h.bulk.submitSetup()
    expect(h.bulk.setupError.value).toBe('Amount must be a positive number')
    expect(h.list).not.toHaveBeenCalled()

    h.bulk.setupForm.value.action = 'RESET'
    h.bulk.submitSetup()
    await vi.waitFor(() => expect(h.bulk.preview.previewLoading.value).toBe(false))
    expect(h.bulk.action.value).toBe('RESET')

    h.bulk.cancelPreview()
    h.bulk.openSetup()
    h.bulk.setupForm.value.action = 'RESET_SPENT'
    h.bulk.setupForm.value.amount = 0
    h.bulk.setupForm.value.spent = -1
    h.bulk.submitSetup()
    expect(h.bulk.setupError.value).toBe('Spent override must be zero or a positive number')
  })

  it('requires an operation unit before arming Preview', () => {
    const h = createHarness()
    h.bulk.openSetup()
    h.bulk.setupForm.value.unit = ''
    h.bulk.setupForm.value.amount = 10

    h.bulk.submitSetup()

    expect(h.bulk.setupError.value).toBe('Unit is required')
    expect(h.list).not.toHaveBeenCalled()
  })

  it('builds the exact CREDIT request and sends expected_count only for a complete preview', async () => {
    const h = createHarness({
      limit: '100',
      tenant_id: 'acme',
      unit: 'TOKENS',
      scope_prefix: 'tenant:acme/workspace:',
      search: 'billing',
      utilization_min: '0.25',
      utilization_max: '0.9',
      sort_by: 'utilization',
      sort_dir: 'desc',
    })
    h.list.mockResolvedValue({ ledgers: [ledger('one'), ledger('two')], has_more: false })
    h.submit.mockResolvedValue(response({
      total_matched: 2,
      succeeded: [{ id: 'one' }, { id: 'two' }],
    }))

    h.bulk.openSetup()
    h.bulk.setupForm.value.amount = 25
    h.bulk.setupForm.value.reason = 'Quarterly credit'
    h.bulk.submitSetup()
    await vi.waitFor(() => expect(h.bulk.preview.previewLoading.value).toBe(false))

    await expect(h.bulk.execute()).resolves.toBe(true)
    expect(h.submit).toHaveBeenCalledWith({
      filter: {
        tenant_id: 'acme',
        status: 'ACTIVE',
        unit: 'TOKENS',
        scope_prefix: 'tenant:acme/workspace:',
        search: 'billing',
        utilization_min: 0.25,
        utilization_max: 0.9,
      },
      action: 'CREDIT',
      amount: { unit: 'TOKENS', amount: 25 },
      reason: 'Quarterly credit',
      expected_count: 2,
      idempotency_key: 'idem-fixed',
    })
    expect(h.onSuccess).toHaveBeenCalledWith('2/2 budgets credited')
    expect(h.refresh).toHaveBeenCalledOnce()
    expect(h.bulk.action.value).toBeNull()
  })

  it('keeps FROZEN RESET_SPENT rows in the exact count and exposes failed-row details', async () => {
    const h = createHarness()
    h.list.mockResolvedValue({
      ledgers: [ledger('active'), ledger('frozen', 'FROZEN')],
      has_more: false,
    })
    h.submit.mockResolvedValue(response({
      action: 'RESET_SPENT',
      total_matched: 2,
      succeeded: [{ id: 'active' }],
      failed: [{ id: 'frozen', error_code: 'BUDGET_FROZEN', message: 'frozen' }],
    }))

    h.bulk.openSetup()
    h.bulk.setupForm.value.action = 'RESET_SPENT'
    h.bulk.setupForm.value.amount = 0
    h.bulk.setupForm.value.spent = 5
    h.bulk.submitSetup()
    await vi.waitFor(() => expect(h.bulk.preview.previewLoading.value).toBe(false))

    expect(h.bulk.preview.previewCount.value).toBe(2)
    expect(h.bulk.frozenWarning.value).toContain('1 FROZEN budget')
    await h.bulk.execute()

    expect(h.submit.mock.calls[0]?.[0]).toMatchObject({
      filter: { tenant_id: 'acme' },
      action: 'RESET_SPENT',
      amount: { unit: 'USD_MICROCENTS', amount: 0 },
      spent: { unit: 'USD_MICROCENTS', amount: 5 },
      expected_count: 2,
    })
    expect(h.onError).toHaveBeenCalledWith('1/2 budgets spent reset, 1 failed — see details')
    expect(h.onResult).toHaveBeenCalledWith(expect.objectContaining({
      actionVerb: 'Reset spent',
      tenantId: 'acme',
      labelById: {
        active: 'tenant:acme/active',
        frozen: 'tenant:acme/frozen',
      },
    }))
  })

  it('reuses one immutable filter tuple across cursor pages and submit', async () => {
    const h = createHarness({ limit: '100', tenant_id: 'acme', search: 'old' })
    h.list
      .mockImplementationOnce(async () => {
        h.setParams({ limit: '100', tenant_id: 'beta', search: 'new' })
        return { ledgers: [ledger('one')], has_more: true, next_cursor: 'cursor-1' }
      })
      .mockResolvedValueOnce({ ledgers: [ledger('two')], has_more: false })
    h.submit.mockResolvedValue(response({
      total_matched: 2,
      succeeded: [{ id: 'one' }, { id: 'two' }],
    }))

    await h.preview()
    expect(h.list.mock.calls).toEqual([
      [{ limit: '100', tenant_id: 'acme', search: 'old' }],
      [{ limit: '100', tenant_id: 'acme', search: 'old', cursor: 'cursor-1' }],
    ])
    expect(h.bulk.summary.value).toContain('tenant_id=acme')
    expect(h.bulk.summary.value).toContain('search="old"')

    await h.bulk.execute()
    expect(h.submit.mock.calls[0]?.[0].filter).toMatchObject({
      tenant_id: 'acme',
      search: 'old',
    })
  })

  it('revalidates tenant ownership when Preview is armed', () => {
    const h = createHarness()
    h.bulk.openSetup()
    h.bulk.setupForm.value.amount = 10
    h.setParams({ limit: '100', tenant_id: 'acme', has_debt: 'true' })

    h.bulk.submitSetup()

    expect(h.bulk.setupError.value).toBe('Select a tenant before submitting a bulk action.')
    expect(h.bulk.action.value).toBeNull()
    expect(h.list).not.toHaveBeenCalled()
  })

  it('rejects a direct execute call whose armed state has no filter owner', async () => {
    const h = createHarness()
    h.bulk.action.value = 'CREDIT'
    h.bulk.preview.previewCount.value = 1

    await expect(h.bulk.execute()).resolves.toBe(false)

    expect(h.bulk.submitError.value).toBe('Select a tenant before submitting a bulk action.')
    expect(h.submit).not.toHaveBeenCalled()
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('humanizes count drift, keeps the preview retryable, and refreshes the owner', async () => {
    const h = createHarness()
    h.submit.mockRejectedValue(new ApiError(
      409,
      'Budget list changed since preview',
      'COUNT_MISMATCH',
      'req-1',
    ))
    await h.preview()

    await expect(h.bulk.execute()).resolves.toBe(false)

    expect(h.bulk.submitError.value).toContain('list changed between preview and submit')
    expect(h.bulk.action.value).toBe('CREDIT')
    expect(h.bulk.preview.previewCount.value).toBe(1)
    expect(h.refresh).toHaveBeenCalledOnce()
    expect(h.onResult).not.toHaveBeenCalled()
  })

  it('keeps generic mutation failures retryable with operation context', async () => {
    const h = createHarness()
    h.submit.mockRejectedValue(new Error('network unavailable'))
    await h.preview()

    await expect(h.bulk.execute()).resolves.toBe(false)

    expect(h.bulk.submitError.value).toBe('Bulk CREDIT failed: network unavailable')
    expect(h.bulk.action.value).toBe('CREDIT')
    expect(h.refresh).toHaveBeenCalledOnce()
  })
})

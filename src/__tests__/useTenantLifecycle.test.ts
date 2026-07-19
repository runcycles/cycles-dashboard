import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import {
  useTenantLifecycle,
  type UseTenantLifecycleOptions,
} from '../composables/useTenantLifecycle'
import type { TenantDetailRefreshResult } from '../composables/useTenantDetailData'
import type { ApiKey, BudgetLedger, Tenant, WebhookSubscription } from '../types'

function tenant(status = 'ACTIVE'): Tenant {
  return {
    tenant_id: 'acme',
    name: 'Acme',
    status,
    created_at: '2026-07-19T00:00:00Z',
  }
}

function budget(id: string, status = 'ACTIVE'): BudgetLedger {
  return {
    ledger_id: id,
    tenant_id: 'acme',
    scope: `tenant:acme/agent:${id}`,
    unit: 'TOKENS',
    allocated: { unit: 'TOKENS', amount: 100 },
    remaining: { unit: 'TOKENS', amount: 100 },
    status,
    created_at: '2026-07-19T00:00:00Z',
  }
}

function apiKey(id: string, status = 'ACTIVE'): ApiKey {
  return {
    key_id: id,
    key_prefix: `cyc_${id}`,
    tenant_id: 'acme',
    status,
    permissions: [],
    created_at: '2026-07-19T00:00:00Z',
  }
}

function webhook(id: string, status = 'ACTIVE'): WebhookSubscription {
  return {
    subscription_id: id,
    tenant_id: 'acme',
    url: 'https://example.com/hook',
    event_types: ['budget.updated'],
    status,
    created_at: '2026-07-19T00:00:00Z',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(overrides: Partial<UseTenantLifecycleOptions> = {}) {
  const tenantRef = ref<Tenant | null>(tenant())
  const budgets = ref<BudgetLedger[]>([])
  const apiKeys = ref<ApiKey[]>([])
  const webhooks = ref<WebhookSubscription[]>([])
  const budgetsPartial = ref(false)
  const cascadePartial = ref(false)
  const error = ref('')

  const updateStatus = vi.fn(async (_id: string, status: string) => tenant(status))
  const freeze = vi.fn(async () => budget('frozen', 'FROZEN'))
  const refreshTenant = vi.fn<() => Promise<TenantDetailRefreshResult>>()
    .mockResolvedValue('applied')
  const refreshBudgets = vi.fn<() => Promise<TenantDetailRefreshResult>>()
    .mockResolvedValue('applied')
  const refreshCascadeState = vi.fn<() => Promise<TenantDetailRefreshResult>>()
    .mockResolvedValue('applied')
  const commitTenant = vi.fn((next: Tenant) => { tenantRef.value = next })
  const reportError = vi.fn((message: string) => { error.value = message })
  const dismissError = vi.fn(() => { error.value = '' })
  const notify = {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }

  const options: UseTenantLifecycleOptions = {
    tenantId: 'acme',
    tenant: tenantRef,
    budgets,
    apiKeys,
    webhooks,
    budgetsPartial,
    cascadePartial,
    error,
    refreshTenant,
    refreshBudgets,
    refreshCascadeState,
    commitTenant,
    reportError,
    dismissError,
    notify,
    updateStatus,
    freeze,
    ...overrides,
  }

  return {
    lifecycle: useTenantLifecycle(options),
    tenantRef,
    budgets,
    apiKeys,
    webhooks,
    budgetsPartial,
    cascadePartial,
    error,
    updateStatus,
    freeze,
    refreshTenant,
    refreshBudgets,
    refreshCascadeState,
    commitTenant,
    reportError,
    dismissError,
    notify,
  }
}

describe('useTenantLifecycle', () => {
  it('derives cascade preview, recovery counts, and partial verification state', () => {
    const state = setup()
    state.tenantRef.value = tenant('CLOSED')
    state.budgets.value = [budget('active'), budget('frozen', 'FROZEN'), budget('closed', 'CLOSED')]
    state.apiKeys.value = [apiKey('active'), apiKey('revoked', 'REVOKED')]
    state.webhooks.value = [webhook('active'), webhook('disabled', 'DISABLED')]

    expect(state.lifecycle.cascadePreview.value).toEqual({
      nonTerminalBudgets: 2,
      activeKeys: 1,
    })
    expect(state.lifecycle.cascadePending.value).toEqual({
      budgets: 2,
      webhooks: 1,
      apiKeys: 1,
      total: 4,
    })
    expect(state.lifecycle.showRecoveryBanner.value).toBe(true)

    state.budgets.value = [budget('closed', 'CLOSED')]
    state.apiKeys.value = [apiKey('revoked', 'REVOKED')]
    state.webhooks.value = [webhook('disabled', 'DISABLED')]
    expect(state.lifecycle.showRecoveryBanner.value).toBe(false)
    state.cascadePartial.value = true
    expect(state.lifecycle.showRecoveryBanner.value).toBe(true)
  })

  it('commits suspend before the tenant refresh and announces success', async () => {
    const state = setup()
    state.lifecycle.requestTenantAction('SUSPENDED')

    await expect(state.lifecycle.executeTenantAction()).resolves.toBe(true)

    expect(state.updateStatus).toHaveBeenCalledWith('acme', 'SUSPENDED')
    expect(state.commitTenant).toHaveBeenCalledWith(expect.objectContaining({ status: 'SUSPENDED' }))
    expect(state.refreshTenant).toHaveBeenCalledOnce()
    expect(state.refreshCascadeState).not.toHaveBeenCalled()
    expect(state.dismissError).toHaveBeenCalledOnce()
    expect(state.notify.success).toHaveBeenCalledWith('Tenant suspended')
    expect(state.lifecycle.pendingTenantAction.value).toBeNull()
  })

  it('guards suspend/reactivate against duplicate submission before visible state changes', async () => {
    const update = deferred<Tenant>()
    const updateStatus = vi.fn(() => update.promise)
    const state = setup({ updateStatus })
    state.lifecycle.requestTenantAction('SUSPENDED')

    const first = state.lifecycle.executeTenantAction()
    expect(state.lifecycle.tenantActionLoading.value).toBe(true)
    expect(state.lifecycle.isMutationRunning.value).toBe(true)
    await expect(state.lifecycle.executeTenantAction()).resolves.toBe(false)
    state.lifecycle.cancelTenantAction()
    expect(state.lifecycle.pendingTenantAction.value).toBe('SUSPENDED')
    expect(updateStatus).toHaveBeenCalledOnce()

    update.resolve(tenant('SUSPENDED'))
    await expect(first).resolves.toBe(true)
    expect(state.lifecycle.isMutationRunning.value).toBe(false)
  })

  it('requires the typed tenant name even when CLOSE is invoked directly', async () => {
    const state = setup()
    state.lifecycle.requestTenantAction('CLOSED')

    await expect(state.lifecycle.executeTenantAction()).resolves.toBe(false)

    expect(state.updateStatus).not.toHaveBeenCalled()
    expect(state.lifecycle.pendingTenantAction.value).toBe('CLOSED')
    state.lifecycle.closeConfirmInput.value = 'wrong tenant'
    await expect(state.lifecycle.executeTenantAction()).resolves.toBe(false)
    expect(state.updateStatus).not.toHaveBeenCalled()
  })

  it('cancels an idle tenant action and clears typed confirmation state', () => {
    const state = setup()
    state.lifecycle.requestTenantAction('CLOSED')
    state.lifecycle.closeConfirmInput.value = 'Acme'

    state.lifecycle.cancelTenantAction()

    expect(state.lifecycle.pendingTenantAction.value).toBeNull()
    expect(state.lifecycle.closeConfirmInput.value).toBe('')
  })

  it('warns when a committed status refresh is superseded', async () => {
    const refreshTenant = vi.fn(async () => 'superseded' as const)
    const state = setup({ refreshTenant })
    state.lifecycle.requestTenantAction('SUSPENDED')

    await state.lifecycle.executeTenantAction()

    expect(state.notify.warning).toHaveBeenCalledWith(
      'Tenant status changed; its refresh was superseded by a newer view update',
    )
  })

  it('allows only one lifecycle dialog and refuses cascade recovery on a live tenant', async () => {
    const state = setup()
    state.lifecycle.openRerunCascade()
    expect(state.lifecycle.pendingRerunCascade.value).toBe(false)

    state.lifecycle.requestTenantAction('SUSPENDED')
    await expect(state.lifecycle.openEmergencyFreeze()).resolves.toBe(false)
    expect(state.lifecycle.pendingTenantAction.value).toBe('SUSPENDED')
    expect(state.lifecycle.pendingEmergencyFreeze.value).toBe(false)
  })

  it('uses the full cascade refresh for close and keeps the committed CLOSED state on refresh failure', async () => {
    const state = setup()
    state.refreshCascadeState.mockImplementation(async () => {
      state.error.value = 'children unavailable'
      return 'failed'
    })
    state.lifecycle.requestTenantAction('CLOSED')
    state.lifecycle.closeConfirmInput.value = 'Acme'

    await expect(state.lifecycle.executeTenantAction()).resolves.toBe(true)

    expect(state.tenantRef.value?.status).toBe('CLOSED')
    expect(state.refreshCascadeState).toHaveBeenCalledOnce()
    expect(state.refreshTenant).not.toHaveBeenCalled()
    expect(state.reportError).toHaveBeenCalledWith(
      'Tenant status changed, but refresh failed: children unavailable',
    )
    expect(state.notify.warning).toHaveBeenCalledWith(
      'Tenant status changed, but refresh failed: children unavailable',
    )
    expect(state.lifecycle.closeConfirmInput.value).toBe('')
  })

  it('reports a failed status mutation without refreshing', async () => {
    const updateStatus = vi.fn(async () => { throw new Error('status writer unavailable') })
    const state = setup({ updateStatus })
    state.lifecycle.requestTenantAction('ACTIVE')

    await expect(state.lifecycle.executeTenantAction()).resolves.toBe(false)

    expect(state.reportError).toHaveBeenCalledWith('status writer unavailable')
    expect(state.notify.error).toHaveBeenCalledWith(
      'Tenant status change failed: status writer unavailable',
    )
    expect(state.refreshTenant).not.toHaveBeenCalled()
    expect(state.lifecycle.pendingTenantAction.value).toBeNull()
  })

  it('re-runs a CLOSED cascade, verifies children, and closes on convergence', async () => {
    const state = setup()
    state.tenantRef.value = tenant('CLOSED')
    state.budgets.value = [budget('active')]
    state.refreshCascadeState.mockImplementation(async () => {
      state.budgets.value = [budget('active', 'CLOSED')]
      return 'applied'
    })
    state.lifecycle.openRerunCascade()

    await expect(state.lifecycle.rerunCascade()).resolves.toBe(true)

    expect(state.updateStatus).toHaveBeenCalledWith('acme', 'CLOSED')
    expect(state.notify.success).toHaveBeenCalledWith(
      'Cascade complete — all owned objects terminal',
    )
    expect(state.lifecycle.pendingRerunCascade.value).toBe(false)
  })

  it('keeps cascade recovery open when committed verification fails', async () => {
    const refreshCascadeState = vi.fn(async () => 'failed' as const)
    const state = setup({ refreshCascadeState })
    state.tenantRef.value = tenant('CLOSED')
    state.error.value = 'verification unavailable'
    state.lifecycle.openRerunCascade()

    await expect(state.lifecycle.rerunCascade()).resolves.toBe(true)

    expect(state.lifecycle.pendingRerunCascade.value).toBe(true)
    expect(state.lifecycle.rerunCascadeError.value).toBe(
      'Cascade re-run committed, but verification failed: verification unavailable',
    )
    expect(state.notify.warning).toHaveBeenCalledOnce()

    state.lifecycle.cancelRerunCascade()
    expect(state.lifecycle.pendingRerunCascade.value).toBe(false)
    expect(state.lifecycle.rerunCascadeError.value).toBe('')
  })

  it('keeps cascade recovery open when verification is superseded', async () => {
    const refreshCascadeState = vi.fn(async () => 'superseded' as const)
    const state = setup({ refreshCascadeState })
    state.tenantRef.value = tenant('CLOSED')
    state.lifecycle.openRerunCascade()

    await expect(state.lifecycle.rerunCascade()).resolves.toBe(true)

    expect(state.lifecycle.pendingRerunCascade.value).toBe(true)
    expect(state.lifecycle.rerunCascadeError.value).toContain('verification was superseded')
    expect(state.notify.warning).toHaveBeenCalledWith(
      'Cascade re-run committed, but verification was superseded by a newer view update',
    )
  })

  it('discloses partial and still-pending cascade outcomes', async () => {
    const partial = setup()
    partial.tenantRef.value = tenant('CLOSED')
    partial.cascadePartial.value = true
    partial.lifecycle.openRerunCascade()
    await partial.lifecycle.rerunCascade()
    expect(partial.notify.warning).toHaveBeenCalledWith(
      expect.stringContaining('verification remains partial'),
    )

    const remaining = setup()
    remaining.tenantRef.value = tenant('CLOSED')
    remaining.budgets.value = [budget('one')]
    remaining.lifecycle.openRerunCascade()
    await remaining.lifecycle.rerunCascade()
    expect(remaining.notify.success).toHaveBeenCalledWith(
      'Cascade re-run — 1 object still non-terminal; retry may be needed',
    )
  })

  it('blocks Emergency Freeze when the action-time scan is partial', async () => {
    const state = setup()
    state.budgets.value = [budget('active')]
    state.refreshBudgets.mockImplementation(async () => {
      state.budgetsPartial.value = true
      return 'applied'
    })

    await expect(state.lifecycle.openEmergencyFreeze()).resolves.toBe(false)

    expect(state.lifecycle.pendingEmergencyFreeze.value).toBe(false)
    expect(state.lifecycle.emergencyFreezeTargets.value).toEqual([])
    expect(state.notify.error).toHaveBeenCalledWith(
      expect.stringContaining('budget scan could not complete'),
    )
  })

  it.each([
    ['failed', 'error', 'budget scan failed'],
    ['superseded', 'warning', 'scan was superseded'],
  ] as const)('does not arm Emergency Freeze when its scan is %s', async (result, level, copy) => {
    const refreshBudgets = vi.fn(async () => result)
    const state = setup({ refreshBudgets })
    state.error.value = 'read unavailable'
    state.budgets.value = [budget('one')]

    await expect(state.lifecycle.openEmergencyFreeze()).resolves.toBe(false)

    expect(state.lifecycle.pendingEmergencyFreeze.value).toBe(false)
    expect(state.notify[level]).toHaveBeenCalledWith(expect.stringContaining(copy))
  })

  it('refuses Emergency Freeze for terminal tenants and exact empty scans', async () => {
    const state = setup()
    state.tenantRef.value = tenant('CLOSED')
    await expect(state.lifecycle.openEmergencyFreeze()).resolves.toBe(false)
    expect(state.refreshBudgets).not.toHaveBeenCalled()

    state.tenantRef.value = tenant('ACTIVE')
    await expect(state.lifecycle.openEmergencyFreeze()).resolves.toBe(false)
    expect(state.notify.warning).toHaveBeenCalledWith(
      'Emergency Freeze not needed — no ACTIVE budgets remain',
    )
  })

  it('freezes the immutable action-time snapshot, not later ambient rows', async () => {
    const runBatch: NonNullable<UseTenantLifecycleOptions['runBatch']> = vi.fn(
      async (items, worker, options) => {
        for (let index = 0; index < items.length; index++) {
          await worker(items[index], index)
          options?.onProgress?.(index + 1, items.length, 0)
        }
        return { done: items.length, failed: 0, cancelled: false, errors: [] }
      },
    )
    const state = setup({ runBatch })
    state.budgets.value = [budget('reviewed'), budget('already-frozen', 'FROZEN')]

    await expect(state.lifecycle.openEmergencyFreeze()).resolves.toBe(true)
    expect(Object.isFrozen(state.lifecycle.emergencyFreezeTargets.value)).toBe(true)
    expect(Object.isFrozen(state.lifecycle.emergencyFreezeTargets.value[0])).toBe(true)
    state.budgets.value = [budget('late')]

    await expect(state.lifecycle.executeEmergencyFreeze()).resolves.toBe(true)

    expect(state.freeze).toHaveBeenCalledOnce()
    expect(state.freeze).toHaveBeenCalledWith(
      'tenant:acme/agent:reviewed',
      'TOKENS',
      '[EMERGENCY_FREEZE] Tenant lockdown via admin dashboard',
    )
    expect(state.lifecycle.pendingEmergencyFreeze.value).toBe(false)
    expect(state.lifecycle.emergencyFreezeResult.value).toBeNull()
  })

  it('surfaces failed Emergency Freeze rows and lets the result owner close them', async () => {
    const rowFailure = new Error('freeze rejected')
    const runBatch: NonNullable<UseTenantLifecycleOptions['runBatch']> = vi.fn(
      async (items, worker, options) => {
        await worker(items[0], 0)
        options?.onProgress?.(2, 2, 1)
        return {
          done: 2,
          failed: 1,
          cancelled: false,
          errors: [{ index: 1, error: rowFailure }],
        }
      },
    )
    const state = setup({ runBatch })
    state.budgets.value = [budget('one'), budget('two')]
    await state.lifecycle.openEmergencyFreeze()

    await state.lifecycle.executeEmergencyFreeze()

    expect(state.notify.error).toHaveBeenCalledWith('1/2 budgets frozen, 1 failed — see details')
    expect(state.lifecycle.emergencyFreezeResult.value?.response.failed).toEqual([
      { id: 'two', error_code: undefined, message: 'freeze rejected' },
    ])
    expect(state.lifecycle.emergencyFreezeResult.value?.labelById).toEqual({
      one: 'tenant:acme/agent:one (TOKENS)',
      two: 'tenant:acme/agent:two (TOKENS)',
    })

    state.lifecycle.closeEmergencyFreezeResult()
    expect(state.lifecycle.emergencyFreezeResult.value).toBeNull()
  })

  it.each([
    ['failed', 'Budgets frozen, but refresh failed: post-write read failed'],
    ['superseded', 'Budgets frozen; its refresh was superseded by a newer view update'],
  ] as const)('warns when the post-freeze refresh is %s', async (result, message) => {
    const refreshBudgets = vi.fn<() => Promise<'applied' | 'failed' | 'superseded'>>()
      .mockResolvedValueOnce('applied')
      .mockImplementationOnce(async () => result)
    const runBatch: NonNullable<UseTenantLifecycleOptions['runBatch']> = vi.fn(
      async (items, worker, options) => {
        await worker(items[0], 0)
        options?.onProgress?.(1, 1, 0)
        return { done: 1, failed: 0, cancelled: false, errors: [] }
      },
    )
    const state = setup({ refreshBudgets, runBatch })
    state.error.value = 'post-write read failed'
    state.budgets.value = [budget('one')]
    await state.lifecycle.openEmergencyFreeze()

    await state.lifecycle.executeEmergencyFreeze()

    expect(state.notify.warning).toHaveBeenCalledWith(message)
  })

  it('closes an unstarted Emergency Freeze without mutating rows', async () => {
    const state = setup()
    state.budgets.value = [budget('one')]
    await state.lifecycle.openEmergencyFreeze()

    state.lifecycle.cancelEmergencyFreeze()

    expect(state.lifecycle.pendingEmergencyFreeze.value).toBe(false)
    expect(state.lifecycle.emergencyFreezeTargets.value).toEqual([])
    await expect(state.lifecycle.executeEmergencyFreeze()).resolves.toBe(false)
    expect(state.freeze).not.toHaveBeenCalled()
  })

  it('terminates an unexpectedly rejected batch and refreshes to verify possible writes', async () => {
    const runBatch: NonNullable<UseTenantLifecycleOptions['runBatch']> = vi.fn(
      async () => { throw new Error('runner crashed') },
    )
    const state = setup({ runBatch })
    state.budgets.value = [budget('one')]
    await state.lifecycle.openEmergencyFreeze()

    await expect(state.lifecycle.executeEmergencyFreeze()).resolves.toBe(false)

    expect(state.lifecycle.emergencyFreezeRunning.value).toBe(false)
    expect(state.lifecycle.pendingEmergencyFreeze.value).toBe(false)
    expect(state.reportError).toHaveBeenCalledWith(
      'Emergency Freeze could not finish: runner crashed. Some rows may have committed.',
    )
    expect(state.notify.error).toHaveBeenCalledWith(
      'Emergency Freeze could not finish: runner crashed. Refreshing to verify any committed rows.',
    )
    expect(state.refreshBudgets).toHaveBeenCalledTimes(2)
  })

  it('aborts unstarted Emergency Freeze work and exposes skipped rows for retry', async () => {
    const batch = deferred<{
      done: number
      failed: number
      cancelled: boolean
      errors: never[]
    }>()
    let signal: AbortSignal | undefined
    const runBatch: NonNullable<UseTenantLifecycleOptions['runBatch']> = vi.fn(
      async (_items, _worker, options) => {
        signal = options?.signal
        return batch.promise
      },
    )
    const state = setup({ runBatch })
    state.budgets.value = [budget('one'), budget('two')]
    await state.lifecycle.openEmergencyFreeze()

    const execution = state.lifecycle.executeEmergencyFreeze()
    expect(state.lifecycle.emergencyFreezeRunning.value).toBe(true)
    state.lifecycle.cancelEmergencyFreeze()
    expect(signal?.aborted).toBe(true)
    batch.resolve({ done: 0, failed: 0, cancelled: true, errors: [] })
    await execution

    expect(state.lifecycle.emergencyFreezeResult.value?.response.skipped).toEqual([
      { id: 'one', reason: 'Not reached (operation cancelled)' },
      { id: 'two', reason: 'Not reached (operation cancelled)' },
    ])
    expect(state.notify.success).toHaveBeenCalledWith('0/2 budgets frozen (cancelled by user)')
  })

  it('keeps polling gated until the post-freeze refresh settles', async () => {
    const settlement = deferred<'applied'>()
    const refreshBudgets = vi.fn()
      .mockResolvedValueOnce('applied')
      .mockReturnValueOnce(settlement.promise)
    const runBatch: NonNullable<UseTenantLifecycleOptions['runBatch']> = vi.fn(
      async (items, worker, options) => {
        await worker(items[0], 0)
        options?.onProgress?.(1, 1, 0)
        return { done: 1, failed: 0, cancelled: false, errors: [] }
      },
    )
    const state = setup({ refreshBudgets, runBatch })
    state.budgets.value = [budget('one')]
    await state.lifecycle.openEmergencyFreeze()

    const execution = state.lifecycle.executeEmergencyFreeze()
    await vi.waitFor(() => expect(refreshBudgets).toHaveBeenCalledTimes(2))
    expect(state.lifecycle.emergencyFreezeRunning.value).toBe(false)
    expect(state.lifecycle.isMutationRunning.value).toBe(true)

    settlement.resolve('applied')
    await execution
    expect(state.lifecycle.isMutationRunning.value).toBe(false)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, type EffectScope } from 'vue'
import { ApiError } from '../api/client'
import {
  TENANT_DETAIL_SCAN_MAX_ROWS,
  useTenantDetailData,
  type TenantDetailDataDependencies,
  type TenantDetailTab,
} from '../composables/useTenantDetailData'
import { POLLING_STALE } from '../composables/pollingResult'
import type { ApiKey, BudgetLedger, Policy, Tenant, WebhookSubscription } from '../types'

function tenant(status = 'ACTIVE'): Tenant {
  return {
    tenant_id: 'acme',
    name: 'Acme',
    status,
    created_at: '2026-07-18T00:00:00Z',
  }
}

function budget(id: string, status = 'ACTIVE'): BudgetLedger {
  return {
    ledger_id: id,
    tenant_id: 'acme',
    scope: `tenant:acme/agent:${id}`,
    unit: 'TOKENS',
    allocated: { unit: 'TOKENS', amount: 100 },
    remaining: { unit: 'TOKENS', amount: 50 },
    status,
    created_at: '2026-07-18T00:00:00Z',
  }
}

function key(id: string): ApiKey {
  return {
    key_id: id,
    tenant_id: 'acme',
    key_prefix: id,
    status: 'ACTIVE',
    permissions: [],
    created_at: '2026-07-18T00:00:00Z',
  }
}

function policy(id: string): Policy {
  return {
    policy_id: id,
    name: id,
    scope_pattern: 'tenant:acme/*',
    status: 'ACTIVE',
    created_at: '2026-07-18T00:00:00Z',
  }
}

function webhook(id: string): WebhookSubscription {
  return {
    subscription_id: id,
    tenant_id: 'acme',
    url: `https://${id}.example/hook`,
    event_types: [],
    status: 'ACTIVE',
    created_at: '2026-07-18T00:00:00Z',
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

type Harness = ReturnType<typeof createHarness>
const scopes: EffectScope[] = []

function createHarness(initialTab: TenantDetailTab = 'budgets') {
  const activeTab = ref<TenantDetailTab>(initialTab)
  const mutationRunning = ref(false)
  const getTenant = vi.fn<TenantDetailDataDependencies['getTenant']>().mockResolvedValue(tenant())
  const listBudgets = vi.fn<TenantDetailDataDependencies['listBudgets']>()
    .mockResolvedValue({ ledgers: [], has_more: false })
  const listTenants = vi.fn<TenantDetailDataDependencies['listTenants']>()
    .mockResolvedValue({ tenants: [], has_more: false })
  const listApiKeys = vi.fn<TenantDetailDataDependencies['listApiKeys']>()
    .mockResolvedValue({ keys: [], has_more: false })
  const listPolicies = vi.fn<TenantDetailDataDependencies['listPolicies']>()
    .mockResolvedValue({ policies: [], has_more: false })
  const listWebhooks = vi.fn<TenantDetailDataDependencies['listWebhooks']>()
    .mockResolvedValue({ subscriptions: [], has_more: false })

  const isLoading = ref(false)
  const lastSuccessAt = ref<Date | null>(null)
  const refresh = vi.fn()
  let pollCallback: Parameters<TenantDetailDataDependencies['usePolling']>[0] = async () => {}
  const usePolling: TenantDetailDataDependencies['usePolling'] = callback => {
    pollCallback = callback
    return { refresh, isLoading, lastSuccessAt }
  }

  const scope = effectScope()
  scopes.push(scope)
  const data = scope.run(() => useTenantDetailData({
    tenantId: 'acme',
    getActiveTab: () => activeTab.value,
    isMutationRunning: () => mutationRunning.value,
    dependencies: {
      getTenant,
      listBudgets,
      listTenants,
      listApiKeys,
      listPolicies,
      listWebhooks,
      usePolling,
    },
  }))
  if (!data) throw new Error('Tenant Detail data scope did not initialize')

  return {
    data,
    activeTab,
    mutationRunning,
    getTenant,
    listBudgets,
    listTenants,
    listApiKeys,
    listPolicies,
    listWebhooks,
    lastSuccessAt,
    tick: (signal = new AbortController().signal) => pollCallback(signal),
  }
}

function clearCalls(h: Harness): void {
  h.getTenant.mockClear()
  h.listBudgets.mockClear()
  h.listTenants.mockClear()
  h.listApiKeys.mockClear()
  h.listPolicies.mockClear()
  h.listWebhooks.mockClear()
}

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
})

describe('useTenantDetailData', () => {
  it('walks every initial child axis and publishes complete multi-page snapshots', async () => {
    const h = createHarness()
    h.listBudgets.mockImplementation(async params => params.cursor
      ? { ledgers: [budget('b2')], has_more: false }
      : { ledgers: [budget('b1')], has_more: true, next_cursor: 'budget-cursor' })
    h.listApiKeys.mockResolvedValue({ keys: [key('k1')], has_more: false })
    h.listPolicies.mockResolvedValue({ policies: [policy('p1')], has_more: false })
    h.listWebhooks.mockResolvedValue({ subscriptions: [webhook('w1')], has_more: false })
    h.listTenants.mockResolvedValue({ tenants: [tenant()], has_more: false })

    await expect(h.tick()).resolves.toBe(true)

    expect(h.data.budgets.value.map(item => item.ledger_id)).toEqual(['b1', 'b2'])
    expect(h.data.apiKeys.value.map(item => item.key_id)).toEqual(['k1'])
    expect(h.data.policies.value.map(item => item.policy_id)).toEqual(['p1'])
    expect(h.data.webhooks.value.map(item => item.subscription_id)).toEqual(['w1'])
    expect(h.data.budgetsPartial.value).toBe(false)
    expect(h.data.initialLoadDone.value).toBe(true)
    expect(h.listBudgets).toHaveBeenNthCalledWith(1, {
      tenant_id: 'acme',
      limit: '100',
    }, expect.any(AbortSignal))
    expect(h.listBudgets).toHaveBeenNthCalledWith(2, {
      tenant_id: 'acme',
      limit: '100',
      cursor: 'budget-cursor',
    }, expect.any(AbortSignal))
  })

  it('marks a capped walk partial and retains the bounded lower-bound rows', async () => {
    const h = createHarness()
    let page = 0
    h.listBudgets.mockImplementation(async () => {
      page++
      return {
        ledgers: Array.from({ length: 100 }, (_, index) => budget(`p${page}-${index}`)),
        has_more: true,
        next_cursor: `cursor-${page}`,
      }
    })

    await h.tick()

    expect(h.data.budgets.value).toHaveLength(TENANT_DETAIL_SCAN_MAX_ROWS)
    expect(h.data.budgetsPartial.value).toBe(true)
    expect(h.data.cascadePartial.value).toBe(true)
    expect(h.listBudgets).toHaveBeenCalledTimes(10)
  })

  it('reports has_more without a continuation cursor as partial', async () => {
    const h = createHarness()
    h.listApiKeys.mockResolvedValue({ keys: [key('k1')], has_more: true })

    await h.tick()

    expect(h.data.apiKeys.value.map(item => item.key_id)).toEqual(['k1'])
    expect(h.data.apiKeysPartial.value).toBe(true)
    expect(h.listApiKeys).toHaveBeenCalledOnce()
  })

  it('keeps steady ACTIVE polls lazy to the active sub-list', async () => {
    const h = createHarness('keys')
    await h.tick()
    clearCalls(h)

    await expect(h.tick()).resolves.toBe(true)

    expect(h.getTenant).toHaveBeenCalledOnce()
    expect(h.listBudgets).toHaveBeenCalledOnce()
    expect(h.listTenants).toHaveBeenCalledOnce()
    expect(h.listApiKeys).toHaveBeenCalledOnce()
    expect(h.listPolicies).not.toHaveBeenCalled()
    expect(h.listWebhooks).not.toHaveBeenCalled()
  })

  it('refreshes cascade axes on a steady CLOSED poll regardless of active tab', async () => {
    const h = createHarness('policies')
    await h.tick()
    clearCalls(h)
    h.getTenant.mockResolvedValue(tenant('CLOSED'))

    await expect(h.tick()).resolves.toBe(true)

    expect(h.listPolicies).toHaveBeenCalledOnce()
    expect(h.listApiKeys).toHaveBeenCalledOnce()
    expect(h.listWebhooks).toHaveBeenCalledOnce()
  })

  it('discards a late poll after a direct mutation refresh takes ownership', async () => {
    const h = createHarness()
    h.listBudgets.mockResolvedValue({ ledgers: [budget('initial')], has_more: false })
    await h.tick()

    const tenantRead = deferred<Tenant>()
    h.getTenant.mockImplementationOnce(() => tenantRead.promise)
    const stalePoll = h.tick()

    h.listBudgets.mockResolvedValue({ ledgers: [budget('post-mutation')], has_more: false })
    await expect(h.data.refreshBudgets()).resolves.toBe('applied')
    tenantRead.resolve(tenant())

    await expect(stalePoll).resolves.toBe(POLLING_STALE)
    expect(h.data.budgets.value.map(item => item.ledger_id)).toEqual(['post-mutation'])
  })

  it('aborts direct reads and supersedes their publication when a mutation begins', async () => {
    const h = createHarness('keys')
    await h.tick()
    const keyRead = deferred<{ keys: ApiKey[]; has_more: boolean }>()
    h.listApiKeys.mockImplementationOnce((_params, signal) => {
      signal?.addEventListener('abort', () => keyRead.reject(new DOMException('aborted', 'AbortError')))
      return keyRead.promise
    })

    const staleRefresh = h.data.refreshApiKeys()
    expect(h.data.isLoading.value).toBe(true)
    h.data.beginMutation()

    await expect(staleRefresh).resolves.toBe('superseded')
    expect(h.data.isLoading.value).toBe(false)
    expect(h.data.error.value).toBe('')
  })

  it('publishes authoritative API-key mutation responses without replacing sibling rows', async () => {
    const h = createHarness('keys')
    h.listApiKeys.mockResolvedValue({ keys: [key('key-1'), key('key-2')], has_more: false })
    await h.tick()

    h.data.commitApiKey({ ...key('key-2'), status: 'REVOKED' })
    expect(h.data.apiKeys.value.map(item => `${item.key_id}:${item.status}`)).toEqual([
      'key-1:ACTIVE',
      'key-2:REVOKED',
    ])

    h.data.commitApiKey(key('key-3'))
    expect(h.data.apiKeys.value.map(item => item.key_id)).toEqual(['key-3', 'key-1', 'key-2'])
  })

  it('publishes authoritative policy mutation responses without replacing sibling rows', async () => {
    const h = createHarness('policies')
    h.listPolicies.mockResolvedValue({ policies: [policy('policy-1'), policy('policy-2')], has_more: false })
    await h.tick()

    h.data.commitPolicy({ ...policy('policy-2'), name: 'Updated policy' })
    expect(h.data.policies.value.map(item => `${item.policy_id}:${item.name}`)).toEqual([
      'policy-1:policy-1',
      'policy-2:Updated policy',
    ])

    h.data.commitPolicy(policy('policy-3'))
    expect(h.data.policies.value.map(item => item.policy_id)).toEqual(['policy-3', 'policy-1', 'policy-2'])
  })

  it('does not publish an action-time walk aborted between pages', async () => {
    const h = createHarness()
    h.listBudgets.mockResolvedValue({ ledgers: [budget('owned')], has_more: false })
    await h.tick()

    const page = deferred<{ ledgers: BudgetLedger[]; has_more: boolean }>()
    h.listBudgets.mockImplementationOnce(() => page.promise)
    const controller = new AbortController()
    const pendingPoll = h.tick(controller.signal)
    controller.abort()
    page.resolve({ ledgers: [budget('stale')], has_more: false })

    await expect(pendingPoll).resolves.toBe(POLLING_STALE)
    expect(h.data.budgets.value.map(item => item.ledger_id)).toEqual(['owned'])
  })

  it('distinguishes a missing route tenant from a child-endpoint 404', async () => {
    const missing = createHarness()
    missing.getTenant.mockRejectedValue(new ApiError(404, 'missing'))
    await expect(missing.tick()).resolves.toBe(false)
    expect(missing.data.notFound.value).toBe(true)
    expect(missing.listBudgets).not.toHaveBeenCalled()

    const childFailure = createHarness()
    childFailure.listPolicies.mockRejectedValue(new ApiError(404, 'policies unavailable'))
    await expect(childFailure.tick()).resolves.toBe(false)
    expect(childFailure.data.notFound.value).toBe(false)
    expect(childFailure.data.error.value).toBe('policies unavailable')

    const steadyChildFailure = createHarness()
    await steadyChildFailure.tick()
    steadyChildFailure.listBudgets.mockRejectedValue(new ApiError(404, 'budgets unavailable'))
    await expect(steadyChildFailure.tick()).resolves.toBe(false)
    expect(steadyChildFailure.data.notFound.value).toBe(false)
    expect(steadyChildFailure.data.error.value).toBe('budgets unavailable')
  })

  it('preserves successful cascade siblings when another verification read fails', async () => {
    const h = createHarness()
    await h.tick()
    h.getTenant.mockResolvedValue(tenant('CLOSED'))
    h.listBudgets.mockResolvedValue({ ledgers: [budget('closed', 'CLOSED')], has_more: false })
    h.listWebhooks.mockRejectedValue(new Error('webhook read failed'))
    h.listApiKeys.mockResolvedValue({ keys: [], has_more: false })

    await expect(h.data.refreshCascadeState()).resolves.toBe('failed')

    expect(h.data.tenant.value?.status).toBe('CLOSED')
    expect(h.data.budgets.value[0]?.status).toBe('CLOSED')
    expect(h.data.error.value).toBe('webhook read failed')
  })

  it('yields polls while a destructive mutation owns settlement', async () => {
    const h = createHarness()
    h.mutationRunning.value = true

    await expect(h.tick()).resolves.toBe(POLLING_STALE)
    expect(h.getTenant).not.toHaveBeenCalled()

    h.mutationRunning.value = false
    const budgetRead = deferred<{ ledgers: BudgetLedger[]; has_more: boolean }>()
    h.listBudgets.mockImplementationOnce(() => budgetRead.promise)
    const directRefresh = h.data.refreshBudgets()
    await expect(h.tick()).resolves.toBe(POLLING_STALE)
    expect(h.getTenant).not.toHaveBeenCalled()
    budgetRead.resolve({ ledgers: [], has_more: false })
    await expect(directRefresh).resolves.toBe('applied')
  })

  it('keeps a poll error through unrelated refreshes but clears it on a same-axis retry', async () => {
    const h = createHarness()
    await h.tick()
    const priorSuccess = new Date('2026-07-18T00:00:00Z')
    h.lastSuccessAt.value = priorSuccess

    h.listBudgets.mockRejectedValueOnce(new Error('budget poll failed'))
    await expect(h.tick()).resolves.toBe(false)
    expect(h.data.error.value).toBe('budget poll failed')

    h.listPolicies.mockResolvedValue({ policies: [policy('fresh-policy')], has_more: false })
    await expect(h.data.refreshPolicies()).resolves.toBe('applied')

    expect(h.data.policies.value.map(item => item.policy_id)).toEqual(['fresh-policy'])
    expect(h.data.error.value).toBe('budget poll failed')
    expect(h.data.lastSuccessAt.value).toBe(priorSuccess)

    await expect(h.data.refreshBudgets()).resolves.toBe('applied')
    expect(h.data.error.value).toBe('')
    expect(h.data.lastSuccessAt.value).toBe(priorSuccess)
  })

  it('distinguishes a superseded direct refresh from a failed request', async () => {
    const h = createHarness()
    await h.tick()
    const budgetRead = deferred<{ ledgers: BudgetLedger[]; has_more: boolean }>()
    h.listBudgets.mockImplementationOnce(() => budgetRead.promise)

    const staleBudgetRefresh = h.data.refreshBudgets()
    await expect(h.data.refreshPolicies()).resolves.toBe('applied')
    budgetRead.resolve({ ledgers: [budget('stale-direct')], has_more: false })

    await expect(staleBudgetRefresh).resolves.toBe('superseded')
    expect(h.data.error.value).toBe('')
    expect(h.data.budgets.value).toEqual([])
  })

  it('clears a direct-axis error only when that same axis later succeeds', async () => {
    const h = createHarness()
    await h.tick()
    h.listPolicies.mockRejectedValueOnce(new Error('policy read failed'))

    await expect(h.data.refreshPolicies()).resolves.toBe('failed')
    expect(h.data.error.value).toBe('policy read failed')
    await expect(h.data.refreshBudgets()).resolves.toBe('applied')
    expect(h.data.error.value).toBe('policy read failed')
    await expect(h.data.refreshPolicies()).resolves.toBe('applied')
    expect(h.data.error.value).toBe('')
  })
})

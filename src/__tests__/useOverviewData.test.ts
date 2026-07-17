import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import { POLLING_STALE } from '../composables/pollingResult'
import {
  useOverviewData,
  type OverviewDataDependencies,
} from '../composables/useOverviewData'
import type {
  AdminOverviewResponse,
  ApiKey,
  BudgetLedger,
  Tenant,
  WebhookSubscription,
} from '../types'

function healthyOverview(overrides: Partial<AdminOverviewResponse> = {}): AdminOverviewResponse {
  return {
    as_of: '2026-07-17T12:00:00Z',
    event_window_seconds: 3600,
    tenant_counts: { total: 10, active: 10, suspended: 0, closed: 0 },
    budget_counts: {
      total: 5,
      active: 5,
      frozen: 0,
      closed: 0,
      over_limit: 0,
      with_debt: 0,
      by_unit: {},
    },
    over_limit_scopes: [],
    debt_scopes: [],
    webhook_counts: { total: 3, active: 3, disabled: 0, with_failures: 0 },
    failing_webhooks: [],
    event_counts: { total_recent: 42, by_category: { runtime: 42 } },
    recent_denials: [],
    recent_expiries: [],
    ...overrides,
  }
}

function key(id: string): ApiKey {
  return {
    key_id: id,
    tenant_id: 'acme',
    key_prefix: `cyc_${id}`,
    status: 'ACTIVE',
    permissions: [],
    created_at: '2026-07-01T00:00:00Z',
  }
}

function budget(scope: string, status = 'ACTIVE'): BudgetLedger {
  return {
    ledger_id: `ledger-${scope}`,
    tenant_id: 'acme',
    scope,
    unit: 'tokens',
    allocated: { unit: 'tokens', amount: 100 },
    spent: { unit: 'tokens', amount: 95 },
    remaining: { unit: 'tokens', amount: 5 },
    debt: { unit: 'tokens', amount: 0 },
    overdraft_limit: { unit: 'tokens', amount: 0 },
    is_over_limit: false,
    status,
    created_at: '2026-07-01T00:00:00Z',
  }
}

function webhook(id: string): WebhookSubscription {
  return {
    subscription_id: id,
    tenant_id: 'acme',
    url: `https://${id}.example/hook`,
    event_types: [],
    status: 'ACTIVE',
    created_at: '2026-07-01T00:00:00Z',
  }
}

function tenant(id: string): Tenant {
  return {
    tenant_id: id,
    name: id,
    status: 'CLOSED',
    created_at: '2026-07-01T00:00:00Z',
  }
}

type Harness = ReturnType<typeof createHarness>
const scopes: EffectScope[] = []

function createHarness() {
  const getOverview = vi.fn<OverviewDataDependencies['getOverview']>()
    .mockResolvedValue(healthyOverview())
  const listApiKeys = vi.fn<OverviewDataDependencies['listApiKeys']>()
    .mockResolvedValue({ keys: [], has_more: false })
  const listAuditLogs = vi.fn<OverviewDataDependencies['listAuditLogs']>()
    .mockResolvedValue({ logs: [], has_more: false })
  const listBudgets = vi.fn<OverviewDataDependencies['listBudgets']>()
    .mockResolvedValue({ ledgers: [], has_more: false })
  const listTenants = vi.fn<OverviewDataDependencies['listTenants']>()
    .mockResolvedValue({ tenants: [], has_more: false })
  const listWebhooks = vi.fn<OverviewDataDependencies['listWebhooks']>()
    .mockResolvedValue({ subscriptions: [], has_more: false })

  const isLoading = ref(false)
  const lastSuccessAt = ref<Date | null>(null)
  const refresh = vi.fn()
  let pollCallback: Parameters<OverviewDataDependencies['usePolling']>[0] = async () => {}
  const usePolling: OverviewDataDependencies['usePolling'] = (callback) => {
    pollCallback = callback
    return { refresh, isLoading, lastSuccessAt }
  }

  const scope = effectScope()
  scopes.push(scope)
  const data = scope.run(() => useOverviewData({
    getOverview,
    listApiKeys,
    listAuditLogs,
    listBudgets,
    listTenants,
    listWebhooks,
    usePolling,
  }))
  if (!data) throw new Error('Overview data scope did not initialize')

  return {
    data,
    getOverview,
    listApiKeys,
    listAuditLogs,
    listBudgets,
    listTenants,
    listWebhooks,
    isLoading,
    refresh,
    tick: () => pollCallback(new AbortController().signal),
  }
}

function clearCalls(h: Harness) {
  h.getOverview.mockClear()
  h.listApiKeys.mockClear()
  h.listAuditLogs.mockClear()
  h.listBudgets.mockClear()
  h.listTenants.mockClear()
  h.listWebhooks.mockClear()
}

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
})

describe('useOverviewData', () => {
  it('loads both phases and publishes every owned data slice', async () => {
    const h = createHarness()
    const frozen = budget('frozen', 'FROZEN')
    const debt = { ...budget('debt'), debt: { unit: 'tokens', amount: 4 } }
    const atCap = budget('near-cap')
    h.listApiKeys.mockResolvedValue({ keys: [key('key-1')], has_more: false })
    h.listBudgets.mockImplementation(async (params) => {
      if (params.status === 'FROZEN') return { ledgers: [frozen], has_more: false }
      if (params.has_debt === 'true') return { ledgers: [debt], has_more: false }
      return { ledgers: [atCap], has_more: false }
    })
    h.listTenants.mockResolvedValue({ tenants: [tenant('closed-1')], has_more: false })
    h.listWebhooks.mockResolvedValue({ subscriptions: [webhook('hook-1')], has_more: false })

    await expect(h.tick()).resolves.toBe(true)

    expect(h.data.overview.value?.tenant_counts.total).toBe(10)
    expect(h.data.keys.value.map(item => item.key_id)).toEqual(['key-1'])
    expect(h.data.frozenBudgets.value).toEqual([frozen])
    expect(h.data.debtBudgets.value).toEqual([debt])
    expect(h.data.atCapBudgets.value).toEqual([atCap])
    expect([...h.data.closedTenantIds.value]).toEqual(['closed-1'])
    expect(h.data.failingWebhooksRaw.value.map(item => item.subscription_id)).toEqual(['hook-1'])
    expect(h.data.error.value).toBe('')
  })

  it('skips walks for unchanged counters but re-walks when the signature changes', async () => {
    const h = createHarness()
    await h.tick()
    clearCalls(h)

    await h.tick()
    expect(h.getOverview).toHaveBeenCalledOnce()
    expect(h.listAuditLogs).toHaveBeenCalledOnce()
    expect(h.listApiKeys).not.toHaveBeenCalled()

    h.getOverview.mockResolvedValue(healthyOverview({
      budget_counts: {
        ...healthyOverview().budget_counts,
        frozen: 1,
      },
    }))
    await h.tick()
    expect(h.listApiKeys).toHaveBeenCalledOnce()
    expect(h.listTenants).toHaveBeenCalledOnce()
    expect(h.listWebhooks).toHaveBeenCalledOnce()
  })

  it('uses the tenth unchanged tick as the fallback walk cadence', async () => {
    const h = createHarness()
    await h.tick()
    clearCalls(h)

    for (let tick = 1; tick < 10; tick++) await h.tick()
    expect(h.listApiKeys).not.toHaveBeenCalled()

    await h.tick()
    expect(h.listApiKeys).toHaveBeenCalledOnce()
  })

  it('marks a capped cursor walk partial and keeps all collected rows', async () => {
    const h = createHarness()
    let page = 0
    h.listApiKeys.mockImplementation(async () => {
      page++
      return {
        keys: [key(`key-${page}`)],
        has_more: true,
        next_cursor: String(page),
      }
    })

    await h.tick()

    expect(h.listApiKeys).toHaveBeenCalledTimes(10)
    expect(h.listApiKeys.mock.calls[0]?.[0]).toMatchObject({ status: 'ACTIVE', limit: '100' })
    expect(h.data.keys.value).toHaveLength(10)
    expect(h.data.keysPartial.value).toBe(true)
  })

  it('backs off failed walks, preserves their banner, and gives phase-one errors precedence', async () => {
    const h = createHarness()
    h.listApiKeys.mockRejectedValue(new Error('key walk unavailable'))

    await expect(h.tick()).resolves.toBe(POLLING_STALE)
    expect(h.data.error.value).toBe('key walk unavailable')
    h.listApiKeys.mockClear()

    h.listAuditLogs.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(h.tick()).resolves.toBe(false)
    expect(h.data.error.value).toBe('audit unavailable')
    expect(h.listApiKeys).not.toHaveBeenCalled()

    await expect(h.tick()).resolves.toBe(POLLING_STALE)
    expect(h.listApiKeys).toHaveBeenCalledOnce()
    expect(h.data.error.value).toBe('key walk unavailable')
  })

  it('a successful forced retry clears the walk failure and resets its retry cadence', async () => {
    const h = createHarness()
    h.listApiKeys.mockRejectedValue(new Error('key walk unavailable'))
    await h.tick()

    h.listApiKeys.mockResolvedValue({ keys: [], has_more: false })
    h.data.refreshAll()
    await expect(h.tick()).resolves.toBe(true)
    expect(h.data.error.value).toBe('')

    h.listApiKeys.mockRejectedValue(new Error('failed again'))
    h.data.refreshAll()
    await h.tick()
    h.listApiKeys.mockClear()

    await h.tick()
    expect(h.listApiKeys).not.toHaveBeenCalled()
    await h.tick()
    expect(h.listApiKeys).toHaveBeenCalledOnce()
  })

  it('queues a manual refresh while loading and forces walks on the replay', async () => {
    const h = createHarness()
    await h.tick()
    clearCalls(h)

    h.isLoading.value = true
    await nextTick()
    h.data.refreshAll()
    expect(h.refresh).not.toHaveBeenCalled()

    h.isLoading.value = false
    await nextTick()
    expect(h.refresh).toHaveBeenCalledOnce()

    await h.tick()
    expect(h.listApiKeys).toHaveBeenCalledOnce()
  })
})

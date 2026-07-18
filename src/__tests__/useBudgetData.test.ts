import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useBudgetData } from '../composables/useBudgetData'
import type { BudgetDataDependencies } from '../composables/useBudgetData'
import { POLL_SLOW_MS } from '../composables/pollingConstants'
import { POLLING_STALE } from '../composables/pollingResult'
import type { BudgetLedger, Event, Tenant } from '../types'

function budget(scope: string, unit = 'USD_MICROCENTS'): BudgetLedger {
  return {
    ledger_id: `ledger-${scope}`,
    tenant_id: 'acme',
    scope,
    unit,
    status: 'ACTIVE',
    allocated: { unit, amount: 100 },
    remaining: { unit, amount: 80 },
    reserved: { unit, amount: 0 },
    spent: { unit, amount: 20 },
    created_at: '2026-07-17T00:00:00Z',
  }
}

function event(id: string, scope: string): Event {
  return {
    event_id: id,
    event_type: 'budget.updated',
    category: 'budget',
    timestamp: '2026-07-17T00:00:00Z',
    tenant_id: 'acme',
    scope,
    source: 'cycles-server-admin',
  }
}

function tenant(id: string): Tenant {
  return {
    tenant_id: id,
    name: id,
    status: 'ACTIVE',
    created_at: '2026-07-17T00:00:00Z',
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

type PollCallback = Parameters<BudgetDataDependencies['usePolling']>[0]

function setup(initialMode: 'list' | 'detail' = 'list') {
  let detailMode = initialMode === 'detail'
  let listParams: Record<string, string> = {
    limit: '100',
    status: 'ACTIVE',
    sort_by: 'utilization',
    sort_dir: 'desc',
  }
  let detailTarget = { scope: 'tenant:acme/a', unit: 'USD_MICROCENTS' }
  let tick!: PollCallback

  const listBudgets = vi.fn().mockResolvedValue({
    ledgers: [budget('tenant:acme/initial')],
    has_more: false,
  })
  const listEvents = vi.fn().mockResolvedValue({ events: [], has_more: false })
  const listTenants = vi.fn().mockResolvedValue({ tenants: [tenant('acme')], has_more: false })
  const lookupBudget = vi.fn().mockImplementation((scope: string, unit: string) => (
    Promise.resolve(budget(scope, unit))
  ))
  const refresh = vi.fn()
  const usePolling = vi.fn((callback: PollCallback, intervalMs: number) => {
    tick = callback
    expect(intervalMs).toBe(POLL_SLOW_MS)
    return {
      refresh,
      isLoading: ref(false),
      lastSuccessAt: ref<Date | null>(null),
    }
  })

  const data = useBudgetData({
    isDetail: () => detailMode,
    getListParams: () => ({ ...listParams }),
    getDetailTarget: () => ({ ...detailTarget }),
    dependencies: {
      listBudgets: listBudgets as unknown as BudgetDataDependencies['listBudgets'],
      listEvents: listEvents as unknown as BudgetDataDependencies['listEvents'],
      listTenants: listTenants as unknown as BudgetDataDependencies['listTenants'],
      lookupBudget: lookupBudget as unknown as BudgetDataDependencies['lookupBudget'],
      usePolling: usePolling as unknown as BudgetDataDependencies['usePolling'],
    },
  })

  return {
    data,
    listBudgets,
    listEvents,
    listTenants,
    lookupBudget,
    refresh,
    runTick: () => tick(new AbortController().signal),
    setDetailMode: (value: boolean) => { detailMode = value },
    setListParams: (value: Record<string, string>) => { listParams = value },
    setDetailTarget: (value: { scope: string; unit: string }) => { detailTarget = value },
  }
}

describe('useBudgetData', () => {
  it('loads tenants and the initial applied list tuple through the slow poll', async () => {
    const harness = setup()

    await expect(harness.runTick()).resolves.toBe(true)

    expect(harness.listTenants).toHaveBeenCalledOnce()
    expect(harness.listBudgets).toHaveBeenCalledWith({
      limit: '100',
      status: 'ACTIVE',
      sort_by: 'utilization',
      sort_dir: 'desc',
    })
    expect(harness.data.tenants.value.map(item => item.tenant_id)).toEqual(['acme'])
    expect(harness.data.budgets.value.map(item => item.scope)).toEqual(['tenant:acme/initial'])
    expect(harness.data.initialLoadDone.value).toBe(true)
  })

  it('commits only the newest overlapping page-one request and discards a stale failure', async () => {
    const harness = setup()
    await harness.runTick()
    const older = deferred<{ ledgers: BudgetLedger[]; has_more: boolean }>()
    const newer = deferred<{ ledgers: BudgetLedger[]; has_more: boolean; next_cursor: string }>()
    harness.listBudgets
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)

    harness.setListParams({ limit: '100', search: 'older' })
    const olderLoad = harness.data.applyListParams()
    harness.setListParams({ limit: '100', search: 'newer' })
    const newerLoad = harness.data.applyListParams()

    newer.resolve({ ledgers: [budget('tenant:acme/newer')], has_more: true, next_cursor: 'newer-cursor' })
    await expect(newerLoad).resolves.toBe(true)
    older.reject(new Error('stale 502'))
    await expect(olderLoad).resolves.toBe(POLLING_STALE)

    expect(harness.data.budgets.value.map(item => item.scope)).toEqual(['tenant:acme/newer'])
    expect(harness.data.nextCursor.value).toBe('newer-cursor')
    expect(harness.data.error.value).toBe('')
  })

  it('refreshes with the applied tuple while a live draft filter is pending', async () => {
    const harness = setup()
    await harness.runTick()
    harness.setListParams({ limit: '100', status: 'FROZEN' })
    harness.listBudgets.mockClear()

    await harness.data.refreshList()

    expect(harness.listBudgets).toHaveBeenCalledWith({
      limit: '100',
      status: 'ACTIVE',
      sort_by: 'utilization',
      sort_dir: 'desc',
    })
  })

  it('uses the cursor-owning tuple for Load more instead of live filters', async () => {
    const harness = setup()
    harness.listBudgets.mockResolvedValueOnce({
      ledgers: [budget('tenant:acme/page-1')],
      has_more: true,
      next_cursor: 'cursor-1',
    })
    await harness.runTick()
    harness.setListParams({ limit: '100', status: 'FROZEN' })
    harness.listBudgets.mockResolvedValueOnce({
      ledgers: [budget('tenant:acme/page-2')],
      has_more: false,
    })

    await expect(harness.data.loadMore()).resolves.toBe(true)

    expect(harness.listBudgets).toHaveBeenLastCalledWith({
      limit: '100',
      status: 'ACTIVE',
      sort_by: 'utilization',
      sort_dir: 'desc',
      cursor: 'cursor-1',
    })
    expect(harness.data.budgets.value.map(item => item.scope)).toEqual([
      'tenant:acme/page-1',
      'tenant:acme/page-2',
    ])
  })

  it('discards an in-flight Load-more page when filters advance to a new epoch', async () => {
    const harness = setup()
    harness.listBudgets.mockResolvedValueOnce({
      ledgers: [budget('tenant:acme/old-page-1')],
      has_more: true,
      next_cursor: 'old-cursor',
    })
    await harness.runTick()

    const oldPageTwo = deferred<{ ledgers: BudgetLedger[]; has_more: boolean }>()
    harness.listBudgets
      .mockImplementationOnce(() => oldPageTwo.promise)
      .mockResolvedValueOnce({ ledgers: [budget('tenant:acme/new-page-1')], has_more: false })
    const loadMore = harness.data.loadMore()
    harness.setListParams({ limit: '100', status: 'FROZEN' })
    await expect(harness.data.applyListParams()).resolves.toBe(true)
    oldPageTwo.resolve({ ledgers: [budget('tenant:acme/stale-page-2')], has_more: false })

    await expect(loadMore).resolves.toBe(POLLING_STALE)
    expect(harness.data.budgets.value.map(item => item.scope)).toEqual(['tenant:acme/new-page-1'])
  })

  it('surfaces a current Load-more failure without changing the cursor-owned rows', async () => {
    const harness = setup()
    harness.listBudgets.mockResolvedValueOnce({
      ledgers: [budget('tenant:acme/page-1')],
      has_more: true,
      next_cursor: 'cursor-1',
    })
    await harness.runTick()
    harness.listBudgets.mockRejectedValueOnce(new Error('page two unavailable'))

    await expect(harness.data.loadMore()).resolves.toBe(false)

    expect(harness.data.error.value).toBe('page two unavailable')
    expect(harness.data.nextCursor.value).toBe('cursor-1')
    expect(harness.data.budgets.value.map(item => item.scope)).toEqual(['tenant:acme/page-1'])
    expect(harness.data.loadingMore.value).toBe(false)
  })

  it('binds an export page to one snapshot and rejects it after a filter transition', async () => {
    const harness = setup()
    await harness.runTick()
    const snapshot = harness.data.snapshotListQuery()
    const exportController = new AbortController()
    harness.setListParams({ limit: '100', status: 'FROZEN' })
    harness.listBudgets.mockResolvedValueOnce({
      ledgers: [budget('tenant:acme/export-page')],
      has_more: false,
    })

    await expect(harness.data.fetchListPage(
      snapshot,
      'export-cursor',
      exportController.signal,
    )).resolves.toEqual({
      items: [budget('tenant:acme/export-page')],
      hasMore: false,
      nextCursor: '',
    })
    expect(harness.listBudgets).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'ACTIVE',
        cursor: 'export-cursor',
      }),
      exportController.signal,
    )

    const inFlightPage = deferred<{ ledgers: BudgetLedger[]; has_more: boolean }>()
    harness.listBudgets
      .mockImplementationOnce(() => inFlightPage.promise)
      .mockResolvedValueOnce({ ledgers: [], has_more: false })
    const inFlightExport = harness.data.fetchListPage(snapshot, 'in-flight')
    await harness.data.applyListParams()
    inFlightPage.resolve({ ledgers: [budget('tenant:acme/stale-export-page')], has_more: false })
    await expect(inFlightExport).rejects.toThrow(
      'Export cancelled because the applied budget filters changed.',
    )
    await expect(harness.data.fetchListPage(snapshot, 'next')).rejects.toThrow(
      'Export cancelled because the applied budget filters changed.',
    )
  })

  it('deduplicates watcher echoes but permits a forced same-tuple retry', async () => {
    const harness = setup()
    await harness.runTick()
    harness.listBudgets.mockClear()

    await expect(harness.data.applyListParams()).resolves.toBe(POLLING_STALE)
    expect(harness.listBudgets).not.toHaveBeenCalled()
    await expect(harness.data.applyListParams(true)).resolves.toBe(true)
    expect(harness.listBudgets).toHaveBeenCalledOnce()
  })

  it('withholds cursor consumers until a newly-applied tuple owns page one', async () => {
    const harness = setup()
    await harness.runTick()
    const failedPage = deferred<{ ledgers: BudgetLedger[]; has_more: boolean }>()
    harness.listBudgets.mockImplementationOnce(() => failedPage.promise)
    harness.setListParams({ limit: '100', status: 'FROZEN' })

    const transition = harness.data.applyListParams()
    expect(harness.data.resultsMatchAppliedFilters.value).toBe(false)
    expect(harness.data.listLoading.value).toBe(true)
    const pendingSnapshot = harness.data.snapshotListQuery()
    await expect(harness.data.fetchListPage(pendingSnapshot, 'cursor')).rejects.toThrow(
      'Export cancelled because the applied budget filters changed.',
    )
    failedPage.reject(new Error('page one unavailable'))
    await expect(transition).resolves.toBe(false)
    expect(harness.data.resultsMatchAppliedFilters.value).toBe(false)
    expect(harness.data.listLoading.value).toBe(false)

    harness.listBudgets.mockResolvedValueOnce({
      ledgers: [budget('tenant:acme/frozen')],
      has_more: false,
    })
    await expect(harness.data.refreshList()).resolves.toBe(true)
    expect(harness.data.resultsMatchAppliedFilters.value).toBe(true)
  })

  it('loads exact-scope detail events and paginates the timeline', async () => {
    const harness = setup('detail')
    harness.listEvents
      .mockResolvedValueOnce({
        events: [
          event('exact-1', 'tenant:acme/a'),
          event('child', 'tenant:acme/a/child'),
        ],
        has_more: true,
        next_cursor: 'event-cursor',
      })
      .mockResolvedValueOnce({
        events: [
          event('exact-2', 'tenant:acme/a'),
          event('child-2', 'tenant:acme/a/child'),
        ],
        has_more: false,
      })

    await expect(harness.runTick()).resolves.toBe(true)
    await expect(harness.data.loadMoreDetailEvents()).resolves.toBe(true)

    expect(harness.listTenants).not.toHaveBeenCalled()
    expect(harness.listBudgets).not.toHaveBeenCalled()
    expect(harness.lookupBudget).toHaveBeenCalledWith('tenant:acme/a', 'USD_MICROCENTS')
    expect(harness.listEvents).toHaveBeenNthCalledWith(1, {
      scope: 'tenant:acme/a',
      limit: '20',
    })
    expect(harness.listEvents).toHaveBeenNthCalledWith(2, {
      scope: 'tenant:acme/a',
      limit: '20',
      cursor: 'event-cursor',
    })
    expect(harness.data.detailEvents.value.map(item => item.event_id)).toEqual(['exact-1', 'exact-2'])
  })

  it('surfaces a current detail-event pagination failure and keeps its cursor retryable', async () => {
    const harness = setup('detail')
    harness.listEvents
      .mockResolvedValueOnce({
        events: [event('exact-1', 'tenant:acme/a')],
        has_more: true,
        next_cursor: 'event-cursor',
      })
      .mockRejectedValueOnce(new Error('event page unavailable'))
    await harness.runTick()

    await expect(harness.data.loadMoreDetailEvents()).resolves.toBe(false)

    expect(harness.data.error.value).toBe('event page unavailable')
    expect(harness.data.detailEventsCursor.value).toBe('event-cursor')
    expect(harness.data.detailEvents.value.map(item => item.event_id)).toEqual(['exact-1'])
    expect(harness.data.detailEventsLoadingMore.value).toBe(false)
  })

  it('keeps a newer detail route authoritative over an older in-flight lookup', async () => {
    const harness = setup('detail')
    const older = deferred<BudgetLedger>()
    harness.lookupBudget.mockImplementationOnce(() => older.promise)
    const olderLoad = harness.data.loadDetail()

    harness.setDetailTarget({ scope: 'tenant:acme/b', unit: 'TOKENS' })
    harness.lookupBudget.mockResolvedValueOnce(budget('tenant:acme/b', 'TOKENS'))
    harness.listEvents.mockResolvedValueOnce({
      events: [event('new-event', 'tenant:acme/b')],
      has_more: false,
    })
    await expect(harness.data.loadDetail()).resolves.toBe(true)
    older.resolve(budget('tenant:acme/a'))
    await expect(olderLoad).resolves.toBe(POLLING_STALE)

    expect(harness.data.detail.value?.scope).toBe('tenant:acme/b')
    expect(harness.data.detailEvents.value.map(item => item.event_id)).toEqual(['new-event'])
  })

  it('invalidates an abandoned detail request before it can leak an error into list mode', async () => {
    const harness = setup('detail')
    const lookup = deferred<BudgetLedger>()
    harness.lookupBudget.mockImplementationOnce(() => lookup.promise)
    const pending = harness.data.loadDetail()

    harness.setDetailMode(false)
    harness.data.invalidateDetail()
    lookup.reject(new Error('late detail 502'))

    await expect(pending).resolves.toBe(POLLING_STALE)
    expect(harness.data.error.value).toBe('')
  })

  it('invalidates an abandoned list request before it can leak an error into detail mode', async () => {
    const harness = setup()
    await harness.runTick()
    const pageOne = deferred<{ ledgers: BudgetLedger[]; has_more: boolean }>()
    harness.listBudgets.mockImplementationOnce(() => pageOne.promise)
    const pending = harness.data.refreshList()

    harness.setDetailMode(true)
    harness.data.invalidateList()
    pageOne.reject(new Error('late list 502'))

    await expect(pending).resolves.toBe(POLLING_STALE)
    expect(harness.data.error.value).toBe('')
  })

  it('discards a tenant-list failure when a list poll navigates into detail', async () => {
    const harness = setup()
    const tenants = deferred<{ tenants: Tenant[]; has_more: boolean }>()
    harness.listTenants.mockImplementationOnce(() => tenants.promise)
    const pending = harness.runTick()

    harness.setDetailMode(true)
    harness.data.invalidateList()
    tenants.reject(new Error('late tenant 502'))

    await expect(pending).resolves.toBe(POLLING_STALE)
    expect(harness.data.tenantsError.value).toBe('')
    expect(harness.listBudgets).not.toHaveBeenCalled()
  })

  it('loads tenants and page one when a directly-loaded detail enters list mode', async () => {
    const harness = setup('detail')
    await expect(harness.runTick()).resolves.toBe(true)
    expect(harness.listTenants).not.toHaveBeenCalled()
    expect(harness.listBudgets).not.toHaveBeenCalled()

    harness.setDetailMode(false)
    harness.data.invalidateDetail()
    await expect(harness.data.loadListMode(true)).resolves.toBe(true)

    expect(harness.listTenants).toHaveBeenCalledOnce()
    expect(harness.listBudgets).toHaveBeenCalledOnce()
    expect(harness.data.tenants.value.map(item => item.tenant_id)).toEqual(['acme'])
    expect(harness.data.budgets.value.map(item => item.scope)).toEqual(['tenant:acme/initial'])
  })

  it('isolates committed list and detail errors across mode transitions', async () => {
    const harness = setup()
    harness.listTenants.mockRejectedValueOnce(new Error('tenant list unavailable'))
    harness.listBudgets.mockRejectedValueOnce(new Error('budget list unavailable'))
    await expect(harness.runTick()).resolves.toBe(false)
    expect(harness.data.error.value).toBe('budget list unavailable')
    expect(harness.data.tenantsError.value).toContain('tenant list unavailable')

    harness.setDetailMode(true)
    harness.data.invalidateList()
    expect(harness.data.error.value).toBe('')
    expect(harness.data.tenantsError.value).toBe('')

    harness.lookupBudget.mockRejectedValueOnce(new Error('detail unavailable'))
    await expect(harness.data.loadDetail()).resolves.toBe(false)
    expect(harness.data.error.value).toBe('detail unavailable')

    harness.setDetailMode(false)
    harness.data.invalidateDetail()
    expect(harness.data.error.value).toBe('')
    harness.data.reportError('export unavailable')
    expect(harness.data.error.value).toBe('export unavailable')
    harness.data.dismissError()
    expect(harness.data.error.value).toBe('')
  })

  it('keeps tenant-list failure separate while still committing budget rows', async () => {
    const harness = setup()
    harness.listTenants.mockRejectedValueOnce(new Error('tenant service unavailable'))

    await expect(harness.runTick()).resolves.toBe(false)

    expect(harness.data.tenantsError.value).toContain('tenant service unavailable')
    expect(harness.data.budgets.value.map(item => item.scope)).toEqual(['tenant:acme/initial'])
    expect(harness.data.error.value).toBe('')
    harness.data.dismissTenantsError()
    expect(harness.data.tenantsError.value).toBe('')
  })
})

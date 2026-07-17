import { ref } from 'vue'
import {
  listBudgets as listBudgetsDefault,
  listEvents as listEventsDefault,
  listTenants as listTenantsDefault,
  lookupBudget as lookupBudgetDefault,
} from '../api/client'
import type { BudgetLedger, Event, Tenant } from '../types'
import { toMessage } from '../utils/errors'
import { useAppliedQuery } from './useAppliedQuery'
import type { AppliedQuerySnapshot } from './useAppliedQuery'
import { POLL_SLOW_MS } from './pollingConstants'
import { POLLING_STALE } from './pollingResult'
import { usePolling as usePollingDefault } from './usePolling'

const DETAIL_EVENTS_PAGE_SIZE = 20

type BudgetPolling = (
  callback: Parameters<typeof usePollingDefault>[0],
  intervalMs: number,
) => Pick<ReturnType<typeof usePollingDefault>, 'refresh' | 'isLoading' | 'lastSuccessAt'>

export interface BudgetDataDependencies {
  listBudgets: typeof listBudgetsDefault
  listEvents: typeof listEventsDefault
  listTenants: typeof listTenantsDefault
  lookupBudget: typeof lookupBudgetDefault
  usePolling: BudgetPolling
}

export interface UseBudgetDataOptions {
  /** Whether the route currently renders the single-ledger detail shell. */
  isDetail: () => boolean
  /** Current server-visible list tuple, without a cursor. */
  getListParams: () => Record<string, string>
  /** Current detail route tuple. */
  getDetailTarget: () => { scope: string; unit: string }
  /** Focused dependency seams for deterministic protocol tests. */
  dependencies?: Partial<BudgetDataDependencies>
}

/**
 * Owns BudgetsView's read-side protocol.
 *
 * Filter controls and route hydration stay in the view. This boundary owns
 * tenant/list/detail acquisition, polling, page-one sequencing, cursor state,
 * and the immutable applied tuple shared by Load more and export.
 */
export function useBudgetData(options: UseBudgetDataOptions) {
  const dependencies = options.dependencies ?? {}
  const listBudgets = () => dependencies.listBudgets ?? listBudgetsDefault
  const listEvents = () => dependencies.listEvents ?? listEventsDefault
  const listTenants = () => dependencies.listTenants ?? listTenantsDefault
  const lookupBudget = () => dependencies.lookupBudget ?? lookupBudgetDefault

  const tenants = ref<Tenant[]>([])
  const tenantsError = ref('')

  const budgets = ref<BudgetLedger[]>([])
  const initialLoadDone = ref(false)
  const hasMore = ref(false)
  const nextCursor = ref('')
  const loadingMore = ref(false)
  const listLoading = ref(false)
  // False only while the first page for a newly-applied tuple is unresolved
  // or failed. Routine same-tuple refresh failures preserve row ownership.
  const resultsMatchAppliedFilters = ref(false)
  const error = ref('')

  const detail = ref<BudgetLedger | null>(null)
  const detailEvents = ref<Event[]>([])
  const detailEventsCursor = ref('')
  const detailEventsHasMore = ref(false)
  const detailEventsLoadingMore = ref(false)

  const {
    appliedParams: appliedListParams,
    startFilterTransition,
    snapshotApplied: snapshotListQuery,
    ownsFilterSnapshot: ownsListQuery,
    beginPageOne,
    ownsPageOne,
  } = useAppliedQuery()
  let listQueryInitialized = false

  function ensureListQuery(): AppliedQuerySnapshot {
    if (!listQueryInitialized) {
      listQueryInitialized = true
      return startFilterTransition(options.getListParams(), { force: true, commit: 'start' })!
    }
    return snapshotListQuery()
  }

  async function loadTenants(): Promise<boolean | typeof POLLING_STALE> {
    try {
      const response = await listTenants()()
      if (options.isDetail()) return POLLING_STALE
      tenants.value = response.tenants
      tenantsError.value = ''
      return true
    } catch (cause) {
      if (options.isDetail()) return POLLING_STALE
      tenantsError.value = `Could not load tenant list: ${toMessage(cause)}`
      return false
    }
  }

  async function loadListPageOne(snapshot: AppliedQuerySnapshot) {
    const request = beginPageOne(snapshot)
    listLoading.value = true
    // A cursor belongs to exactly one applied filter/sort tuple. Hide it as
    // soon as page one starts so it cannot be reused during the transition.
    nextCursor.value = ''
    hasMore.value = false
    try {
      const response = await listBudgets()({ ...request.params })
      if (!ownsPageOne(request)) return POLLING_STALE
      budgets.value = response.ledgers
      hasMore.value = !!response.has_more
      nextCursor.value = response.next_cursor ?? ''
      error.value = ''
      initialLoadDone.value = true
      resultsMatchAppliedFilters.value = true
      return true
    } catch (cause) {
      if (!ownsPageOne(request)) return POLLING_STALE
      error.value = toMessage(cause)
      return false
    } finally {
      if (ownsPageOne(request)) listLoading.value = false
    }
  }

  /** Reload page one for the tuple that currently owns the visible rows. */
  function refreshList() {
    if (options.isDetail()) return Promise.resolve(POLLING_STALE)
    return loadListPageOne(ensureListQuery())
  }

  /**
   * Apply the view's current filter/sort tuple and load its first page.
   * Repeated watcher echoes are deduplicated; force remains the retry seam.
   */
  function applyListParams(force = false) {
    if (options.isDetail()) return Promise.resolve(POLLING_STALE)
    const transition = startFilterTransition(options.getListParams(), {
      force: force || !listQueryInitialized,
      commit: 'start',
    })
    listQueryInitialized = true
    if (!transition) return Promise.resolve(POLLING_STALE)
    resultsMatchAppliedFilters.value = false
    return loadListPageOne(transition)
  }

  /** Fetch one cursor page for a caller-owned applied snapshot (export). */
  async function fetchListPage(snapshot: AppliedQuerySnapshot, cursor: string) {
    if (options.isDetail() || !resultsMatchAppliedFilters.value || !ownsListQuery(snapshot)) {
      throw new Error('Export cancelled because the applied budget filters changed.')
    }
    const response = await listBudgets()({ ...snapshot.params, ...(cursor ? { cursor } : {}) })
    if (options.isDetail() || !resultsMatchAppliedFilters.value || !ownsListQuery(snapshot)) {
      throw new Error('Export cancelled because the applied budget filters changed.')
    }
    return {
      items: response.ledgers,
      hasMore: !!response.has_more,
      nextCursor: response.next_cursor ?? '',
    }
  }

  async function loadMore() {
    if (options.isDetail() || loadingMore.value || !nextCursor.value || !resultsMatchAppliedFilters.value) return false
    const filterSnapshot = snapshotListQuery()
    const cursor = nextCursor.value
    loadingMore.value = true
    try {
      const response = await listBudgets()({ ...filterSnapshot.params, cursor })
      if (!ownsListQuery(filterSnapshot)) return POLLING_STALE
      budgets.value = [...budgets.value, ...response.ledgers]
      hasMore.value = !!response.has_more
      nextCursor.value = response.next_cursor ?? ''
      return true
    } catch (cause) {
      if (!ownsListQuery(filterSnapshot)) return POLLING_STALE
      error.value = toMessage(cause)
      return false
    } finally {
      loadingMore.value = false
    }
  }

  let detailLoadSequence = 0

  async function loadDetail() {
    const sequence = ++detailLoadSequence
    const { scope, unit } = options.getDetailTarget()
    const changedLedger = !detail.value || detail.value.scope !== scope || detail.value.unit !== unit
    if (changedLedger) {
      detail.value = null
      detailEvents.value = []
      detailEventsCursor.value = ''
      detailEventsHasMore.value = false
    }
    detailEventsLoadingMore.value = false

    try {
      const ledger = await lookupBudget()(scope, unit)
      if (sequence !== detailLoadSequence) return POLLING_STALE
      detail.value = ledger
      detailEventsCursor.value = ''
      detailEventsHasMore.value = false

      const response = await listEvents()({ scope, limit: String(DETAIL_EVENTS_PAGE_SIZE) })
      if (sequence !== detailLoadSequence) return POLLING_STALE
      // Some older admin versions interpret scope as a prefix. Keep the
      // timeline exact even when the server returns child-scope events.
      detailEvents.value = response.events.filter(event => event.scope === scope)
      detailEventsHasMore.value = !!response.has_more
      detailEventsCursor.value = response.next_cursor ?? ''
      error.value = ''
      return true
    } catch (cause) {
      if (sequence !== detailLoadSequence) return POLLING_STALE
      error.value = toMessage(cause)
      return false
    }
  }

  async function loadMoreDetailEvents() {
    if (!detailEventsCursor.value || detailEventsLoadingMore.value) return false
    const sequence = detailLoadSequence
    const { scope } = options.getDetailTarget()
    const cursor = detailEventsCursor.value
    detailEventsLoadingMore.value = true
    try {
      const response = await listEvents()({
        scope,
        limit: String(DETAIL_EVENTS_PAGE_SIZE),
        cursor,
      })
      if (sequence !== detailLoadSequence) return POLLING_STALE
      const exactEvents = response.events.filter(event => event.scope === scope)
      detailEvents.value = [...detailEvents.value, ...exactEvents]
      detailEventsHasMore.value = !!response.has_more
      detailEventsCursor.value = response.next_cursor ?? ''
      return true
    } catch (cause) {
      if (sequence !== detailLoadSequence) return POLLING_STALE
      error.value = toMessage(cause)
      return false
    } finally {
      if (sequence === detailLoadSequence) detailEventsLoadingMore.value = false
    }
  }

  function invalidateDetail(): void {
    detailLoadSequence++
    detailEventsLoadingMore.value = false
  }

  function invalidateList(): void {
    if (listQueryInitialized) {
      // Advance only the ownership epoch. The tuple is unchanged, but every
      // list page/export captured before detail navigation becomes stale.
      startFilterTransition(appliedListParams.value, { force: true, commit: 'start' })
    }
    loadingMore.value = false
    listLoading.value = false
  }

  async function tick() {
    if (options.isDetail()) return loadDetail()
    const tenantsLoaded = await loadTenants()
    if (tenantsLoaded === POLLING_STALE) return POLLING_STALE
    const budgetsLoaded = await refreshList()
    if (tenantsLoaded === false || budgetsLoaded === false) return false
    if (budgetsLoaded === POLLING_STALE) return POLLING_STALE
    return true
  }

  const poll = dependencies.usePolling ?? usePollingDefault
  const { refresh, isLoading, lastSuccessAt } = poll(tick, POLL_SLOW_MS)

  return {
    tenants,
    tenantsError,
    budgets,
    initialLoadDone,
    hasMore,
    nextCursor,
    loadingMore,
    listLoading,
    resultsMatchAppliedFilters,
    error,
    detail,
    detailEvents,
    detailEventsCursor,
    detailEventsHasMore,
    detailEventsLoadingMore,
    appliedListParams,
    snapshotListQuery,
    ownsListQuery,
    fetchListPage,
    refreshList,
    applyListParams,
    loadMore,
    loadDetail,
    loadMoreDetailEvents,
    invalidateList,
    invalidateDetail,
    refresh,
    isLoading,
    lastSuccessAt,
  }
}

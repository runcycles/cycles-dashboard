import { computed, onScopeDispose, readonly, ref, watch } from 'vue'
import {
  ApiError,
  getWebhook as getWebhookDefault,
  listDeliveries as listDeliveriesDefault,
} from '../api/client'
import type { WebhookDelivery, WebhookSubscription } from '../types'
import { toMessage } from '../utils/errors'
import { useAppliedQuery } from './useAppliedQuery'
import type { AppliedQuerySnapshot } from './useAppliedQuery'
import { POLL_FAST_MS } from './pollingConstants'
import { POLLING_STALE } from './pollingResult'
import { usePolling as usePollingDefault } from './usePolling'

type WebhookDetailPolling = (
  callback: Parameters<typeof usePollingDefault>[0],
  intervalMs: number,
) => Pick<ReturnType<typeof usePollingDefault>, 'refresh' | 'isLoading' | 'lastSuccessAt'>

export interface WebhookDetailDataDependencies {
  getWebhook: typeof getWebhookDefault
  listDeliveries: typeof listDeliveriesDefault
  usePolling: WebhookDetailPolling
}

export interface UseWebhookDetailDataOptions {
  webhookId: string
  /** Current server-visible delivery filter tuple, without a cursor. */
  getDeliveryParams: () => Record<string, string>
  /** Operation-owned writes publish directly; ambient polls must stay out. */
  isMutationRunning?: () => boolean
  /** Focused dependency seams for deterministic protocol tests. */
  dependencies?: Partial<WebhookDetailDataDependencies>
}

const defaultDependencies: WebhookDetailDataDependencies = {
  getWebhook: getWebhookDefault,
  listDeliveries: listDeliveriesDefault,
  usePolling: usePollingDefault,
}

const MISSING_DELIVERY_CURSOR = 'The server reported more deliveries but omitted the continuation cursor. Refresh or change the filter before retrying.'

function isAbortError(cause: unknown): boolean {
  return (
    (cause instanceof DOMException && cause.name === 'AbortError') ||
    (cause instanceof Error && cause.name === 'AbortError')
  )
}

function mergeDeliveryHead(
  head: readonly WebhookDelivery[],
  existing: readonly WebhookDelivery[],
): WebhookDelivery[] {
  const seen = new Set(head.map(delivery => delivery.delivery_id))
  return [...head, ...existing.filter(delivery => !seen.has(delivery.delivery_id))]
}

function isTerminalDelivery(delivery: WebhookDelivery): boolean {
  return delivery.status === 'SUCCESS' || delivery.status === 'FAILED'
}

/**
 * Owns WebhookDetailView's read-side protocol.
 *
 * The delivery status tuple is committed before its page-one request and is
 * then reused by Load more and export. Page-one publications are sequenced,
 * while filter epochs prevent an old cursor response from entering a newer
 * result set. Routine polls merge a fresh head into an operator-loaded tail
 * instead of silently throwing away pages every 30 seconds.
 */
export function useWebhookDetailData(options: UseWebhookDetailDataOptions) {
  const deps: WebhookDetailDataDependencies = {
    ...defaultDependencies,
    ...options.dependencies,
  }

  const webhook = ref<WebhookSubscription | null>(null)
  const deliveries = ref<WebhookDelivery[]>([])
  const error = ref('')
  const notFound = ref(false)
  const initialLoadDone = ref(false)

  const deliveriesHasMore = ref(false)
  const deliveriesNextCursor = ref('')
  const deliveriesLoadingMore = ref(false)
  const deliveryFilterLoading = ref(false)
  const resultsMatchAppliedFilter = ref(false)
  const deliveryContinuationUsable = computed(() => (
    !deliveriesHasMore.value || !!deliveriesNextCursor.value
  ))
  let loadedMorePages = false

  const {
    appliedParams: appliedDeliveryParams,
    startFilterTransition,
    snapshotApplied: snapshotDeliveryQuery,
    ownsFilterSnapshot: ownsDeliveryQuery,
    beginPageOne,
    ownsPageOne,
  } = useAppliedQuery()
  let deliveryQueryInitialized = false

  let webhookGeneration = 0
  let filterController: AbortController | null = null
  let loadMoreController: AbortController | null = null
  let pendingFilterSnapshot: AppliedQuerySnapshot | null = null
  let disposed = false
  const pendingManualRefresh = ref(false)

  function ensureDeliveryQuery(): AppliedQuerySnapshot {
    if (!deliveryQueryInitialized) {
      deliveryQueryInitialized = true
      return startFilterTransition(options.getDeliveryParams(), {
        force: true,
        commit: 'start',
      })!
    }
    return snapshotDeliveryQuery()
  }

  function ownsWebhookRead(generation: number, signal: AbortSignal): boolean {
    return generation === webhookGeneration && !signal.aborted
  }

  function clearDeliveryState(): void {
    deliveries.value = []
    deliveriesHasMore.value = false
    deliveriesNextCursor.value = ''
    deliveriesLoadingMore.value = false
    deliveryFilterLoading.value = false
    resultsMatchAppliedFilter.value = false
    loadedMorePages = false
  }

  function publishNotFound(): void {
    // A subscription 404 is authoritative for the whole detail surface. Make
    // every delivery owner stale before clearing its rows so a request that
    // ignores abort cannot republish data after the not-found state.
    const activeFilter = filterController
    const activeLoadMore = loadMoreController
    filterController = null
    loadMoreController = null
    activeFilter?.abort()
    activeLoadMore?.abort()
    pendingFilterSnapshot = null
    pendingManualRefresh.value = false
    if (deliveryQueryInitialized) {
      startFilterTransition(snapshotDeliveryQuery().params, {
        force: true,
        commit: 'start',
      })
    }
    webhook.value = null
    clearDeliveryState()
    notFound.value = true
    initialLoadDone.value = true
    error.value = ''
  }

  async function readWebhook(generation: number, signal: AbortSignal) {
    try {
      const response = await deps.getWebhook(options.webhookId, signal)
      if (!ownsWebhookRead(generation, signal)) return POLLING_STALE
      webhook.value = response
      notFound.value = false
      return true
    } catch (cause) {
      if (isAbortError(cause)) throw cause
      if (!ownsWebhookRead(generation, signal)) return POLLING_STALE
      if (cause instanceof ApiError && cause.status === 404) publishNotFound()
      else error.value = toMessage(cause)
      return false
    }
  }

  async function loadDeliveryPageOne(
    snapshot: AppliedQuerySnapshot,
    signal: AbortSignal,
    preserveLoadedTail: boolean,
  ) {
    const request = beginPageOne(snapshot)
    try {
      const response = await deps.listDeliveries(
        options.webhookId,
        { ...request.params },
        signal,
      )
      if (!ownsPageOne(request) || signal.aborted) return POLLING_STALE

      const preservesLoadedHistory = preserveLoadedTail && loadedMorePages && resultsMatchAppliedFilter.value
      const loadedIds = preservesLoadedHistory
        ? new Set(deliveries.value.map(existing => existing.delivery_id))
        : null
      const headIds = preservesLoadedHistory
        ? new Set(response.deliveries.map(fresh => fresh.delivery_id))
        : null
      const headReconnects = !!loadedIds && response.deliveries.some(fresh => loadedIds.has(fresh.delivery_id))
      // SUCCESS and FAILED are immutable terminal outcomes. A retained
      // PENDING/RETRYING (or forward-compatible unknown) row can change after
      // it falls beyond page one, so re-anchor instead of presenting a stale
      // status indefinitely under the old tail cursor.
      const retainedTailIsTerminal = !headIds || deliveries.value.every(existing => (
        headIds.has(existing.delivery_id) || isTerminalDelivery(existing)
      ))
      const keepsTailCursor = preservesLoadedHistory
        && headReconnects
        && deliveryContinuationUsable.value
        && retainedTailIsTerminal
      if (keepsTailCursor) {
        deliveries.value = mergeDeliveryHead(response.deliveries, deliveries.value)
      } else {
        // A burst larger than page one can leave no overlap with the loaded
        // rows. Retaining a disconnected tail would create an unseen gap and
        // later duplicate those retained rows in a full export. Re-anchor at
        // the fresh head; the operator can Load more to bridge history again.
        deliveries.value = response.deliveries
        deliveriesHasMore.value = !!response.has_more
        deliveriesNextCursor.value = response.next_cursor ?? ''
        loadedMorePages = false
      }

      resultsMatchAppliedFilter.value = true
      initialLoadDone.value = true
      const missingContinuation = !keepsTailCursor && !!response.has_more && !response.next_cursor
      error.value = missingContinuation
        ? MISSING_DELIVERY_CURSOR
        : ''
      return missingContinuation ? false : true
    } catch (cause) {
      if (isAbortError(cause)) throw cause
      if (!ownsPageOne(request) || signal.aborted) return POLLING_STALE
      error.value = toMessage(cause)
      return false
    }
  }

  function settlePendingFilter(snapshot: AppliedQuerySnapshot): void {
    if (pendingFilterSnapshot?.epoch === snapshot.epoch) {
      pendingFilterSnapshot = null
      deliveryFilterLoading.value = false
    }
  }

  async function tick(signal: AbortSignal = new AbortController().signal) {
    if (options.isMutationRunning?.()) return POLLING_STALE
    const generation = ++webhookGeneration
    const webhookResult = await readWebhook(generation, signal)
    if (webhookResult !== true) return webhookResult

    const snapshot = ensureDeliveryQuery()
    const deliveryResult = await loadDeliveryPageOne(snapshot, signal, true)
    if (deliveryResult !== POLLING_STALE) settlePendingFilter(snapshot)
    return deliveryResult
  }

  const { refresh, isLoading, lastSuccessAt } = deps.usePolling(tick, POLL_FAST_MS)

  async function runFilterTransition(snapshot: AppliedQuerySnapshot) {
    filterController?.abort()
    const controller = new AbortController()
    filterController = controller
    deliveryFilterLoading.value = true
    try {
      const result = await loadDeliveryPageOne(snapshot, controller.signal, false)
      if (result !== POLLING_STALE) {
        settlePendingFilter(snapshot)
      }
      return result
    } catch (cause) {
      if (isAbortError(cause)) return POLLING_STALE
      throw cause
    } finally {
      if (filterController === controller) {
        filterController = null
        const pending = pendingFilterSnapshot
        if (!disposed && pending && !isLoading.value) {
          void runFilterTransition(pending)
        } else if (!pending) {
          deliveryFilterLoading.value = false
        }
      }
    }
  }

  /** Apply the current live delivery controls as one immutable tuple. */
  function applyDeliveryParams(force = false) {
    const transition = startFilterTransition(options.getDeliveryParams(), {
      force: force || !deliveryQueryInitialized,
      commit: 'start',
    })
    deliveryQueryInitialized = true
    if (!transition) return Promise.resolve(POLLING_STALE)

    loadMoreController?.abort()
    filterController?.abort()
    deliveriesLoadingMore.value = false
    deliveriesHasMore.value = false
    deliveriesNextCursor.value = ''
    resultsMatchAppliedFilter.value = false
    loadedMorePages = false
    pendingFilterSnapshot = transition
    deliveryFilterLoading.value = true

    // usePolling deliberately drops refresh() while a tick is active. Keep
    // the new epoch now (so the old response cannot publish), then consume
    // the latest pending tuple as soon as that tick settles.
    if (isLoading.value) return Promise.resolve(POLLING_STALE)
    return runFilterTransition(transition)
  }

  async function loadMoreDeliveries() {
    if (
      deliveriesLoadingMore.value ||
      deliveryFilterLoading.value ||
      !deliveriesNextCursor.value ||
      !resultsMatchAppliedFilter.value
    ) return false

    const snapshot = snapshotDeliveryQuery()
    const cursor = deliveriesNextCursor.value
    const controller = new AbortController()
    loadMoreController = controller
    deliveriesLoadingMore.value = true
    try {
      const response = await deps.listDeliveries(
        options.webhookId,
        { ...snapshot.params, cursor },
        controller.signal,
      )
      if (!ownsDeliveryQuery(snapshot) || controller.signal.aborted) return POLLING_STALE
      deliveries.value = mergeDeliveryHead(deliveries.value, response.deliveries)
      deliveriesHasMore.value = !!response.has_more
      deliveriesNextCursor.value = response.next_cursor ?? ''
      loadedMorePages = true
      const missingContinuation = !!response.has_more && !response.next_cursor
      error.value = missingContinuation
        ? MISSING_DELIVERY_CURSOR
        : ''
      return missingContinuation ? false : true
    } catch (cause) {
      if (isAbortError(cause) || !ownsDeliveryQuery(snapshot)) return POLLING_STALE
      error.value = toMessage(cause)
      return false
    } finally {
      if (loadMoreController === controller) {
        loadMoreController = null
        deliveriesLoadingMore.value = false
      }
    }
  }

  /** Fetch one cursor page for a caller-owned applied snapshot (export). */
  async function fetchDeliveryPage(
    snapshot: AppliedQuerySnapshot,
    cursor: string,
    signal?: AbortSignal,
  ) {
    if (!resultsMatchAppliedFilter.value || !ownsDeliveryQuery(snapshot)) {
      throw new Error('Export cancelled because the applied delivery filter changed.')
    }
    const response = await deps.listDeliveries(
      options.webhookId,
      { ...snapshot.params, ...(cursor ? { cursor } : {}) },
      signal,
    )
    if (!resultsMatchAppliedFilter.value || !ownsDeliveryQuery(snapshot)) {
      throw new Error('Export cancelled because the applied delivery filter changed.')
    }
    if (response.has_more && !response.next_cursor) {
      throw new Error(MISSING_DELIVERY_CURSOR)
    }
    return {
      items: response.deliveries,
      hasMore: !!response.has_more,
      nextCursor: response.next_cursor ?? '',
    }
  }

  /** Mutation responses can publish authoritative subscription state directly. */
  function beginSubscriptionMutation(): void {
    // Invalidate an already-running subscription GET before the write begins.
    // The operation owner will publish the authoritative mutation response.
    webhookGeneration++
  }

  function publishWebhook(value: WebhookSubscription): void {
    beginSubscriptionMutation()
    webhook.value = value
    notFound.value = false
  }

  /** A committed DELETE owns the terminal detail state before navigation. */
  function publishDeletedWebhook(): void {
    beginSubscriptionMutation()
    publishNotFound()
  }

  function reportError(message: string): void {
    error.value = message
  }

  function dismissError(): void {
    error.value = ''
  }

  function refreshAll(): void {
    if (isLoading.value || deliveryFilterLoading.value) {
      pendingManualRefresh.value = true
      return
    }
    refresh()
  }

  watch([isLoading, deliveryFilterLoading], ([polling, filtering], [wasPolling, wasFiltering]) => {
    if (disposed) return
    const pending = pendingFilterSnapshot
    if (wasPolling && !polling && pending && !filterController) {
      void runFilterTransition(pending)
      return
    }
    if ((wasPolling || wasFiltering) && !polling && !filtering) {
      if (pendingManualRefresh.value) {
        pendingManualRefresh.value = false
        refreshAll()
      }
    }
  })

  onScopeDispose(() => {
    disposed = true
    webhookGeneration++
    pendingFilterSnapshot = null
    pendingManualRefresh.value = false
    filterController?.abort()
    loadMoreController?.abort()
  })

  const loading = computed(() => isLoading.value || deliveryFilterLoading.value)
  // computed wrappers prevent ref replacement while preserving the mutable
  // DTO types expected by existing pure view helpers. Vue's deep readonly()
  // would turn nested selector arrays into readonly arrays as well.
  const publishedWebhook = computed<WebhookSubscription | null>(() => webhook.value)
  const publishedDeliveries = computed<WebhookDelivery[]>(() => deliveries.value)

  return {
    webhook: publishedWebhook,
    deliveries: publishedDeliveries,
    error: readonly(error),
    notFound: readonly(notFound),
    initialLoadDone: readonly(initialLoadDone),
    deliveriesHasMore: readonly(deliveriesHasMore),
    deliveriesNextCursor: readonly(deliveriesNextCursor),
    deliveriesLoadingMore: readonly(deliveriesLoadingMore),
    deliveryFilterLoading: readonly(deliveryFilterLoading),
    deliveryContinuationUsable,
    resultsMatchAppliedFilter: readonly(resultsMatchAppliedFilter),
    appliedDeliveryParams,
    snapshotDeliveryQuery,
    ownsDeliveryQuery,
    applyDeliveryParams,
    loadMoreDeliveries,
    fetchDeliveryPage,
    beginSubscriptionMutation,
    publishWebhook,
    publishDeletedWebhook,
    reportError,
    dismissError,
    refreshAll,
    loading,
    lastSuccessAt,
  }
}

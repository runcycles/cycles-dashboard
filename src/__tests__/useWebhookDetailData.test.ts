import { effectScope, nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { useWebhookDetailData } from '../composables/useWebhookDetailData'
import type { WebhookDetailDataDependencies } from '../composables/useWebhookDetailData'
import { POLL_FAST_MS } from '../composables/pollingConstants'
import { POLLING_STALE } from '../composables/pollingResult'
import type { WebhookDelivery, WebhookSubscription } from '../types'

function subscription(name = 'Webhook'): WebhookSubscription {
  return {
    subscription_id: 'wh-1',
    tenant_id: 'acme',
    name,
    url: 'https://example.test/hook',
    event_types: ['budget.updated'],
    status: 'ACTIVE',
    created_at: '2026-07-19T00:00:00Z',
  }
}

function delivery(id: string, status = 'SUCCESS'): WebhookDelivery {
  return {
    delivery_id: id,
    event_id: `event-${id}`,
    status,
    attempts: 1,
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

type PollCallback = Parameters<WebhookDetailDataDependencies['usePolling']>[0]

function setup() {
  let deliveryParams: Record<string, string> = {}
  let mutationRunning = false
  let tick!: PollCallback
  const pollingLoading = ref(false)
  const lastSuccessAt = ref<Date | null>(null)
  const refresh = vi.fn()
  const getWebhook = vi.fn().mockResolvedValue(subscription())
  const listDeliveries = vi.fn().mockResolvedValue({
    deliveries: [delivery('initial')],
    has_more: false,
  })
  const usePolling = vi.fn((callback: PollCallback, intervalMs: number) => {
    tick = callback
    expect(intervalMs).toBe(POLL_FAST_MS)
    return { refresh, isLoading: pollingLoading, lastSuccessAt }
  })

  const scope = effectScope()
  const data = scope.run(() => useWebhookDetailData({
    webhookId: 'wh-1',
    getDeliveryParams: () => ({ ...deliveryParams }),
    isMutationRunning: () => mutationRunning,
    dependencies: {
      getWebhook: getWebhook as unknown as WebhookDetailDataDependencies['getWebhook'],
      listDeliveries: listDeliveries as unknown as WebhookDetailDataDependencies['listDeliveries'],
      usePolling: usePolling as unknown as WebhookDetailDataDependencies['usePolling'],
    },
  }))!

  return {
    data,
    getWebhook,
    listDeliveries,
    refresh,
    pollingLoading,
    lastSuccessAt,
    runTick: (signal = new AbortController().signal) => tick(signal),
    setParams: (params: Record<string, string>) => { deliveryParams = params },
    setMutationRunning: (running: boolean) => { mutationRunning = running },
    stop: () => scope.stop(),
  }
}

describe('useWebhookDetailData', () => {
  it('loads the subscription and initial delivery tuple with the poll signal', async () => {
    const harness = setup()
    const controller = new AbortController()

    await expect(harness.runTick(controller.signal)).resolves.toBe(true)

    expect(harness.getWebhook).toHaveBeenCalledWith('wh-1', controller.signal)
    expect(harness.listDeliveries).toHaveBeenCalledWith('wh-1', {}, controller.signal)
    expect(harness.data.webhook.value?.name).toBe('Webhook')
    expect(harness.data.deliveries.value.map(item => item.delivery_id)).toEqual(['initial'])
    expect(harness.data.initialLoadDone.value).toBe(true)
    expect(harness.data.resultsMatchAppliedFilter.value).toBe(true)
    harness.stop()
  })

  it('keeps ambient polling out while the operation owner is settling a write', async () => {
    const harness = setup()
    harness.setMutationRunning(true)

    await expect(harness.runTick()).resolves.toBe(POLLING_STALE)

    expect(harness.getWebhook).not.toHaveBeenCalled()
    expect(harness.listDeliveries).not.toHaveBeenCalled()
    harness.stop()
  })

  it('applies the newest overlapping filter and discards the stale page-one response', async () => {
    const harness = setup()
    await harness.runTick()
    const older = deferred<{ deliveries: WebhookDelivery[]; has_more: boolean }>()
    const newer = deferred<{ deliveries: WebhookDelivery[]; has_more: boolean; next_cursor: string }>()
    harness.listDeliveries
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)

    harness.setParams({ status: 'FAILED' })
    const olderLoad = harness.data.applyDeliveryParams()
    harness.setParams({ status: 'PENDING' })
    const newerLoad = harness.data.applyDeliveryParams()

    newer.resolve({ deliveries: [delivery('newer', 'PENDING')], has_more: true, next_cursor: 'new-cursor' })
    await expect(newerLoad).resolves.toBe(true)
    older.resolve({ deliveries: [delivery('older', 'FAILED')], has_more: false })
    await expect(olderLoad).resolves.toBe(POLLING_STALE)

    expect(harness.data.deliveries.value.map(item => item.delivery_id)).toEqual(['newer'])
    expect(harness.data.deliveriesNextCursor.value).toBe('new-cursor')
    expect(harness.data.error.value).toBe('')
    // Delivery-only filter work must not make the subscription's global
    // PageHeader freshness timestamp claim a full refresh occurred.
    expect(harness.lastSuccessAt.value).toBeNull()
    harness.stop()
  })

  it('queues the latest filter tuple past an in-flight poll instead of losing it to dedupe', async () => {
    const harness = setup()
    await harness.runTick()
    harness.listDeliveries.mockClear()
    harness.pollingLoading.value = true
    await nextTick()

    harness.setParams({ status: 'FAILED' })
    await expect(harness.data.applyDeliveryParams()).resolves.toBe(POLLING_STALE)
    harness.setParams({ status: 'RETRYING' })
    await expect(harness.data.applyDeliveryParams()).resolves.toBe(POLLING_STALE)
    expect(harness.listDeliveries).not.toHaveBeenCalled()

    harness.pollingLoading.value = false
    await nextTick()
    await Promise.resolve()

    expect(harness.listDeliveries).toHaveBeenCalledTimes(1)
    expect(harness.listDeliveries.mock.calls[0][1]).toEqual({ status: 'RETRYING' })
    expect(harness.data.resultsMatchAppliedFilter.value).toBe(true)
    harness.stop()
  })

  it('replays a queued filter after an older direct request and poll settle together', async () => {
    const harness = setup()
    await harness.runTick()
    const older = deferred<{ deliveries: WebhookDelivery[]; has_more: boolean }>()
    harness.listDeliveries
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce({ deliveries: [delivery('latest', 'RETRYING')], has_more: false })

    harness.setParams({ status: 'FAILED' })
    const olderLoad = harness.data.applyDeliveryParams()
    harness.pollingLoading.value = true
    await nextTick()
    harness.setParams({ status: 'RETRYING' })
    await expect(harness.data.applyDeliveryParams()).resolves.toBe(POLLING_STALE)

    // The polling edge occurs while the aborted direct controller still owns
    // cleanup, so its finally path must consume the pending latest tuple.
    harness.pollingLoading.value = false
    await nextTick()
    older.resolve({ deliveries: [delivery('stale', 'FAILED')], has_more: false })
    await expect(olderLoad).resolves.toBe(POLLING_STALE)
    await nextTick()
    await Promise.resolve()

    expect(harness.listDeliveries).toHaveBeenCalledTimes(3) // initial + old + latest
    expect(harness.listDeliveries).toHaveBeenLastCalledWith(
      'wh-1',
      { status: 'RETRYING' },
      expect.any(AbortSignal),
    )
    expect(harness.data.deliveries.value.map(item => item.delivery_id)).toEqual(['latest'])
    expect(harness.data.deliveryFilterLoading.value).toBe(false)
    harness.stop()
  })

  it('uses the applied tuple for Load more even when live controls change', async () => {
    const harness = setup()
    harness.setParams({ status: 'FAILED' })
    harness.listDeliveries.mockResolvedValueOnce({
      deliveries: [delivery('page-1', 'FAILED')],
      has_more: true,
      next_cursor: 'cursor-1',
    })
    await harness.runTick()
    harness.setParams({ status: 'SUCCESS' })
    harness.listDeliveries.mockResolvedValueOnce({
      deliveries: [delivery('page-2', 'FAILED')],
      has_more: false,
    })

    await expect(harness.data.loadMoreDeliveries()).resolves.toBe(true)

    expect(harness.listDeliveries).toHaveBeenLastCalledWith(
      'wh-1',
      { status: 'FAILED', cursor: 'cursor-1' },
      expect.any(AbortSignal),
    )
    expect(harness.data.deliveries.value.map(item => item.delivery_id)).toEqual(['page-1', 'page-2'])
    harness.stop()
  })

  it('discards an in-flight Load-more response after the filter epoch advances', async () => {
    const harness = setup()
    harness.listDeliveries.mockResolvedValueOnce({
      deliveries: [delivery('old-page-1')],
      has_more: true,
      next_cursor: 'old-cursor',
    })
    await harness.runTick()
    const pageTwo = deferred<{ deliveries: WebhookDelivery[]; has_more: boolean }>()
    harness.listDeliveries
      .mockImplementationOnce(() => pageTwo.promise)
      .mockResolvedValueOnce({ deliveries: [delivery('new-page-1', 'FAILED')], has_more: false })

    const loadMore = harness.data.loadMoreDeliveries()
    harness.setParams({ status: 'FAILED' })
    await expect(harness.data.applyDeliveryParams()).resolves.toBe(true)
    pageTwo.resolve({ deliveries: [delivery('stale-page-2')], has_more: false })

    await expect(loadMore).resolves.toBe(POLLING_STALE)
    expect(harness.data.deliveries.value.map(item => item.delivery_id)).toEqual(['new-page-1'])
    harness.stop()
  })

  it('merges a routine poll head into the loaded tail and preserves the tail cursor', async () => {
    const harness = setup()
    harness.listDeliveries
      .mockResolvedValueOnce({
        deliveries: [delivery('d3', 'PENDING'), delivery('d2')],
        has_more: true,
        next_cursor: 'cursor-page-2',
      })
      .mockResolvedValueOnce({
        deliveries: [delivery('d1')],
        has_more: true,
        next_cursor: 'cursor-page-3',
      })
      .mockResolvedValueOnce({
        deliveries: [delivery('d4'), delivery('d3', 'SUCCESS')],
        has_more: true,
        next_cursor: 'new-page-2-cursor',
      })

    await harness.runTick()
    await harness.data.loadMoreDeliveries()
    await harness.runTick()

    expect(harness.data.deliveries.value.map(item => `${item.delivery_id}:${item.status}`)).toEqual([
      'd4:SUCCESS',
      'd3:SUCCESS',
      'd2:SUCCESS',
      'd1:SUCCESS',
    ])
    expect(harness.data.deliveriesNextCursor.value).toBe('cursor-page-3')
    expect(harness.data.deliveriesHasMore.value).toBe(true)
    harness.stop()
  })

  it('re-anchors at page one when a burst leaves no safe overlap with the loaded tail', async () => {
    const harness = setup()
    harness.listDeliveries
      .mockResolvedValueOnce({
        deliveries: [delivery('old-2'), delivery('old-1')],
        has_more: true,
        next_cursor: 'old-page-2',
      })
      .mockResolvedValueOnce({
        deliveries: [delivery('old-tail')],
        has_more: true,
        next_cursor: 'old-page-3',
      })
      .mockResolvedValueOnce({
        deliveries: [delivery('new-4'), delivery('new-3')],
        has_more: true,
        next_cursor: 'new-page-2',
      })

    await harness.runTick()
    await harness.data.loadMoreDeliveries()
    await harness.runTick()

    expect(harness.data.deliveries.value.map(item => item.delivery_id)).toEqual(['new-4', 'new-3'])
    expect(harness.data.deliveriesNextCursor.value).toBe('new-page-2')
    expect(harness.data.deliveryContinuationUsable.value).toBe(true)
    harness.stop()
  })

  it('re-anchors when a mutable delivery would otherwise remain stale in the retained tail', async () => {
    const harness = setup()
    harness.listDeliveries
      .mockResolvedValueOnce({
        deliveries: [delivery('d4'), delivery('d3')],
        has_more: true,
        next_cursor: 'cursor-page-2',
      })
      .mockResolvedValueOnce({
        deliveries: [delivery('mutable-tail', 'RETRYING'), delivery('terminal-tail')],
        has_more: true,
        next_cursor: 'cursor-page-3',
      })
      .mockResolvedValueOnce({
        deliveries: [delivery('d5'), delivery('d4')],
        has_more: true,
        next_cursor: 'fresh-page-2',
      })

    await harness.runTick()
    await harness.data.loadMoreDeliveries()
    await harness.runTick()

    expect(harness.data.deliveries.value.map(item => item.delivery_id)).toEqual(['d5', 'd4'])
    expect(harness.data.deliveriesNextCursor.value).toBe('fresh-page-2')
    expect(harness.data.deliveriesHasMore.value).toBe(true)
    harness.stop()
  })

  it('binds export pages to one snapshot and rejects a mid-export filter change', async () => {
    const harness = setup()
    harness.setParams({ status: 'FAILED' })
    harness.listDeliveries.mockResolvedValueOnce({
      deliveries: [delivery('page-1', 'FAILED')],
      has_more: true,
      next_cursor: 'cursor-1',
    })
    await harness.runTick()
    const snapshot = harness.data.snapshotDeliveryQuery()
    const signal = new AbortController().signal
    harness.listDeliveries.mockResolvedValueOnce({ deliveries: [delivery('page-2', 'FAILED')], has_more: false })

    await expect(harness.data.fetchDeliveryPage(snapshot, 'cursor-1', signal)).resolves.toMatchObject({
      items: [expect.objectContaining({ delivery_id: 'page-2' })],
      hasMore: false,
    })
    expect(harness.listDeliveries).toHaveBeenLastCalledWith(
      'wh-1',
      { status: 'FAILED', cursor: 'cursor-1' },
      signal,
    )

    harness.setParams({ status: 'SUCCESS' })
    await harness.data.applyDeliveryParams()
    await expect(harness.data.fetchDeliveryPage(snapshot, 'cursor-2')).rejects.toThrow(
      'applied delivery filter changed',
    )
    harness.stop()
  })

  it('rejects an export page that resolves after its filter snapshot is superseded', async () => {
    const harness = setup()
    harness.listDeliveries.mockResolvedValueOnce({
      deliveries: [delivery('page-1')],
      has_more: true,
      next_cursor: 'cursor-1',
    })
    await harness.runTick()
    const snapshot = harness.data.snapshotDeliveryQuery()
    const oldExportPage = deferred<{ deliveries: WebhookDelivery[]; has_more: boolean }>()
    harness.listDeliveries
      .mockImplementationOnce(() => oldExportPage.promise)
      .mockResolvedValueOnce({ deliveries: [delivery('failed', 'FAILED')], has_more: false })

    const exportPage = harness.data.fetchDeliveryPage(snapshot, 'cursor-1')
    harness.setParams({ status: 'FAILED' })
    await harness.data.applyDeliveryParams()
    oldExportPage.resolve({ deliveries: [delivery('stale-export')], has_more: false })

    await expect(exportPage).rejects.toThrow('applied delivery filter changed')
    harness.stop()
  })

  it('blocks pagination and export when has_more omits its required cursor', async () => {
    const harness = setup()
    harness.listDeliveries.mockResolvedValueOnce({
      deliveries: [delivery('page-1')],
      has_more: true,
    })

    await expect(harness.runTick()).resolves.toBe(false)

    expect(harness.data.deliveryContinuationUsable.value).toBe(false)
    expect(harness.data.error.value).toContain('omitted the continuation cursor')
    await expect(harness.data.loadMoreDeliveries()).resolves.toBe(false)
    harness.stop()
  })

  it('rejects a malformed continuation page instead of silently truncating export', async () => {
    const harness = setup()
    harness.listDeliveries.mockResolvedValueOnce({
      deliveries: [delivery('page-1')],
      has_more: true,
      next_cursor: 'cursor-1',
    })
    await harness.runTick()
    const snapshot = harness.data.snapshotDeliveryQuery()
    harness.listDeliveries.mockResolvedValueOnce({
      deliveries: [delivery('page-2')],
      has_more: true,
    })

    await expect(harness.data.fetchDeliveryPage(snapshot, 'cursor-1')).rejects.toThrow(
      'omitted the continuation cursor',
    )
    harness.stop()
  })

  it('keeps the applied page and cursor when Load more fails', async () => {
    const harness = setup()
    harness.listDeliveries.mockResolvedValueOnce({
      deliveries: [delivery('page-1')],
      has_more: true,
      next_cursor: 'cursor-1',
    })
    await harness.runTick()
    harness.listDeliveries.mockRejectedValueOnce(new Error('delivery page unavailable'))

    await expect(harness.data.loadMoreDeliveries()).resolves.toBe(false)

    expect(harness.data.deliveries.value.map(item => item.delivery_id)).toEqual(['page-1'])
    expect(harness.data.deliveriesNextCursor.value).toBe('cursor-1')
    expect(harness.data.error.value).toBe('delivery page unavailable')
    expect(harness.data.deliveriesLoadingMore.value).toBe(false)
    harness.stop()
  })

  it('clears stale detail content when a later authoritative read returns 404', async () => {
    const harness = setup()
    await harness.runTick()
    harness.getWebhook.mockRejectedValueOnce(new ApiError(404, 'missing'))

    await expect(harness.runTick()).resolves.toBe(false)

    expect(harness.data.notFound.value).toBe(true)
    expect(harness.data.webhook.value).toBeNull()
    expect(harness.data.deliveries.value).toEqual([])
    expect(harness.data.initialLoadDone.value).toBe(true)
    expect(harness.data.error.value).toBe('')
    harness.stop()
  })

  it('keeps an authoritative 404 after an older delivery filter request resolves', async () => {
    const harness = setup()
    await harness.runTick()
    const stalePage = deferred<{ deliveries: WebhookDelivery[]; has_more: boolean }>()
    harness.listDeliveries.mockImplementationOnce(() => stalePage.promise)
    harness.setParams({ status: 'FAILED' })
    const applying = harness.data.applyDeliveryParams()

    harness.getWebhook.mockRejectedValueOnce(new ApiError(404, 'missing'))
    await expect(harness.runTick()).resolves.toBe(false)
    stalePage.resolve({ deliveries: [delivery('stale', 'FAILED')], has_more: false })
    await expect(applying).resolves.toBe(POLLING_STALE)

    expect(harness.data.notFound.value).toBe(true)
    expect(harness.data.webhook.value).toBeNull()
    expect(harness.data.deliveries.value).toEqual([])
    expect(harness.data.resultsMatchAppliedFilter.value).toBe(false)
    expect(harness.data.deliveryFilterLoading.value).toBe(false)
    harness.stop()
  })

  it('prevents a late poll read from overwriting an authoritative mutation response', async () => {
    const harness = setup()
    const oldRead = deferred<WebhookSubscription>()
    harness.getWebhook.mockImplementationOnce(() => oldRead.promise)
    const poll = harness.runTick()

    harness.data.publishWebhook(subscription('Mutation response'))
    oldRead.resolve(subscription('Stale poll'))

    await expect(poll).resolves.toBe(POLLING_STALE)
    expect(harness.data.webhook.value?.name).toBe('Mutation response')
    expect(harness.listDeliveries).not.toHaveBeenCalled()
    harness.stop()
  })

  it('invalidates an older poll read when a subscription mutation begins', async () => {
    const harness = setup()
    const oldRead = deferred<WebhookSubscription>()
    harness.getWebhook.mockImplementationOnce(() => oldRead.promise)
    const poll = harness.runTick()

    harness.data.beginSubscriptionMutation()
    oldRead.resolve(subscription('Stale poll'))

    await expect(poll).resolves.toBe(POLLING_STALE)
    expect(harness.data.webhook.value).toBeNull()
    expect(harness.listDeliveries).not.toHaveBeenCalled()
    harness.stop()
  })

  it('publishes a committed delete as terminal before an older poll can return', async () => {
    const harness = setup()
    await harness.runTick()
    const oldRead = deferred<WebhookSubscription>()
    harness.getWebhook.mockImplementationOnce(() => oldRead.promise)
    const poll = harness.runTick()

    harness.data.publishDeletedWebhook()
    oldRead.resolve(subscription('Stale poll'))

    await expect(poll).resolves.toBe(POLLING_STALE)
    expect(harness.data.notFound.value).toBe(true)
    expect(harness.data.webhook.value).toBeNull()
    expect(harness.data.deliveries.value).toEqual([])
    expect(harness.listDeliveries).toHaveBeenCalledOnce()
    harness.stop()
  })

  it('queues a manual refresh while a filter transition owns loading', async () => {
    const harness = setup()
    await harness.runTick()
    const page = deferred<{ deliveries: WebhookDelivery[]; has_more: boolean }>()
    harness.listDeliveries.mockImplementationOnce(() => page.promise)
    harness.setParams({ status: 'FAILED' })
    const applying = harness.data.applyDeliveryParams()

    harness.data.refreshAll()
    expect(harness.refresh).not.toHaveBeenCalled()
    page.resolve({ deliveries: [delivery('failed', 'FAILED')], has_more: false })
    await applying
    await nextTick()

    expect(harness.refresh).toHaveBeenCalledOnce()
    harness.stop()
  })

  it('owns external error reporting and delegates an idle manual refresh', () => {
    const harness = setup()

    harness.data.reportError('Export failed')
    expect(harness.data.error.value).toBe('Export failed')
    harness.data.dismissError()
    expect(harness.data.error.value).toBe('')

    harness.data.refreshAll()
    expect(harness.refresh).toHaveBeenCalledOnce()
    harness.stop()
  })
})

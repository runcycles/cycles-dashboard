import { effectScope, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import {
  useWebhookOperations,
  type WebhookOperationDependencies,
} from '../composables/useWebhookOperations'
import type { WebhookSubscription, WebhookTestResponse } from '../types'

function subscription(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    subscription_id: 'wh-1',
    tenant_id: 'acme',
    name: 'Payments hook',
    url: 'https://example.test/hook',
    event_types: ['budget.updated'],
    status: 'ACTIVE',
    created_at: '2026-07-20T00:00:00Z',
    ...overrides,
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

function setup(initial: WebhookSubscription | null = subscription()) {
  const webhook = ref<WebhookSubscription | null>(initial)
  const updateWebhook = vi.fn().mockResolvedValue(subscription({ status: 'PAUSED' }))
  const deleteWebhook = vi.fn().mockResolvedValue(undefined)
  const rotateWebhookSecret = vi.fn().mockResolvedValue({
    signing_secret: 'whsec_once',
    subscription: subscription({ updated_at: '2026-07-20T00:01:00Z' }),
  })
  const testWebhook = vi.fn().mockResolvedValue({
    success: true,
    response_status: 204,
  } satisfies WebhookTestResponse)
  const replayWebhookEvents = vi.fn().mockResolvedValue({ events_queued: 3 })
  const beginSubscriptionMutation = vi.fn()
  const publishWebhook = vi.fn((value: WebhookSubscription) => { webhook.value = value })
  const publishDeletedWebhook = vi.fn(() => { webhook.value = null })
  const reportError = vi.fn()
  const navigateToList = vi.fn().mockResolvedValue(undefined)
  const notify = { success: vi.fn(), warning: vi.fn(), error: vi.fn() }

  const scope = effectScope()
  const operations = scope.run(() => useWebhookOperations({
    webhookId: 'wh-1',
    webhook,
    beginSubscriptionMutation,
    publishWebhook,
    publishDeletedWebhook,
    reportError,
    navigateToList,
    notify,
    dependencies: {
      updateWebhook: updateWebhook as unknown as WebhookOperationDependencies['updateWebhook'],
      deleteWebhook: deleteWebhook as unknown as WebhookOperationDependencies['deleteWebhook'],
      rotateWebhookSecret: rotateWebhookSecret as unknown as WebhookOperationDependencies['rotateWebhookSecret'],
      testWebhook: testWebhook as unknown as WebhookOperationDependencies['testWebhook'],
      replayWebhookEvents: replayWebhookEvents as unknown as WebhookOperationDependencies['replayWebhookEvents'],
    },
  }))!

  return {
    operations,
    webhook,
    updateWebhook,
    deleteWebhook,
    rotateWebhookSecret,
    testWebhook,
    replayWebhookEvents,
    beginSubscriptionMutation,
    publishWebhook,
    publishDeletedWebhook,
    reportError,
    navigateToList,
    notify,
    stop: () => scope.stop(),
  }
}

describe('useWebhookOperations', () => {
  it('refuses to arm or run operations without a published subscription', async () => {
    const harness = setup(null)

    harness.operations.openDelete()
    harness.operations.openRotate()
    harness.operations.openReplay()
    harness.operations.requestStatusAction('PAUSED')
    await expect(harness.operations.runTest()).resolves.toBe(false)

    expect(harness.operations.hasPendingOperation.value).toBe(false)
    expect(harness.testWebhook).not.toHaveBeenCalled()
    harness.stop()
  })

  it('publishes the authoritative status PATCH response without a follow-up read', async () => {
    const harness = setup()
    const updated = subscription({ status: 'PAUSED', updated_at: '2026-07-20T00:02:00Z' })
    harness.updateWebhook.mockResolvedValueOnce(updated)

    harness.operations.requestStatusAction('PAUSED')
    await expect(harness.operations.executeStatusAction()).resolves.toBe(true)

    expect(harness.beginSubscriptionMutation).toHaveBeenCalledOnce()
    expect(harness.updateWebhook).toHaveBeenCalledWith('wh-1', { status: 'PAUSED' })
    expect(harness.publishWebhook).toHaveBeenCalledWith(updated)
    expect(harness.operations.pendingStatusAction.value).toBeNull()
    expect(harness.notify.success).toHaveBeenCalledWith('Webhook paused')
    harness.stop()
  })

  it('guards duplicate status submits and refuses cancellation while the write owns settlement', async () => {
    const harness = setup()
    const patch = deferred<WebhookSubscription>()
    harness.updateWebhook.mockImplementationOnce(() => patch.promise)
    harness.operations.requestStatusAction('PAUSED')

    const first = harness.operations.executeStatusAction()
    await expect(harness.operations.executeStatusAction()).resolves.toBe(false)
    harness.operations.cancelStatusAction()

    expect(harness.updateWebhook).toHaveBeenCalledOnce()
    expect(harness.operations.statusActionLoading.value).toBe(true)
    expect(harness.operations.pendingStatusAction.value).toBe('PAUSED')
    patch.resolve(subscription({ status: 'PAUSED' }))
    await expect(first).resolves.toBe(true)
    harness.stop()
  })

  it('keeps a failed status action armed with an inline error for retry', async () => {
    const harness = setup()
    harness.updateWebhook.mockRejectedValueOnce(new Error('status endpoint unavailable'))
    harness.operations.requestStatusAction('PAUSED')

    await expect(harness.operations.executeStatusAction()).resolves.toBe(false)

    expect(harness.operations.pendingStatusAction.value).toBe('PAUSED')
    expect(harness.operations.statusActionError.value).toBe('status endpoint unavailable')
    expect(harness.notify.error).toHaveBeenCalledWith(
      'Status change failed: status endpoint unavailable',
    )
    expect(harness.operations.statusActionLoading.value).toBe(false)
    harness.stop()
  })

  it('maps reset and re-enable to an authoritative ACTIVE status PATCH', async () => {
    const harness = setup(subscription({ status: 'DISABLED', consecutive_failures: 4 }))
    const updated = subscription({ status: 'ACTIVE', consecutive_failures: 0 })
    harness.updateWebhook.mockResolvedValueOnce(updated)
    harness.operations.requestStatusAction('reset')

    await expect(harness.operations.executeStatusAction()).resolves.toBe(true)

    expect(harness.updateWebhook).toHaveBeenCalledWith('wh-1', { status: 'ACTIVE' })
    expect(harness.publishWebhook).toHaveBeenCalledWith(updated)
    expect(harness.notify.success).toHaveBeenCalledWith('Webhook re-enabled')
    harness.stop()
  })

  it('enforces legal status transitions and one armed operation at a time', () => {
    const harness = setup(subscription({ status: 'ACTIVE', consecutive_failures: 2 }))

    harness.operations.requestStatusAction('ACTIVE')
    expect(harness.operations.pendingStatusAction.value).toBeNull()
    harness.operations.requestStatusAction('reset')
    expect(harness.operations.pendingStatusAction.value).toBeNull()
    harness.operations.requestStatusAction('PAUSED')
    harness.operations.openRotate()

    expect(harness.operations.pendingStatusAction.value).toBe('PAUSED')
    expect(harness.operations.pendingRotate.value).toBe(false)
    harness.operations.cancelStatusAction()
    expect(harness.operations.pendingStatusAction.value).toBeNull()
    harness.stop()
  })

  it('refuses a status action that became stale while its confirmation was open', async () => {
    const harness = setup(subscription({ status: 'ACTIVE' }))
    harness.operations.requestStatusAction('PAUSED')
    harness.webhook.value = subscription({ status: 'DISABLED' })

    await expect(harness.operations.executeStatusAction()).resolves.toBe(false)

    expect(harness.updateWebhook).not.toHaveBeenCalled()
    expect(harness.beginSubscriptionMutation).not.toHaveBeenCalled()
    expect(harness.operations.pendingStatusAction.value).toBeNull()
    expect(harness.notify.warning).toHaveBeenCalledWith(
      'Webhook status changed while confirmation was open. Review the current status before trying again.',
    )
    harness.stop()
  })

  it('deletes once, blocks mid-request cancel, and navigates only after commit', async () => {
    const harness = setup()
    const removing = deferred<void>()
    harness.deleteWebhook.mockImplementationOnce(() => removing.promise)
    harness.operations.openDelete()

    const first = harness.operations.executeDelete()
    await expect(harness.operations.executeDelete()).resolves.toBe(false)
    harness.operations.cancelDelete()
    expect(harness.operations.pendingDelete.value).toBe(true)
    expect(harness.navigateToList).not.toHaveBeenCalled()

    removing.resolve()
    await expect(first).resolves.toBe(true)
    expect(harness.deleteWebhook).toHaveBeenCalledOnce()
    expect(harness.beginSubscriptionMutation).toHaveBeenCalledOnce()
    expect(harness.publishDeletedWebhook).toHaveBeenCalledOnce()
    expect(harness.webhook.value).toBeNull()
    expect(harness.notify.success).toHaveBeenCalledWith('Webhook deleted')
    expect(harness.navigateToList).toHaveBeenCalledOnce()
    harness.stop()
  })

  it('keeps delete failures in their dialog and allows an idle cancel', async () => {
    const harness = setup()
    harness.deleteWebhook.mockRejectedValueOnce(new Error('delete denied'))
    harness.operations.openDelete()

    await expect(harness.operations.executeDelete()).resolves.toBe(false)

    expect(harness.operations.pendingDelete.value).toBe(true)
    expect(harness.operations.deleteError.value).toBe('delete denied')
    expect(harness.navigateToList).not.toHaveBeenCalled()
    harness.operations.cancelDelete()
    expect(harness.operations.pendingDelete.value).toBe(false)
    expect(harness.operations.deleteError.value).toBe('')
    harness.stop()
  })

  it('keeps a committed delete terminal when navigation fails afterward', async () => {
    const harness = setup()
    harness.navigateToList.mockRejectedValueOnce(new Error('router unavailable'))
    harness.operations.openDelete()

    await expect(harness.operations.executeDelete()).resolves.toBe(true)

    expect(harness.operations.pendingDelete.value).toBe(false)
    expect(harness.operations.deleteError.value).toBe('')
    expect(harness.publishDeletedWebhook).toHaveBeenCalledOnce()
    expect(harness.webhook.value).toBeNull()
    expect(harness.reportError).toHaveBeenCalledWith(
      'Webhook deleted, but navigation failed: router unavailable',
    )
    expect(harness.notify.warning).toHaveBeenCalledWith(
      'Webhook deleted, but navigation failed: router unavailable',
    )
    harness.stop()
  })

  it('publishes secret rotation and owns the one-time reveal lifecycle', async () => {
    const harness = setup()
    const rotated = subscription({ updated_at: '2026-07-20T00:03:00Z' })
    harness.rotateWebhookSecret.mockResolvedValueOnce({
      signing_secret: 'whsec_new',
      subscription: rotated,
    })
    harness.operations.openRotate()

    await expect(harness.operations.executeRotate()).resolves.toBe(true)

    expect(harness.publishWebhook).toHaveBeenCalledWith(rotated)
    expect(harness.operations.rotatedSecret.value).toBe('whsec_new')
    expect(harness.operations.pendingRotate.value).toBe(false)
    harness.operations.closeRotatedSecret()
    expect(harness.operations.rotatedSecret.value).toBeNull()
    harness.stop()
  })

  it('keeps rotation failures armed with context and permits cancel after settlement', async () => {
    const harness = setup()
    harness.rotateWebhookSecret.mockRejectedValueOnce(new Error('rotation denied'))
    harness.operations.openRotate()

    await expect(harness.operations.executeRotate()).resolves.toBe(false)

    expect(harness.operations.pendingRotate.value).toBe(true)
    expect(harness.operations.rotateError.value).toBe('rotation denied')
    expect(harness.notify.error).toHaveBeenCalledWith('Rotate secret failed: rotation denied')
    harness.operations.cancelRotate()
    expect(harness.operations.pendingRotate.value).toBe(false)
    expect(harness.operations.rotateError.value).toBe('')
    harness.stop()
  })

  it('publishes a successful endpoint test result', async () => {
    const harness = setup()

    await expect(harness.operations.runTest()).resolves.toBe(true)

    expect(harness.testWebhook).toHaveBeenCalledWith('wh-1')
    expect(harness.operations.testResult.value).toEqual({ success: true, response_status: 204 })
    expect(harness.operations.testLoading.value).toBe(false)
    harness.stop()
  })

  it('guards duplicate tests and reports a readable failure through the page owner', async () => {
    const harness = setup()
    const request = deferred<WebhookTestResponse>()
    harness.testWebhook.mockImplementationOnce(() => request.promise)

    const first = harness.operations.runTest()
    await expect(harness.operations.runTest()).resolves.toBe(false)
    expect(harness.testWebhook).toHaveBeenCalledOnce()
    request.reject(new Error('test endpoint unreachable'))
    await expect(first).resolves.toBe(false)

    expect(harness.reportError).toHaveBeenCalledWith('test endpoint unreachable')
    expect(harness.notify.error).toHaveBeenCalledWith('Test failed: test endpoint unreachable')
    expect(harness.operations.testResult.value).toBeNull()
    harness.stop()
  })

  it('validates replay ranges and numeric limits before sending', async () => {
    const harness = setup()
    harness.operations.openReplay()
    harness.operations.replayForm.value.from = '2026-07-20T12:00'
    harness.operations.replayForm.value.to = '2026-07-20T11:00'

    await expect(harness.operations.submitReplay()).resolves.toBe(false)
    expect(harness.operations.replayError.value).toBe('"From" must be before "To"')
    expect(harness.replayWebhookEvents).not.toHaveBeenCalled()

    harness.operations.replayForm.value.from = 'not-a-date'
    harness.operations.replayForm.value.to = ''
    await expect(harness.operations.submitReplay()).resolves.toBe(false)
    expect(harness.operations.replayError.value).toBe('"From" must be a valid date and time')

    harness.operations.replayForm.value.from = ''
    harness.operations.replayForm.value.to = 'not-a-date'
    await expect(harness.operations.submitReplay()).resolves.toBe(false)
    expect(harness.operations.replayError.value).toBe('"To" must be a valid date and time')

    harness.operations.replayForm.value.to = ''
    harness.operations.replayForm.value.max_events = 0
    expect(harness.operations.replayMaxEventsError.value).toBe('Must be a positive number')
    await expect(harness.operations.submitReplay()).resolves.toBe(false)
    expect(harness.replayWebhookEvents).not.toHaveBeenCalled()
    harness.stop()
  })

  it('keeps replay failures in context and permits cancel after settlement', async () => {
    const harness = setup()
    harness.replayWebhookEvents.mockRejectedValueOnce(new Error('replay unavailable'))
    harness.operations.openReplay()

    await expect(harness.operations.submitReplay()).resolves.toBe(false)

    expect(harness.operations.showReplay.value).toBe(true)
    expect(harness.operations.replayError.value).toBe('replay unavailable')
    harness.operations.cancelReplay()
    expect(harness.operations.showReplay.value).toBe(false)
    expect(harness.operations.replayError.value).toBe('')
    harness.stop()
  })

  it('snapshots a valid replay request, guards duplicates, and retains its result until dismissed', async () => {
    const harness = setup()
    const request = deferred<{ events_queued: number }>()
    harness.replayWebhookEvents.mockImplementationOnce(() => request.promise)
    harness.operations.openReplay()
    harness.operations.replayForm.value.from = '2026-07-20T10:00'
    harness.operations.replayForm.value.to = '2026-07-20T11:00'
    harness.operations.replayForm.value.max_events = 25

    const first = harness.operations.submitReplay()
    await expect(harness.operations.submitReplay()).resolves.toBe(false)
    harness.operations.cancelReplay()
    expect(harness.operations.showReplay.value).toBe(true)
    expect(harness.replayWebhookEvents).toHaveBeenCalledWith('wh-1', {
      from: new Date('2026-07-20T10:00').toISOString(),
      to: new Date('2026-07-20T11:00').toISOString(),
      max_events: 25,
    })

    request.resolve({ events_queued: 7 })
    await expect(first).resolves.toBe(true)
    expect(harness.operations.showReplay.value).toBe(false)
    expect(harness.operations.replayResult.value).toBe('7 events queued for replay')
    harness.operations.dismissReplayResult()
    expect(harness.operations.replayResult.value).toBeNull()
    harness.stop()
  })
})

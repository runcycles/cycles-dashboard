import { effectScope, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import {
  useWebhookEditor,
  type WebhookEditorDependencies,
} from '../composables/useWebhookEditor'
import type { WebhookSubscription } from '../types'

function subscription(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    subscription_id: 'wh-1',
    tenant_id: 'acme',
    name: 'Payments hook',
    description: 'Payment lifecycle events',
    url: 'https://example.test/hook',
    event_types: ['budget.updated'],
    event_categories: ['budget'],
    scope_filter: 'tenant:acme/*',
    disable_after_failures: 10,
    metadata: { team: 'payments' },
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

function setup(
  initial: WebhookSubscription | null = subscription(),
  canOpen: () => boolean = () => true,
) {
  const webhook = ref<WebhookSubscription | null>(initial)
  const updateWebhook = vi.fn().mockResolvedValue(subscription({ name: 'Updated hook' }))
  const beginSubscriptionMutation = vi.fn()
  const publishWebhook = vi.fn((value: WebhookSubscription) => { webhook.value = value })
  const notifySuccess = vi.fn()
  const scope = effectScope()
  const editor = scope.run(() => useWebhookEditor({
    webhookId: 'wh-1',
    webhook,
    canOpen,
    beginSubscriptionMutation,
    publishWebhook,
    notifySuccess,
    dependencies: {
      updateWebhook: updateWebhook as unknown as WebhookEditorDependencies['updateWebhook'],
    },
  }))!

  return {
    editor,
    webhook,
    updateWebhook,
    beginSubscriptionMutation,
    publishWebhook,
    notifySuccess,
    stop: () => scope.stop(),
  }
}

describe('useWebhookEditor', () => {
  it('refuses to arm without a row or while a sibling owner blocks arming', () => {
    const noRow = setup(null)
    const blocked = setup(subscription(), () => false)

    expect(noRow.editor.openEdit()).toBe(false)
    expect(blocked.editor.openEdit()).toBe(false)
    expect(noRow.editor.showEdit.value).toBe(false)
    expect(blocked.editor.showEdit.value).toBe(false)
    noRow.stop()
    blocked.stop()
  })

  it('opens from independent form and advanced snapshots', () => {
    const harness = setup(subscription({
      tenant_id: '__system__',
      thresholds: { budget_utilization: [0.8, 0.95] },
      retry_policy: { max_retries: 7 },
    }))

    expect(harness.editor.openEdit()).toBe(true)
    expect(harness.editor.openEdit()).toBe(false)
    expect(harness.editor.showEdit.value).toBe(true)
    expect(harness.editor.isTenantOwned.value).toBe(false)
    expect(harness.editor.editEventTypes.value).toContain('api_key.created')
    expect(harness.editor.editEventCategories.value).toContain('system')
    expect(harness.editor.editAdvanced.value.budget_utilization).toBe('0.8, 0.95')
    expect(harness.editor.editAdvanced.value.max_retries).toBe('7')
    expect(harness.editor.editAdvancedHasConfig.value).toBe(true)

    harness.editor.editForm.value.name = 'Changed locally'
    harness.editor.editAdvanced.value.max_retries = '8'
    expect(harness.webhook.value?.name).toBe('Payments hook')
    expect(harness.webhook.value?.retry_policy?.max_retries).toBe(7)
    harness.stop()
  })

  it('sends an exact diff and publishes the authoritative PATCH response directly', async () => {
    const harness = setup()
    const updated = subscription({
      name: 'Updated hook',
      description: undefined,
      scope_filter: undefined,
      disable_after_failures: 12,
      metadata: { team: 'platform' },
      updated_at: '2026-07-20T01:00:00Z',
    })
    harness.updateWebhook.mockResolvedValueOnce(updated)
    harness.editor.openEdit()
    harness.editor.editForm.value.name = 'Updated hook'
    harness.editor.editForm.value.description = ''
    harness.editor.editForm.value.scope_filter = ''
    harness.editor.editForm.value.disable_after_failures = '12'
    harness.editor.editForm.value.metadata = '{"team":"platform"}'

    await expect(harness.editor.submitEdit()).resolves.toBe(true)

    expect(harness.beginSubscriptionMutation).toHaveBeenCalledOnce()
    expect(harness.updateWebhook).toHaveBeenCalledWith('wh-1', {
      name: 'Updated hook',
      description: '',
      scope_filter: '',
      disable_after_failures: 12,
      metadata: { team: 'platform' },
    })
    expect(harness.publishWebhook).toHaveBeenCalledWith(updated)
    expect(harness.webhook.value).toEqual(updated)
    expect(harness.editor.showEdit.value).toBe(false)
    expect(harness.notifySuccess).toHaveBeenCalledWith('Webhook updated')
    harness.stop()
  })

  it('reports no changes without starting mutation settlement', async () => {
    const harness = setup()
    harness.editor.openEdit()

    await expect(harness.editor.submitEdit()).resolves.toBe(false)

    expect(harness.editor.editError.value).toBe('No changes to save')
    expect(harness.beginSubscriptionMutation).not.toHaveBeenCalled()
    expect(harness.updateWebhook).not.toHaveBeenCalled()
    harness.stop()
  })

  it('strips legacy tenant selectors without a phantom diff on rename', async () => {
    const harness = setup(subscription({
      event_types: ['api_key.created'],
      event_categories: ['system'],
    }))
    harness.editor.openEdit()

    expect(harness.editor.hiddenLegacySelectorCount.value).toBe(2)
    expect(harness.editor.editForm.value.event_types).toEqual([])
    expect(harness.editor.editForm.value.event_categories).toEqual([])
    expect(harness.editor.editEventTypes.value).not.toContain('api_key.created')
    harness.editor.editForm.value.name = 'Renamed only'
    await harness.editor.submitEdit()

    expect(harness.updateWebhook).toHaveBeenCalledWith('wh-1', { name: 'Renamed only' })
    harness.stop()
  })

  it('sends both cleaned selector arrays when a legacy row is deliberately edited', async () => {
    const harness = setup(subscription({
      event_types: ['api_key.created'],
      event_categories: ['budget', 'system'],
    }))
    harness.editor.openEdit()
    harness.editor.editForm.value.event_categories.push('tenant')

    await expect(harness.editor.submitEdit()).resolves.toBe(true)

    expect(harness.updateWebhook).toHaveBeenCalledWith('wh-1', {
      event_types: [],
      event_categories: ['budget', 'tenant'],
    })
    harness.stop()
  })

  it('rejects a deliberate both-empty selector result', async () => {
    const harness = setup(subscription({ event_categories: [] }))
    harness.editor.openEdit()
    harness.editor.editForm.value.event_types = []

    await expect(harness.editor.submitEdit()).resolves.toBe(false)

    expect(harness.editor.editError.value).toBe('Select at least one event type or category.')
    expect(harness.updateWebhook).not.toHaveBeenCalled()
    harness.stop()
  })

  it('validates metadata as a JSON object and supports an explicit clear', async () => {
    const harness = setup()
    harness.editor.openEdit()
    harness.editor.editForm.value.metadata = '["not", "an", "object"]'

    await expect(harness.editor.submitEdit()).resolves.toBe(false)
    expect(harness.editor.editMetadataError.value).toBe('Metadata must be a JSON object')
    harness.editor.editForm.value.metadata = '{broken'
    await expect(harness.editor.submitEdit()).resolves.toBe(false)
    expect(harness.editor.editMetadataError.value).toBe('Invalid JSON')
    harness.editor.editForm.value.metadata = ''
    harness.editor.editForm.value.name = ''
    await expect(harness.editor.submitEdit()).resolves.toBe(true)
    expect(harness.updateWebhook).toHaveBeenCalledWith('wh-1', { name: '', metadata: {} })
    harness.stop()
  })

  it('validates and serializes changed threshold and retry fields', async () => {
    const harness = setup()
    harness.editor.openEdit()
    harness.editor.editAdvanced.value.budget_utilization = '0.8, nope'

    await expect(harness.editor.submitEdit()).resolves.toBe(false)
    expect(harness.editor.editError.value).toBe('Budget utilization "nope" is not a number.')
    harness.editor.editAdvanced.value.budget_utilization = '0.8, 0.95'
    harness.editor.editAdvanced.value.max_retries = '4'
    await expect(harness.editor.submitEdit()).resolves.toBe(true)
    expect(harness.updateWebhook).toHaveBeenCalledWith('wh-1', {
      thresholds: { budget_utilization: [0.8, 0.95] },
      retry_policy: { max_retries: 4 },
    })
    harness.stop()
  })

  it('guards duplicate submit and cancellation while the PATCH is pending', async () => {
    const harness = setup()
    const patch = deferred<WebhookSubscription>()
    harness.updateWebhook.mockImplementationOnce(() => patch.promise)
    harness.editor.openEdit()
    harness.editor.editForm.value.url = 'https://new.example.test/hook'

    const first = harness.editor.submitEdit()
    await expect(harness.editor.submitEdit()).resolves.toBe(false)
    expect(harness.editor.cancelEdit()).toBe(false)
    expect(harness.updateWebhook).toHaveBeenCalledOnce()
    expect(harness.editor.editLoading.value).toBe(true)
    expect(harness.editor.showEdit.value).toBe(true)

    patch.resolve(subscription({ url: 'https://new.example.test/hook' }))
    await expect(first).resolves.toBe(true)
    expect(harness.editor.editLoading.value).toBe(false)
    harness.stop()
  })

  it('keeps the dialog armed with an inline error after a failed PATCH', async () => {
    const harness = setup()
    harness.updateWebhook.mockRejectedValueOnce(new Error('edit endpoint unavailable'))
    harness.editor.openEdit()
    harness.editor.editForm.value.url = 'https://new.example.test/hook'

    await expect(harness.editor.submitEdit()).resolves.toBe(false)

    expect(harness.editor.showEdit.value).toBe(true)
    expect(harness.editor.editLoading.value).toBe(false)
    expect(harness.editor.editError.value).toBe('edit endpoint unavailable')
    expect(harness.publishWebhook).not.toHaveBeenCalled()
    expect(harness.notifySuccess).not.toHaveBeenCalled()
    expect(harness.editor.cancelEdit()).toBe(true)
    harness.stop()
  })
})

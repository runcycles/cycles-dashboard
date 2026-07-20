import { computed, readonly, ref, type Ref } from 'vue'
import {
  deleteWebhook as deleteWebhookDefault,
  replayWebhookEvents as replayWebhookEventsDefault,
  rotateWebhookSecret as rotateWebhookSecretDefault,
  testWebhook as testWebhookDefault,
  updateWebhook as updateWebhookDefault,
} from '../api/client'
import type {
  ReplayEventsRequest,
  WebhookSubscription,
  WebhookTestResponse,
} from '../types'
import { toMessage } from '../utils/errors'

export type WebhookStatusAction = 'ACTIVE' | 'PAUSED' | 'reset'

export interface WebhookReplayForm {
  from: string
  to: string
  max_events: string | number
}

export interface WebhookOperationNotifications {
  success: (message: string) => void
  warning: (message: string) => void
  error: (message: string) => void
}

export interface WebhookOperationDependencies {
  updateWebhook: typeof updateWebhookDefault
  deleteWebhook: typeof deleteWebhookDefault
  rotateWebhookSecret: typeof rotateWebhookSecretDefault
  testWebhook: typeof testWebhookDefault
  replayWebhookEvents: typeof replayWebhookEventsDefault
}

export interface UseWebhookOperationsOptions {
  webhookId: string
  webhook: Readonly<Ref<WebhookSubscription | null>>
  /** Invalidates a poll read before a subscription mutation starts. */
  beginSubscriptionMutation: () => void
  publishWebhook: (webhook: WebhookSubscription) => void
  reportError: (message: string) => void
  navigateToList: () => void | Promise<void>
  notify: WebhookOperationNotifications
  dependencies?: Partial<WebhookOperationDependencies>
}

const defaultDependencies: WebhookOperationDependencies = {
  updateWebhook: updateWebhookDefault,
  deleteWebhook: deleteWebhookDefault,
  rotateWebhookSecret: rotateWebhookSecretDefault,
  testWebhook: testWebhookDefault,
  replayWebhookEvents: replayWebhookEventsDefault,
}

const STATUS_SUCCESS: Record<WebhookStatusAction, string> = {
  ACTIVE: 'Webhook enabled',
  PAUSED: 'Webhook paused',
  reset: 'Webhook re-enabled',
}

function isStatusActionLegal(
  webhook: WebhookSubscription,
  action: WebhookStatusAction,
): boolean {
  if (action === 'PAUSED') return webhook.status === 'ACTIVE'
  if (action === 'ACTIVE') {
    return webhook.status === 'PAUSED' || webhook.status === 'DISABLED'
  }
  return (webhook.consecutive_failures ?? 0) > 0 && webhook.status !== 'ACTIVE'
}

/**
 * Owns Webhook Detail's non-editor operation protocol.
 *
 * The view retains route intent, charts, delivery acquisition, and the
 * security-sensitive edit form. This owner provides one dialog/request gate,
 * duplicate-submit protection, direct publication of authoritative PATCH
 * responses, one-time secret reveal, and replay/test settlement.
 */
export function useWebhookOperations(options: UseWebhookOperationsOptions) {
  const deps: WebhookOperationDependencies = {
    ...defaultDependencies,
    ...options.dependencies,
  }

  const pendingStatusActionState = ref<WebhookStatusAction | null>(null)
  const pendingStatusAction = computed(() => pendingStatusActionState.value)
  const statusActionLoading = ref(false)
  const statusActionError = ref('')

  const pendingDeleteState = ref(false)
  const pendingDelete = computed(() => pendingDeleteState.value)
  const deleteLoading = ref(false)
  const deleteError = ref('')

  const pendingRotateState = ref(false)
  const pendingRotate = computed(() => pendingRotateState.value)
  const rotateLoading = ref(false)
  const rotateError = ref('')
  const rotatedSecretState = ref<string | null>(null)
  const rotatedSecret = computed(() => rotatedSecretState.value)

  const testResultState = ref<WebhookTestResponse | null>(null)
  const testResult = computed(() => testResultState.value)
  const testLoading = ref(false)

  const showReplayState = ref(false)
  const showReplay = computed(() => showReplayState.value)
  const replayLoading = ref(false)
  const replayError = ref('')
  const replayForm = ref<WebhookReplayForm>({ from: '', to: '', max_events: '100' })
  const replayResultState = ref<string | null>(null)
  const replayResult = computed(() => replayResultState.value)

  const isMutationRunning = computed(() => (
    statusActionLoading.value
    || deleteLoading.value
    || rotateLoading.value
    || testLoading.value
    || replayLoading.value
  ))

  const hasPendingOperation = computed(() => (
    pendingStatusActionState.value !== null
    || pendingDeleteState.value
    || pendingRotateState.value
    || showReplayState.value
  ))

  function canArmOperation(): boolean {
    return !!options.webhook.value
      && !isMutationRunning.value
      && !hasPendingOperation.value
  }

  function requestStatusAction(action: WebhookStatusAction): void {
    if (!canArmOperation()) return
    const webhook = options.webhook.value
    if (!webhook) return
    if (!isStatusActionLegal(webhook, action)) return
    statusActionError.value = ''
    pendingStatusActionState.value = action
  }

  function cancelStatusAction(): void {
    if (statusActionLoading.value) return
    pendingStatusActionState.value = null
    statusActionError.value = ''
  }

  async function executeStatusAction(): Promise<boolean> {
    const action = pendingStatusActionState.value
    // Keep the guard before visible state mutation so a direct/re-entrant call
    // cannot clear the first request's inline error or send another PATCH.
    if (!action || statusActionLoading.value) return false
    const webhook = options.webhook.value
    // Polling remains active while the operator reads the confirmation. Check
    // the newly published row again so an external transition cannot turn a
    // formerly legal confirmation into a stale PATCH.
    if (!webhook || !isStatusActionLegal(webhook, action)) {
      pendingStatusActionState.value = null
      statusActionError.value = ''
      options.notify.warning(
        webhook
          ? 'Webhook status changed while confirmation was open. Review the current status before trying again.'
          : 'Webhook is no longer available. Refresh before trying again.',
      )
      return false
    }
    statusActionError.value = ''
    statusActionLoading.value = true
    options.beginSubscriptionMutation()
    try {
      const updated = await deps.updateWebhook(
        options.webhookId,
        // Per the webhook lifecycle contract, transitioning a disabled row to
        // ACTIVE also resets consecutive_failures; there is no separate wire
        // action named "reset".
        { status: action === 'reset' ? 'ACTIVE' : action },
      )
      options.publishWebhook(updated)
      pendingStatusActionState.value = null
      options.notify.success(STATUS_SUCCESS[action])
      return true
    } catch (cause) {
      const message = toMessage(cause)
      statusActionError.value = message
      options.notify.error(`Status change failed: ${message}`)
      return false
    } finally {
      statusActionLoading.value = false
    }
  }

  function openDelete(): void {
    if (!canArmOperation()) return
    deleteError.value = ''
    pendingDeleteState.value = true
  }

  function cancelDelete(): void {
    if (deleteLoading.value) return
    pendingDeleteState.value = false
    deleteError.value = ''
  }

  async function executeDelete(): Promise<boolean> {
    if (!pendingDeleteState.value || deleteLoading.value) return false
    deleteError.value = ''
    deleteLoading.value = true
    options.beginSubscriptionMutation()
    try {
      try {
        await deps.deleteWebhook(options.webhookId)
      } catch (cause) {
        const message = toMessage(cause)
        deleteError.value = message
        options.notify.error(`Delete failed: ${message}`)
        return false
      }
      pendingDeleteState.value = false
      options.notify.success('Webhook deleted')
      try {
        await options.navigateToList()
      } catch (cause) {
        const message = `Webhook deleted, but navigation failed: ${toMessage(cause)}`
        options.reportError(message)
        options.notify.warning(message)
      }
      return true
    } finally {
      deleteLoading.value = false
    }
  }

  function openRotate(): void {
    if (!canArmOperation()) return
    rotateError.value = ''
    pendingRotateState.value = true
  }

  function cancelRotate(): void {
    if (rotateLoading.value) return
    pendingRotateState.value = false
    rotateError.value = ''
  }

  async function executeRotate(): Promise<boolean> {
    if (!pendingRotateState.value || rotateLoading.value) return false
    rotateError.value = ''
    rotateLoading.value = true
    options.beginSubscriptionMutation()
    try {
      const { signing_secret, subscription } = await deps.rotateWebhookSecret(options.webhookId)
      rotatedSecretState.value = signing_secret
      options.publishWebhook(subscription)
      pendingRotateState.value = false
      options.notify.success('Signing secret rotated — copy it now, it will not be shown again')
      return true
    } catch (cause) {
      const message = toMessage(cause)
      rotateError.value = message
      options.notify.error(`Rotate secret failed: ${message}`)
      return false
    } finally {
      rotateLoading.value = false
    }
  }

  function closeRotatedSecret(): void {
    rotatedSecretState.value = null
  }

  async function runTest(): Promise<boolean> {
    if (!options.webhook.value || isMutationRunning.value || hasPendingOperation.value) return false
    testLoading.value = true
    testResultState.value = null
    try {
      testResultState.value = await deps.testWebhook(options.webhookId)
      return true
    } catch (cause) {
      const message = toMessage(cause)
      options.reportError(message)
      options.notify.error(`Test failed: ${message}`)
      return false
    } finally {
      testLoading.value = false
    }
  }

  const replayMaxEventsError = computed<string>(() => {
    const raw = replayForm.value.max_events
    if (raw === '' || raw === null || raw === undefined) return ''
    const count = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(count) || count <= 0) return 'Must be a positive number'
    if (count > 1000) return 'Must be 1000 or fewer'
    return ''
  })
  const canSubmitReplay = computed(() => !replayMaxEventsError.value)

  function openReplay(): void {
    if (!canArmOperation()) return
    replayError.value = ''
    showReplayState.value = true
  }

  function cancelReplay(): void {
    if (replayLoading.value) return
    showReplayState.value = false
    replayError.value = ''
  }

  async function submitReplay(): Promise<boolean> {
    if (!showReplayState.value || replayLoading.value) return false
    replayError.value = ''

    const fromDate = replayForm.value.from ? new Date(replayForm.value.from) : null
    const toDate = replayForm.value.to ? new Date(replayForm.value.to) : null
    if (fromDate && Number.isNaN(fromDate.getTime())) {
      replayError.value = '"From" must be a valid date and time'
      return false
    }
    if (toDate && Number.isNaN(toDate.getTime())) {
      replayError.value = '"To" must be a valid date and time'
      return false
    }
    if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
      replayError.value = '"From" must be before "To"'
      return false
    }
    if (!canSubmitReplay.value) {
      replayError.value = replayMaxEventsError.value || 'Invalid input'
      return false
    }

    const body: ReplayEventsRequest = {}
    if (fromDate) body.from = fromDate.toISOString()
    if (toDate) body.to = toDate.toISOString()
    if (replayForm.value.max_events !== '') {
      body.max_events = Number(replayForm.value.max_events)
    }

    replayLoading.value = true
    try {
      const result = await deps.replayWebhookEvents(options.webhookId, body)
      replayResultState.value = `${result.events_queued} events queued for replay`
      showReplayState.value = false
      return true
    } catch (cause) {
      replayError.value = toMessage(cause)
      return false
    } finally {
      replayLoading.value = false
    }
  }

  function dismissReplayResult(): void {
    replayResultState.value = null
  }

  return {
    pendingStatusAction,
    statusActionLoading: readonly(statusActionLoading),
    statusActionError: readonly(statusActionError),
    requestStatusAction,
    cancelStatusAction,
    executeStatusAction,
    pendingDelete,
    deleteLoading: readonly(deleteLoading),
    deleteError: readonly(deleteError),
    openDelete,
    cancelDelete,
    executeDelete,
    pendingRotate,
    rotateLoading: readonly(rotateLoading),
    rotateError: readonly(rotateError),
    rotatedSecret,
    openRotate,
    cancelRotate,
    executeRotate,
    closeRotatedSecret,
    testResult,
    testLoading: readonly(testLoading),
    runTest,
    showReplay,
    replayLoading: readonly(replayLoading),
    replayError: readonly(replayError),
    replayForm,
    replayResult,
    replayMaxEventsError,
    canSubmitReplay,
    openReplay,
    cancelReplay,
    submitReplay,
    dismissReplayResult,
    hasPendingOperation,
    isMutationRunning,
  }
}

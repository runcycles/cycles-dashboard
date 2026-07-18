import { computed, ref } from 'vue'
import {
  ApiError,
  bulkActionWebhooks as bulkActionWebhooksDefault,
  listWebhooks as listWebhooksDefault,
} from '../api/client'
import type {
  WebhookBulkAction,
  WebhookBulkActionRequest,
  WebhookBulkActionResponse,
  WebhookBulkFilter,
  WebhookSubscription,
} from '../types'
import { formatBulkRequestError } from '../utils/errorCodeMessages'
import { toMessage } from '../utils/errors'
import { generateIdempotencyKey } from '../utils/idempotencyKey'
import { useBulkActionPreview } from './useBulkActionPreview'

const SYSTEM_TENANT_ID = '__system__'

export interface WebhookFilterBulkFilters {
  tenantId: string
  search: string
  failingOnly: boolean
}

export interface WebhookFilterBulkResult {
  actionVerb: string
  response: WebhookBulkActionResponse
}

export type WebhookFilterBulkAction = Extract<WebhookBulkAction, 'PAUSE' | 'RESUME'>

type ListWebhooksFn = typeof listWebhooksDefault
type BulkActionWebhooksFn = typeof bulkActionWebhooksDefault

export interface UseWebhookFilterBulkOptions {
  getFilters: () => WebhookFilterBulkFilters
  refresh: () => Promise<unknown>
  onResult: (result: WebhookFilterBulkResult) => void
  onSuccess?: (message: string) => void
  onError?: (message: string) => void
  /** Focused dependency seams for deterministic protocol tests. */
  list?: ListWebhooksFn
  submit?: BulkActionWebhooksFn
  createIdempotencyKey?: () => string
}

interface WebhookFilterSnapshot {
  tenantId: string
  search: string
}

function requiredStatus(action: WebhookFilterBulkAction): 'ACTIVE' | 'PAUSED' {
  return action === 'PAUSE' ? 'ACTIVE' : 'PAUSED'
}

function formatActionVerb(action: WebhookFilterBulkAction): string {
  return action === 'PAUSE' ? 'Pause' : 'Resume'
}

function normalizedSnapshot(filters: WebhookFilterBulkFilters): WebhookFilterSnapshot {
  return Object.freeze({
    tenantId: filters.tenantId,
    search: filters.search.trim(),
  })
}

function isRepresentable(filters: WebhookFilterBulkFilters): boolean {
  return filters.tenantId !== SYSTEM_TENANT_ID && !filters.search.includes('*') && !filters.failingOnly
}

function buildFilter(
  snapshot: Readonly<WebhookFilterSnapshot>,
  action: WebhookFilterBulkAction,
): WebhookBulkFilter {
  const filter: WebhookBulkFilter = { status: requiredStatus(action) }
  if (snapshot.tenantId) filter.tenant_id = snapshot.tenantId
  if (snapshot.search) filter.search = snapshot.search
  return filter
}

/**
 * Owns WebhooksView's filter-apply pause/resume protocol.
 *
 * The server bulk filter cannot represent the dashboard's system pseudo-
 * tenant, wildcard matcher, or derived failing-only predicate, so those modes
 * refuse to arm. Representable filters are captured once and reused for every
 * preview page, the visible summary, expected_count, and final mutation.
 */
export function useWebhookFilterBulk(options: UseWebhookFilterBulkOptions) {
  const action = ref<WebhookFilterBulkAction | null>(null)
  const running = ref(false)
  const submitError = ref('')
  const filterSnapshot = ref<Readonly<WebhookFilterSnapshot> | null>(null)

  const createKey = options.createIdempotencyKey ?? generateIdempotencyKey

  const preview = useBulkActionPreview<WebhookSubscription>({
    fetchPage: async (cursor) => {
      const snapshot = filterSnapshot.value
      if (!snapshot) return { items: [], hasMore: false, nextCursor: '' }
      const params: Record<string, string> = {}
      if (snapshot.search) params.search = snapshot.search
      if (cursor) params.cursor = cursor
      const response = await (options.list ?? listWebhooksDefault)(params)
      return {
        items: response.subscriptions,
        hasMore: !!response.has_more,
        nextCursor: response.next_cursor ?? '',
      }
    },
    filterFn: (webhook) => {
      const snapshot = filterSnapshot.value
      const submittedAction = action.value
      if (!snapshot || !submittedAction) return false
      if (webhook.status !== requiredStatus(submittedAction)) return false
      if (snapshot.tenantId && webhook.tenant_id !== snapshot.tenantId) return false
      return true
    },
    toSample: (webhook) => ({
      id: webhook.subscription_id,
      primary: webhook.url,
      status: webhook.status,
    }),
  })

  const summary = computed(() => {
    const snapshot = filterSnapshot.value
    const submittedAction = action.value
    if (!snapshot || !submittedAction) return ''
    const parts = [`status=${requiredStatus(submittedAction)}`]
    if (snapshot.tenantId) parts.push(`tenant_id=${snapshot.tenantId}`)
    if (snapshot.search) parts.push(`search="${snapshot.search}"`)
    return parts.join(' AND ')
  })

  function canOpen(): boolean {
    return !running.value && isRepresentable(options.getFilters())
  }

  function open(nextAction: WebhookFilterBulkAction): void {
    if (!canOpen()) return
    const currentFilters = options.getFilters()
    if (!isRepresentable(currentFilters)) return
    action.value = nextAction
    filterSnapshot.value = normalizedSnapshot(currentFilters)
    submitError.value = ''
    void preview.startPreview()
  }

  function resetArmedState(): void {
    action.value = null
    filterSnapshot.value = null
    submitError.value = ''
  }

  function cancel(): void {
    if (running.value) return
    preview.cancelPreview()
    preview.resetPreview()
    resetArmedState()
  }

  async function execute(): Promise<boolean> {
    if (!action.value || running.value) return false
    if (preview.previewLoading.value || preview.previewCount.value === 0 || preview.cappedAtMax.value) return false

    const snapshot = filterSnapshot.value
    if (!snapshot) {
      submitError.value = 'Preview this webhook selection before submitting the bulk action.'
      return false
    }

    const submittedAction = action.value
    running.value = true
    submitError.value = ''
    try {
      const body: WebhookBulkActionRequest = {
        filter: buildFilter(snapshot, submittedAction),
        action: submittedAction,
        idempotency_key: createKey(),
      }
      if (preview.reachedEnd.value) body.expected_count = preview.previewCount.value

      const response = await (options.submit ?? bulkActionWebhooksDefault)(body)
      const pastTense = submittedAction === 'PAUSE' ? 'paused' : 'resumed'
      const parts = [`${response.succeeded.length}/${response.total_matched} webhooks ${pastTense}`]
      if (response.skipped.length) parts.push(`${response.skipped.length} skipped (already in target state)`)
      if (response.failed.length) parts.push(`${response.failed.length} failed`)
      const outcome = parts.join(', ')
      if (response.failed.length) options.onError?.(`${outcome} — see details`)
      else options.onSuccess?.(outcome)

      preview.resetPreview()
      resetArmedState()
      if (response.failed.length || response.skipped.length) {
        options.onResult({ actionVerb: formatActionVerb(submittedAction), response })
      }
      return true
    } catch (cause) {
      if (cause instanceof ApiError && (cause.errorCode === 'LIMIT_EXCEEDED' || cause.errorCode === 'COUNT_MISMATCH')) {
        submitError.value = formatBulkRequestError(
          cause.errorCode,
          'webhooks',
          500,
          cause.details as Record<string, unknown> | undefined,
        ) ?? `Bulk ${submittedAction} failed: ${toMessage(cause)}`
      } else {
        submitError.value = `Bulk ${submittedAction} failed: ${toMessage(cause)}`
      }
      return false
    } finally {
      running.value = false
      await options.refresh()
    }
  }

  return {
    action,
    running,
    submitError,
    summary,
    preview,
    canOpen,
    open,
    cancel,
    execute,
    formatActionVerb,
  }
}

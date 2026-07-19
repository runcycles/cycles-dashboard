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
  status: string
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
  status: string
}

interface WebhookFilterBulkSelection {
  action: WebhookFilterBulkAction
  filters: Readonly<WebhookFilterSnapshot>
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
    status: filters.status,
  })
}

function representabilityError(
  filters: WebhookFilterBulkFilters,
  action: WebhookFilterBulkAction,
): string {
  if (filters.tenantId === SYSTEM_TENANT_ID) {
    return 'Bulk actions are unavailable for the system-wide filter because the server has no equivalent tenant selector.'
  }
  if (filters.search.includes('*')) {
    return 'Bulk actions are unavailable for wildcard URL filters because the server accepts literal search text only.'
  }
  if (filters.failingOnly) {
    return 'Bulk actions are unavailable for the failing-only filter because the server has no failure-state selector.'
  }
  const required = requiredStatus(action)
  if (filters.status && filters.status !== required) {
    return `${formatActionVerb(action)} only applies to ${required} webhooks, but the current status filter is ${filters.status}.`
  }
  return ''
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
  const selection = ref<Readonly<WebhookFilterBulkSelection> | null>(null)
  const action = computed(() => selection.value?.action ?? null)
  const running = ref(false)
  const submitError = ref('')

  const createKey = options.createIdempotencyKey ?? generateIdempotencyKey

  const preview = useBulkActionPreview<WebhookSubscription>({
    fetchPage: async (cursor) => {
      const ownedSelection = selection.value
      if (!ownedSelection) return { items: [], hasMore: false, nextCursor: '' }
      const snapshot = ownedSelection.filters
      // Webhook lists natively accept status. Push the action-derived source
      // status server-side so the bounded preview does not spend its page
      // budget scanning rows the bulk endpoint can never target.
      const params: Record<string, string> = { status: requiredStatus(ownedSelection.action) }
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
      const ownedSelection = selection.value
      if (!ownedSelection) return false
      if (webhook.status !== requiredStatus(ownedSelection.action)) return false
      const snapshot = ownedSelection.filters
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
    const ownedSelection = selection.value
    if (!ownedSelection) return ''
    const { action: submittedAction, filters: snapshot } = ownedSelection
    const parts = [`status=${requiredStatus(submittedAction)}`]
    if (snapshot.tenantId) parts.push(`tenant_id=${snapshot.tenantId}`)
    if (snapshot.search) parts.push(`search="${snapshot.search}"`)
    return parts.join(' AND ')
  })

  function unsupportedReason(nextAction: WebhookFilterBulkAction): string {
    return representabilityError(options.getFilters(), nextAction)
  }

  function canOpen(nextAction: WebhookFilterBulkAction): boolean {
    return !unsupportedReason(nextAction)
  }

  function open(nextAction: WebhookFilterBulkAction): void {
    if (running.value) return
    const currentFilters = options.getFilters()
    if (representabilityError(currentFilters, nextAction)) return
    selection.value = Object.freeze({
      action: nextAction,
      filters: normalizedSnapshot(currentFilters),
    })
    submitError.value = ''
    void preview.startPreview()
  }

  function resetArmedState(): void {
    selection.value = null
    submitError.value = ''
  }

  function cancel(): void {
    if (running.value) return
    preview.cancelPreview()
    preview.resetPreview()
    resetArmedState()
  }

  async function execute(): Promise<boolean> {
    const ownedSelection = selection.value
    if (!ownedSelection || running.value) return false
    if (
      preview.previewLoading.value
      || preview.previewError.value
      || preview.previewCount.value === 0
      || preview.cappedAtMax.value
    ) return false

    const { filters: snapshot, action: submittedAction } = ownedSelection
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
    unsupportedReason,
    preview,
    canOpen,
    open,
    cancel,
    execute,
    formatActionVerb,
  }
}

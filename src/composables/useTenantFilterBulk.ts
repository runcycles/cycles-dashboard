import { computed, ref } from 'vue'
import {
  ApiError,
  bulkActionTenants as bulkActionTenantsDefault,
  listTenants as listTenantsDefault,
} from '../api/client'
import type {
  Tenant,
  TenantBulkAction,
  TenantBulkActionRequest,
  TenantBulkActionResponse,
  TenantBulkFilter,
} from '../types'
import { formatBulkRequestError } from '../utils/errorCodeMessages'
import { toMessage } from '../utils/errors'
import { generateIdempotencyKey } from '../utils/idempotencyKey'
import { useBulkActionPreview } from './useBulkActionPreview'

export interface TenantFilterBulkFilters {
  search: string
  parentTenantId: string
}

export interface TenantFilterBulkResult {
  actionVerb: string
  response: TenantBulkActionResponse
}

export type TenantFilterBulkAction = Extract<TenantBulkAction, 'SUSPEND' | 'REACTIVATE'>

type ListTenantsFn = typeof listTenantsDefault
type BulkActionTenantsFn = typeof bulkActionTenantsDefault

export interface UseTenantFilterBulkOptions {
  getFilters: () => TenantFilterBulkFilters
  refresh: () => Promise<unknown>
  onResult: (result: TenantFilterBulkResult) => void
  onSuccess?: (message: string) => void
  onError?: (message: string) => void
  /** Focused dependency seams for deterministic protocol tests. */
  list?: ListTenantsFn
  submit?: BulkActionTenantsFn
  createIdempotencyKey?: () => string
}

interface TenantFilterSnapshot {
  search: string
  parentTenantId: string
}

function requiredStatus(action: TenantFilterBulkAction): string {
  return action === 'SUSPEND' ? 'ACTIVE' : 'SUSPENDED'
}

function formatActionVerb(action: TenantFilterBulkAction): string {
  return action === 'SUSPEND' ? 'Suspend' : 'Reactivate'
}

function normalizedSnapshot(filters: TenantFilterBulkFilters): TenantFilterSnapshot {
  return Object.freeze({
    search: filters.search.trim(),
    parentTenantId: filters.parentTenantId,
  })
}

function buildFilter(
  snapshot: Readonly<TenantFilterSnapshot>,
  action: TenantFilterBulkAction,
): TenantBulkFilter {
  const filter: TenantBulkFilter = { status: requiredStatus(action) }
  if (snapshot.parentTenantId) filter.parent_tenant_id = snapshot.parentTenantId
  if (snapshot.search) filter.search = snapshot.search
  return filter
}

/**
 * Owns TenantsView's filter-apply suspend/reactivate protocol.
 *
 * Preview captures one immutable action/filter tuple. Every cursor page, the
 * visible summary, expected_count, and the eventual mutation reuse that tuple,
 * so route or control changes cannot submit a different tenant set from the
 * one the operator reviewed.
 */
export function useTenantFilterBulk(options: UseTenantFilterBulkOptions) {
  const action = ref<TenantFilterBulkAction | null>(null)
  const running = ref(false)
  const submitError = ref('')
  const filterSnapshot = ref<Readonly<TenantFilterSnapshot> | null>(null)

  const createKey = options.createIdempotencyKey ?? generateIdempotencyKey

  const preview = useBulkActionPreview<Tenant>({
    fetchPage: async (cursor) => {
      const snapshot = filterSnapshot.value
      if (!snapshot) return { items: [], hasMore: false, nextCursor: '' }
      const params: Record<string, string> = {}
      if (snapshot.search) params.search = snapshot.search
      if (cursor) params.cursor = cursor
      const response = await (options.list ?? listTenantsDefault)(params)
      return {
        items: response.tenants,
        hasMore: !!response.has_more,
        nextCursor: response.next_cursor ?? '',
      }
    },
    filterFn: (tenant) => {
      const snapshot = filterSnapshot.value
      const submittedAction = action.value
      if (!snapshot || !submittedAction) return false
      if (tenant.status !== requiredStatus(submittedAction)) return false
      if (snapshot.parentTenantId && tenant.parent_tenant_id !== snapshot.parentTenantId) return false
      return true
    },
    toSample: (tenant) => ({
      id: tenant.tenant_id,
      primary: tenant.name || '',
      status: tenant.status,
    }),
  })

  const summary = computed(() => {
    const snapshot = filterSnapshot.value
    const submittedAction = action.value
    if (!snapshot || !submittedAction) return ''
    const parts = [`status=${requiredStatus(submittedAction)}`]
    if (snapshot.parentTenantId) parts.push(`parent_tenant_id=${snapshot.parentTenantId}`)
    if (snapshot.search) parts.push(`search="${snapshot.search}"`)
    return parts.join(' AND ')
  })

  function canOpen(): boolean {
    return !running.value && options.getFilters().parentTenantId !== '__root__'
  }

  function open(nextAction: TenantFilterBulkAction): void {
    if (!canOpen()) return
    const snapshot = normalizedSnapshot(options.getFilters())
    if (snapshot.parentTenantId === '__root__') return
    action.value = nextAction
    filterSnapshot.value = snapshot
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
    if (!snapshot || snapshot.parentTenantId === '__root__') {
      submitError.value = 'Preview this tenant selection before submitting the bulk action.'
      return false
    }

    const submittedAction = action.value
    running.value = true
    submitError.value = ''
    try {
      const body: TenantBulkActionRequest = {
        filter: buildFilter(snapshot, submittedAction),
        action: submittedAction,
        idempotency_key: createKey(),
      }
      // Only a naturally exhausted walk owns the exact count. Page- or
      // match-capped lower bounds must omit expected_count or every submit
      // would necessarily fail the server's COUNT_MISMATCH guard.
      if (preview.reachedEnd.value) body.expected_count = preview.previewCount.value

      const response = await (options.submit ?? bulkActionTenantsDefault)(body)
      const pastTense = submittedAction === 'SUSPEND' ? 'suspended' : 'reactivated'
      const parts = [`${response.succeeded.length}/${response.total_matched} tenants ${pastTense}`]
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
          'tenants',
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

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
import { LIST_PAGE_LIMIT } from '../utils/cursorWalk'
import { toMessage } from '../utils/errors'
import { generateIdempotencyKey } from '../utils/idempotencyKey'
import { useBulkActionPreview } from './useBulkActionPreview'

export interface TenantFilterBulkFilters {
  search: string
  parentTenantId: string
  status: string
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
  status: string
}

interface TenantFilterBulkSelection {
  action: TenantFilterBulkAction
  filters: Readonly<TenantFilterSnapshot>
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
    status: filters.status,
  })
}

function representabilityError(
  filters: TenantFilterBulkFilters,
  action: TenantFilterBulkAction,
): string {
  if (filters.parentTenantId === '__root__') {
    return 'Bulk actions are unavailable for the root-level filter because the server has no equivalent parent selector.'
  }
  const required = requiredStatus(action)
  if (filters.status && filters.status !== required) {
    return `${formatActionVerb(action)} only applies to ${required} tenants, but the current status filter is ${filters.status}.`
  }
  return ''
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
  const selection = ref<Readonly<TenantFilterBulkSelection> | null>(null)
  const action = computed(() => selection.value?.action ?? null)
  const running = ref(false)
  const submitError = ref('')

  const createKey = options.createIdempotencyKey ?? generateIdempotencyKey

  const preview = useBulkActionPreview<Tenant>({
    fetchPage: async (cursor) => {
      const ownedSelection = selection.value
      if (!ownedSelection) return { items: [], hasMore: false, nextCursor: '' }
      const snapshot = ownedSelection.filters
      // Tenant lists natively accept every representable bulk predicate. Push
      // them server-side so the bounded walk spends its 20-page budget only on
      // rows the mutation can target; filterFn remains the defensive mirror.
      const params: Record<string, string> = {
        status: requiredStatus(ownedSelection.action),
        limit: String(LIST_PAGE_LIMIT),
      }
      if (snapshot.parentTenantId) params.parent_tenant_id = snapshot.parentTenantId
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
      const ownedSelection = selection.value
      if (!ownedSelection) return false
      if (tenant.status !== requiredStatus(ownedSelection.action)) return false
      const snapshot = ownedSelection.filters
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
    const ownedSelection = selection.value
    if (!ownedSelection) return ''
    const { action: submittedAction, filters: snapshot } = ownedSelection
    const parts = [`status=${requiredStatus(submittedAction)}`]
    if (snapshot.parentTenantId) parts.push(`parent_tenant_id=${snapshot.parentTenantId}`)
    if (snapshot.search) parts.push(`search="${snapshot.search}"`)
    return parts.join(' AND ')
  })

  function unsupportedReason(nextAction: TenantFilterBulkAction): string {
    return representabilityError(options.getFilters(), nextAction)
  }

  function canOpen(nextAction: TenantFilterBulkAction): boolean {
    return !unsupportedReason(nextAction)
  }

  function open(nextAction: TenantFilterBulkAction): void {
    if (running.value) return
    const currentFilters = options.getFilters()
    if (representabilityError(currentFilters, nextAction)) return
    const snapshot = normalizedSnapshot(currentFilters)
    selection.value = Object.freeze({ action: nextAction, filters: snapshot })
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
      || (!preview.reachedEnd.value && !preview.cappedAtPages.value)
    ) return false

    const { filters: snapshot, action: submittedAction } = ownedSelection
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
    unsupportedReason,
    preview,
    canOpen,
    open,
    cancel,
    execute,
    formatActionVerb,
  }
}

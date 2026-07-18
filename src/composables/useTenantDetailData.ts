import { computed, onScopeDispose, ref } from 'vue'
import {
  ApiError,
  getTenant as getTenantDefault,
  listApiKeys as listApiKeysDefault,
  listBudgets as listBudgetsDefault,
  listPolicies as listPoliciesDefault,
  listTenants as listTenantsDefault,
  listWebhooks as listWebhooksDefault,
} from '../api/client'
import type {
  ApiKey,
  BudgetLedger,
  Policy,
  Tenant,
  WebhookSubscription,
} from '../types'
import {
  CURSOR_WALK_MAX_PAGES,
  LIST_PAGE_LIMIT,
  walkCursorPages,
  type CursorWalkResult,
} from '../utils/cursorWalk'
import { toMessage } from '../utils/errors'
import { isTerminalTenant } from '../utils/tenantStatus'
import { POLL_SLOW_MS } from './pollingConstants'
import { POLLING_STALE } from './pollingResult'
import { usePolling as usePollingDefault } from './usePolling'

export type TenantDetailTab = 'budgets' | 'keys' | 'policies'
export type TenantDetailRefreshResult = 'applied' | 'failed' | 'superseded'

type TenantDetailReadOwner = 'poll' | 'tenant' | 'tenants' | 'budgets' | 'keys' | 'policies' | 'webhooks' | 'cascade'
type TenantDetailErrorOwner = TenantDetailReadOwner | 'external'

type TenantDetailPolling = (
  callback: Parameters<typeof usePollingDefault>[0],
  intervalMs: number,
) => Pick<ReturnType<typeof usePollingDefault>, 'refresh' | 'isLoading' | 'lastSuccessAt'>

export interface TenantDetailDataDependencies {
  getTenant: typeof getTenantDefault
  listApiKeys: typeof listApiKeysDefault
  listBudgets: typeof listBudgetsDefault
  listPolicies: typeof listPoliciesDefault
  listTenants: typeof listTenantsDefault
  listWebhooks: typeof listWebhooksDefault
  usePolling: TenantDetailPolling
}

export interface UseTenantDetailDataOptions {
  tenantId: string
  getActiveTab: () => TenantDetailTab
  /** Destructive mutations publish through dedicated refreshes, not polls. */
  isMutationRunning: () => boolean
  dependencies?: Partial<TenantDetailDataDependencies>
}

const defaultDependencies: TenantDetailDataDependencies = {
  getTenant: getTenantDefault,
  listApiKeys: listApiKeysDefault,
  listBudgets: listBudgetsDefault,
  listPolicies: listPoliciesDefault,
  listTenants: listTenantsDefault,
  listWebhooks: listWebhooksDefault,
  usePolling: usePollingDefault,
}

/** Maximum number of rows whose completeness Tenant Detail will claim. */
export const TENANT_DETAIL_SCAN_MAX_ROWS = CURSOR_WALK_MAX_PAGES * LIST_PAGE_LIMIT

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
}

/**
 * Owns TenantDetailView's cursor-aware read protocol.
 *
 * Every child endpoint is cursor paginated and clamps pages to 100 rows.
 * Whole-set UI (badges, rollups, cascade verification, emergency-freeze
 * targets) therefore consumes bounded walks and carries an explicit partial
 * bit. A global publication generation prevents a late poll from overwriting
 * a newer mutation refresh.
 */
export function useTenantDetailData(options: UseTenantDetailDataOptions) {
  const deps: TenantDetailDataDependencies = {
    ...defaultDependencies,
    ...options.dependencies,
  }
  const tenantId = options.tenantId

  const tenant = ref<Tenant | null>(null)
  const allTenants = ref<Tenant[]>([])
  const budgets = ref<BudgetLedger[]>([])
  const apiKeys = ref<ApiKey[]>([])
  const policies = ref<Policy[]>([])
  const webhooks = ref<WebhookSubscription[]>([])

  const tenantsPartial = ref(false)
  const budgetsPartial = ref(false)
  const apiKeysPartial = ref(false)
  const policiesPartial = ref(false)
  const webhooksPartial = ref(false)
  const cascadePartial = computed(() => (
    budgetsPartial.value || apiKeysPartial.value || webhooksPartial.value
  ))

  const error = ref('')
  let errorOwner: TenantDetailErrorOwner | null = null
  const notFound = ref(false)
  const initialLoadDone = ref(false)

  let publicationGeneration = 0
  let directController: AbortController | null = null
  const directLoading = ref(false)

  function owns(generation: number, signal: AbortSignal): boolean {
    return generation === publicationGeneration && !signal.aborted
  }

  function startDirectRefresh(): { generation: number; controller: AbortController } {
    publicationGeneration++
    directController?.abort()
    const controller = new AbortController()
    directController = controller
    directLoading.value = true
    return { generation: publicationGeneration, controller }
  }

  function finishDirectRefresh(controller: AbortController): void {
    if (directController === controller) {
      directController = null
      directLoading.value = false
    }
  }

  function walkBudgets(signal: AbortSignal) {
    return walkCursorPages<BudgetLedger>(async (cursor) => {
      throwIfAborted(signal)
      const response = await deps.listBudgets({
        tenant_id: tenantId,
        limit: String(LIST_PAGE_LIMIT),
        ...(cursor ? { cursor } : {}),
      }, signal)
      throwIfAborted(signal)
      return {
        items: response.ledgers,
        hasMore: !!response.has_more,
        nextCursor: response.next_cursor ?? '',
      }
    })
  }

  function walkApiKeys(signal: AbortSignal) {
    return walkCursorPages<ApiKey>(async (cursor) => {
      throwIfAborted(signal)
      const response = await deps.listApiKeys({
        tenant_id: tenantId,
        limit: String(LIST_PAGE_LIMIT),
        ...(cursor ? { cursor } : {}),
      }, signal)
      throwIfAborted(signal)
      return {
        items: response.keys,
        hasMore: !!response.has_more,
        nextCursor: response.next_cursor ?? '',
      }
    })
  }

  function walkPolicies(signal: AbortSignal) {
    return walkCursorPages<Policy>(async (cursor) => {
      throwIfAborted(signal)
      const response = await deps.listPolicies({
        tenant_id: tenantId,
        limit: String(LIST_PAGE_LIMIT),
        ...(cursor ? { cursor } : {}),
      }, signal)
      throwIfAborted(signal)
      return {
        items: response.policies,
        hasMore: !!response.has_more,
        nextCursor: response.next_cursor ?? '',
      }
    })
  }

  function walkWebhooks(signal: AbortSignal) {
    return walkCursorPages<WebhookSubscription>(async (cursor) => {
      throwIfAborted(signal)
      const response = await deps.listWebhooks({
        tenant_id: tenantId,
        limit: String(LIST_PAGE_LIMIT),
        ...(cursor ? { cursor } : {}),
      }, signal)
      throwIfAborted(signal)
      return {
        items: response.subscriptions,
        hasMore: !!response.has_more,
        nextCursor: response.next_cursor ?? '',
      }
    })
  }

  function walkTenants(signal: AbortSignal) {
    return walkCursorPages<Tenant>(async (cursor) => {
      throwIfAborted(signal)
      const response = await deps.listTenants({
        limit: String(LIST_PAGE_LIMIT),
        ...(cursor ? { cursor } : {}),
      }, signal)
      throwIfAborted(signal)
      return {
        items: response.tenants,
        hasMore: !!response.has_more,
        nextCursor: response.next_cursor ?? '',
      }
    })
  }

  function publishBudgets(result: CursorWalkResult<BudgetLedger>): void {
    budgets.value = result.items
    budgetsPartial.value = result.partial
  }

  function publishApiKeys(result: CursorWalkResult<ApiKey>): void {
    apiKeys.value = result.items
    apiKeysPartial.value = result.partial
  }

  function publishPolicies(result: CursorWalkResult<Policy>): void {
    policies.value = result.items
    policiesPartial.value = result.partial
  }

  function publishWebhooks(result: CursorWalkResult<WebhookSubscription>): void {
    webhooks.value = result.items
    webhooksPartial.value = result.partial
  }

  function publishTenants(result: CursorWalkResult<Tenant>): void {
    allTenants.value = result.items
    tenantsPartial.value = result.partial
  }

  function setError(owner: TenantDetailErrorOwner, message: string): void {
    errorOwner = owner
    error.value = message
  }

  function clearOwnedError(...owners: TenantDetailErrorOwner[]): void {
    if (errorOwner === null || !owners.includes(errorOwner)) return
    errorOwner = null
    error.value = ''
  }

  function clearAllErrors(): void {
    errorOwner = null
    error.value = ''
  }

  function reportFailure(cause: unknown): false | typeof POLLING_STALE {
    if (cause instanceof DOMException && cause.name === 'AbortError') return POLLING_STALE
    setError('poll', toMessage(cause))
    return false
  }

  async function initialTick(generation: number, signal: AbortSignal) {
    let tenantResult: Tenant
    try {
      // Resolve the route resource first so only its 404 becomes the dedicated
      // not-found state. A missing/unsupported child endpoint is a load error,
      // not evidence that the tenant route itself does not exist.
      tenantResult = await deps.getTenant(tenantId, signal)
      if (!owns(generation, signal)) return POLLING_STALE
    } catch (cause) {
      if (!owns(generation, signal)) return POLLING_STALE
      if (cause instanceof ApiError && cause.status === 404) {
        notFound.value = true
        clearAllErrors()
        return false
      }
      return reportFailure(cause)
    }

    try {
      const [budgetResult, tenantListResult, keyResult, policyResult, webhookResult] = await Promise.all([
        walkBudgets(signal),
        walkTenants(signal),
        walkApiKeys(signal),
        walkPolicies(signal),
        walkWebhooks(signal),
      ])
      if (!owns(generation, signal)) return POLLING_STALE
      tenant.value = tenantResult
      publishBudgets(budgetResult)
      publishTenants(tenantListResult)
      publishApiKeys(keyResult)
      publishPolicies(policyResult)
      publishWebhooks(webhookResult)
      initialLoadDone.value = true
      notFound.value = false
      clearOwnedError('poll', 'tenant', 'tenants', 'budgets', 'keys', 'policies', 'webhooks', 'cascade')
      return true
    } catch (cause) {
      if (!owns(generation, signal)) return POLLING_STALE
      return reportFailure(cause)
    }
  }

  async function steadyTick(generation: number, signal: AbortSignal) {
    let nextTenant: Tenant
    try {
      nextTenant = await deps.getTenant(tenantId, signal)
      if (!owns(generation, signal)) return POLLING_STALE
    } catch (cause) {
      if (!owns(generation, signal)) return POLLING_STALE
      if (cause instanceof ApiError && cause.status === 404) {
        notFound.value = true
        clearAllErrors()
        return false
      }
      return reportFailure(cause)
    }

    try {
      const activeTab = options.getActiveTab()
      const needsKeys = activeTab === 'keys' || isTerminalTenant(nextTenant)
      const needsPolicies = activeTab === 'policies'
      const needsWebhooks = isTerminalTenant(nextTenant)
      const [budgetResult, tenantListResult, keyResult, policyResult, webhookResult] = await Promise.all([
        walkBudgets(signal),
        walkTenants(signal),
        needsKeys ? walkApiKeys(signal) : Promise.resolve(null),
        needsPolicies ? walkPolicies(signal) : Promise.resolve(null),
        needsWebhooks ? walkWebhooks(signal) : Promise.resolve(null),
      ])
      if (!owns(generation, signal)) return POLLING_STALE

      tenant.value = nextTenant
      publishBudgets(budgetResult)
      publishTenants(tenantListResult)
      if (keyResult) publishApiKeys(keyResult)
      if (policyResult) publishPolicies(policyResult)
      if (webhookResult) publishWebhooks(webhookResult)
      notFound.value = false
      clearOwnedError(
        'poll',
        'tenant',
        'tenants',
        'budgets',
        ...(keyResult ? ['keys' as const] : []),
        ...(policyResult ? ['policies' as const] : []),
        ...(webhookResult ? ['webhooks' as const] : []),
      )
      return true
    } catch (cause) {
      if (!owns(generation, signal)) return POLLING_STALE
      return reportFailure(cause)
    }
  }

  async function tick(signal: AbortSignal = new AbortController().signal) {
    if (options.isMutationRunning() || directLoading.value) return POLLING_STALE
    const generation = ++publicationGeneration
    return initialLoadDone.value
      ? steadyTick(generation, signal)
      : initialTick(generation, signal)
  }

  async function runDirect<T>(
    owner: TenantDetailReadOwner,
    read: (signal: AbortSignal) => Promise<T>,
    publish: (result: T) => void,
  ): Promise<TenantDetailRefreshResult> {
    const { generation, controller } = startDirectRefresh()
    try {
      const result = await read(controller.signal)
      if (!owns(generation, controller.signal)) return 'superseded'
      publish(result)
      notFound.value = false
      clearOwnedError(owner)
      return 'applied'
    } catch (cause) {
      if (!owns(generation, controller.signal)) return 'superseded'
      setError(owner, toMessage(cause))
      return 'failed'
    } finally {
      finishDirectRefresh(controller)
    }
  }

  function refreshTenant(): Promise<TenantDetailRefreshResult> {
    return runDirect(
      'tenant',
      signal => deps.getTenant(tenantId, signal),
      result => { tenant.value = result },
    )
  }

  function refreshBudgets(): Promise<TenantDetailRefreshResult> {
    return runDirect('budgets', walkBudgets, publishBudgets)
  }

  function refreshApiKeys(): Promise<TenantDetailRefreshResult> {
    return runDirect('keys', walkApiKeys, publishApiKeys)
  }

  function refreshPolicies(): Promise<TenantDetailRefreshResult> {
    return runDirect('policies', walkPolicies, publishPolicies)
  }

  /**
   * Refresh the tenant-close convergence axes after a committed CLOSE.
   * Successful siblings publish even when another read fails, matching the
   * mutation-terminal contract while returning false for operator warning.
   */
  async function refreshCascadeState(): Promise<TenantDetailRefreshResult> {
    const { generation, controller } = startDirectRefresh()
    const signal = controller.signal
    try {
      const results = await Promise.allSettled([
        deps.getTenant(tenantId, signal),
        walkBudgets(signal),
        walkWebhooks(signal),
        walkApiKeys(signal),
      ] as const)
      if (!owns(generation, signal)) return 'superseded'

      const [tenantResult, budgetResult, webhookResult, keyResult] = results
      if (tenantResult.status === 'fulfilled') tenant.value = tenantResult.value
      if (budgetResult.status === 'fulfilled') publishBudgets(budgetResult.value)
      if (webhookResult.status === 'fulfilled') publishWebhooks(webhookResult.value)
      if (keyResult.status === 'fulfilled') publishApiKeys(keyResult.value)

      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') {
        setError('cascade', toMessage(failed.reason))
        return 'failed'
      }
      notFound.value = false
      clearOwnedError('cascade', 'tenant', 'budgets', 'keys', 'webhooks')
      return 'applied'
    } finally {
      finishDirectRefresh(controller)
    }
  }

  /** Commit an authoritative mutation response and supersede older polls. */
  function commitTenant(nextTenant: Tenant): void {
    publicationGeneration++
    tenant.value = nextTenant
    notFound.value = false
    clearOwnedError('tenant')
  }

  function reportError(message: string): void {
    setError('external', message)
  }

  function dismissError(): void {
    clearAllErrors()
  }

  onScopeDispose(() => {
    publicationGeneration++
    directController?.abort()
    directController = null
    directLoading.value = false
  })

  const {
    refresh,
    isLoading: pollLoading,
    lastSuccessAt: pollLastSuccessAt,
  } = deps.usePolling(tick, POLL_SLOW_MS)
  // Optional chaining keeps older focused test doubles (which predate the
  // loading/freshness fields) compatible without weakening production. Only
  // a successful poll advances the page-wide freshness stamp: a direct
  // policy/key/budget refresh must not make unrelated stale axes look fresh.
  const isLoading = computed(() => (pollLoading?.value ?? false) || directLoading.value)
  const lastSuccessAt = computed(() => pollLastSuccessAt?.value ?? null)

  return {
    tenant,
    allTenants,
    budgets,
    apiKeys,
    policies,
    webhooks,
    tenantsPartial,
    budgetsPartial,
    apiKeysPartial,
    policiesPartial,
    webhooksPartial,
    cascadePartial,
    error,
    notFound,
    initialLoadDone,
    refresh,
    isLoading,
    lastSuccessAt,
    refreshTenant,
    refreshBudgets,
    refreshApiKeys,
    refreshPolicies,
    refreshCascadeState,
    commitTenant,
    reportError,
    dismissError,
  }
}

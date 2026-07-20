import { computed, readonly, ref, type Ref } from 'vue'
import {
  freezeBudget as freezeBudgetDefault,
  updateTenantStatus as updateTenantStatusDefault,
} from '../api/client'
import type { ApiKey, BudgetLedger, Tenant, WebhookSubscription } from '../types'
import { toMessage } from '../utils/errors'
import {
  rateLimitedBatch as rateLimitedBatchDefault,
  type BatchOptions,
  type BatchResult,
} from '../utils/rateLimitedBatch'
import {
  synthesizeRowSelectBulkResult,
  type RowSelectBulkResponse,
} from '../utils/rowSelectBulkResult'
import {
  cascadeIsIncomplete,
  cascadePendingCounts,
  isTerminalTenant,
} from '../utils/tenantStatus'
import { TENANT_DETAIL_SCAN_MAX_ROWS, type TenantDetailRefreshResult } from './useTenantDetailData'

export type TenantLifecycleAction = 'SUSPENDED' | 'ACTIVE' | 'CLOSED'

export type EmergencyFreezeTarget = Readonly<
  Pick<BudgetLedger, 'ledger_id' | 'tenant_id' | 'scope' | 'unit'>
>

export interface EmergencyFreezeResult {
  actionVerb: string
  response: RowSelectBulkResponse
  labelById: Record<string, string>
  tenantId: string
}

export interface TenantLifecycleNotifications {
  success: (message: string) => void
  warning: (message: string) => void
  error: (message: string) => void
}

type UpdateTenantStatusFn = typeof updateTenantStatusDefault
type FreezeBudgetFn = typeof freezeBudgetDefault
type TenantLifecycleBatchFn = (
  items: readonly EmergencyFreezeTarget[],
  worker: (item: EmergencyFreezeTarget, index: number) => Promise<void>,
  options?: BatchOptions,
) => Promise<BatchResult>

export interface UseTenantLifecycleOptions {
  tenantId: string
  tenant: Readonly<Ref<Tenant | null>>
  budgets: Readonly<Ref<BudgetLedger[]>>
  apiKeys: Readonly<Ref<ApiKey[]>>
  webhooks: Readonly<Ref<WebhookSubscription[]>>
  budgetsPartial: Readonly<Ref<boolean>>
  cascadePartial: Readonly<Ref<boolean>>
  error: Readonly<Ref<string>>
  refreshTenant: () => Promise<TenantDetailRefreshResult>
  refreshBudgets: () => Promise<TenantDetailRefreshResult>
  refreshCascadeState: () => Promise<TenantDetailRefreshResult>
  commitTenant: (tenant: Tenant) => void
  reportError: (message: string) => void
  dismissError: () => void
  notify: TenantLifecycleNotifications
  /** Refuse to arm a lifecycle surface while a sibling owner is armed. */
  canArm?: () => boolean
  /** Focused dependency seams for deterministic destructive-flow tests. */
  updateStatus?: UpdateTenantStatusFn
  freeze?: FreezeBudgetFn
  runBatch?: TenantLifecycleBatchFn
}

const TENANT_ACTION_SUCCESS: Record<TenantLifecycleAction, string> = {
  SUSPENDED: 'Tenant suspended',
  ACTIVE: 'Tenant reactivated',
  CLOSED: 'Tenant permanently closed',
}

/**
 * Owns Tenant Detail's destructive lifecycle protocol.
 *
 * The owning view retains acquisition, tabs, forms, routing, and markup. This
 * composable owns action selection, duplicate-submit protection, commit-before-
 * refresh settlement, close-cascade recovery, and the immutable/cancellable
 * Emergency Freeze batch. Polling consumes `isMutationRunning` so it cannot
 * publish through any of those mutation-owned refresh windows.
 */
export function useTenantLifecycle(options: UseTenantLifecycleOptions) {
  const pendingTenantActionState = ref<TenantLifecycleAction | null>(null)
  const pendingTenantAction = computed(() => pendingTenantActionState.value)
  const closeConfirmInput = ref('')
  const tenantActionLoading = ref(false)

  const pendingRerunCascadeState = ref(false)
  const pendingRerunCascade = computed(() => pendingRerunCascadeState.value)
  const rerunCascadeLoading = ref(false)
  const rerunCascadeError = ref('')

  const pendingEmergencyFreezeState = ref(false)
  const pendingEmergencyFreeze = computed(() => pendingEmergencyFreezeState.value)
  const emergencyFreezePreparing = ref(false)
  const emergencyFreezeRunning = ref(false)
  const emergencyFreezeSettling = ref(false)
  const emergencyFreezeProgress = ref({ done: 0, total: 0, failed: 0 })
  const emergencyFreezeTargetsState = ref<readonly EmergencyFreezeTarget[]>([])
  const emergencyFreezeTargets = computed(() => emergencyFreezeTargetsState.value)
  const emergencyFreezeResultState = ref<EmergencyFreezeResult | null>(null)
  const emergencyFreezeResult = computed(() => emergencyFreezeResultState.value)
  let emergencyFreezeAbort: AbortController | null = null

  const activeBudgets = computed(() => options.budgets.value.filter(b => b.status === 'ACTIVE'))
  const cascadePreview = computed(() => ({
    nonTerminalBudgets: options.budgets.value.filter(
      b => b.status === 'ACTIVE' || b.status === 'FROZEN',
    ).length,
    activeKeys: options.apiKeys.value.filter(k => k.status === 'ACTIVE').length,
  }))
  const cascadeChildren = computed(() => ({
    budgets: options.budgets.value,
    webhooks: options.webhooks.value,
    apiKeys: options.apiKeys.value,
  }))
  const cascadePending = computed(() => cascadePendingCounts(cascadeChildren.value))
  const showRecoveryBanner = computed(() => (
    cascadeIsIncomplete(options.tenant.value, cascadeChildren.value)
    || (isTerminalTenant(options.tenant.value) && options.cascadePartial.value)
  ))

  const isMutationRunning = computed(() => (
    tenantActionLoading.value
    || rerunCascadeLoading.value
    || emergencyFreezePreparing.value
    || emergencyFreezeRunning.value
    || emergencyFreezeSettling.value
  ))

  const lifecycleArmed = computed(() => (
    isMutationRunning.value
    || pendingTenantActionState.value !== null
    || pendingRerunCascadeState.value
    || pendingEmergencyFreezeState.value
    || emergencyFreezeResultState.value !== null
  ))

  function hasPendingLifecycleAction(): boolean {
    return pendingTenantActionState.value !== null
      || pendingRerunCascadeState.value
      || pendingEmergencyFreezeState.value
      || emergencyFreezeResultState.value !== null
  }

  function warnRefreshSettlement(
    result: TenantDetailRefreshResult,
    committedLabel: string,
  ): void {
    if (result === 'applied') return
    if (result === 'failed') {
      options.notify.warning(`${committedLabel}, but refresh failed: ${options.error.value}`)
    } else {
      options.notify.warning(`${committedLabel}; its refresh was superseded by a newer view update`)
    }
  }

  function requestTenantAction(action: TenantLifecycleAction): void {
    if (
      options.canArm?.() === false
      || isMutationRunning.value
      || hasPendingLifecycleAction()
    ) return
    const status = options.tenant.value?.status
    const isLegalTransition = action === 'SUSPENDED'
      ? status === 'ACTIVE'
      : action === 'ACTIVE'
        ? status === 'SUSPENDED'
        : !!status && status !== 'CLOSED'
    if (!isLegalTransition) return
    pendingTenantActionState.value = action
  }

  function cancelTenantAction(): void {
    if (tenantActionLoading.value) return
    pendingTenantActionState.value = null
    closeConfirmInput.value = ''
  }

  async function executeTenantAction(): Promise<boolean> {
    const action = pendingTenantActionState.value
    // ConfirmAction and the typed-close dialog both disable submit while this
    // is true. Keep the protocol guard first so a direct/re-entrant caller can
    // neither send a second PATCH nor mutate visible state.
    if (!action || tenantActionLoading.value) return false
    if (
      action === 'CLOSED'
      && closeConfirmInput.value !== (options.tenant.value?.name || options.tenantId)
    ) return false
    tenantActionLoading.value = true
    try {
      try {
        const updated = await (options.updateStatus ?? updateTenantStatusDefault)(
          options.tenantId,
          action,
        )
        // The PATCH response is authoritative. Commit immediately so a failed
        // GET cannot leave now-illegal actions visible on a CLOSED tenant.
        options.commitTenant(updated)
      } catch (cause) {
        const message = toMessage(cause)
        options.reportError(message)
        options.notify.error(`Tenant status change failed: ${message}`)
        return false
      }

      options.dismissError()
      options.notify.success(TENANT_ACTION_SUCCESS[action])
      const refreshed = action === 'CLOSED'
        ? await options.refreshCascadeState()
        : await options.refreshTenant()
      if (refreshed === 'failed') {
        const message = `Tenant status changed, but refresh failed: ${options.error.value}`
        options.reportError(message)
        options.notify.warning(message)
      } else if (refreshed === 'superseded') {
        options.notify.warning(
          'Tenant status changed; its refresh was superseded by a newer view update',
        )
      }
      return true
    } finally {
      tenantActionLoading.value = false
      pendingTenantActionState.value = null
      closeConfirmInput.value = ''
    }
  }

  function openRerunCascade(): void {
    if (
      options.canArm?.() === false
      || isMutationRunning.value
      || hasPendingLifecycleAction()
      || !isTerminalTenant(options.tenant.value)
    ) return
    rerunCascadeError.value = ''
    pendingRerunCascadeState.value = true
  }

  function cancelRerunCascade(): void {
    if (rerunCascadeLoading.value) return
    pendingRerunCascadeState.value = false
    rerunCascadeError.value = ''
  }

  async function rerunCascade(): Promise<boolean> {
    if (!pendingRerunCascadeState.value || rerunCascadeLoading.value) return false
    rerunCascadeLoading.value = true
    rerunCascadeError.value = ''
    try {
      const updated = await (options.updateStatus ?? updateTenantStatusDefault)(
        options.tenantId,
        'CLOSED',
      )
      options.commitTenant(updated)
      const refreshed = await options.refreshCascadeState()
      if (refreshed === 'failed') {
        const message = `Cascade re-run committed, but verification failed: ${options.error.value}`
        rerunCascadeError.value = message
        options.notify.warning(message)
        return true
      }
      if (refreshed === 'superseded') {
        const message = 'Cascade re-run committed, but verification was superseded by a newer view update'
        rerunCascadeError.value = message
        options.notify.warning(message)
        return true
      }

      const remaining = cascadePending.value.total
      if (remaining === 0) {
        if (options.cascadePartial.value) {
          options.notify.warning(
            `Cascade re-run complete — verification remains partial within the ${TENANT_DETAIL_SCAN_MAX_ROWS.toLocaleString()}-row scan bound`,
          )
        } else {
          options.notify.success('Cascade complete — all owned objects terminal')
        }
      } else {
        const qualifier = options.cascadePartial.value ? 'at least ' : ''
        options.notify.success(
          `Cascade re-run — ${qualifier}${remaining} object${remaining === 1 ? '' : 's'} still non-terminal; retry may be needed`,
        )
      }
      pendingRerunCascadeState.value = false
      return true
    } catch (cause) {
      const message = toMessage(cause)
      rerunCascadeError.value = message
      options.notify.error(`Cascade re-run failed: ${message}`)
      return false
    } finally {
      rerunCascadeLoading.value = false
    }
  }

  async function openEmergencyFreeze(): Promise<boolean> {
    if (
      options.canArm?.() === false
      || isMutationRunning.value
      || hasPendingLifecycleAction()
    ) return false
    if (isTerminalTenant(options.tenant.value)) return false
    emergencyFreezePreparing.value = true
    try {
      // Confirmation owns a fresh completed scan, never an ambient poll's
      // potentially partial collection.
      const scanResult = await options.refreshBudgets()
      if (scanResult === 'failed') {
        options.notify.error(
          `Emergency Freeze unavailable — budget scan failed: ${options.error.value}`,
        )
        return false
      }
      if (scanResult === 'superseded') {
        options.notify.warning(
          'Emergency Freeze scan was superseded by a newer view update — retry when the page settles',
        )
        return false
      }
      if (options.budgetsPartial.value) {
        options.notify.error(
          `Emergency Freeze unavailable — the budget scan could not complete within ${TENANT_DETAIL_SCAN_MAX_ROWS.toLocaleString()} rows`,
        )
        return false
      }

      const targets = Object.freeze(activeBudgets.value.map(b => Object.freeze({
        ledger_id: b.ledger_id,
        tenant_id: b.tenant_id,
        scope: b.scope,
        unit: b.unit,
      })))
      if (targets.length === 0) {
        options.notify.warning('Emergency Freeze not needed — no ACTIVE budgets remain')
        return false
      }
      emergencyFreezeTargetsState.value = targets
      pendingEmergencyFreezeState.value = true
      return true
    } finally {
      emergencyFreezePreparing.value = false
    }
  }

  async function executeEmergencyFreeze(): Promise<boolean> {
    if (!pendingEmergencyFreezeState.value || emergencyFreezeRunning.value) return false
    const targets = emergencyFreezeTargetsState.value.slice()
    if (targets.length === 0) return false

    emergencyFreezeProgress.value = { done: 0, total: targets.length, failed: 0 }
    emergencyFreezeRunning.value = true
    emergencyFreezeAbort = new AbortController()
    const settledSucceeded: number[] = []

    let result: BatchResult
    try {
      result = await (options.runBatch ?? rateLimitedBatchDefault)(
        targets,
        async (budget, index) => {
          // Keep the structured tag stable: operators can grep one token
          // across the audit stream; the suffix identifies this dashboard flow.
          await (options.freeze ?? freezeBudgetDefault)(
            budget.scope,
            budget.unit,
            '[EMERGENCY_FREEZE] Tenant lockdown via admin dashboard',
          )
          settledSucceeded.push(index)
        },
        {
          signal: emergencyFreezeAbort.signal,
          onProgress: (done, total, failed) => {
            emergencyFreezeProgress.value = { done, total, failed }
          },
        },
      )
    } catch (cause) {
      // The production batch runner converts per-row failures into BatchResult,
      // but retain a terminal path for an unexpected runner-level rejection.
      // Some writes may already have committed, so close the reviewed snapshot
      // and refresh instead of making the whole batch blindly retryable.
      const message = toMessage(cause)
      emergencyFreezeRunning.value = false
      emergencyFreezeAbort = null
      pendingEmergencyFreezeState.value = false
      emergencyFreezeTargetsState.value = []
      options.reportError(
        `Emergency Freeze could not finish: ${message}. Some rows may have committed.`,
      )
      options.notify.error(
        `Emergency Freeze could not finish: ${message}. Refreshing to verify any committed rows.`,
      )
      emergencyFreezeSettling.value = true
      try {
        warnRefreshSettlement(await options.refreshBudgets(), 'Emergency Freeze attempted')
      } finally {
        emergencyFreezeSettling.value = false
      }
      return false
    }

    emergencyFreezeRunning.value = false
    emergencyFreezeAbort = null
    const succeeded = result.done - result.failed
    const summary = `${succeeded}/${emergencyFreezeProgress.value.total} budgets frozen`
    if (result.failed > 0) {
      options.notify.error(`${summary}, ${result.failed} failed — see details`)
    } else if (result.cancelled) {
      options.notify.success(`${summary} (cancelled by user)`)
    } else {
      options.notify.success(summary)
    }

    pendingEmergencyFreezeState.value = false
    emergencyFreezeTargetsState.value = []
    if (result.failed > 0 || result.cancelled) {
      const labels: Record<string, string> = {}
      for (const budget of targets) labels[budget.ledger_id] = `${budget.scope} (${budget.unit})`
      emergencyFreezeResultState.value = {
        actionVerb: 'Emergency Freeze',
        response: synthesizeRowSelectBulkResult({
          targets,
          result,
          succeededIndices: settledSucceeded,
          idOf: budget => budget.ledger_id,
        }),
        labelById: labels,
        tenantId: options.tenantId,
      }
    }

    // The dialog may close before the read settles, but polling must not own a
    // competing publication window. Keep a private settlement bit until the
    // mutation-owned refresh finishes.
    emergencyFreezeSettling.value = true
    try {
      warnRefreshSettlement(await options.refreshBudgets(), 'Budgets frozen')
    } finally {
      emergencyFreezeSettling.value = false
    }
    return true
  }

  function cancelEmergencyFreeze(): void {
    if (emergencyFreezeRunning.value) {
      emergencyFreezeAbort?.abort()
      return
    }
    if (emergencyFreezePreparing.value || emergencyFreezeSettling.value) return
    pendingEmergencyFreezeState.value = false
    emergencyFreezeTargetsState.value = []
  }

  function closeEmergencyFreezeResult(): void {
    emergencyFreezeResultState.value = null
  }

  return {
    activeBudgets,
    cascadePending,
    cascadePreview,
    showRecoveryBanner,
    isMutationRunning,
    lifecycleArmed,
    pendingTenantAction,
    closeConfirmInput,
    tenantActionLoading: readonly(tenantActionLoading),
    requestTenantAction,
    cancelTenantAction,
    executeTenantAction,
    pendingRerunCascade,
    rerunCascadeLoading: readonly(rerunCascadeLoading),
    rerunCascadeError: readonly(rerunCascadeError),
    openRerunCascade,
    cancelRerunCascade,
    rerunCascade,
    pendingEmergencyFreeze,
    emergencyFreezePreparing: readonly(emergencyFreezePreparing),
    emergencyFreezeRunning: readonly(emergencyFreezeRunning),
    emergencyFreezeProgress: readonly(emergencyFreezeProgress),
    emergencyFreezeTargets,
    emergencyFreezeResult,
    openEmergencyFreeze,
    executeEmergencyFreeze,
    cancelEmergencyFreeze,
    closeEmergencyFreezeResult,
  }
}

<script setup lang="ts">
import { ref, computed, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useFocusTrap } from '../composables/useFocusTrap'
import { useTerminalAwareList } from '../composables/useTerminalAwareList'
import {
  TENANT_DETAIL_SCAN_MAX_ROWS,
  useTenantDetailData,
  type TenantDetailRefreshResult,
  type TenantDetailTab,
} from '../composables/useTenantDetailData'
import { useTenantLifecycle } from '../composables/useTenantLifecycle'
import { useTenantApiKeys } from '../composables/useTenantApiKeys'
import { useTenantPolicies } from '../composables/useTenantPolicies'
import { updateTenant, createBudget } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { TenantUpdateRequest, BudgetLedger, ApiKey, Policy, BudgetCreateRequest } from '../types'
import { COMMIT_OVERAGE_POLICIES } from '../types'
import { validateScope } from '../utils/safe'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import MaskedValue from '../components/MaskedValue.vue'
import EmptyState from '../components/EmptyState.vue'
import LoadingSkeleton from '../components/LoadingSkeleton.vue'
import InlineErrorBanner from '../components/InlineErrorBanner.vue'
import ConfirmAction from '../components/ConfirmAction.vue'
import FormDialog from '../components/FormDialog.vue'
import TenantApiKeyDialogs from '../components/TenantApiKeyDialogs.vue'
import TenantPolicyDialogs from '../components/TenantPolicyDialogs.vue'
import ScopeBuilder from '../components/ScopeBuilder.vue'
import RowActionsMenu from '../components/RowActionsMenu.vue'
import { writeClipboardJson } from '../utils/clipboard'
import { useToast } from '../composables/useToast'
import { toMessage } from '../utils/errors'
import { isTerminalTenant } from '../utils/tenantStatus'
import BulkActionResultDialog from '../components/BulkActionResultDialog.vue'
import BackArrowIcon from '../components/icons/BackArrowIcon.vue'

const toast = useToast()

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const id = route.params.id as string
const canManageTenants = computed(() => auth.capabilities?.manage_tenants !== false)
const canManageKeys = computed(() => auth.capabilities?.manage_api_keys !== false)
// v0.1.25.20: Create Budget + Create/Edit Policy buttons gated on the
// matching capability flags. Both default to "allow" when undefined so
// older admin servers (pre-v0.1.25.14) keep working.
const canManageBudgets = computed(() => auth.capabilities?.manage_budgets !== false)
const canManagePolicies = computed(() => auth.capabilities?.manage_policies !== false)

const tab = ref<TenantDetailTab>('budgets')
// The acquisition composable's first test tick can run synchronously. The
// mutation owners are wired immediately after acquisition exists; until then
// no mutation can have started, so the safe bootstrap answer is false.
let tenantMutationRunning = () => false
let apiKeyOwnerArmed = () => false
let policyOwnerArmed = () => false

// Breadcrumb back-link origin. When the operator clicks a child tenant
// from another tenant's "Children" list, the link threads ?parent=<src>
// so the back arrow here returns to that source instead of defaulting to
// the flat /tenants list. Same pattern applied in TenantsView for the
// "+N more" deep-link. Only single-hop; deeper A→B→C→… chains return to
// the immediately-previous tenant, not the full breadcrumb root.
const parentFromQuery = computed<string | null>(() => {
  const p = route.query.parent
  return typeof p === 'string' && p ? p : null
})
function goBack() {
  if (parentFromQuery.value) {
    router.push({ name: 'tenant-detail', params: { id: parentFromQuery.value } })
    return
  }
  // Prefer browser-back so any filter state the operator set on
  // TenantsView (e.g. status=ACTIVE, parent=foo) is restored — the
  // filter refs on TenantsView mirror into URL query, so the previous
  // history entry already carries them. Fall back to a plain push
  // when there's no prior history (direct-link entry to /tenants/:id).
  if (typeof window !== 'undefined' && window.history.length > 1) {
    router.back()
  } else {
    router.push({ name: 'tenants' })
  }
}

// Cursor-aware acquisition owns every child collection and its completeness
// bit. The view keeps presentation and all mutation forms.
const {
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
  beginMutation,
  commitTenant,
  commitApiKey,
  commitPolicy,
  reportError,
  dismissError,
} = useTenantDetailData({
  tenantId: id,
  getActiveTab: () => tab.value,
  isMutationRunning: () => tenantMutationRunning(),
})

const tenantLifecycle = useTenantLifecycle({
  tenantId: id,
  tenant,
  budgets,
  apiKeys,
  webhooks,
  budgetsPartial,
  cascadePartial,
  error,
  refreshTenant,
  refreshBudgets,
  refreshCascadeState,
  commitTenant,
  reportError,
  dismissError,
  notify: toast,
  canArm: () => !apiKeyOwnerArmed() && !policyOwnerArmed(),
})

const tenantApiKeys = useTenantApiKeys({
  tenantId: id,
  apiKeys,
  error,
  refreshApiKeys,
  beginMutation,
  commitApiKey,
  notify: toast,
  canArm: () => (
    !tenantLifecycle.lifecycleArmed.value
    && !policyOwnerArmed()
    && !isTerminalTenant(tenant.value)
  ),
})

const tenantPolicies = useTenantPolicies({
  tenantId: id,
  tenant,
  policies,
  error,
  refreshPolicies,
  beginMutation,
  commitPolicy,
  notify: toast,
  canArm: () => (
    !tenantLifecycle.lifecycleArmed.value
    && !apiKeyOwnerArmed()
  ),
})
apiKeyOwnerArmed = () => tenantApiKeys.ownerArmed.value
policyOwnerArmed = () => tenantPolicies.ownerArmed.value
tenantMutationRunning = () => (
  tenantLifecycle.isMutationRunning.value
  || tenantApiKeys.isMutationRunning.value
  || tenantPolicies.isMutationRunning.value
)

const {
  activeBudgets,
  cascadePending,
  cascadePreview,
  showRecoveryBanner,
  pendingTenantAction,
  closeConfirmInput,
  tenantActionLoading,
  requestTenantAction,
  cancelTenantAction,
  executeTenantAction,
  pendingRerunCascade,
  rerunCascadeLoading,
  rerunCascadeError,
  openRerunCascade,
  cancelRerunCascade,
  rerunCascade,
  pendingEmergencyFreeze,
  emergencyFreezePreparing,
  emergencyFreezeRunning,
  emergencyFreezeProgress,
  emergencyFreezeTargets,
  emergencyFreezeResult,
  openEmergencyFreeze,
  executeEmergencyFreeze,
  cancelEmergencyFreeze,
  closeEmergencyFreezeResult,
} = tenantLifecycle

const {
  ownerArmed: apiKeyOwnerBusy,
  pendingRevoke: pendingKeyRevoke,
  revokeLoading: keyRevokeLoading,
  revokeError: keyRevokeError,
  requestRevoke: requestKeyRevoke,
  cancelRevoke: cancelKeyRevoke,
  executeRevoke: executeKeyRevoke,
  showCreate: showCreateKey,
  createLoading: createKeyLoading,
  createError: createKeyError,
  createForm: createKeyForm,
  createdSecret: createdKeySecret,
  openCreate: openCreateKey,
  cancelCreate: cancelCreateKey,
  submitCreate: submitCreateKey,
  closeCreatedSecret: closeCreatedKeySecret,
  editingKey,
  editLoading: editKeyLoading,
  editError: editKeyError,
  editForm: editKeyForm,
  pendingPermissionAdds: pendingKeyPermAdds,
  pendingPermissionRemoves: pendingKeyPermRemoves,
  openEdit: openEditKey,
  cancelEdit: cancelEditKey,
  submitEdit: submitEditKey,
} = tenantApiKeys

const {
  ownerArmed: policyOwnerBusy,
  showCreate: showCreatePolicy,
  createLoading: createPolicyLoading,
  createError: createPolicyError,
  createForm: createPolicyForm,
  createAdvanced: createPolicyAdvanced,
  openCreate: openCreatePolicy,
  cancelCreate: cancelCreatePolicy,
  submitCreate: submitCreatePolicy,
  editingPolicy,
  editLoading: editPolicyLoading,
  editError: editPolicyError,
  editForm: editPolicyForm,
  editAdvanced: editPolicyAdvanced,
  editHasAdvanced: editPolicyHasAdvanced,
  openEdit: openEditPolicy,
  cancelEdit: cancelEditPolicy,
  submitEdit: submitEditPolicy,
} = tenantPolicies

const lifecycleActionsBlocked = computed(() => (
  tenantLifecycle.lifecycleArmed.value || apiKeyOwnerBusy.value || policyOwnerBusy.value
))
const apiKeyActionsBlocked = computed(() => (
  isTerminalTenant(tenant.value)
  || apiKeyOwnerBusy.value
  || tenantLifecycle.lifecycleArmed.value
  || policyOwnerBusy.value
))
const apiKeyActionBlockedReason = computed(() => (
  isTerminalTenant(tenant.value)
    ? 'Closed tenants are permanently read-only'
    : tenantLifecycle.lifecycleArmed.value
      ? 'Finish the current tenant action first'
      : policyOwnerBusy.value
        ? 'Finish the current policy action first'
        : apiKeyOwnerBusy.value
          ? 'Finish the current API-key action first'
          : ''
))
const policyActionsBlocked = computed(() => (
  isTerminalTenant(tenant.value)
  || policyOwnerBusy.value
  || tenantLifecycle.lifecycleArmed.value
  || apiKeyOwnerBusy.value
))
const policyActionBlockedReason = computed(() => (
  isTerminalTenant(tenant.value)
    ? 'Closed tenants are permanently read-only'
    : tenantLifecycle.lifecycleArmed.value
      ? 'Finish the current tenant action first'
      : apiKeyOwnerBusy.value
        ? 'Finish the current API-key action first'
        : policyOwnerBusy.value
          ? 'Finish the current policy action first'
          : ''
))

// v0.1.25.46: hide terminal rows in the embedded sub-lists by default.
// Pre-fix, the budgets/keys tables rendered in whatever order the API
// returned — CLOSED budgets and REVOKED keys mixed in with ACTIVE ones,
// making the "what can I still act on" question harder than it should
// be. The toggle is sub-list-scoped (not URL-mirrored) because the
// TenantDetailView is a single URL destination — no drill-in → back
// problem to solve here, and the operator picks a setting per-tenant
// rather than persisting it across views.
const {
  visibleRows: visibleBudgets,
  includeTerminal: includeTerminalBudgets,
  terminalCount: terminalBudgetsCount,
  terminalVerb: terminalBudgetsVerb,
} = useTerminalAwareList<BudgetLedger>({
  kind: 'budget',
  source: budgets,
  statusOf: b => b.status,
})
const {
  visibleRows: visibleApiKeys,
  includeTerminal: includeTerminalKeys,
  terminalCount: terminalKeysCount,
  terminalVerb: terminalKeysVerb,
} = useTerminalAwareList<ApiKey>({
  kind: 'apiKey',
  source: apiKeys,
  statusOf: k => k.status,
})

// The initial tick scans every child axis to seed truthful badge/cascade
// state. Steady polls always scan budgets + tenant hierarchy, refresh only
// the active key/policy tab, and add key/webhook scans while CLOSED.

// v0.1.25.21 (#6): spend rollup — aggregate allocated / remaining /
// spent / debt across the tenant's budgets, grouped by unit. Budgets in
// different units are summed separately because adding TOKENS to
// USD_MICROCENTS would be meaningless. ACTIVE-only because FROZEN /
// CLOSED budgets shouldn't skew the "current capacity" view.
const rollupByUnit = computed(() => {
  const out: Record<string, { allocated: number; remaining: number; spent: number; debt: number; count: number }> = {}
  for (const b of budgets.value) {
    if (b.status !== 'ACTIVE') continue
    const u = b.unit
    if (!out[u]) out[u] = { allocated: 0, remaining: 0, spent: 0, debt: 0, count: 0 }
    out[u].allocated += b.allocated.amount
    out[u].remaining += b.remaining.amount
    out[u].spent += (b.spent?.amount ?? 0)
    out[u].debt += (b.debt?.amount ?? 0)
    out[u].count++
  }
  return out
})
const rollupUnits = computed(() => Object.keys(rollupByUnit.value).sort())

const childTenants = computed(() =>
  allTenants.value.filter(t => t.parent_tenant_id === id),
)

function tabCountLabel(target: TenantDetailTab): string {
  const [count, partial] = target === 'budgets'
    ? [budgets.value.length, budgetsPartial.value]
    : target === 'keys'
      ? [apiKeys.value.length, apiKeysPartial.value]
      : [policies.value.length, policiesPartial.value]
  return `${count.toLocaleString()}${partial ? '+' : ''}`
}

function selectTab(target: TenantDetailTab): void {
  if (tab.value === target) return
  tab.value = target
  // The initial scan seeds every tab. Subsequent activation runs a dedicated
  // refresh so an in-flight poll for the previous tab cannot swallow it.
  if (target === 'budgets') void refreshBudgets()
  else if (target === 'keys') void refreshApiKeys()
  else void refreshPolicies()
}

const partialCascadeAxes = computed(() => [
  budgetsPartial.value ? 'budgets' : '',
  webhooksPartial.value ? 'webhooks' : '',
  apiKeysPartial.value ? 'API keys' : '',
].filter(Boolean).join(', '))

function warnRefreshSettlement(result: TenantDetailRefreshResult, committedLabel: string): void {
  if (result === 'applied') return
  if (result === 'failed') {
    toast.warning(`${committedLabel}, but refresh failed: ${error.value}`)
  } else {
    toast.warning(`${committedLabel}; its refresh was superseded by a newer view update`)
  }
}

// A11y for the hand-rolled CLOSE dialog — parity with what
// ConfirmAction gets from being a dedicated component. useFocusTrap
// (which activates on closeDialogRef populate) owns the whole focus
// contract: Tab cycling, initial focus (its first-focusable target IS
// the typed-confirmation input — nothing focusable precedes it in the
// dialog), and restoring focus to the trigger on close. Only the
// document-level Escape (gated on in-flight) is added here — a second
// manual save/restore alongside the trap ran a duplicate restore on
// every close.
const closeDialogRef = ref<HTMLElement | null>(null)
useFocusTrap(closeDialogRef)
function onCloseDialogKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') cancelTenantAction()
}
watch(() => pendingTenantAction.value === 'CLOSED', (open, was) => {
  if (open && !was) {
    document.addEventListener('keydown', onCloseDialogKeydown)
  } else if (!open && was) {
    document.removeEventListener('keydown', onCloseDialogKeydown)
  }
})
onUnmounted(() => document.removeEventListener('keydown', onCloseDialogKeydown))

async function copyKeyId(keyId: string) {
  try {
    await navigator.clipboard.writeText(keyId)
    toast.success('Key ID copied')
  } catch {
    toast.error('Copy failed — clipboard unavailable')
  }
}

async function copyApiKeyJson(k: ApiKey) {
  if (await writeClipboardJson(k)) toast.success('API key JSON copied')
  else toast.error('Copy failed — clipboard unavailable')
}

async function copyPolicyJson(p: Policy) {
  if (await writeClipboardJson(p)) toast.success('Policy JSON copied')
  else toast.error('Copy failed — clipboard unavailable')
}

// Edit tenant. No reservation_expiry_policy field — the spec's PATCH
// body is additionalProperties:false and the policy is create-only
// (TenantCreateRequest); the server would silently drop it (200 OK,
// policy unchanged). The dialog shows it read-only instead.
const showEditTenant = ref(false)
const editTenantLoading = ref(false)
const editTenantError = ref('')
const editTenantForm = ref({ name: '', default_commit_overage_policy: '', default_reservation_ttl_ms: '', max_reservation_ttl_ms: '', max_reservation_extensions: '' })

function openEditTenant() {
  const t = tenant.value
  editTenantForm.value = {
    name: t?.name || '',
    default_commit_overage_policy: t?.default_commit_overage_policy || '',
    default_reservation_ttl_ms: t?.default_reservation_ttl_ms != null ? String(t.default_reservation_ttl_ms) : '',
    max_reservation_ttl_ms: t?.max_reservation_ttl_ms != null ? String(t.max_reservation_ttl_ms) : '',
    max_reservation_extensions: t?.max_reservation_extensions != null ? String(t.max_reservation_extensions) : '',
  }
  editTenantError.value = ''
  showEditTenant.value = true
}

async function submitEditTenant() {
  editTenantError.value = ''
  editTenantLoading.value = true
  try {
    const body: TenantUpdateRequest = { name: editTenantForm.value.name }
    if (editTenantForm.value.default_commit_overage_policy) body.default_commit_overage_policy = editTenantForm.value.default_commit_overage_policy
    if (editTenantForm.value.default_reservation_ttl_ms) body.default_reservation_ttl_ms = Number(editTenantForm.value.default_reservation_ttl_ms)
    if (editTenantForm.value.max_reservation_ttl_ms) body.max_reservation_ttl_ms = Number(editTenantForm.value.max_reservation_ttl_ms)
    // Explicit blank check, not a truthy guard: the type=number v-model
    // coerces an entered 0 to the number 0 (falsy), and 0 is the natural
    // "disable extensions" value an operator must be able to set.
    if (String(editTenantForm.value.max_reservation_extensions).trim() !== '') body.max_reservation_extensions = Number(editTenantForm.value.max_reservation_extensions)
    // reservation_expiry_policy is never sent — create-only per spec.
    commitTenant(await updateTenant(id, body))
    toast.success('Tenant updated')
    showEditTenant.value = false
  } catch (e) { editTenantError.value = toMessage(e) }
  finally { editTenantLoading.value = false }
}

// v0.1.25.20: Create Budget — admin-on-behalf-of (server v0.1.25.14, spec
// v0.1.25.13). Tenant_id is supplied by the API client wrapper from the
// route param; the form is tenant-agnostic. Allocation is bound as a
// number (Vue v-model on type=number coerces — see feedback memory on
// that), so we coerce defensively at submit.
const showCreateBudget = ref(false)
const createBudgetLoading = ref(false)
const createBudgetError = ref('')
const createBudgetForm = ref<{
  scope: string
  unit: string
  allocated: number | string
  overdraft_limit: number | string
  commit_overage_policy: string
}>({
  scope: '',
  unit: 'USD_MICROCENTS',
  allocated: '',
  overdraft_limit: '',
  commit_overage_policy: '',
})

function openCreateBudget() {
  // Pre-fill scope with `tenant:<id>` so the user only fills the suffix
  // (workspace, agent, etc) — the most common shape and the one that
  // satisfies the server's `tenant:*` requirement out of the box.
  createBudgetForm.value = {
    scope: `tenant:${id}`,
    unit: 'USD_MICROCENTS',
    allocated: '',
    overdraft_limit: '',
    commit_overage_policy: '',
  }
  createBudgetError.value = ''
  showCreateBudget.value = true
}

async function submitCreateBudget() {
  if (createBudgetLoading.value) return
  createBudgetError.value = ''
  const allocated = Number(createBudgetForm.value.allocated)
  if (!Number.isFinite(allocated) || allocated <= 0) {
    createBudgetError.value = 'Allocated amount must be a positive number'
    return
  }
  if (!createBudgetForm.value.scope.trim()) {
    createBudgetError.value = 'Scope is required'
    return
  }
  // Client-side scope grammar check — mirrors server's ScopeValidator
  // (cycles-server-admin v0.1.25.15). Catches typos like "agentic" for
  // "agent" before the round-trip, and steers toward the canonical
  // kind set without the user having to remember it. The server remains
  // the source of truth and will re-validate.
  const scopeError = validateScope(createBudgetForm.value.scope.trim(), { fieldName: 'Scope' })
  if (scopeError) { createBudgetError.value = scopeError; return }
  const body: BudgetCreateRequest = {
    scope: createBudgetForm.value.scope.trim(),
    unit: createBudgetForm.value.unit,
    allocated: { unit: createBudgetForm.value.unit, amount: allocated },
  }
  // overdraft is optional — only include when > 0 to avoid the server
  // recording an explicit zero where "unset" was intended.
  const od = Number(createBudgetForm.value.overdraft_limit)
  if (Number.isFinite(od) && od > 0) {
    body.overdraft_limit = { unit: createBudgetForm.value.unit, amount: od }
  }
  if (createBudgetForm.value.commit_overage_policy) {
    body.commit_overage_policy = createBudgetForm.value.commit_overage_policy
  }
  createBudgetLoading.value = true
  try {
    await createBudget(id, body)
    showCreateBudget.value = false
    toast.success('Budget created')
    warnRefreshSettlement(await refreshBudgets(), 'Budget created')
  } catch (e) { createBudgetError.value = toMessage(e) }
  finally { createBudgetLoading.value = false }
}

</script>

<template>
  <div>
    <PageHeader title="Tenant Detail" :subtitle="tenant?.tenant_id" :loading="isLoading" :last-updated-at="lastSuccessAt" @refresh="refresh">
      <template #back>
        <button @click="goBack" :aria-label="parentFromQuery ? `Back to parent tenant ${parentFromQuery}` : 'Back to tenants'" class="muted hover:text-gray-700 cursor-pointer">
          <BackArrowIcon class="w-5 h-5" />
        </button>
      </template>
    </PageHeader>
    <InlineErrorBanner v-if="error" :message="error" @dismiss="dismissError" />

    <!-- P0-C2: dedicated not-found card. Separate from the error banner
         because a 404 is not a transient failure — the URL is wrong and
         retry-then-refresh doesn't help. The "Back to tenants" button
         uses goBack so a parent-scoped breadcrumb is preserved. -->
    <div
      v-if="notFound"
      class="bg-white dark:bg-gray-900 rounded-lg shadow p-8 text-center"
      data-testid="tenant-not-found"
    >
      <p class="text-lg font-medium text-gray-900 dark:text-white">Tenant not found</p>
      <p class="muted-sm mt-2">
        No tenant with ID <span class="font-mono">{{ id }}</span> exists or is visible to your session.
      </p>
      <button type="button" class="btn-pill-primary mt-4" @click="goBack">Back to tenants</button>
    </div>

    <!-- P0-C2: cold-load skeleton. Pre-fix, a slow first fetch left the
         page blank below the header for 1–2s, indistinguishable from a
         real failure. LoadingSkeleton matches the dense-counter +
         list-shell shape of the loaded view. -->
    <LoadingSkeleton
      v-else-if="!initialLoadDone && !error"
      data-testid="tenant-initial-loading"
    />

    <!-- Tombstone banner: spec v0.1.25.29 Rule 2. A CLOSED tenant and
         everything it owns are permanently read-only; every mutating op
         against them 409s with TENANT_CLOSED. We surface this once, up
         top, so operators don't burn a round-trip per disabled button
         trying to figure out why their edits fail. -->
    <!-- Recovery banner sits ABOVE the tombstone: actionable state
         outranks informational-final state (Gmail/Linear/GitHub
         convention). Tombstone palette is demoted to amber-200 so the
         recovery banner wins the visual hierarchy despite both being
         amber. Banner renders for all roles so a read-only operator
         paged into triage can at least see the signal and escalate;
         the action button is gated on `manage_tenants`. -->
    <div v-if="showRecoveryBanner" class="mb-4 bg-amber-50 border border-amber-400 rounded-lg px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/50 dark:border-amber-600 dark:text-amber-100" role="status" data-testid="cascade-recovery-banner">
      <p class="font-medium mb-1">{{ cascadePending.total > 0 ? 'Cascade incomplete' : 'Cascade verification incomplete' }}</p>
      <p v-if="cascadePending.total > 0" class="text-xs mb-2">
        This tenant is CLOSED but
        <template v-if="cascadePending.budgets > 0"><strong>{{ cascadePending.budgets }}</strong> budget{{ cascadePending.budgets === 1 ? '' : 's' }}</template><template v-if="cascadePending.budgets > 0 && (cascadePending.webhooks > 0 || cascadePending.apiKeys > 0)">, </template><template v-if="cascadePending.webhooks > 0"><strong>{{ cascadePending.webhooks }}</strong> webhook{{ cascadePending.webhooks === 1 ? '' : 's' }}</template><template v-if="cascadePending.webhooks > 0 && cascadePending.apiKeys > 0">, </template><template v-if="cascadePending.apiKeys > 0"><strong>{{ cascadePending.apiKeys }}</strong> API key{{ cascadePending.apiKeys === 1 ? '' : 's' }}</template>
        {{ cascadePending.total === 1 ? 'is' : 'are' }} still non-terminal. Re-running the cascade drives the remaining objects to their terminal states (spec v0.1.25.31 Rule 1(c)).
      </p>
      <p v-if="cascadePartial" class="text-xs mb-2" data-testid="cascade-partial-warning">
        Scanned up to {{ TENANT_DETAIL_SCAN_MAX_ROWS.toLocaleString() }} rows on {{ partialCascadeAxes }} without reaching a complete continuation. Counts are lower bounds, and additional non-terminal objects may exist.
      </p>
      <button
        v-if="canManageTenants"
        @click="openRerunCascade"
        :disabled="lifecycleActionsBlocked"
        class="btn-pill-danger disabled:opacity-50 disabled:cursor-not-allowed"
        data-testid="cascade-recovery-button"
      >{{ rerunCascadeLoading ? 'Re-running…' : 'Re-run cascade' }}</button>
      <p v-else class="text-xs muted italic">Read-only view — ask an operator with manage-tenants access to re-run the cascade.</p>
    </div>

    <div v-if="isTerminalTenant(tenant)" class="mb-4 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:border-amber-800 dark:text-amber-200" role="status">
      <strong>Tenant closed.</strong> The tenant and its owned objects are permanently read-only. Per spec v0.1.25.29, there is no re-open path.
    </div>

    <template v-if="tenant">
      <div class="bg-white rounded-lg shadow p-6 mb-4">
        <div class="flex items-center gap-3 mb-2 flex-wrap">
          <h2 class="text-lg font-medium text-gray-900">{{ tenant.name }}</h2>
          <StatusBadge :status="tenant.status" />
          <span class="flex-1" />
          <div class="flex gap-2 flex-wrap">
            <!-- Active-tab "Create X" primary action sits here alongside
                 the tenant-level actions (Edit/Suspend/Close) so every
                 primary affordance is in the same header row — matches
                 WebhooksView's "Create Webhook" placement. Contextual:
                 only the current tab's creator shows, keeping the header
                 uncluttered. -->
            <button v-if="tab === 'budgets' && canManageBudgets" @click="openCreateBudget" class="text-xs bg-blue-600 text-white hover:bg-blue-700 rounded px-3 py-1.5 cursor-pointer transition-colors">Create Budget</button>
            <button v-if="tab === 'keys' && canManageKeys" @click="openCreateKey" :disabled="apiKeyActionsBlocked" :title="apiKeyActionBlockedReason || undefined" class="text-xs bg-blue-600 text-white hover:bg-blue-700 rounded px-3 py-1.5 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed">Create API Key</button>
            <button v-if="tab === 'policies' && canManagePolicies" @click="openCreatePolicy" :disabled="policyActionsBlocked" :title="policyActionBlockedReason || undefined" class="text-xs bg-blue-600 text-white hover:bg-blue-700 rounded px-3 py-1.5 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed">Create Policy</button>
            <template v-if="canManageTenants">
              <button @click="openEditTenant" class="btn-pill-secondary">Edit</button>
              <!-- #7 Emergency Freeze: only shown if there are ACTIVE budgets
                   to freeze. Otherwise the button would just confirm a no-op. -->
              <button
                v-if="canManageBudgets && !isTerminalTenant(tenant) && (activeBudgets.length > 0 || budgetsPartial)"
                @click="openEmergencyFreeze"
                :disabled="lifecycleActionsBlocked"
                :title="budgetsPartial ? `Re-scan required because the last budget scan could not complete within ${TENANT_DETAIL_SCAN_MAX_ROWS.toLocaleString()} rows` : 'Scan ACTIVE budgets and review the immutable target count'"
                class="btn-pill-danger disabled:opacity-50 disabled:cursor-not-allowed"
              >{{ emergencyFreezePreparing ? 'Scanning budgets…' : budgetsPartial ? 'Emergency Freeze (re-scan)' : `Emergency Freeze (${activeBudgets.length})` }}</button>
              <button v-if="tenant.status === 'ACTIVE'" @click="requestTenantAction('SUSPENDED')" :disabled="lifecycleActionsBlocked" class="btn-pill-danger disabled:opacity-50 disabled:cursor-not-allowed">Suspend</button>
              <button v-if="tenant.status === 'SUSPENDED'" @click="requestTenantAction('ACTIVE')" :disabled="lifecycleActionsBlocked" class="btn-pill-success disabled:opacity-50 disabled:cursor-not-allowed">Reactivate</button>
              <button v-if="tenant.status !== 'CLOSED'" @click="requestTenantAction('CLOSED')" :disabled="lifecycleActionsBlocked" class="btn-pill-danger disabled:opacity-50 disabled:cursor-not-allowed">Close</button>
            </template>
          </div>
        </div>
        <p class="text-sm muted font-mono">{{ tenant.tenant_id }}</p>
        <!-- Hierarchy: parent link + child list (#2). Children show only
             the first 6 inline; if there are more, a "View all" link
             drops into TenantsView filtered by this tenant as parent. -->
        <p v-if="tenant.parent_tenant_id" class="text-sm muted mt-1">
          Parent: <router-link :to="{ name: 'tenant-detail', params: { id: tenant.parent_tenant_id } }" class="text-blue-600 hover:underline">{{ tenant.parent_tenant_id }}</router-link>
        </p>
        <div v-if="childTenants.length > 0 || tenantsPartial" class="text-sm muted mt-2 flex items-center gap-1 flex-wrap">
          <span class="muted">Children ({{ childTenants.length.toLocaleString() }}{{ tenantsPartial ? '+' : '' }}):</span>
          <router-link
            v-for="c in childTenants.slice(0, 6)"
            :key="c.tenant_id"
            :to="{ name: 'tenant-detail', params: { id: c.tenant_id }, query: { parent: tenant.tenant_id } }"
            class="text-blue-600 hover:underline text-xs font-mono"
          >{{ c.tenant_id }}</router-link>
          <router-link v-if="childTenants.length > 6 || tenantsPartial" :to="{ name: 'tenants', query: { parent: tenant.tenant_id } }" class="muted-sm hover:text-gray-700 hover:underline">{{ tenantsPartial ? 'View all…' : `… +${childTenants.length - 6} more` }}</router-link>
        </div>
      </div>

      <!-- Spend rollup (#6). Grouped by unit because adding TOKENS to
           USD_MICROCENTS would be meaningless. Utilization % is
           calculated from the sum, not averaged across budgets — the
           more-informative view for "how close is this tenant to its
           allocated capacity overall." -->
      <div v-if="rollupUnits.length > 0" class="card p-4 mb-4">
        <div class="flex items-baseline gap-2 mb-3 flex-wrap">
          <h3 class="text-sm font-medium text-gray-700">Spend rollup (ACTIVE budgets)</h3>
          <span v-if="budgetsPartial" class="text-xs text-amber-700 dark:text-amber-300" data-testid="budget-rollup-partial">Lower bound — scan incomplete within {{ TENANT_DETAIL_SCAN_MAX_ROWS.toLocaleString() }} rows</span>
        </div>
        <div class="space-y-3">
          <div v-for="u in rollupUnits" :key="u" class="grid grid-cols-5 gap-3 text-sm items-baseline">
            <div class="col-span-1">
              <div class="muted-sm">{{ u }}</div>
              <div class="muted-sm">{{ rollupByUnit[u].count }} ledger{{ rollupByUnit[u].count === 1 ? '' : 's' }}</div>
            </div>
            <div><div class="muted-sm">Allocated</div><div class="font-semibold tabular-nums">{{ rollupByUnit[u].allocated.toLocaleString() }}</div></div>
            <div><div class="muted-sm">Remaining</div><div class="font-semibold tabular-nums">{{ rollupByUnit[u].remaining.toLocaleString() }}</div></div>
            <div><div class="muted-sm">Spent</div><div class="font-semibold tabular-nums">{{ rollupByUnit[u].spent.toLocaleString() }}</div></div>
            <div>
              <div class="muted-sm">Debt</div>
              <div class="font-semibold tabular-nums" :class="rollupByUnit[u].debt > 0 ? 'text-red-600' : 'muted'">{{ rollupByUnit[u].debt.toLocaleString() }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Tabs. R9 scale-hardening: initial mount fetches all four
           lists in parallel so badge counts are accurate from first
           paint; subsequent 60s polls only refresh the active tab's
           data to avoid unbounded per-tenant key/policy fetches
           recurring every minute. -->
      <div class="flex border-b border-gray-200 mb-4">
        <button v-for="t in (['budgets', 'keys', 'policies'] as const)" :key="t"
          @click="selectTab(t)"
          :class="tab === t ? 'border-gray-900 text-gray-900' : 'border-transparent muted hover:text-gray-700'"
          class="px-4 py-2 text-sm font-medium border-b-2 -mb-px cursor-pointer transition-colors">
          {{ t === 'keys' ? 'API Keys' : t.charAt(0).toUpperCase() + t.slice(1) }}
          <span class="ml-1 muted-sm">({{ tabCountLabel(t) }})</span>
        </button>
      </div>

      <!-- Budgets tab. Create button lives in the page header action
           row (above) per design convention — every primary action in
           the same place. -->
      <div v-if="tab === 'budgets'" class="card-table">
        <p v-if="budgetsPartial" class="banner-warning m-3 text-xs" data-testid="budgets-partial-warning">Budget scan incomplete within {{ TENANT_DETAIL_SCAN_MAX_ROWS.toLocaleString() }} rows. Counts and rollups are lower bounds.</p>
        <div v-if="budgets.length > 0" class="flex items-center justify-end px-3 pt-2">
          <label class="text-sm flex items-center gap-1.5 text-gray-700 dark:text-gray-200 whitespace-nowrap">
            <input v-model="includeTerminalBudgets" type="checkbox" :aria-label="`Show ${terminalBudgetsVerb} budgets`" />
            Show {{ terminalBudgetsVerb }}<span v-if="terminalBudgetsCount > 0 && !includeTerminalBudgets" class="muted-sm">&nbsp;({{ terminalBudgetsCount }})</span>
          </label>
        </div>
        <table class="w-full text-sm min-w-[520px]">
          <thead class="table-header">
            <tr><th class="table-cell text-left">Scope</th><th class="table-cell text-left">Unit</th><th class="table-cell text-left">Status</th><th class="table-cell text-right">Allocated</th></tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="b in visibleBudgets" :key="b.ledger_id" class="table-row-hover">
              <td class="table-cell"><router-link :to="{ name: 'budgets', query: { scope: b.scope, unit: b.unit } }" class="text-blue-600 hover:underline font-mono text-xs">{{ b.scope }}</router-link></td>
              <td class="table-cell muted">{{ b.unit }}</td>
              <td class="table-cell"><StatusBadge :status="b.status" /></td>
              <td class="table-cell text-right muted tabular-nums">{{ b.allocated.amount.toLocaleString() }}</td>
            </tr>
            <tr v-if="visibleBudgets.length === 0"><td colspan="4"><EmptyState message="No budgets" hint="Budgets will appear here once allocated" /></td></tr>
          </tbody>
        </table>
      </div>

      <!-- API Keys tab. Create button lives in the page header. -->
      <div v-if="tab === 'keys'" class="card-table">
        <p v-if="apiKeysPartial" class="banner-warning m-3 text-xs" data-testid="keys-partial-warning">API-key scan incomplete within {{ TENANT_DETAIL_SCAN_MAX_ROWS.toLocaleString() }} rows. The tab count is a lower bound.</p>
        <div v-if="apiKeys.length > 0" class="flex items-center justify-end px-3 pt-2">
          <label class="text-sm flex items-center gap-1.5 text-gray-700 dark:text-gray-200 whitespace-nowrap">
            <input v-model="includeTerminalKeys" type="checkbox" :aria-label="`Show ${terminalKeysVerb} keys`" />
            Show {{ terminalKeysVerb }}<span v-if="terminalKeysCount > 0 && !includeTerminalKeys" class="muted-sm">&nbsp;({{ terminalKeysCount }})</span>
          </label>
        </div>
        <table class="w-full text-sm min-w-[520px]">
          <thead class="table-header">
            <tr><th class="table-cell text-left">Key ID</th><th class="table-cell text-left">Name</th><th class="table-cell text-left">Status</th><th class="table-cell text-left">Permissions</th><th v-if="canManageKeys" class="table-cell w-20"></th></tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="k in visibleApiKeys" :key="k.key_id" class="table-row-hover">
              <td class="table-cell"><MaskedValue :value="k.key_id" /></td>
              <td class="table-cell text-gray-700">{{ k.name || '-' }}</td>
              <td class="table-cell"><StatusBadge :status="k.status" /></td>
              <td class="table-cell muted-sm">{{ k.permissions.join(', ') }}</td>
              <td v-if="canManageKeys" class="table-cell">
                <RowActionsMenu
                  :aria-label="`Actions for API key ${k.name || k.key_id}`"
                  :items="[
                    { label: 'Activity', to: { name: 'audit', query: { key_id: k.key_id } } },
                    { label: 'Copy key ID', onClick: () => copyKeyId(k.key_id) },
                    { label: 'Copy as JSON', onClick: () => copyApiKeyJson(k) },
                    { label: 'Edit', onClick: () => openEditKey(k), hidden: k.status !== 'ACTIVE', disabled: apiKeyActionsBlocked, disabledReason: apiKeyActionBlockedReason },
                    { separator: true },
                    { label: 'Revoke', onClick: () => requestKeyRevoke(k), danger: true, hidden: k.status !== 'ACTIVE', disabled: apiKeyActionsBlocked, disabledReason: apiKeyActionBlockedReason },
                  ]"
                />
              </td>
            </tr>
            <tr v-if="visibleApiKeys.length === 0"><td :colspan="canManageKeys ? 5 : 4"><EmptyState message="No API keys" hint="API keys will appear here once created" /></td></tr>
          </tbody>
        </table>
      </div>

      <!-- Policies tab. Create button lives in the page header. -->
      <div v-if="tab === 'policies'" class="card-table">
        <p v-if="policiesPartial" class="banner-warning m-3 text-xs" data-testid="policies-partial-warning">Policy scan incomplete within {{ TENANT_DETAIL_SCAN_MAX_ROWS.toLocaleString() }} rows. The tab count is a lower bound.</p>
        <table class="w-full text-sm min-w-[520px]">
          <thead class="table-header">
            <tr><th class="table-cell text-left">Policy ID</th><th class="table-cell text-left">Name</th><th class="table-cell text-left">Scope</th><th class="table-cell text-left">Status</th><th v-if="canManagePolicies" class="table-cell w-20"></th></tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="p in policies" :key="p.policy_id" class="table-row-hover">
              <td class="table-cell font-mono text-xs">{{ p.policy_id }}</td>
              <td class="table-cell text-gray-700">{{ p.name }}</td>
              <td class="table-cell muted font-mono text-xs">{{ p.scope_pattern }}</td>
              <td class="table-cell"><StatusBadge :status="p.status" /></td>
              <td v-if="canManagePolicies" class="table-cell">
                <RowActionsMenu
                  :aria-label="`Actions for policy ${p.name || p.policy_id}`"
                  :items="[
                    { label: 'Activity', to: { name: 'audit', query: { resource_type: 'policy', resource_id: p.policy_id } } },
                    { label: 'Copy as JSON', onClick: () => copyPolicyJson(p) },
                    { label: 'Edit', onClick: () => openEditPolicy(p), disabled: policyActionsBlocked, disabledReason: policyActionBlockedReason },
                  ]"
                />
              </td>
            </tr>
            <tr v-if="policies.length === 0"><td :colspan="canManagePolicies ? 5 : 4"><EmptyState message="No policies" hint="Policies will appear here once configured" /></td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <ConfirmAction
      v-if="pendingTenantAction && pendingTenantAction !== 'CLOSED'"
      :title="pendingTenantAction === 'SUSPENDED' ? 'Suspend this tenant?' : 'Reactivate this tenant?'"
      :message="pendingTenantAction === 'SUSPENDED'
        ? `Suspending '${tenant?.name || id}' will block all API access for this tenant and its keys. Budgets and webhooks will be unaffected but unusable until reactivated.`
        : `Reactivating '${tenant?.name || id}' will restore API access for this tenant.`"
      :confirm-label="pendingTenantAction === 'SUSPENDED' ? 'Suspend Tenant' : 'Reactivate Tenant'"
      :danger="pendingTenantAction === 'SUSPENDED'"
      :loading="tenantActionLoading"
      @confirm="executeTenantAction"
      @cancel="cancelTenantAction"
    />

    <!-- Close tenant — requires typing tenant name -->
    <div v-if="pendingTenantAction === 'CLOSED'" class="fixed inset-0 bg-black/40 flex items-center justify-center z-50 overflow-y-auto p-4 sm:p-8" @click.self="!tenantActionLoading && cancelTenantAction()">
      <div ref="closeDialogRef" class="bg-white dark:bg-gray-900 dark:border dark:border-gray-700 rounded-lg shadow-lg p-6 w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto" role="dialog" aria-modal="true" aria-label="Close tenant permanently" :aria-busy="tenantActionLoading || undefined">
        <h3 class="text-sm font-semibold text-red-600 mb-2">Permanently close this tenant?</h3>
        <p class="text-sm text-gray-600 mb-3">This action is <strong>irreversible</strong>. Closing <strong>{{ tenant?.name || id }}</strong> cascades every owned object into its terminal state (spec v0.1.25.29 Rule 1):</p>
        <ul class="text-sm text-gray-600 list-disc pl-5 mb-3 space-y-0.5">
          <li v-if="cascadePreview.nonTerminalBudgets > 0">{{ budgetsPartial ? 'At least ' : '' }}{{ cascadePreview.nonTerminalBudgets }} budget{{ cascadePreview.nonTerminalBudgets === 1 ? '' : 's' }} → <strong>CLOSED</strong> (open reservations released)</li>
          <li v-if="cascadePreview.activeKeys > 0">{{ apiKeysPartial ? 'At least ' : '' }}{{ cascadePreview.activeKeys }} API key{{ cascadePreview.activeKeys === 1 ? '' : 's' }} → <strong>REVOKED</strong></li>
          <li>Every owned webhook subscription → <strong>DISABLED</strong></li>
        </ul>
        <p v-if="cascadePartial" class="banner-warning mb-3 text-xs">The preview is partial within the {{ TENANT_DETAIL_SCAN_MAX_ROWS.toLocaleString() }}-row scan bound on {{ partialCascadeAxes }}. The server-side cascade still applies to every owned object.</p>
        <p class="text-sm text-gray-600 mb-2">Afterwards, any mutation against these objects will return <code class="text-xs bg-gray-100 rounded px-1 py-0.5">TENANT_CLOSED</code> (409). There is no re-open path.</p>
        <p class="text-sm text-gray-600 mb-2">To confirm, type the tenant name below:</p>
        <input v-model="closeConfirmInput" type="text" :placeholder="tenant?.name || id" :disabled="tenantActionLoading" class="form-input mb-4 font-mono" autocomplete="off" aria-label="Type the tenant name to confirm" />
        <!-- Visually-hidden wait announcement while the close PATCH is
             in flight — both buttons are :disabled, so screen readers
             need the state change surfaced (mirrors ConfirmAction). -->
        <div aria-live="polite" class="sr-only">{{ tenantActionLoading ? 'Closing tenant, please wait' : '' }}</div>
        <div class="flex justify-end gap-2">
          <button @click="cancelTenantAction" :disabled="tenantActionLoading" class="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 rounded hover:bg-gray-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">Cancel</button>
          <button @click="executeTenantAction()" :disabled="tenantActionLoading || closeConfirmInput !== (tenant?.name || id)" class="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">{{ tenantActionLoading ? 'Closing…' : 'Close Permanently' }}</button>
        </div>
      </div>
    </div>

    <!-- Rerun cascade confirm — v0.1.25.44. ConfirmAction (not the
         type-to-confirm CLOSE dialog) because at this point the tenant
         is already CLOSED; the irreversible step already happened.
         This is a per-child cleanup. Enumerates exact pending counts +
         the two scenarios that produce this state so operators aren't
         guessing whether they're papering over an active bug. -->
    <ConfirmAction
      v-if="pendingRerunCascade"
      title="Re-run cascade on this closed tenant?"
      :message="`This will close ${cascadePending.budgets} budget${cascadePending.budgets === 1 ? '' : 's'}, disable ${cascadePending.webhooks} webhook${cascadePending.webhooks === 1 ? '' : 's'}, and revoke ${cascadePending.apiKeys} API key${cascadePending.apiKeys === 1 ? '' : 's'} still non-terminal on this CLOSED tenant.${cascadePartial ? ` These are lower bounds because at least one child scan could not complete within ${TENANT_DETAIL_SCAN_MAX_ROWS.toLocaleString()} rows.` : ''} This happens on tenants closed before admin v0.1.25.35 (no cascade ran) or after a partial-failure cascade. No-op at the tenant level; only the owned objects transition. This cannot be undone.`"
      confirm-label="Re-run Cascade"
      :danger="true"
      :loading="rerunCascadeLoading"
      :error="rerunCascadeError"
      @confirm="rerunCascade"
      @cancel="cancelRerunCascade"
    />

    <!-- Edit tenant dialog -->
    <FormDialog v-if="showEditTenant" title="Edit Tenant" submit-label="Save Changes" :loading="editTenantLoading" :error="editTenantError" @submit="submitEditTenant" @cancel="showEditTenant = false">
      <div>
        <label for="et-name" class="form-label">Display Name</label>
        <input id="et-name" v-model="editTenantForm.name" required maxlength="256" class="form-input" />
      </div>
      <div>
        <label for="et-overage" class="form-label">Default Commit Overage Policy</label>
        <select id="et-overage" v-model="editTenantForm.default_commit_overage_policy" class="form-select w-full">
          <option value="">Inherit</option>
          <option value="REJECT">Reject</option>
          <option value="ALLOW_IF_AVAILABLE">Allow if available</option>
          <option value="ALLOW_WITH_OVERDRAFT">Allow with overdraft</option>
        </select>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label for="et-ttl" class="form-label">Default Reservation TTL (ms)</label>
          <input id="et-ttl" v-model="editTenantForm.default_reservation_ttl_ms" type="number" min="1000" max="86400000" class="form-input" placeholder="60000" />
        </div>
        <div>
          <label for="et-max-ttl" class="form-label">Max Reservation TTL (ms)</label>
          <input id="et-max-ttl" v-model="editTenantForm.max_reservation_ttl_ms" type="number" min="1000" max="86400000" class="form-input" placeholder="3600000" />
        </div>
        <div>
          <label for="et-max-ext" class="form-label">Max Reservation Extensions</label>
          <input id="et-max-ext" v-model="editTenantForm.max_reservation_extensions" type="number" min="0" step="1" class="form-input" placeholder="10" />
        </div>
        <!-- Read-only: reservation_expiry_policy is create-only per spec
             (PATCH body is additionalProperties:false without it) — the
             old select was a silent no-op the server dropped. -->
        <div data-testid="tenant-expiry-policy-readonly">
          <span class="form-label">Reservation Expiry Policy</span>
          <p class="text-sm text-gray-700 dark:text-gray-200">{{ tenant?.reservation_expiry_policy || 'Inherit' }}</p>
          <p class="muted-sm mt-0.5">Set at creation — cannot be changed on an existing tenant.</p>
        </div>
      </div>
    </FormDialog>

    <TenantApiKeyDialogs
      :pending-revoke="pendingKeyRevoke"
      :revoke-loading="keyRevokeLoading"
      :revoke-error="keyRevokeError"
      :show-create="showCreateKey"
      :create-loading="createKeyLoading"
      :create-error="createKeyError"
      :create-form="createKeyForm"
      :created-secret="createdKeySecret"
      :editing-key="editingKey"
      :edit-loading="editKeyLoading"
      :edit-error="editKeyError"
      :edit-form="editKeyForm"
      :pending-permission-adds="pendingKeyPermAdds"
      :pending-permission-removes="pendingKeyPermRemoves"
      @confirm-revoke="executeKeyRevoke"
      @cancel-revoke="cancelKeyRevoke"
      @submit-create="submitCreateKey"
      @cancel-create="cancelCreateKey"
      @close-created-secret="closeCreatedKeySecret"
      @submit-edit="submitEditKey"
      @cancel-edit="cancelEditKey"
    />

    <!-- v0.1.25.21 (#7): Emergency Freeze confirm. Intentionally spells
         out the blast radius from the complete action-time scan. The target
         snapshot remains immutable while rateLimitedBatch executes with
         bounded concurrency and cancellable progress. -->
    <ConfirmAction
      v-if="pendingEmergencyFreeze"
      title="Emergency Freeze scanned budgets?"
      :message="emergencyFreezeRunning
        ? `Working… ${emergencyFreezeProgress.done}/${emergencyFreezeProgress.total} processed${emergencyFreezeProgress.failed ? ` (${emergencyFreezeProgress.failed} failed)` : ''}.`
        : `Freezes the ${emergencyFreezeTargets.length} ACTIVE budgets found by the completed scan for tenant '${tenant?.name || id}'. Pending reservations against these scopes will be rejected until unfrozen. Budgets created or activated after this confirmation opened are not part of the reviewed snapshot. Audit log records 'Emergency freeze — tenant lockdown' as the reason on each.`"
      :confirm-label="emergencyFreezeRunning ? 'Working…' : `Freeze ${emergencyFreezeTargets.length} budgets`"
      :danger="true"
      :loading="emergencyFreezeRunning"
      cancellable-while-loading
      @confirm="executeEmergencyFreeze"
      @cancel="cancelEmergencyFreeze"
    />

    <!-- v0.1.25.37 (slice B): per-row result dialog for Emergency Freeze.
         Surfaces which budgets didn't freeze + why (error_code / message)
         so ops can retry just the failed tail instead of tailing devtools. -->
    <BulkActionResultDialog
      v-if="emergencyFreezeResult"
      :action-verb="emergencyFreezeResult.actionVerb"
      item-noun-plural="budgets"
      :response="emergencyFreezeResult.response"
      :label-by-id="emergencyFreezeResult.labelById"
      :tenant-id="emergencyFreezeResult.tenantId"
      @close="closeEmergencyFreezeResult"
    />

    <!-- v0.1.25.20: Create Budget (admin-on-behalf-of) -->
    <FormDialog v-if="showCreateBudget" title="Create Budget" submit-label="Create" :loading="createBudgetLoading" :error="createBudgetError" @submit="submitCreateBudget" @cancel="showCreateBudget = false">
      <div>
        <label class="form-label">Scope</label>
        <!-- v0.1.25.20: structured builder replaces the free-text input.
             Tenant row is locked to the current detail's tenant, so the
             admin-on-behalf-of cross-field check passes by construction.
             Deeper levels chosen from an "+ Add level" dropdown that only
             offers canonical kinds in canonical order. -->
        <ScopeBuilder v-model="createBudgetForm.scope" :tenant-id="id" />
      </div>
      <div>
        <label for="cb-unit" class="form-label">Unit</label>
        <select id="cb-unit" v-model="createBudgetForm.unit" required class="form-select w-full">
          <option value="USD_MICROCENTS">USD_MICROCENTS</option>
          <option value="TOKENS">TOKENS</option>
          <option value="CREDITS">CREDITS</option>
          <option value="RISK_POINTS">RISK_POINTS</option>
        </select>
      </div>
      <div>
        <label for="cb-allocated" class="form-label">Initial allocation</label>
        <input id="cb-allocated" v-model="createBudgetForm.allocated" type="number" min="0" step="1" required class="form-input-mono" />
      </div>
      <div>
        <label for="cb-overdraft" class="form-label">Overdraft limit (optional)</label>
        <input id="cb-overdraft" v-model="createBudgetForm.overdraft_limit" type="number" min="0" step="1" class="form-input-mono" />
      </div>
      <div>
        <label for="cb-cop" class="form-label">Commit overage policy (optional)</label>
        <select id="cb-cop" v-model="createBudgetForm.commit_overage_policy" class="form-select w-full">
          <option value="">— Inherit from tenant —</option>
          <option v-for="p in COMMIT_OVERAGE_POLICIES" :key="p" :value="p">{{ p }}</option>
        </select>
      </div>
    </FormDialog>

    <TenantPolicyDialogs
      :tenant-id="id"
      :show-create="showCreatePolicy"
      :create-loading="createPolicyLoading"
      :create-error="createPolicyError"
      :create-form="createPolicyForm"
      :create-advanced="createPolicyAdvanced"
      :editing-policy="editingPolicy"
      :edit-loading="editPolicyLoading"
      :edit-error="editPolicyError"
      :edit-form="editPolicyForm"
      :edit-advanced="editPolicyAdvanced"
      :edit-has-advanced="editPolicyHasAdvanced"
      @submit-create="submitCreatePolicy"
      @cancel-create="cancelCreatePolicy"
      @submit-edit="submitEditPolicy"
      @cancel-edit="cancelEditPolicy"
    />
  </div>
</template>

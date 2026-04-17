<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { getTenant, listTenants, listBudgets, listApiKeys, listPolicies, updateTenantStatus, updateTenant, revokeApiKey, createApiKey, updateApiKey, createBudget, createPolicy, updatePolicy, freezeBudget } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { Tenant, BudgetLedger, ApiKey, Policy, ApiKeyCreateResponse, BudgetCreateRequest, PolicyCreateRequest, PolicyUpdateRequest } from '../types'
import { COMMIT_OVERAGE_POLICIES, PERMISSIONS } from '../types'
import PermissionPicker from '../components/PermissionPicker.vue'
import { validateScope } from '../utils/safe'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import MaskedValue from '../components/MaskedValue.vue'
import EmptyState from '../components/EmptyState.vue'
import ConfirmAction from '../components/ConfirmAction.vue'
import FormDialog from '../components/FormDialog.vue'
import SecretReveal from '../components/SecretReveal.vue'
import ScopeBuilder from '../components/ScopeBuilder.vue'
import RowActionsMenu from '../components/RowActionsMenu.vue'
import { useToast } from '../composables/useToast'
import { toMessage } from '../utils/errors'
import { rateLimitedBatch } from '../utils/rateLimitedBatch'

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
  } else {
    router.push('/tenants')
  }
}

const tenant = ref<Tenant | null>(null)
// v0.1.25.21 (#2): sibling tenants keyed off this tenant's id — used
// for the "Children" list on the header card.
const allTenants = ref<Tenant[]>([])
const budgets = ref<BudgetLedger[]>([])
const apiKeys = ref<ApiKey[]>([])
const policies = ref<Policy[]>([])
const error = ref('')
const tab = ref<'budgets' | 'keys' | 'policies'>('budgets')

// R9 (scale-hardening): lazy tabs. Pre-fix, Promise.all([budgets, keys,
// policies, tenants]) ran on every mount and poll regardless of which
// tab was open. At 10k+ keys or policies per tenant, that's two
// unbounded fetches the operator never asked for. Post-fix: keys and
// policies are only fetched if their tab is currently active or has
// been opened previously in this session. Budgets are still always
// fetched — the header rollup card depends on them. Tab activation
// triggers a refresh so the first open doesn't wait up to 60s for
// the next poll.
// R9 scale-hardening: lazy refresh on POLL — the periodic 60s tick
// refreshes only the active tab's data to avoid fetching unbounded
// key/policy lists every minute for tenants that have many. The
// INITIAL mount, however, loads everything so tab-count badges are
// accurate from first paint. Previous "lazy even on mount" approach
// with keysLoaded / policiesLoaded flags had a reactivity bug that
// left badges stuck on "…" — replaced with this simpler flow.

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

const childTenants = computed<Tenant[]>(() =>
  allTenants.value.filter(t => t.parent_tenant_id === id),
)

// Tenant status action
const pendingTenantAction = ref<'SUSPENDED' | 'ACTIVE' | 'CLOSED' | null>(null)
const closeConfirmInput = ref('')

async function executeTenantAction() {
  if (!pendingTenantAction.value) return
  try {
    await updateTenantStatus(id, pendingTenantAction.value)
    const labels: Record<string, string> = { SUSPENDED: 'Tenant suspended', ACTIVE: 'Tenant reactivated', CLOSED: 'Tenant permanently closed' }
    toast.success(labels[pendingTenantAction.value])
    tenant.value = await getTenant(id)
  } catch (e) {
    const msg = toMessage(e)
    error.value = msg
    toast.error(`Tenant status change failed: ${msg}`)
  }
  finally { pendingTenantAction.value = null }
}

// API key revoke action
const pendingKeyRevoke = ref<ApiKey | null>(null)

async function executeKeyRevoke() {
  if (!pendingKeyRevoke.value) return
  try {
    await revokeApiKey(pendingKeyRevoke.value.key_id, 'Revoked via admin dashboard')
    toast.success('API key revoked')
    const kRes = await listApiKeys({ tenant_id: id })
    apiKeys.value = kRes.keys
  } catch (e) {
    const msg = toMessage(e)
    error.value = msg
    toast.error(`Revoke failed: ${msg}`)
  }
  finally { pendingKeyRevoke.value = null }
}

// Edit tenant
const showEditTenant = ref(false)
const editTenantLoading = ref(false)
const editTenantError = ref('')
const editTenantForm = ref({ name: '', default_commit_overage_policy: '', default_reservation_ttl_ms: '', max_reservation_ttl_ms: '' })

function openEditTenant() {
  const t = tenant.value
  editTenantForm.value = {
    name: t?.name || '',
    default_commit_overage_policy: (t as any)?.default_commit_overage_policy || '',
    default_reservation_ttl_ms: (t as any)?.default_reservation_ttl_ms ? String((t as any).default_reservation_ttl_ms) : '',
    max_reservation_ttl_ms: (t as any)?.max_reservation_ttl_ms ? String((t as any).max_reservation_ttl_ms) : '',
  }
  editTenantError.value = ''
  showEditTenant.value = true
}

async function submitEditTenant() {
  editTenantError.value = ''
  editTenantLoading.value = true
  try {
    const body: Record<string, unknown> = { name: editTenantForm.value.name }
    if (editTenantForm.value.default_commit_overage_policy) body.default_commit_overage_policy = editTenantForm.value.default_commit_overage_policy
    if (editTenantForm.value.default_reservation_ttl_ms) body.default_reservation_ttl_ms = Number(editTenantForm.value.default_reservation_ttl_ms)
    if (editTenantForm.value.max_reservation_ttl_ms) body.max_reservation_ttl_ms = Number(editTenantForm.value.max_reservation_ttl_ms)
    await updateTenant(id, body as any)
    toast.success('Tenant updated')
    tenant.value = await getTenant(id)
    showEditTenant.value = false
  } catch (e) { editTenantError.value = toMessage(e) }
  finally { editTenantLoading.value = false }
}

// Create API key for this tenant
const showCreateKey = ref(false)
const createKeyLoading = ref(false)
const createKeyError = ref('')
const createKeyForm = ref({ name: '', permissions: [] as string[], scope_filter: '', expires_at: '' })
const createdKeySecret = ref<ApiKeyCreateResponse | null>(null)

function openCreateKey() {
  createKeyForm.value = { name: '', permissions: [], scope_filter: '', expires_at: '' }
  createKeyError.value = ''
  showCreateKey.value = true
}

async function submitCreateKey() {
  createKeyError.value = ''
  createKeyLoading.value = true
  try {
    const body: Record<string, unknown> = { tenant_id: id, name: createKeyForm.value.name }
    if (createKeyForm.value.permissions.length) body.permissions = createKeyForm.value.permissions
    if (createKeyForm.value.scope_filter) body.scope_filter = createKeyForm.value.scope_filter.split(',').map(s => s.trim()).filter(Boolean)
    if (createKeyForm.value.expires_at) body.expires_at = new Date(createKeyForm.value.expires_at).toISOString()
    const res = await createApiKey(body as any)
    createdKeySecret.value = res
    showCreateKey.value = false
  } catch (e) { createKeyError.value = toMessage(e) }
  finally { createKeyLoading.value = false }
}

// Edit API key — mirrors the ApiKeysView.vue flow (v0.1.25.24
// diff-before-patch) so operators can rename / reshape permissions
// without navigating away from the tenant page. Sends only changed
// fields to dodge the closed-permission-enum 400 on round-tripped
// legacy values.
const editingKey = ref<ApiKey | null>(null)
const editKeyLoading = ref(false)
const editKeyError = ref('')
const editKeyForm = ref({ name: '', permissions: [] as string[], scope_filter: '' })

function openEditKey(k: ApiKey) {
  // Drop any stored permission that isn't in the canonical set — same
  // legacy-value handling as ApiKeysView.openEdit.
  const allowed = new Set<string>(PERMISSIONS as readonly string[])
  const stored = k.permissions || []
  const dropped = stored.filter(p => !allowed.has(p))
  const kept = stored.filter(p => allowed.has(p))
  editKeyForm.value = {
    name: k.name || '',
    permissions: kept,
    scope_filter: k.scope_filter?.join(', ') || '',
  }
  editKeyError.value = ''
  editingKey.value = k
  if (dropped.length) {
    toast.error(`Unrecognized permissions will be removed on save: ${dropped.join(', ')}`)
  }
}

function sameKeyStringSet(a: string[] | undefined, b: string[] | undefined): boolean {
  const aa = a || []
  const bb = b || []
  if (aa.length !== bb.length) return false
  const sa = new Set(aa)
  for (const v of bb) if (!sa.has(v)) return false
  return true
}

const pendingKeyPermAdds = computed<string[]>(() => {
  if (!editingKey.value) return []
  const orig = new Set(editingKey.value.permissions || [])
  return editKeyForm.value.permissions.filter(p => !orig.has(p))
})
const pendingKeyPermRemoves = computed<string[]>(() => {
  if (!editingKey.value) return []
  const curr = new Set(editKeyForm.value.permissions)
  return (editingKey.value.permissions || []).filter(p => !curr.has(p))
})

async function submitEditKey() {
  if (!editingKey.value) return
  editKeyError.value = ''
  editKeyLoading.value = true
  try {
    const body: Record<string, unknown> = {}
    const original = editingKey.value
    if (editKeyForm.value.name !== (original.name || '')) {
      body.name = editKeyForm.value.name
    }
    if (!sameKeyStringSet(editKeyForm.value.permissions, original.permissions)) {
      body.permissions = editKeyForm.value.permissions
    }
    const scopes = editKeyForm.value.scope_filter
      ? editKeyForm.value.scope_filter.split(',').map(s => s.trim()).filter(Boolean)
      : []
    if (!sameKeyStringSet(scopes, original.scope_filter)) {
      body.scope_filter = scopes
    }
    if (Object.keys(body).length === 0) {
      editingKey.value = null
      return
    }
    await updateApiKey(original.key_id, body as any)
    toast.success('API key updated')
    editingKey.value = null
    const kRes = await listApiKeys({ tenant_id: id })
    apiKeys.value = kRes.keys
  } catch (e) { editKeyError.value = toMessage(e) }
  finally { editKeyLoading.value = false }
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
    refresh()
  } catch (e) { createBudgetError.value = toMessage(e) }
  finally { createBudgetLoading.value = false }
}

// v0.1.25.20: Create Policy — admin-on-behalf-of. Same shape as Create
// Budget — tenant_id supplied by wrapper. UI exposes the most-used
// fields; advanced fields (caps, rate_limits, action_quotas) can be
// added in a follow-up once the basic flow is exercised.
const showCreatePolicy = ref(false)
const createPolicyLoading = ref(false)
const createPolicyError = ref('')
const createPolicyForm = ref<{
  name: string
  scope_pattern: string
  description: string
  priority: number | string
  commit_overage_policy: string
}>({
  name: '',
  scope_pattern: `tenant:${id}/*`,
  description: '',
  priority: '',
  commit_overage_policy: '',
})

function openCreatePolicy() {
  createPolicyForm.value = {
    name: '',
    scope_pattern: `tenant:${id}/*`,
    description: '',
    priority: '',
    commit_overage_policy: '',
  }
  createPolicyError.value = ''
  showCreatePolicy.value = true
}

async function submitCreatePolicy() {
  if (createPolicyLoading.value) return
  createPolicyError.value = ''
  if (!createPolicyForm.value.name.trim()) {
    createPolicyError.value = 'Name is required'
    return
  }
  if (!createPolicyForm.value.scope_pattern.trim()) {
    createPolicyError.value = 'Scope pattern is required'
    return
  }
  // Client-side grammar check for the pattern. `allowWildcards: true`
  // because policy patterns can use `tenant:acme/*` (all descendants)
  // and `tenant:acme/agent:*` (id-wildcard) per spec examples. Budget
  // scopes stay concrete (no wildcards).
  const scopeError = validateScope(createPolicyForm.value.scope_pattern.trim(), {
    fieldName: 'Scope pattern', allowWildcards: true,
  })
  if (scopeError) { createPolicyError.value = scopeError; return }
  const body: PolicyCreateRequest = {
    name: createPolicyForm.value.name.trim(),
    scope_pattern: createPolicyForm.value.scope_pattern.trim(),
  }
  if (createPolicyForm.value.description.trim()) body.description = createPolicyForm.value.description.trim()
  const prio = Number(createPolicyForm.value.priority)
  if (createPolicyForm.value.priority !== '' && Number.isFinite(prio)) body.priority = prio
  if (createPolicyForm.value.commit_overage_policy) body.commit_overage_policy = createPolicyForm.value.commit_overage_policy
  createPolicyLoading.value = true
  try {
    await createPolicy(id, body)
    showCreatePolicy.value = false
    toast.success('Policy created')
    refresh()
  } catch (e) { createPolicyError.value = toMessage(e) }
  finally { createPolicyLoading.value = false }
}

// v0.1.25.20: Edit Policy — uses PATCH /v1/admin/policies/{id}. policy_id
// pins the owning tenant on the server; no tenant_id needed in body.
const showEditPolicy = ref(false)
const editPolicyLoading = ref(false)
const editPolicyError = ref('')
const editPolicyTarget = ref<Policy | null>(null)
const editPolicyForm = ref<{
  name: string
  description: string
  priority: number | string
  commit_overage_policy: string
}>({ name: '', description: '', priority: '', commit_overage_policy: '' })

function openEditPolicy(p: Policy) {
  editPolicyTarget.value = p
  editPolicyForm.value = {
    name: p.name,
    description: '',
    priority: p.priority ?? '',
    commit_overage_policy: '',
  }
  editPolicyError.value = ''
  showEditPolicy.value = true
}

async function submitEditPolicy() {
  if (!editPolicyTarget.value || editPolicyLoading.value) return
  editPolicyError.value = ''
  const body: PolicyUpdateRequest = {}
  // PATCH semantics: only send fields the user actually changed/filled.
  // Avoid no-op payloads that would dirty the audit log.
  if (editPolicyForm.value.name.trim() && editPolicyForm.value.name.trim() !== editPolicyTarget.value.name) {
    body.name = editPolicyForm.value.name.trim()
  }
  if (editPolicyForm.value.description.trim()) body.description = editPolicyForm.value.description.trim()
  const prio = Number(editPolicyForm.value.priority)
  if (editPolicyForm.value.priority !== '' && Number.isFinite(prio) && prio !== editPolicyTarget.value.priority) {
    body.priority = prio
  }
  if (editPolicyForm.value.commit_overage_policy) body.commit_overage_policy = editPolicyForm.value.commit_overage_policy
  if (Object.keys(body).length === 0) {
    editPolicyError.value = 'No changes to save'
    return
  }
  editPolicyLoading.value = true
  try {
    await updatePolicy(editPolicyTarget.value.policy_id, body)
    showEditPolicy.value = false
    toast.success('Policy updated')
    refresh()
  } catch (e) { editPolicyError.value = toMessage(e) }
  finally { editPolicyLoading.value = false }
}

// v0.1.25.21 (#7): Emergency freeze — loops freezeBudget over every
// ACTIVE budget in this tenant. Single click replaces a 3+ minute
// click-through-each-budget ritual during incident response. We pre-
// filter to ACTIVE because freezing FROZEN budgets would either no-op
// or 409 depending on server state; either way it's noise.
const pendingEmergencyFreeze = ref(false)
const emergencyFreezeRunning = ref(false)
const emergencyFreezeProgress = ref({ done: 0, total: 0, failed: 0 })
const activeBudgets = computed(() => budgets.value.filter(b => b.status === 'ACTIVE'))
// W4 (scale-hardening): emergency-freeze reuses the same concurrent
// bulk runner as TenantsView / WebhooksView — concurrency 4 with 429
// backoff. During an incident, freezing 200+ budgets sequentially was
// painfully slow; this keeps the operation responsive while still
// retrying past rate limits rather than silently failing half the batch.
let emergencyFreezeAbort: AbortController | null = null

function openEmergencyFreeze() { pendingEmergencyFreeze.value = true }
async function executeEmergencyFreeze() {
  if (emergencyFreezeRunning.value) return
  const targets = activeBudgets.value.slice()
  emergencyFreezeProgress.value = { done: 0, total: targets.length, failed: 0 }
  emergencyFreezeRunning.value = true
  emergencyFreezeAbort = new AbortController()
  // Audit-log reason is structured for grep-ability: the
  // [EMERGENCY_FREEZE] tag lets ops surface every emergency-freeze
  // action with a single regex against the audit log. Free-text
  // suffix preserves human-readable context.
  const result = await rateLimitedBatch(
    targets,
    async (b) => { await freezeBudget(b.scope, b.unit, '[EMERGENCY_FREEZE] Tenant lockdown via admin dashboard') },
    {
      signal: emergencyFreezeAbort.signal,
      onProgress: (done, total, failed) => { emergencyFreezeProgress.value = { done, total, failed } },
    },
  )
  for (const err of result.errors) {
    const b = targets[err.index]
    console.warn(`emergency freeze failed on ${b.scope}:${b.unit}:`, toMessage(err.error))
  }
  emergencyFreezeRunning.value = false
  emergencyFreezeAbort = null
  const succeeded = result.done - result.failed
  const summary = `${succeeded}/${emergencyFreezeProgress.value.total} budgets frozen`
  if (result.failed > 0) toast.error(`${summary}, ${result.failed} failed — check console`)
  else if (result.cancelled) toast.success(`${summary} (cancelled by user)`)
  else toast.success(summary)
  pendingEmergencyFreeze.value = false
  await refresh()
}
function cancelEmergencyFreeze() {
  if (emergencyFreezeRunning.value) {
    emergencyFreezeAbort?.abort()
  } else {
    pendingEmergencyFreeze.value = false
  }
}

// Tracks whether the first full fetch has completed. Before it does,
// all four lists (tenant, budgets, keys, policies) are fetched in
// parallel so tab counts are accurate from first paint. After, the
// poll tick switches to lazy mode: only refreshes the active tab.
let initialLoadDone = false

const { refresh, isLoading, lastUpdated } = usePolling(async () => {
  try {
    if (!initialLoadDone) {
      // Mount-time eager load: fetch everything so badge counts are
      // accurate immediately. One-time per component instance; the
      // cost for a 10k-key tenant is capped at this single fetch
      // rather than recurring every 60s.
      const [tRes, bRes, ttRes, kRes, pRes] = await Promise.all([
        getTenant(id),
        listBudgets({ tenant_id: id }),
        listTenants(),
        listApiKeys({ tenant_id: id }),
        listPolicies({ tenant_id: id }),
      ])
      tenant.value = tRes
      budgets.value = bRes.ledgers
      allTenants.value = ttRes.tenants
      apiKeys.value = kRes.keys
      policies.value = pRes.policies
      initialLoadDone = true
      error.value = ''
      return
    }

    // Poll tick (steady state): always refresh tenant + budgets +
    // tenant list (header card), but only refresh the active tab's
    // sub-list to keep per-poll cost bounded on tenants with many
    // keys/policies.
    tenant.value = await getTenant(id)
    const [bRes, ttRes] = await Promise.all([
      listBudgets({ tenant_id: id }),
      listTenants(),
    ])
    budgets.value = bRes.ledgers
    allTenants.value = ttRes.tenants
    if (tab.value === 'keys') {
      const kRes = await listApiKeys({ tenant_id: id })
      apiKeys.value = kRes.keys
    } else if (tab.value === 'policies') {
      const pRes = await listPolicies({ tenant_id: id })
      policies.value = pRes.policies
    }
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
}, 60000)
</script>

<template>
  <div>
    <PageHeader title="Tenant Detail" :subtitle="tenant?.tenant_id" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh">
      <template #back>
        <button @click="goBack" :aria-label="parentFromQuery ? `Back to parent tenant ${parentFromQuery}` : 'Back to tenants'" class="muted hover:text-gray-700 cursor-pointer">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
        </button>
      </template>
    </PageHeader>
    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg table-cell mb-4">{{ error }}</p>

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
            <button v-if="tab === 'keys' && canManageKeys" @click="openCreateKey" class="text-xs bg-blue-600 text-white hover:bg-blue-700 rounded px-3 py-1.5 cursor-pointer transition-colors">Create API Key</button>
            <button v-if="tab === 'policies' && canManagePolicies" @click="openCreatePolicy" class="text-xs bg-blue-600 text-white hover:bg-blue-700 rounded px-3 py-1.5 cursor-pointer transition-colors">Create Policy</button>
            <template v-if="canManageTenants">
              <button @click="openEditTenant" class="btn-pill-secondary">Edit</button>
              <!-- #7 Emergency Freeze: only shown if there are ACTIVE budgets
                   to freeze. Otherwise the button would just confirm a no-op. -->
              <button v-if="canManageBudgets && activeBudgets.length > 0" @click="openEmergencyFreeze" class="btn-pill-danger">Emergency Freeze ({{ activeBudgets.length }})</button>
              <button v-if="tenant.status === 'ACTIVE'" @click="pendingTenantAction = 'SUSPENDED'" class="btn-pill-danger">Suspend</button>
              <button v-if="tenant.status === 'SUSPENDED'" @click="pendingTenantAction = 'ACTIVE'" class="btn-pill-success">Reactivate</button>
              <button v-if="tenant.status !== 'CLOSED'" @click="pendingTenantAction = 'CLOSED'" class="btn-pill-danger">Close</button>
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
        <div v-if="childTenants.length > 0" class="text-sm muted mt-2 flex items-center gap-1 flex-wrap">
          <span class="muted">Children ({{ childTenants.length }}):</span>
          <router-link
            v-for="c in childTenants.slice(0, 6)"
            :key="c.tenant_id"
            :to="{ name: 'tenant-detail', params: { id: c.tenant_id }, query: { parent: tenant.tenant_id } }"
            class="text-blue-600 hover:underline text-xs font-mono"
          >{{ c.tenant_id }}</router-link>
          <router-link v-if="childTenants.length > 6" :to="{ name: 'tenants', query: { parent: tenant.tenant_id } }" class="muted-sm hover:text-gray-700 hover:underline">… +{{ childTenants.length - 6 }} more</router-link>
        </div>
      </div>

      <!-- Spend rollup (#6). Grouped by unit because adding TOKENS to
           USD_MICROCENTS would be meaningless. Utilization % is
           calculated from the sum, not averaged across budgets — the
           more-informative view for "how close is this tenant to its
           allocated capacity overall." -->
      <div v-if="rollupUnits.length > 0" class="card p-4 mb-4">
        <h3 class="text-sm font-medium text-gray-700 mb-3">Spend rollup (ACTIVE budgets)</h3>
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
          @click="tab = t"
          :class="tab === t ? 'border-gray-900 text-gray-900' : 'border-transparent muted hover:text-gray-700'"
          class="px-4 py-2 text-sm font-medium border-b-2 -mb-px cursor-pointer transition-colors">
          {{ t === 'keys' ? 'API Keys' : t.charAt(0).toUpperCase() + t.slice(1) }}
          <span class="ml-1 muted-sm">({{ t === 'budgets' ? budgets.length : t === 'keys' ? apiKeys.length : policies.length }})</span>
        </button>
      </div>

      <!-- Budgets tab. Create button lives in the page header action
           row (above) per design convention — every primary action in
           the same place. -->
      <div v-if="tab === 'budgets'" class="card-table">
        <table class="w-full text-sm min-w-[520px]">
          <thead class="table-header">
            <tr><th class="table-cell text-left">Scope</th><th class="table-cell text-left">Unit</th><th class="table-cell text-left">Status</th><th class="table-cell text-right">Allocated</th></tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="b in budgets" :key="b.ledger_id" class="table-row-hover">
              <td class="table-cell"><router-link :to="{ name: 'budgets', query: { scope: b.scope, unit: b.unit } }" class="text-blue-600 hover:underline font-mono text-xs">{{ b.scope }}</router-link></td>
              <td class="table-cell muted">{{ b.unit }}</td>
              <td class="table-cell"><StatusBadge :status="b.status" /></td>
              <td class="table-cell text-right muted tabular-nums">{{ b.allocated.amount.toLocaleString() }}</td>
            </tr>
            <tr v-if="budgets.length === 0"><td colspan="4"><EmptyState message="No budgets" hint="Budgets will appear here once allocated" /></td></tr>
          </tbody>
        </table>
      </div>

      <!-- API Keys tab. Create button lives in the page header. -->
      <div v-if="tab === 'keys'" class="card-table">
        <table class="w-full text-sm min-w-[520px]">
          <thead class="table-header">
            <tr><th class="table-cell text-left">Key ID</th><th class="table-cell text-left">Name</th><th class="table-cell text-left">Status</th><th class="table-cell text-left">Permissions</th><th v-if="canManageKeys" class="table-cell w-20"></th></tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="k in apiKeys" :key="k.key_id" class="table-row-hover">
              <td class="table-cell"><MaskedValue :value="k.key_id" /></td>
              <td class="table-cell text-gray-700">{{ k.name || '-' }}</td>
              <td class="table-cell"><StatusBadge :status="k.status" /></td>
              <td class="table-cell muted-sm">{{ k.permissions.join(', ') }}</td>
              <td v-if="canManageKeys" class="table-cell">
                <RowActionsMenu
                  :aria-label="`Actions for API key ${k.name || k.key_id}`"
                  :items="[
                    { label: 'Activity', to: { name: 'audit', query: { key_id: k.key_id } } },
                    { label: 'Edit', onClick: () => openEditKey(k), hidden: k.status !== 'ACTIVE' },
                    { separator: true },
                    { label: 'Revoke', onClick: () => pendingKeyRevoke = k, danger: true, hidden: k.status !== 'ACTIVE' },
                  ]"
                />
              </td>
            </tr>
            <tr v-if="apiKeys.length === 0"><td :colspan="canManageKeys ? 5 : 4"><EmptyState message="No API keys" hint="API keys will appear here once created" /></td></tr>
          </tbody>
        </table>
      </div>

      <!-- Policies tab. Create button lives in the page header. -->
      <div v-if="tab === 'policies'" class="card-table">
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
                    { label: 'Edit', onClick: () => openEditPolicy(p) },
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
      @confirm="executeTenantAction"
      @cancel="pendingTenantAction = null"
    />

    <!-- Close tenant — requires typing tenant name -->
    <div v-if="pendingTenantAction === 'CLOSED'" class="fixed inset-0 bg-black/40 flex items-center justify-center z-50" @click.self="pendingTenantAction = null">
      <div class="bg-white dark:bg-gray-900 dark:border dark:border-gray-700 rounded-lg shadow-lg p-6 max-w-sm mx-4" role="dialog" aria-modal="true" aria-label="Close tenant permanently">
        <h3 class="text-sm font-semibold text-red-600 mb-2">Permanently close this tenant?</h3>
        <p class="text-sm text-gray-600 mb-3">This action is <strong>irreversible</strong>. Closing <strong>{{ tenant?.name || id }}</strong> will permanently archive this tenant. All API access, keys, budgets, and webhooks will become unusable and cannot be restored.</p>
        <p class="text-sm text-gray-600 mb-2">To confirm, type the tenant name below:</p>
        <input v-model="closeConfirmInput" type="text" :placeholder="tenant?.name || id" class="form-input mb-4 font-mono" autocomplete="off" />
        <div class="flex justify-end gap-2">
          <button @click="pendingTenantAction = null; closeConfirmInput = ''" class="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 rounded hover:bg-gray-100 cursor-pointer">Cancel</button>
          <button @click="executeTenantAction(); closeConfirmInput = ''" :disabled="closeConfirmInput !== (tenant?.name || id)" class="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">Close Permanently</button>
        </div>
      </div>
    </div>

    <ConfirmAction
      v-if="pendingKeyRevoke"
      title="Revoke this API key?"
      :message="`Revoking key '${pendingKeyRevoke.name || pendingKeyRevoke.key_id}' will immediately invalidate it. Any services using this key will lose access. This cannot be undone.`"
      confirm-label="Revoke Key"
      :danger="true"
      @confirm="executeKeyRevoke"
      @cancel="pendingKeyRevoke = null"
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
      </div>
    </FormDialog>

    <!-- Create API key for this tenant -->
    <FormDialog v-if="showCreateKey" title="Create API Key" submit-label="Create Key" :loading="createKeyLoading" :error="createKeyError" @submit="submitCreateKey" @cancel="showCreateKey = false">
      <div>
        <label for="ck2-name" class="form-label">Name</label>
        <input id="ck2-name" v-model="createKeyForm.name" required class="form-input" placeholder="my-service-key" />
      </div>
      <div>
        <label class="form-label">Permissions</label>
        <PermissionPicker v-model="createKeyForm.permissions" />
      </div>
      <div>
        <label for="ck2-scope" class="form-label">Scope filter (comma-separated, optional)</label>
        <input id="ck2-scope" v-model="createKeyForm.scope_filter" class="form-input-mono" />
      </div>
      <div>
        <label for="ck2-expires" class="form-label">Expires at (optional)</label>
        <input id="ck2-expires" v-model="createKeyForm.expires_at" type="datetime-local" class="border border-gray-300 rounded px-2 py-1.5 text-sm" />
      </div>
    </FormDialog>

    <SecretReveal v-if="createdKeySecret" title="API Key Created" :secret="createdKeySecret.key_secret" label="API Key Secret" @close="createdKeySecret = null; refresh()" />

    <!-- Edit API Key — mirrors ApiKeysView.vue's edit dialog, including
         the green/red pending-changes diff so operators see what the
         PATCH body will actually carry. -->
    <FormDialog v-if="editingKey" title="Edit API Key" submit-label="Save Changes" :loading="editKeyLoading" :error="editKeyError" @submit="submitEditKey" @cancel="editingKey = null">
      <div>
        <label for="ek2-name" class="form-label">Name</label>
        <input id="ek2-name" v-model="editKeyForm.name" required class="form-input" />
      </div>
      <div>
        <label class="form-label">Permissions</label>
        <PermissionPicker v-model="editKeyForm.permissions" />
        <div
          v-if="pendingKeyPermAdds.length || pendingKeyPermRemoves.length"
          class="mt-2 text-xs flex flex-wrap gap-1 items-center"
          aria-live="polite"
        >
          <template v-if="pendingKeyPermAdds.length">
            <span class="text-green-700 font-medium">Adding:</span>
            <span
              v-for="p in pendingKeyPermAdds"
              :key="'add:' + p"
              class="bg-green-50 text-green-700 border border-green-200 rounded px-1.5 py-0.5 font-mono"
            >+{{ p }}</span>
          </template>
          <template v-if="pendingKeyPermRemoves.length">
            <span class="text-red-700 font-medium" :class="pendingKeyPermAdds.length ? 'ml-3' : ''">Removing:</span>
            <span
              v-for="p in pendingKeyPermRemoves"
              :key="'rem:' + p"
              class="bg-red-50 text-red-700 border border-red-200 rounded px-1.5 py-0.5 font-mono"
            >−{{ p }}</span>
          </template>
        </div>
      </div>
      <div>
        <label for="ek2-scope" class="form-label">Scope filter (comma-separated)</label>
        <input id="ek2-scope" v-model="editKeyForm.scope_filter" class="form-input-mono" />
      </div>
    </FormDialog>

    <!-- v0.1.25.21 (#7): Emergency Freeze confirm. Intentionally spells
         out the blast radius (N budgets, list of scopes if small) so ops
         sees exactly what they're about to hit. Uses bulk-loader pattern
         from TenantsView — sequential calls, progress in message slot,
         cancel between requests. -->
    <ConfirmAction
      v-if="pendingEmergencyFreeze"
      title="Emergency Freeze all budgets?"
      :message="emergencyFreezeRunning
        ? `Working… ${emergencyFreezeProgress.done}/${emergencyFreezeProgress.total} processed${emergencyFreezeProgress.failed ? ` (${emergencyFreezeProgress.failed} failed)` : ''}.`
        : `Freezes ALL ${activeBudgets.length} ACTIVE budgets for tenant '${tenant?.name || id}'. Pending reservations against these scopes will be rejected until unfrozen. FROZEN / CLOSED budgets are skipped. Audit log records 'Emergency freeze — tenant lockdown' as the reason on each.`"
      :confirm-label="emergencyFreezeRunning ? 'Working…' : `Freeze ${activeBudgets.length} budgets`"
      :danger="true"
      :loading="emergencyFreezeRunning"
      @confirm="executeEmergencyFreeze"
      @cancel="cancelEmergencyFreeze"
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

    <!-- v0.1.25.20: Create Policy (admin-on-behalf-of) -->
    <FormDialog v-if="showCreatePolicy" title="Create Policy" submit-label="Create" :loading="createPolicyLoading" :error="createPolicyError" @submit="submitCreatePolicy" @cancel="showCreatePolicy = false">
      <div>
        <label for="cp-name" class="form-label">Name</label>
        <input id="cp-name" v-model="createPolicyForm.name" required maxlength="256" class="form-input" />
      </div>
      <div>
        <label class="form-label">Scope pattern</label>
        <!-- Policy patterns enable wildcards: per-row "any <kind> (*)"
             radio for id-wildcards, and a trailing /* checkbox for
             "match everything deeper." -->
        <ScopeBuilder v-model="createPolicyForm.scope_pattern" :tenant-id="id" allow-wildcards />
      </div>
      <div>
        <label for="cp-desc" class="form-label">Description (optional)</label>
        <input id="cp-desc" v-model="createPolicyForm.description" maxlength="1024" class="form-input" />
      </div>
      <div>
        <label for="cp-priority" class="form-label">Priority (higher wins on overlap)</label>
        <input id="cp-priority" v-model="createPolicyForm.priority" type="number" step="1" class="form-input-mono" placeholder="0" />
      </div>
      <div>
        <label for="cp-cop" class="form-label">Commit overage policy (optional)</label>
        <select id="cp-cop" v-model="createPolicyForm.commit_overage_policy" class="form-select w-full">
          <option value="">— Default —</option>
          <option v-for="p in COMMIT_OVERAGE_POLICIES" :key="p" :value="p">{{ p }}</option>
        </select>
      </div>
    </FormDialog>

    <!-- v0.1.25.20: Edit Policy -->
    <FormDialog v-if="showEditPolicy" title="Edit Policy" submit-label="Save Changes" :loading="editPolicyLoading" :error="editPolicyError" @submit="submitEditPolicy" @cancel="showEditPolicy = false">
      <div>
        <label for="ep-name" class="form-label">Name</label>
        <input id="ep-name" v-model="editPolicyForm.name" maxlength="256" class="form-input" />
      </div>
      <div>
        <label for="ep-desc" class="form-label">Description (optional)</label>
        <input id="ep-desc" v-model="editPolicyForm.description" maxlength="1024" class="form-input" />
      </div>
      <div>
        <label for="ep-priority" class="form-label">Priority</label>
        <input id="ep-priority" v-model="editPolicyForm.priority" type="number" step="1" class="form-input-mono" />
      </div>
      <div>
        <label for="ep-cop" class="form-label">Commit overage policy (optional)</label>
        <select id="ep-cop" v-model="editPolicyForm.commit_overage_policy" class="form-select w-full">
          <option value="">— Unchanged —</option>
          <option v-for="p in COMMIT_OVERAGE_POLICIES" :key="p" :value="p">{{ p }}</option>
        </select>
      </div>
    </FormDialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { getTenant, listBudgets, listApiKeys, listPolicies, updateTenantStatus, updateTenant, revokeApiKey, createApiKey, createBudget, createPolicy, updatePolicy } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { Tenant, BudgetLedger, ApiKey, Policy, ApiKeyCreateResponse, BudgetCreateRequest, PolicyCreateRequest, PolicyUpdateRequest } from '../types'
import { PERMISSIONS, COMMIT_OVERAGE_POLICIES } from '../types'
import { validateScope } from '../utils/safe'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import MaskedValue from '../components/MaskedValue.vue'
import EmptyState from '../components/EmptyState.vue'
import ConfirmAction from '../components/ConfirmAction.vue'
import FormDialog from '../components/FormDialog.vue'
import SecretReveal from '../components/SecretReveal.vue'
import ScopeBuilder from '../components/ScopeBuilder.vue'
import { useToast } from '../composables/useToast'
import { toMessage } from '../utils/errors'

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

const tenant = ref<Tenant | null>(null)
const budgets = ref<BudgetLedger[]>([])
const apiKeys = ref<ApiKey[]>([])
const policies = ref<Policy[]>([])
const error = ref('')
const tab = ref<'budgets' | 'keys' | 'policies'>('budgets')

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

const { refresh, isLoading, lastUpdated } = usePolling(async () => {
  try {
    tenant.value = await getTenant(id)
    const [bRes, kRes, pRes] = await Promise.all([
      listBudgets({ tenant_id: id }),
      listApiKeys({ tenant_id: id }),
      listPolicies({ tenant_id: id }),
    ])
    budgets.value = bRes.ledgers
    apiKeys.value = kRes.keys
    policies.value = pRes.policies
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
}, 60000)
</script>

<template>
  <div>
    <PageHeader title="Tenant Detail" :subtitle="tenant?.tenant_id" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh">
      <template #back>
        <button @click="router.push('/tenants')" aria-label="Back to tenants" class="text-gray-400 hover:text-gray-700 cursor-pointer">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
        </button>
      </template>
    </PageHeader>
    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">{{ error }}</p>

    <template v-if="tenant">
      <div class="bg-white rounded-lg shadow p-6 mb-4">
        <div class="flex items-center gap-3 mb-2 flex-wrap">
          <h2 class="text-lg font-medium text-gray-900">{{ tenant.name }}</h2>
          <StatusBadge :status="tenant.status" />
          <span class="flex-1" />
          <div v-if="canManageTenants" class="flex gap-2">
            <button @click="openEditTenant" class="text-xs text-gray-600 hover:text-gray-800 border border-gray-200 rounded px-2.5 py-1 hover:bg-gray-100 cursor-pointer transition-colors">Edit</button>
            <button v-if="tenant.status === 'ACTIVE'" @click="pendingTenantAction = 'SUSPENDED'" class="text-xs text-red-600 hover:text-red-800 border border-red-200 rounded px-2.5 py-1 hover:bg-red-50 cursor-pointer transition-colors">Suspend</button>
            <button v-if="tenant.status === 'SUSPENDED'" @click="pendingTenantAction = 'ACTIVE'" class="text-xs text-green-700 hover:text-green-900 border border-green-200 rounded px-2.5 py-1 hover:bg-green-50 cursor-pointer transition-colors">Reactivate</button>
            <button v-if="tenant.status !== 'CLOSED'" @click="pendingTenantAction = 'CLOSED'" class="text-xs text-red-600 hover:text-red-800 border border-red-200 rounded px-2.5 py-1 hover:bg-red-50 cursor-pointer transition-colors">Close</button>
          </div>
        </div>
        <p class="text-sm text-gray-500 font-mono">{{ tenant.tenant_id }}</p>
        <p v-if="tenant.parent_tenant_id" class="text-sm text-gray-400 mt-1">Parent: <router-link :to="{ name: 'tenant-detail', params: { id: tenant.parent_tenant_id } }" class="text-blue-600 hover:underline">{{ tenant.parent_tenant_id }}</router-link></p>
      </div>

      <!-- Tabs -->
      <div class="flex border-b border-gray-200 mb-4">
        <button v-for="t in (['budgets', 'keys', 'policies'] as const)" :key="t"
          @click="tab = t"
          :class="tab === t ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-700'"
          class="px-4 py-2 text-sm font-medium border-b-2 -mb-px cursor-pointer transition-colors">
          {{ t === 'keys' ? 'API Keys' : t.charAt(0).toUpperCase() + t.slice(1) }}
          <span class="ml-1 text-xs text-gray-400">({{ t === 'budgets' ? budgets.length : t === 'keys' ? apiKeys.length : policies.length }})</span>
        </button>
      </div>

      <!-- Budgets tab -->
      <div v-if="tab === 'budgets' && canManageBudgets" class="flex justify-end mb-2">
        <button @click="openCreateBudget" class="text-xs bg-blue-600 text-white hover:bg-blue-700 rounded px-3 py-1.5 cursor-pointer transition-colors">Create Budget</button>
      </div>
      <div v-if="tab === 'budgets'" class="bg-white rounded-lg shadow overflow-hidden overflow-x-auto">
        <table class="w-full text-sm min-w-[520px]">
          <thead class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
            <tr><th class="px-4 py-3 text-left">Scope</th><th class="px-4 py-3 text-left">Unit</th><th class="px-4 py-3 text-left">Status</th><th class="px-4 py-3 text-right">Allocated</th></tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="b in budgets" :key="b.ledger_id" class="hover:bg-gray-50 transition-colors">
              <td class="px-4 py-3"><router-link :to="{ name: 'budgets', query: { scope: b.scope, unit: b.unit } }" class="text-blue-600 hover:underline font-mono text-xs">{{ b.scope }}</router-link></td>
              <td class="px-4 py-3 text-gray-500">{{ b.unit }}</td>
              <td class="px-4 py-3"><StatusBadge :status="b.status" /></td>
              <td class="px-4 py-3 text-right text-gray-500 tabular-nums">{{ b.allocated.amount.toLocaleString() }}</td>
            </tr>
            <tr v-if="budgets.length === 0"><td colspan="4"><EmptyState message="No budgets" hint="Budgets will appear here once allocated" /></td></tr>
          </tbody>
        </table>
      </div>

      <!-- API Keys tab -->
      <div v-if="tab === 'keys' && canManageKeys" class="flex justify-end mb-2">
        <button @click="openCreateKey" class="text-xs bg-blue-600 text-white hover:bg-blue-700 rounded px-3 py-1.5 cursor-pointer transition-colors">Create API Key</button>
      </div>
      <div v-if="tab === 'keys'" class="bg-white rounded-lg shadow overflow-hidden overflow-x-auto">
        <table class="w-full text-sm min-w-[520px]">
          <thead class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
            <tr><th class="px-4 py-3 text-left">Key ID</th><th class="px-4 py-3 text-left">Name</th><th class="px-4 py-3 text-left">Status</th><th class="px-4 py-3 text-left">Permissions</th><th v-if="canManageKeys" class="px-4 py-3 w-20"></th></tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="k in apiKeys" :key="k.key_id" class="hover:bg-gray-50 transition-colors">
              <td class="px-4 py-3"><MaskedValue :value="k.key_id" /></td>
              <td class="px-4 py-3 text-gray-700">{{ k.name || '-' }}</td>
              <td class="px-4 py-3"><StatusBadge :status="k.status" /></td>
              <td class="px-4 py-3 text-xs text-gray-500">{{ k.permissions.join(', ') }}</td>
              <td v-if="canManageKeys" class="px-4 py-3">
                <button v-if="k.status === 'ACTIVE'" @click="pendingKeyRevoke = k" class="text-xs text-red-600 hover:text-red-800 cursor-pointer hover:underline">Revoke</button>
              </td>
            </tr>
            <tr v-if="apiKeys.length === 0"><td :colspan="canManageKeys ? 5 : 4"><EmptyState message="No API keys" hint="API keys will appear here once created" /></td></tr>
          </tbody>
        </table>
      </div>

      <!-- Policies tab -->
      <div v-if="tab === 'policies' && canManagePolicies" class="flex justify-end mb-2">
        <button @click="openCreatePolicy" class="text-xs bg-blue-600 text-white hover:bg-blue-700 rounded px-3 py-1.5 cursor-pointer transition-colors">Create Policy</button>
      </div>
      <div v-if="tab === 'policies'" class="bg-white rounded-lg shadow overflow-hidden overflow-x-auto">
        <table class="w-full text-sm min-w-[520px]">
          <thead class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
            <tr><th class="px-4 py-3 text-left">Policy ID</th><th class="px-4 py-3 text-left">Name</th><th class="px-4 py-3 text-left">Scope</th><th class="px-4 py-3 text-left">Status</th><th v-if="canManagePolicies" class="px-4 py-3 w-20"></th></tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="p in policies" :key="p.policy_id" class="hover:bg-gray-50 transition-colors">
              <td class="px-4 py-3 font-mono text-xs">{{ p.policy_id }}</td>
              <td class="px-4 py-3 text-gray-700">{{ p.name }}</td>
              <td class="px-4 py-3 text-gray-500 font-mono text-xs">{{ p.scope_pattern }}</td>
              <td class="px-4 py-3"><StatusBadge :status="p.status" /></td>
              <td v-if="canManagePolicies" class="px-4 py-3">
                <button @click="openEditPolicy(p)" class="text-xs text-gray-600 hover:text-gray-800 cursor-pointer hover:underline">Edit</button>
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
        <input v-model="closeConfirmInput" type="text" :placeholder="tenant?.name || id" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full mb-4 font-mono" autocomplete="off" />
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
        <label for="et-name" class="block text-xs text-gray-500 mb-1">Display Name</label>
        <input id="et-name" v-model="editTenantForm.name" required maxlength="256" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full" />
      </div>
      <div>
        <label for="et-overage" class="block text-xs text-gray-500 mb-1">Default Commit Overage Policy</label>
        <select id="et-overage" v-model="editTenantForm.default_commit_overage_policy" class="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white w-full">
          <option value="">Inherit</option>
          <option value="REJECT">Reject</option>
          <option value="ALLOW_IF_AVAILABLE">Allow if available</option>
          <option value="ALLOW_WITH_OVERDRAFT">Allow with overdraft</option>
        </select>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label for="et-ttl" class="block text-xs text-gray-500 mb-1">Default Reservation TTL (ms)</label>
          <input id="et-ttl" v-model="editTenantForm.default_reservation_ttl_ms" type="number" min="1000" max="86400000" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full" placeholder="60000" />
        </div>
        <div>
          <label for="et-max-ttl" class="block text-xs text-gray-500 mb-1">Max Reservation TTL (ms)</label>
          <input id="et-max-ttl" v-model="editTenantForm.max_reservation_ttl_ms" type="number" min="1000" max="86400000" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full" placeholder="3600000" />
        </div>
      </div>
    </FormDialog>

    <!-- Create API key for this tenant -->
    <FormDialog v-if="showCreateKey" title="Create API Key" submit-label="Create Key" :loading="createKeyLoading" :error="createKeyError" @submit="submitCreateKey" @cancel="showCreateKey = false">
      <div>
        <label for="ck2-name" class="block text-xs text-gray-500 mb-1">Name</label>
        <input id="ck2-name" v-model="createKeyForm.name" required class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full" placeholder="my-service-key" />
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">Permissions</label>
        <div class="grid grid-cols-2 gap-1 max-h-40 overflow-y-auto border border-gray-200 rounded p-2">
          <label v-for="p in PERMISSIONS" :key="p" class="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" :value="p" v-model="createKeyForm.permissions" class="rounded" />
            {{ p }}
          </label>
        </div>
      </div>
      <div>
        <label for="ck2-scope" class="block text-xs text-gray-500 mb-1">Scope filter (comma-separated, optional)</label>
        <input id="ck2-scope" v-model="createKeyForm.scope_filter" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full font-mono" />
      </div>
      <div>
        <label for="ck2-expires" class="block text-xs text-gray-500 mb-1">Expires at (optional)</label>
        <input id="ck2-expires" v-model="createKeyForm.expires_at" type="datetime-local" class="border border-gray-300 rounded px-2 py-1.5 text-sm" />
      </div>
    </FormDialog>

    <SecretReveal v-if="createdKeySecret" title="API Key Created" :secret="createdKeySecret.key_secret" label="API Key Secret" @close="createdKeySecret = null; refresh()" />

    <!-- v0.1.25.20: Create Budget (admin-on-behalf-of) -->
    <FormDialog v-if="showCreateBudget" title="Create Budget" submit-label="Create" :loading="createBudgetLoading" :error="createBudgetError" @submit="submitCreateBudget" @cancel="showCreateBudget = false">
      <div>
        <label class="block text-xs text-gray-500 mb-1">Scope</label>
        <!-- v0.1.25.20: structured builder replaces the free-text input.
             Tenant row is locked to the current detail's tenant, so the
             admin-on-behalf-of cross-field check passes by construction.
             Deeper levels chosen from an "+ Add level" dropdown that only
             offers canonical kinds in canonical order. -->
        <ScopeBuilder v-model="createBudgetForm.scope" :tenant-id="id" />
      </div>
      <div>
        <label for="cb-unit" class="block text-xs text-gray-500 mb-1">Unit</label>
        <select id="cb-unit" v-model="createBudgetForm.unit" required class="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white w-full">
          <option value="USD_MICROCENTS">USD_MICROCENTS</option>
          <option value="TOKENS">TOKENS</option>
          <option value="CREDITS">CREDITS</option>
          <option value="RISK_POINTS">RISK_POINTS</option>
        </select>
      </div>
      <div>
        <label for="cb-allocated" class="block text-xs text-gray-500 mb-1">Initial allocation</label>
        <input id="cb-allocated" v-model="createBudgetForm.allocated" type="number" min="0" step="1" required class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full font-mono" />
      </div>
      <div>
        <label for="cb-overdraft" class="block text-xs text-gray-500 mb-1">Overdraft limit (optional)</label>
        <input id="cb-overdraft" v-model="createBudgetForm.overdraft_limit" type="number" min="0" step="1" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full font-mono" />
      </div>
      <div>
        <label for="cb-cop" class="block text-xs text-gray-500 mb-1">Commit overage policy (optional)</label>
        <select id="cb-cop" v-model="createBudgetForm.commit_overage_policy" class="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white w-full">
          <option value="">— Inherit from tenant —</option>
          <option v-for="p in COMMIT_OVERAGE_POLICIES" :key="p" :value="p">{{ p }}</option>
        </select>
      </div>
    </FormDialog>

    <!-- v0.1.25.20: Create Policy (admin-on-behalf-of) -->
    <FormDialog v-if="showCreatePolicy" title="Create Policy" submit-label="Create" :loading="createPolicyLoading" :error="createPolicyError" @submit="submitCreatePolicy" @cancel="showCreatePolicy = false">
      <div>
        <label for="cp-name" class="block text-xs text-gray-500 mb-1">Name</label>
        <input id="cp-name" v-model="createPolicyForm.name" required maxlength="256" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full" />
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">Scope pattern</label>
        <!-- Policy patterns enable wildcards: per-row "any <kind> (*)"
             radio for id-wildcards, and a trailing /* checkbox for
             "match everything deeper." -->
        <ScopeBuilder v-model="createPolicyForm.scope_pattern" :tenant-id="id" allow-wildcards />
      </div>
      <div>
        <label for="cp-desc" class="block text-xs text-gray-500 mb-1">Description (optional)</label>
        <input id="cp-desc" v-model="createPolicyForm.description" maxlength="1024" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full" />
      </div>
      <div>
        <label for="cp-priority" class="block text-xs text-gray-500 mb-1">Priority (higher wins on overlap)</label>
        <input id="cp-priority" v-model="createPolicyForm.priority" type="number" step="1" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full font-mono" placeholder="0" />
      </div>
      <div>
        <label for="cp-cop" class="block text-xs text-gray-500 mb-1">Commit overage policy (optional)</label>
        <select id="cp-cop" v-model="createPolicyForm.commit_overage_policy" class="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white w-full">
          <option value="">— Default —</option>
          <option v-for="p in COMMIT_OVERAGE_POLICIES" :key="p" :value="p">{{ p }}</option>
        </select>
      </div>
    </FormDialog>

    <!-- v0.1.25.20: Edit Policy -->
    <FormDialog v-if="showEditPolicy" title="Edit Policy" submit-label="Save Changes" :loading="editPolicyLoading" :error="editPolicyError" @submit="submitEditPolicy" @cancel="showEditPolicy = false">
      <div>
        <label for="ep-name" class="block text-xs text-gray-500 mb-1">Name</label>
        <input id="ep-name" v-model="editPolicyForm.name" maxlength="256" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full" />
      </div>
      <div>
        <label for="ep-desc" class="block text-xs text-gray-500 mb-1">Description (optional)</label>
        <input id="ep-desc" v-model="editPolicyForm.description" maxlength="1024" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full" />
      </div>
      <div>
        <label for="ep-priority" class="block text-xs text-gray-500 mb-1">Priority</label>
        <input id="ep-priority" v-model="editPolicyForm.priority" type="number" step="1" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full font-mono" />
      </div>
      <div>
        <label for="ep-cop" class="block text-xs text-gray-500 mb-1">Commit overage policy (optional)</label>
        <select id="ep-cop" v-model="editPolicyForm.commit_overage_policy" class="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white w-full">
          <option value="">— Unchanged —</option>
          <option v-for="p in COMMIT_OVERAGE_POLICIES" :key="p" :value="p">{{ p }}</option>
        </select>
      </div>
    </FormDialog>
  </div>
</template>

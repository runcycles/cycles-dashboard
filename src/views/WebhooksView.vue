<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { useSort } from '../composables/useSort'
import { listWebhooks, listTenants, createWebhook, updateWebhook, getWebhookSecurityConfig, updateWebhookSecurityConfig } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { WebhookSubscription, WebhookCreateResponse, Tenant, WebhookSecurityConfig } from '../types'
import { EVENT_TYPES } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import ConfirmAction from '../components/ConfirmAction.vue'
import FormDialog from '../components/FormDialog.vue'
import SecretReveal from '../components/SecretReveal.vue'
import { useToast } from '../composables/useToast'
import { toMessage } from '../utils/errors'

const toast = useToast()

const router = useRouter()
const auth = useAuthStore()
const canManage = computed(() => auth.capabilities?.manage_webhooks !== false)

const webhooks = ref<WebhookSubscription[]>([])
const tenants = ref<Tenant[]>([])
const error = ref('')

// v0.1.25.21 (#5): filter by tenant + bulk pause/enable. The existing
// view was system-wide with no way to scope to "webhooks for tenant X"
// — an ops pain when you need to pause a noisy tenant's subscriptions.
const tenantFilter = ref('')
const filteredWebhooks = computed(() =>
  tenantFilter.value
    ? webhooks.value.filter(w => w.tenant_id === tenantFilter.value)
    : webhooks.value,
)
// Clear the selection when the tenant filter changes. Otherwise a user
// who selects 5 webhooks for tenant A then switches the filter to
// tenant B would see "0 selected" in the bulk bar (selectedVisibleCount
// reads filtered state) but `selected.value` still holds the 5 hidden
// ids — clicking "Pause selected" would silently affect tenant A's
// webhooks even though tenant B is what's on screen.
watch(tenantFilter, () => { selected.value = new Set() })
const { sortKey, sortDir, toggle, sorted: sortedWebhooks } = useSort(filteredWebhooks)

const selected = ref<Set<string>>(new Set())
function toggleSelect(id: string) {
  const next = new Set(selected.value)
  next.has(id) ? next.delete(id) : next.add(id)
  selected.value = next
}
const selectedVisibleAll = computed(() =>
  filteredWebhooks.value.length > 0 &&
  filteredWebhooks.value.every(w => selected.value.has(w.subscription_id)),
)
const selectedVisibleCount = computed(() =>
  filteredWebhooks.value.filter(w => selected.value.has(w.subscription_id)).length,
)
function toggleSelectAll() {
  if (selectedVisibleAll.value) {
    selected.value = new Set()
  } else {
    selected.value = new Set(filteredWebhooks.value.map(w => w.subscription_id))
  }
}

// Bulk pause/enable with the same sequential + cancel + summary pattern
// as TenantsView bulk. See executeBulk there for the design rationale
// (sequential to keep progress honest and avoid rate-limit bursts).
const bulkAction = ref<'PAUSED' | 'ACTIVE' | null>(null)
const bulkProgress = ref({ done: 0, total: 0, failed: 0 })
const bulkRunning = ref(false)
const bulkCancelRequested = ref(false)

function openBulk(action: 'PAUSED' | 'ACTIVE') { bulkAction.value = action }
async function executeBulk() {
  if (!bulkAction.value || bulkRunning.value) return
  const action = bulkAction.value
  // Skip webhooks that are already in target state OR that are DISABLED
  // (DISABLED is set by the server after too many failures — reactivating
  // should be an explicit single-row action, not a bulk sweep, because
  // those endpoints are likely still broken).
  const targets = webhooks.value.filter(w =>
    selected.value.has(w.subscription_id) &&
    w.status !== action &&
    w.status !== 'DISABLED'
  )
  bulkProgress.value = { done: 0, total: targets.length, failed: 0 }
  bulkRunning.value = true
  bulkCancelRequested.value = false
  for (const w of targets) {
    if (bulkCancelRequested.value) break
    try { await updateWebhook(w.subscription_id, { status: action }) }
    catch (e) {
      bulkProgress.value.failed++
      console.warn(`bulk ${action} failed on ${w.subscription_id}:`, toMessage(e))
    }
    bulkProgress.value.done++
  }
  bulkRunning.value = false
  const verb = action === 'PAUSED' ? 'paused' : 'enabled'
  const summary = `${bulkProgress.value.done - bulkProgress.value.failed}/${bulkProgress.value.total} webhooks ${verb}`
  if (bulkProgress.value.failed > 0) {
    toast.error(`${summary}, ${bulkProgress.value.failed} failed — check console for details`)
  } else if (bulkCancelRequested.value) {
    toast.success(`${summary} (cancelled by user)`)
  } else {
    toast.success(summary)
  }
  bulkAction.value = null
  selected.value = new Set()
  await refresh()
}
function cancelBulk() {
  if (bulkRunning.value) bulkCancelRequested.value = true
  else bulkAction.value = null
}

function healthColor(w: WebhookSubscription): string {
  if (w.status === 'DISABLED') return 'bg-red-500'
  if ((w.consecutive_failures ?? 0) >= 1) return 'bg-yellow-500'
  return 'bg-green-500'
}

function healthLabel(w: WebhookSubscription): string {
  if (w.status === 'DISABLED') return 'Disabled'
  if ((w.consecutive_failures ?? 0) >= 1) return 'Failing'
  return 'Healthy'
}

// Create webhook
const showCreate = ref(false)
const createLoading = ref(false)
const createError = ref('')
const createForm = ref({ url: '', name: '', event_types: [] as string[], tenant_id: '', scope_filter: '' })
const createdWebhook = ref<WebhookCreateResponse | null>(null)

function openCreate() {
  createForm.value = { url: '', name: '', event_types: [], tenant_id: '', scope_filter: '' }
  createError.value = ''
  showCreate.value = true
}

async function onSecretClose() {
  const subId = createdWebhook.value?.subscription?.subscription_id
  createdWebhook.value = null
  if (subId) router.push({ name: 'webhook-detail', params: { id: subId } })
  else await refresh()
}

async function submitCreate() {
  createError.value = ''
  if (!createForm.value.event_types.length) { createError.value = 'Select at least one event type'; return }
  createLoading.value = true
  try {
    const body: Record<string, unknown> = { url: createForm.value.url, event_types: createForm.value.event_types }
    if (createForm.value.name) body.name = createForm.value.name
    if (createForm.value.scope_filter) body.scope_filter = createForm.value.scope_filter
    const res = await createWebhook(body as any, createForm.value.tenant_id || undefined)
    createdWebhook.value = res
    showCreate.value = false
    toast.success('Webhook created')
  } catch (e) { createError.value = toMessage(e) }
  finally { createLoading.value = false }
}

// Pause/enable from list
const pendingStatusAction = ref<{ id: string; url: string; action: 'PAUSED' | 'ACTIVE' } | null>(null)

async function executeStatusAction() {
  if (!pendingStatusAction.value) return
  const { id, action } = pendingStatusAction.value
  try {
    await updateWebhook(id, { status: action })
    toast.success(action === 'PAUSED' ? 'Webhook paused' : 'Webhook enabled')
    await refresh()
  } catch (e) {
    const msg = toMessage(e)
    error.value = msg
    toast.error(`${action === 'PAUSED' ? 'Pause' : 'Enable'} failed: ${msg}`)
  }
  finally { pendingStatusAction.value = null }
}

// Webhook security config
const showSecurityConfig = ref(false)
const securityConfig = ref<WebhookSecurityConfig | null>(null)
const securityForm = ref({ blocked_cidr: '', allowed_patterns: '', allow_http: false })
const securityLoading = ref(false)
const securityError = ref('')

async function openSecurityConfig() {
  // Reset synchronously BEFORE the dialog appears. Otherwise the dialog
  // briefly shows the previous session's values during the GET round-trip,
  // and on a slow network the user might edit those stale values before
  // the real config arrives and clobbers them.
  securityError.value = ''
  securityConfig.value = null
  securityForm.value = { blocked_cidr: '', allowed_patterns: '', allow_http: false }
  securityLoading.value = true
  showSecurityConfig.value = true
  try {
    const cfg = await getWebhookSecurityConfig()
    securityConfig.value = cfg
    securityForm.value = {
      blocked_cidr: (cfg.blocked_cidr_ranges || []).join('\n'),
      allowed_patterns: (cfg.allowed_url_patterns || []).join('\n'),
      allow_http: cfg.allow_http || false,
    }
  } catch (e) { securityError.value = toMessage(e) }
  finally { securityLoading.value = false }
}

async function submitSecurityConfig() {
  securityError.value = ''
  securityLoading.value = true
  try {
    const body: WebhookSecurityConfig = {
      blocked_cidr_ranges: securityForm.value.blocked_cidr.split('\n').map(s => s.trim()).filter(Boolean),
      allowed_url_patterns: securityForm.value.allowed_patterns.split('\n').map(s => s.trim()).filter(Boolean),
      allow_http: securityForm.value.allow_http,
    }
    await updateWebhookSecurityConfig(body)
    showSecurityConfig.value = false
    toast.success('Webhook security config updated')
  } catch (e) { securityError.value = toMessage(e) }
  finally { securityLoading.value = false }
}

const { refresh, isLoading, lastUpdated } = usePolling(async () => {
  try {
    const [wRes, tRes] = await Promise.all([listWebhooks(), listTenants()])
    webhooks.value = wRes.subscriptions
    tenants.value = tRes.tenants
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
}, 60000)
</script>

<template>
  <div>
    <PageHeader title="Webhooks" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh">
      <template #actions>
        <button v-if="canManage" @click="openSecurityConfig" class="text-xs text-gray-600 hover:text-gray-800 border border-gray-200 rounded px-2.5 py-1 hover:bg-gray-100 cursor-pointer transition-colors">Security Config</button>
        <button v-if="canManage" @click="openCreate" class="text-xs bg-blue-600 text-white hover:bg-blue-700 rounded px-3 py-1.5 cursor-pointer transition-colors">Create Webhook</button>
      </template>
    </PageHeader>
    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg table-cell mb-4">{{ error }}</p>

    <!-- Tenant filter (#5). Options sourced from the tenants the webhooks
         actually belong to rather than the full tenant list, so the
         dropdown doesn't show tenants with no subscriptions. -->
    <div class="mb-4">
      <select v-model="tenantFilter" aria-label="Filter webhooks by tenant" class="form-select">
        <option value="">All tenants</option>
        <option v-for="t in tenants.filter(t => webhooks.some(w => w.tenant_id === t.tenant_id))" :key="t.tenant_id" :value="t.tenant_id">
          {{ t.name || t.tenant_id }}
        </option>
      </select>
    </div>

    <!-- Bulk bar, visible only on selection. Same design as TenantsView. -->
    <div v-if="canManage && selectedVisibleCount > 0" class="mb-3 bg-blue-50 border border-blue-200 rounded px-4 py-2 flex items-center gap-3 flex-wrap">
      <span class="text-sm text-blue-900">{{ selectedVisibleCount }} selected</span>
      <button @click="openBulk('PAUSED')" class="text-xs text-red-700 hover:text-red-900 border border-red-300 bg-white rounded px-2.5 py-1 cursor-pointer">Pause selected</button>
      <button @click="openBulk('ACTIVE')" class="text-xs text-green-700 hover:text-green-900 border border-green-300 bg-white rounded px-2.5 py-1 cursor-pointer">Enable selected</button>
      <button @click="selected = new Set()" class="text-xs text-gray-600 dark:text-gray-500 hover:text-gray-700 ml-auto cursor-pointer">Clear</button>
    </div>

    <div class="card-table">
      <table class="w-full text-sm min-w-[680px]">
        <thead class="table-header">
          <tr>
            <th v-if="canManage" class="table-cell w-10">
              <input type="checkbox" :checked="selectedVisibleAll" @change="toggleSelectAll" aria-label="Select all visible webhooks" />
            </th>
            <th class="table-cell text-left w-10">Health</th>
            <SortHeader label="URL" column="url" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Status" column="status" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Failures" column="consecutive_failures" :active-column="sortKey" :direction="sortDir" @sort="toggle" align="right" />
            <th class="table-cell text-left">Events</th>
            <th v-if="canManage" class="table-cell w-20"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="w in sortedWebhooks" :key="w.subscription_id" class="table-row-hover">
            <td v-if="canManage" class="table-cell">
              <input type="checkbox" :checked="selected.has(w.subscription_id)" @change="toggleSelect(w.subscription_id)" :aria-label="`Select webhook ${w.name || w.url}`" />
            </td>
            <td class="table-cell"><span :class="healthColor(w)" class="inline-block w-2.5 h-2.5 rounded-full" :title="healthLabel(w)" /></td>
            <td class="table-cell">
              <router-link :to="{ name: 'webhook-detail', params: { id: w.subscription_id } }" class="text-blue-600 hover:underline truncate block max-w-[300px]">{{ w.url }}</router-link>
              <span v-if="w.name" class="text-xs text-gray-600 dark:text-gray-400">{{ w.name }}</span>
            </td>
            <td class="table-cell"><StatusBadge :status="w.status" /></td>
            <td class="table-cell text-right tabular-nums" :class="(w.consecutive_failures ?? 0) > 0 ? 'text-red-600 font-medium' : 'text-gray-600 dark:text-gray-400'">{{ w.consecutive_failures ?? 0 }}</td>
            <td class="table-cell text-xs text-gray-600 dark:text-gray-500">{{ w.event_types?.join(', ') || w.event_categories?.join(', ') || 'all' }}</td>
            <td v-if="canManage" class="table-cell">
              <button v-if="w.status === 'ACTIVE'" @click="pendingStatusAction = { id: w.subscription_id, url: w.url, action: 'PAUSED' }" class="text-xs text-red-600 hover:text-red-800 cursor-pointer hover:underline">Pause</button>
              <button v-if="w.status === 'PAUSED' || w.status === 'DISABLED'" @click="pendingStatusAction = { id: w.subscription_id, url: w.url, action: 'ACTIVE' }" class="text-xs text-green-700 hover:text-green-900 cursor-pointer hover:underline">Enable</button>
            </td>
          </tr>
          <tr v-if="filteredWebhooks.length === 0">
            <td :colspan="canManage ? 7 : 5"><EmptyState :message="tenantFilter ? 'No webhooks for this tenant' : 'No webhook subscriptions'" hint="Webhook subscriptions will appear here once configured" /></td>
          </tr>
        </tbody>
      </table>
    </div>

    <ConfirmAction
      v-if="pendingStatusAction"
      :title="pendingStatusAction.action === 'PAUSED' ? 'Pause this webhook?' : 'Enable this webhook?'"
      :message="pendingStatusAction.action === 'PAUSED'
        ? `Pausing will stop all event deliveries to '${pendingStatusAction.url}'. Events will be silently dropped.`
        : `Enabling will resume event deliveries to '${pendingStatusAction.url}'.`"
      :confirm-label="pendingStatusAction.action === 'PAUSED' ? 'Pause' : 'Enable'"
      :danger="pendingStatusAction.action === 'PAUSED'"
      @confirm="executeStatusAction"
      @cancel="pendingStatusAction = null"
    />

    <!-- Bulk confirm (#5). DISABLED webhooks are excluded server-side from
         the loop because reactivating them should be an explicit per-row
         decision (the URL is likely still broken). -->
    <ConfirmAction
      v-if="bulkAction"
      :title="bulkAction === 'PAUSED'
        ? `Pause ${bulkRunning ? bulkProgress.total : selectedVisibleCount} webhooks?`
        : `Enable ${bulkRunning ? bulkProgress.total : selectedVisibleCount} webhooks?`"
      :message="bulkRunning
        ? `Working… ${bulkProgress.done}/${bulkProgress.total} processed${bulkProgress.failed ? ` (${bulkProgress.failed} failed)` : ''}.`
        : bulkAction === 'PAUSED'
          ? `Pauses each selected subscription. Events to paused endpoints are dropped. Webhooks already PAUSED or DISABLED are skipped.`
          : `Re-enables each selected subscription. Webhooks already ACTIVE are skipped. DISABLED webhooks (auto-disabled after failures) must be re-enabled individually so you can verify the endpoint is healthy first.`"
      :confirm-label="bulkRunning ? 'Working…' : bulkAction === 'PAUSED' ? 'Pause all' : 'Enable all'"
      :danger="bulkAction === 'PAUSED'"
      :loading="bulkRunning"
      @confirm="executeBulk"
      @cancel="cancelBulk"
    />

    <FormDialog v-if="showCreate" title="Create Webhook" submit-label="Create Webhook" :loading="createLoading" :error="createError" @submit="submitCreate" @cancel="showCreate = false" :wide="true">
      <div>
        <label for="cw-url" class="form-label">URL</label>
        <input id="cw-url" v-model="createForm.url" type="url" required class="form-input-mono" placeholder="https://example.com/webhooks" />
      </div>
      <div>
        <label for="cw-name" class="form-label">Name (optional)</label>
        <input id="cw-name" v-model="createForm.name" class="form-input" placeholder="Production alerts" />
      </div>
      <div>
        <label for="cw-tenant" class="form-label">Tenant (optional — omit for system-wide)</label>
        <select id="cw-tenant" v-model="createForm.tenant_id" class="form-select w-full">
          <option value="">System-wide</option>
          <option v-for="t in tenants" :key="t.tenant_id" :value="t.tenant_id">{{ t.name || t.tenant_id }}</option>
        </select>
      </div>
      <div>
        <label class="form-label">Event types</label>
        <div class="grid grid-cols-2 gap-1 max-h-48 overflow-y-auto border border-gray-200 rounded p-2">
          <label v-for="et in EVENT_TYPES" :key="et" class="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" :value="et" v-model="createForm.event_types" class="rounded" />
            {{ et }}
          </label>
        </div>
      </div>
      <div>
        <label for="cw-scope" class="form-label">Scope filter (optional)</label>
        <input id="cw-scope" v-model="createForm.scope_filter" class="form-input-mono" placeholder="tenant:acme/*" />
      </div>
    </FormDialog>

    <SecretReveal
      v-if="createdWebhook?.signing_secret"
      title="Webhook Created"
      :secret="createdWebhook.signing_secret"
      label="Signing Secret"
      @close="onSecretClose"
    />

    <!-- Webhook security config dialog -->
    <FormDialog v-if="showSecurityConfig" title="Webhook Security Config" submit-label="Save Config" :loading="securityLoading" :error="securityError" @submit="submitSecurityConfig" @cancel="showSecurityConfig = false">
      <p class="text-xs text-gray-600 dark:text-gray-500">Server-level security rules applied to all webhook create/update operations. Changes take effect immediately. Existing subscriptions are not retroactively validated.</p>
      <div>
        <label for="sc-cidr" class="form-label">Blocked CIDR ranges (one per line)</label>
        <textarea id="sc-cidr" v-model="securityForm.blocked_cidr" rows="4" class="form-input-mono" placeholder="10.0.0.0/8&#10;172.16.0.0/12&#10;192.168.0.0/16" />
        <p class="text-xs text-gray-600 dark:text-gray-400 mt-0.5">Webhook URLs resolving to these ranges will be blocked (SSRF protection)</p>
      </div>
      <div>
        <label for="sc-patterns" class="form-label">Allowed URL patterns (one per line, glob syntax)</label>
        <textarea id="sc-patterns" v-model="securityForm.allowed_patterns" rows="3" class="form-input-mono" placeholder="https://*.example.com/*" />
        <p class="text-xs text-gray-600 dark:text-gray-400 mt-0.5">If non-empty, only URLs matching at least one pattern are allowed</p>
      </div>
      <label class="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
        <input v-model="securityForm.allow_http" type="checkbox" class="rounded" />
        Allow HTTP (non-HTTPS) webhook URLs
      </label>
    </FormDialog>
  </div>
</template>

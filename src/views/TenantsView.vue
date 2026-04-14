<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { useSort } from '../composables/useSort'
import { listTenants, createTenant, updateTenantStatus } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { Tenant } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import FormDialog from '../components/FormDialog.vue'
import ConfirmAction from '../components/ConfirmAction.vue'
import { formatDate } from '../utils/format'
import { useToast } from '../composables/useToast'
import { toMessage } from '../utils/errors'

const toast = useToast()

const router = useRouter()
const auth = useAuthStore()
const canManage = computed(() => auth.capabilities?.manage_tenants !== false)

const tenants = ref<Tenant[]>([])
const error = ref('')
const search = ref('')
const parentFilter = ref('')

// v0.1.25.21 (#2): show hierarchy. Derive child counts once per poll so
// the column render doesn't re-filter tenants.value for every row.
const childCountMap = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = {}
  for (const t of tenants.value) {
    if (t.parent_tenant_id) counts[t.parent_tenant_id] = (counts[t.parent_tenant_id] ?? 0) + 1
  }
  return counts
})

const filteredTenants = computed(() => {
  let out = tenants.value
  if (parentFilter.value) {
    if (parentFilter.value === '__root__') {
      // "(root-level only)" pseudo-option — tenants with no parent.
      out = out.filter(t => !t.parent_tenant_id)
    } else {
      out = out.filter(t => t.parent_tenant_id === parentFilter.value)
    }
  }
  if (search.value) {
    const q = search.value.toLowerCase()
    out = out.filter(t => t.tenant_id.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
  }
  return out
})
// Default sort: newest tenants first. created_at is an ISO-8601 string,
// which sorts lexicographically in chronological order, so 'desc' ==
// newest first. Click any header to switch to that column's natural order.
const { sortKey, sortDir, toggle, sorted: sortedTenants } = useSort(filteredTenants, 'created_at', 'desc')

// Parents available in the filter dropdown — union of tenants that have
// at least one child, so the filter doesn't list tenants with no kids
// (those would always produce an empty table).
const parentOptions = computed<Tenant[]>(() => {
  const withChildren = new Set(Object.keys(childCountMap.value))
  return tenants.value.filter(t => withChildren.has(t.tenant_id))
})

// ─── #4 bulk suspend / reactivate ─────────────────────────────────────
// Selected tenant_ids. Resets on filter/search changes so users don't
// accidentally bulk-act on rows they can't see. Held as a Set for O(1)
// toggle in the checkbox handler.
const selected = ref<Set<string>>(new Set())
// Clear selection when filters change so a hidden-by-filter row never
// gets unexpectedly bulk-acted on. Same reasoning as WebhooksView.
watch([search, parentFilter], () => { selected.value = new Set() })
function toggleSelect(id: string) {
  const next = new Set(selected.value)
  next.has(id) ? next.delete(id) : next.add(id)
  selected.value = next
}
function toggleSelectAll() {
  if (selectedVisibleAll.value) {
    selected.value = new Set()
  } else {
    selected.value = new Set(filteredTenants.value.map(t => t.tenant_id))
  }
}
const selectedVisibleAll = computed(() =>
  filteredTenants.value.length > 0 &&
  filteredTenants.value.every(t => selected.value.has(t.tenant_id)),
)
const selectedVisibleCount = computed(() =>
  filteredTenants.value.filter(t => selected.value.has(t.tenant_id)).length,
)

// Bulk action state machine. We sequence the per-tenant calls rather
// than parallelizing because (a) it's simpler to report progress and
// (b) a burst of admin writes could trip rate limits. Users can cancel
// between calls — progress resumes only on a fresh click.
const bulkAction = ref<'SUSPENDED' | 'ACTIVE' | null>(null)
const bulkProgress = ref({ done: 0, total: 0, failed: 0 })
const bulkRunning = ref(false)
const bulkCancelRequested = ref(false)

function openBulk(action: 'SUSPENDED' | 'ACTIVE') {
  bulkAction.value = action
}
async function executeBulk() {
  if (!bulkAction.value || bulkRunning.value) return
  const action = bulkAction.value
  // Filter the selection to only tenants whose current status would
  // actually change. Avoids noisy "already suspended" 409s from the
  // server and keeps the progress count honest.
  const targets = tenants.value.filter(t =>
    selected.value.has(t.tenant_id) &&
    t.status !== action &&
    // CLOSED is terminal — never reactivate or re-suspend.
    t.status !== 'CLOSED'
  )
  bulkProgress.value = { done: 0, total: targets.length, failed: 0 }
  bulkRunning.value = true
  bulkCancelRequested.value = false
  for (const t of targets) {
    if (bulkCancelRequested.value) break
    try {
      await updateTenantStatus(t.tenant_id, action)
    } catch (e) {
      bulkProgress.value.failed++
      // Don't toast per failure — one summary at the end is less noisy.
      console.warn(`bulk ${action} failed on ${t.tenant_id}:`, toMessage(e))
    }
    bulkProgress.value.done++
  }
  bulkRunning.value = false
  const summary = `${bulkProgress.value.done - bulkProgress.value.failed}/${bulkProgress.value.total} tenants ${action === 'SUSPENDED' ? 'suspended' : 'reactivated'}`
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
  if (bulkRunning.value) {
    bulkCancelRequested.value = true
  } else {
    bulkAction.value = null
  }
}

// ─── Create tenant (existing) ─────────────────────────────────────────
const showCreate = ref(false)
const createLoading = ref(false)
const createError = ref('')
const createForm = ref({ tenant_id: '', name: '', parent_tenant_id: '' })

function openCreate() {
  createForm.value = { tenant_id: '', name: '', parent_tenant_id: '' }
  createError.value = ''
  showCreate.value = true
}

async function submitCreate() {
  createError.value = ''
  if (!/^[a-z0-9-]+$/.test(createForm.value.tenant_id)) {
    createError.value = 'Tenant ID must contain only lowercase letters, numbers, and hyphens'
    return
  }
  createLoading.value = true
  try {
    const body: Record<string, unknown> = { tenant_id: createForm.value.tenant_id, name: createForm.value.name }
    if (createForm.value.parent_tenant_id) body.parent_tenant_id = createForm.value.parent_tenant_id
    await createTenant(body as any)
    showCreate.value = false
    toast.success(`Tenant '${createForm.value.name}' created`)
    router.push({ name: 'tenant-detail', params: { id: createForm.value.tenant_id } })
  } catch (e) { createError.value = toMessage(e) }
  finally { createLoading.value = false }
}

// ─── Single-row suspend / reactivate (retained) ──────────────────────
const pendingStatusAction = ref<{ tenantId: string; name: string; action: 'SUSPENDED' | 'ACTIVE' } | null>(null)

async function executeStatusAction() {
  if (!pendingStatusAction.value) return
  const { tenantId, action } = pendingStatusAction.value
  try {
    await updateTenantStatus(tenantId, action)
    toast.success(action === 'SUSPENDED' ? 'Tenant suspended' : 'Tenant reactivated')
    await refresh()
  } catch (e) {
    const msg = toMessage(e)
    error.value = msg
    toast.error(`${action === 'SUSPENDED' ? 'Suspend' : 'Reactivate'} failed: ${msg}`)
  }
  finally { pendingStatusAction.value = null }
}

const { refresh, isLoading, lastUpdated } = usePolling(async () => {
  try {
    const res = await listTenants()
    tenants.value = res.tenants
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
}, 60000)

function parentName(id: string | undefined): string {
  if (!id) return ''
  const p = tenants.value.find(t => t.tenant_id === id)
  return p?.name || id
}
</script>

<template>
  <div>
    <PageHeader title="Tenants" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh">
      <template #actions>
        <button v-if="canManage" @click="openCreate" class="text-xs bg-blue-600 text-white hover:bg-blue-700 rounded px-3 py-1.5 cursor-pointer transition-colors">Create Tenant</button>
      </template>
    </PageHeader>
    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg table-cell mb-4">{{ error }}</p>

    <!-- Search + parent filter -->
    <div class="mb-4 flex gap-3 flex-wrap items-center">
      <input v-model="search" placeholder="Search by ID or name..." class="border border-gray-300 rounded px-3 py-1.5 text-sm max-w-xs flex-1 min-w-[14rem]" />
      <select v-model="parentFilter" aria-label="Filter by parent tenant" class="form-select">
        <option value="">All tenants</option>
        <option value="__root__">(root-level only)</option>
        <option v-for="p in parentOptions" :key="p.tenant_id" :value="p.tenant_id">Children of: {{ p.name || p.tenant_id }}</option>
      </select>
    </div>

    <!-- Bulk action bar — appears only when rows are selected and the
         user has write capability. Shows a summary + action buttons +
         per-action confirmation dialog. -->
    <div v-if="canManage && selectedVisibleCount > 0" class="mb-3 bg-blue-50 border border-blue-200 rounded px-4 py-2 flex items-center gap-3 flex-wrap">
      <span class="text-sm text-blue-900">{{ selectedVisibleCount }} selected</span>
      <button @click="openBulk('SUSPENDED')" class="text-xs text-red-700 hover:text-red-900 border border-red-300 bg-white rounded px-2.5 py-1 cursor-pointer">Suspend selected</button>
      <button @click="openBulk('ACTIVE')" class="text-xs text-green-700 hover:text-green-900 border border-green-300 bg-white rounded px-2.5 py-1 cursor-pointer">Reactivate selected</button>
      <button @click="selected = new Set()" class="text-xs text-gray-600 dark:text-gray-500 hover:text-gray-700 ml-auto cursor-pointer">Clear</button>
    </div>

    <div class="card-table">
      <table class="w-full text-sm min-w-[640px]">
        <thead class="table-header">
          <tr>
            <th v-if="canManage" class="table-cell w-10">
              <input type="checkbox" :checked="selectedVisibleAll" @change="toggleSelectAll" aria-label="Select all visible tenants" />
            </th>
            <SortHeader label="Tenant ID" column="tenant_id" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Name" column="name" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <th class="table-cell text-left text-xs uppercase tracking-wider">Parent</th>
            <th class="table-cell text-left text-xs uppercase tracking-wider">Children</th>
            <SortHeader label="Status" column="status" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Created" column="created_at" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <th v-if="canManage" class="table-cell w-24"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="t in sortedTenants" :key="t.tenant_id" class="table-row-hover">
            <td v-if="canManage" class="table-cell">
              <input type="checkbox" :checked="selected.has(t.tenant_id)" @change="toggleSelect(t.tenant_id)" :aria-label="`Select ${t.name || t.tenant_id}`" />
            </td>
            <td class="table-cell">
              <router-link :to="{ name: 'tenant-detail', params: { id: t.tenant_id } }" class="text-blue-600 hover:underline font-mono text-xs">{{ t.tenant_id }}</router-link>
            </td>
            <td class="table-cell text-gray-700">{{ t.name }}</td>
            <td class="table-cell text-xs">
              <router-link v-if="t.parent_tenant_id" :to="{ name: 'tenant-detail', params: { id: t.parent_tenant_id } }" class="text-blue-600 hover:underline font-mono">
                {{ parentName(t.parent_tenant_id) }}
              </router-link>
              <span v-else class="text-gray-500" aria-hidden="true">—</span>
            </td>
            <td class="table-cell text-xs">
              <button
                v-if="childCountMap[t.tenant_id]"
                @click="parentFilter = t.tenant_id"
                class="text-blue-600 hover:underline cursor-pointer"
                :aria-label="`Filter list to ${childCountMap[t.tenant_id]} children of ${t.name}`"
              >{{ childCountMap[t.tenant_id] }} child{{ childCountMap[t.tenant_id] === 1 ? '' : 'ren' }}</button>
              <span v-else class="text-gray-500" aria-hidden="true">—</span>
            </td>
            <td class="table-cell"><StatusBadge :status="t.status" /></td>
            <td class="table-cell muted-sm">{{ formatDate(t.created_at) }}</td>
            <td v-if="canManage" class="table-cell">
              <button v-if="t.status === 'ACTIVE'" @click="pendingStatusAction = { tenantId: t.tenant_id, name: t.name, action: 'SUSPENDED' }" class="btn-row-danger">Suspend</button>
              <button v-if="t.status === 'SUSPENDED'" @click="pendingStatusAction = { tenantId: t.tenant_id, name: t.name, action: 'ACTIVE' }" class="btn-row-success">Reactivate</button>
            </td>
          </tr>
          <tr v-if="filteredTenants.length === 0">
            <td :colspan="canManage ? 8 : 6"><EmptyState :message="search || parentFilter ? 'No tenants match your filters' : 'No tenants found'" :hint="search || parentFilter ? undefined : 'Tenants will appear here once created'" /></td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Single-row confirm (retained) -->
    <ConfirmAction
      v-if="pendingStatusAction"
      :title="pendingStatusAction.action === 'SUSPENDED' ? 'Suspend this tenant?' : 'Reactivate this tenant?'"
      :message="pendingStatusAction.action === 'SUSPENDED'
        ? `Suspending '${pendingStatusAction.name}' will block all API access for this tenant and its keys.`
        : `Reactivating '${pendingStatusAction.name}' will restore API access.`"
      :confirm-label="pendingStatusAction.action === 'SUSPENDED' ? 'Suspend' : 'Reactivate'"
      :danger="pendingStatusAction.action === 'SUSPENDED'"
      @confirm="executeStatusAction"
      @cancel="pendingStatusAction = null"
    />

    <!-- Bulk confirm. During execution shows a live progress message in
         the error slot (not literally an error — reusing the visible
         text region under the title). On cancel mid-run, stops after
         the current request completes. -->
    <ConfirmAction
      v-if="bulkAction"
      :title="bulkAction === 'SUSPENDED'
        ? `Suspend ${bulkRunning ? bulkProgress.total : selectedVisibleCount} tenants?`
        : `Reactivate ${bulkRunning ? bulkProgress.total : selectedVisibleCount} tenants?`"
      :message="bulkRunning
        ? `Working… ${bulkProgress.done}/${bulkProgress.total} processed${bulkProgress.failed ? ` (${bulkProgress.failed} failed)` : ''}.`
        : bulkAction === 'SUSPENDED'
          ? `This will block API access for each selected tenant and all their keys. Tenants already SUSPENDED or CLOSED will be skipped.`
          : `This will restore API access for each selected tenant. Tenants already ACTIVE or CLOSED will be skipped.`"
      :confirm-label="bulkRunning ? 'Working…' : bulkAction === 'SUSPENDED' ? 'Suspend all' : 'Reactivate all'"
      :danger="bulkAction === 'SUSPENDED'"
      :loading="bulkRunning"
      @confirm="executeBulk"
      @cancel="cancelBulk"
    />

    <FormDialog v-if="showCreate" title="Create Tenant" submit-label="Create Tenant" :loading="createLoading" :error="createError" @submit="submitCreate" @cancel="showCreate = false">
      <div>
        <label for="ct-id" class="form-label">Tenant ID</label>
        <input id="ct-id" v-model="createForm.tenant_id" required pattern="^[a-z0-9-]+$" minlength="3" maxlength="64" class="form-input-mono" placeholder="acme-corp" />
        <p class="muted-sm mt-0.5">Lowercase letters, numbers, and hyphens only</p>
      </div>
      <div>
        <label for="ct-name" class="form-label">Display Name</label>
        <input id="ct-name" v-model="createForm.name" required maxlength="256" class="form-input" placeholder="Acme Corporation" />
      </div>
      <div>
        <label for="ct-parent" class="form-label">Parent Tenant (optional)</label>
        <select id="ct-parent" v-model="createForm.parent_tenant_id" class="form-select w-full">
          <option value="">None</option>
          <option v-for="t in tenants" :key="t.tenant_id" :value="t.tenant_id">{{ t.name || t.tenant_id }}</option>
        </select>
      </div>
    </FormDialog>
  </div>
</template>

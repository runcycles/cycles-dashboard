<script setup lang="ts">
/**
 * Reservations admin view. Surfaces the runtime-plane dual-auth
 * endpoints added in cycles-protocol revision 2026-04-13 and cycles-server
 * v0.1.25.8. Primary ops use case: find a hung reservation (ACTIVE past
 * its grace window) and force-release it so the held budget capacity
 * returns to the tenant.
 *
 * Scoping: list requires a tenant filter per spec (admin has no
 * effective tenant). No "show reservations across all tenants" view —
 * cross-tenant scans are expensive and the ops use case is always
 * anchored on a known tenant (they got paged because tenant X's
 * reservation is stuck).
 */
import { ref, computed, watch } from 'vue'
import { usePolling } from '../composables/usePolling'
import { useSort } from '../composables/useSort'
import { listReservations, releaseReservation, listTenants } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { ReservationSummary, Tenant } from '../types'
import { RESERVATION_STATUSES } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import FormDialog from '../components/FormDialog.vue'
import { formatDateTime, formatRelative } from '../utils/format'
import { useToast } from '../composables/useToast'
import { toMessage } from '../utils/errors'

const toast = useToast()
const auth = useAuthStore()
// No `manage_reservations` capability flag in the current introspect
// response — default to allow. Older admin servers surface 401/403 at
// call time if the key lacks access; that path is already handled by
// the ApiError flow.
const canManage = computed(() =>
  (auth.capabilities as { manage_reservations?: boolean } | undefined)?.manage_reservations !== false,
)

// Scoping. Server rejects listReservations under admin auth without
// a tenant; we mirror that at the form level so the user can't submit
// an empty filter. Default the first tenant in the list once tenants
// are loaded so the view has something to show without manual picking.
const tenants = ref<Tenant[]>([])
const tenantFilter = ref('')
const statusFilter = ref<string>('ACTIVE') // operationally-interesting default
const reservations = ref<ReservationSummary[]>([])
const error = ref('')
const loadingList = ref(false)

// Sort local, not server — the runtime spec doesn't guarantee
// stable ordering of returned reservations, and ops typically want
// to sort by age (created_at asc) to find the oldest-stuck one first.
const { sortKey, sortDir, toggle, sorted: sortedReservations } = useSort(
  reservations,
  'created_at_ms',
  'asc',
)

async function loadTenants() {
  try {
    const res = await listTenants()
    tenants.value = res.tenants
    // Default the tenant filter to the first tenant so the view has
    // something to show on first render. The user can switch or clear.
    if (!tenantFilter.value && tenants.value.length > 0) {
      tenantFilter.value = tenants.value[0].tenant_id
    }
  } catch (e) { error.value = toMessage(e) }
}

async function loadReservations() {
  if (!tenantFilter.value) {
    reservations.value = []
    return
  }
  loadingList.value = true
  try {
    const params: { status?: string; limit?: number } = { limit: 100 }
    if (statusFilter.value) params.status = statusFilter.value
    const res = await listReservations(tenantFilter.value, params)
    reservations.value = res.reservations
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
  finally { loadingList.value = false }
}

// Re-query on filter change. Polling keeps the list fresh on a 30s
// cadence — reservations turn over quickly and a stale list is actively
// misleading (an operator could "force-release" one that already
// expired).
watch([tenantFilter, statusFilter], () => { loadReservations() })

const { refresh, isLoading, lastUpdated } = usePolling(async () => {
  try {
    if (tenants.value.length === 0) await loadTenants()
    await loadReservations()
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
}, 30_000)

// ─── Force-release flow ─────────────────────────────────────────────
// Mirrors the budget-freeze confirm pattern: dialog shows scope +
// reserved amount + reason field. Spec SHOULD-guidance: users
// populate `reason` with a structured tag for grep-ability in the
// audit log. Pre-fill the tag so the common case is one click.
const pendingRelease = ref<ReservationSummary | null>(null)
const releaseReason = ref('')
const releaseLoading = ref(false)
const releaseError = ref('')

function openRelease(r: ReservationSummary) {
  pendingRelease.value = r
  releaseReason.value = '[INCIDENT_FORCE_RELEASE] '
  releaseError.value = ''
}

async function submitRelease() {
  if (!pendingRelease.value || releaseLoading.value) return
  releaseError.value = ''
  releaseLoading.value = true
  // Idempotency key is required on every release even admin-driven;
  // server returns the same response on replay with the same key.
  // We use a throwaway UUID per click — no retry coalescing needed
  // because the dialog disables the button during in-flight.
  const idempotencyKey = crypto.randomUUID()
  try {
    await releaseReservation(
      pendingRelease.value.reservation_id,
      idempotencyKey,
      releaseReason.value.trim() || undefined,
    )
    toast.success(`Reservation ${pendingRelease.value.reservation_id} released`)
    pendingRelease.value = null
    await loadReservations()
  } catch (e) {
    releaseError.value = toMessage(e)
  } finally {
    releaseLoading.value = false
  }
}

function ageLabel(r: ReservationSummary): string {
  // Created-at as a relative string so ops can spot "stuck for 3h"
  // faster than parsing an absolute timestamp.
  return formatRelative(new Date(r.created_at_ms).toISOString())
}

function isExpired(r: ReservationSummary): boolean {
  return r.expires_at_ms <= Date.now()
}
</script>

<template>
  <div>
    <PageHeader
      title="Reservations"
      subtitle="Force-release hung reservations during incident response"
      :loading="isLoading"
      :last-updated="lastUpdated"
      @refresh="refresh"
    />
    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">{{ error }}</p>

    <!-- Filters. Tenant is required; the server rejects admin list
         without it, so we enforce client-side too. Status defaults to
         ACTIVE because that's the operationally-interesting set. -->
    <div class="mb-4 flex gap-3 flex-wrap items-end">
      <div>
        <label for="res-tenant" class="block text-xs text-gray-500 mb-1">Tenant *</label>
        <select id="res-tenant" v-model="tenantFilter" class="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white">
          <option value="" disabled>— pick a tenant —</option>
          <option v-for="t in tenants" :key="t.tenant_id" :value="t.tenant_id">{{ t.name || t.tenant_id }}</option>
        </select>
      </div>
      <div>
        <label for="res-status" class="block text-xs text-gray-500 mb-1">Status</label>
        <select id="res-status" v-model="statusFilter" class="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white">
          <option value="">All</option>
          <option v-for="s in RESERVATION_STATUSES" :key="s" :value="s">{{ s }}</option>
        </select>
      </div>
      <p class="text-xs text-gray-400 flex-1 min-w-[16rem]">
        Reservations past their grace window but still ACTIVE are the "hung" ones —
        sort by Created (asc, default) to find the oldest first.
      </p>
    </div>

    <div class="bg-white rounded-lg shadow overflow-hidden overflow-x-auto">
      <table class="w-full text-sm min-w-[720px]">
        <thead class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
          <tr>
            <SortHeader label="Reservation ID" column="reservation_id" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <th class="px-4 py-3 text-left">Scope</th>
            <SortHeader label="Status" column="status" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Reserved" column="reserved" :active-column="sortKey" :direction="sortDir" @sort="toggle" align="right" />
            <SortHeader label="Created" column="created_at_ms" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <th class="px-4 py-3 text-left">Expires</th>
            <th v-if="canManage" class="px-4 py-3 w-24"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="r in sortedReservations" :key="r.reservation_id" class="hover:bg-gray-50 transition-colors">
            <td class="px-4 py-3 font-mono text-xs break-all">{{ r.reservation_id }}</td>
            <td class="px-4 py-3 font-mono text-xs text-gray-600 break-all">{{ r.scope_path }}</td>
            <td class="px-4 py-3"><StatusBadge :status="r.status" /></td>
            <td class="px-4 py-3 text-right tabular-nums">
              {{ r.reserved.amount.toLocaleString() }}
              <span class="text-xs text-gray-400">{{ r.reserved.unit }}</span>
            </td>
            <td class="px-4 py-3 text-gray-500 text-xs" :title="formatDateTime(new Date(r.created_at_ms).toISOString())">
              {{ ageLabel(r) }}
            </td>
            <td class="px-4 py-3 text-xs" :class="isExpired(r) && r.status === 'ACTIVE' ? 'text-red-600 font-medium' : 'text-gray-500'">
              <!-- Overdue indicator: ACTIVE + past expiry is the
                   definitional "hung" state. Tooltip shows the exact
                   expiry time for drill-down. -->
              {{ formatRelative(new Date(r.expires_at_ms).toISOString()) }}
              <span v-if="isExpired(r) && r.status === 'ACTIVE'" class="ml-1" title="Past expiry — this reservation is overdue for cleanup">⚠</span>
            </td>
            <td v-if="canManage" class="px-4 py-3">
              <!-- Only ACTIVE reservations can be released. COMMITTED /
                   RELEASED / EXPIRED are terminal states — no release
                   action makes sense. -->
              <button
                v-if="r.status === 'ACTIVE'"
                @click="openRelease(r)"
                class="text-xs text-red-600 hover:text-red-800 cursor-pointer hover:underline"
              >Force release</button>
            </td>
          </tr>
          <tr v-if="reservations.length === 0 && !loadingList">
            <td :colspan="canManage ? 7 : 6">
              <EmptyState
                :message="tenantFilter
                  ? (statusFilter ? `No ${statusFilter} reservations for this tenant` : 'No reservations for this tenant')
                  : 'Pick a tenant to list reservations'"
                :hint="tenantFilter ? undefined : 'Reservations are listed per-tenant — the runtime spec requires scoping.'"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Force-release form. FormDialog (not ConfirmAction) because we
         need a user-editable reason input. Spec SHOULD-guidance:
         callers populate `reason` with a structured prefix for
         grep-ability in the audit log — pre-filled so the common
         case is one click. -->
    <FormDialog
      v-if="pendingRelease"
      title="Force release this reservation?"
      submit-label="Force release"
      :loading="releaseLoading"
      :error="releaseError"
      @submit="submitRelease"
      @cancel="pendingRelease = null"
    >
      <p class="text-sm text-gray-600">
        Releases <strong class="font-semibold">{{ pendingRelease.reserved.amount.toLocaleString() }} {{ pendingRelease.reserved.unit }}</strong>
        back to the tenant's budget. Scope
        <code class="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded">{{ pendingRelease.scope_path }}</code>
        will be available for new reservations immediately.
      </p>
      <p class="text-xs text-gray-500">
        Audit log records <code class="font-mono">actor_type=admin_on_behalf_of</code> so this action is traceable
        via the Audit tab.
      </p>
      <div>
        <label for="release-reason" class="block text-xs text-gray-500 mb-1">Reason (for audit log)</label>
        <input
          id="release-reason"
          v-model="releaseReason"
          maxlength="256"
          class="border border-gray-300 rounded px-2 py-1 text-sm w-full"
          placeholder="[INCIDENT_FORCE_RELEASE] hung after redis restart"
        />
        <p class="text-xs text-gray-400 mt-0.5">
          Stored on the audit-log entry. Structured prefix like
          <code class="font-mono">[INCIDENT_FORCE_RELEASE]</code> makes later grep easier.
        </p>
      </div>
    </FormDialog>
  </div>
</template>

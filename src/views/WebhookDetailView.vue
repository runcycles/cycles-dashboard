<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useRoute, useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { getWebhook, listDeliveries, updateWebhook, deleteWebhook, testWebhook, replayWebhookEvents, rotateWebhookSecret } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { WebhookSubscription, WebhookDelivery, WebhookTestResponse } from '../types'
import { EVENT_TYPES } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import TenantLink from '../components/TenantLink.vue'
import EmptyState from '../components/EmptyState.vue'
import ConfirmAction from '../components/ConfirmAction.vue'
import FormDialog from '../components/FormDialog.vue'
import SecretReveal from '../components/SecretReveal.vue'
import { useToast } from '../composables/useToast'
import { toMessage } from '../utils/errors'

const toast = useToast()
import { formatDateTime } from '../utils/format'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const id = route.params.id as string
const canManage = computed(() => auth.capabilities?.manage_webhooks !== false)

const webhook = ref<WebhookSubscription | null>(null)
const deliveries = ref<WebhookDelivery[]>([])
const error = ref('')
const pendingAction = ref<'ACTIVE' | 'PAUSED' | 'reset' | null>(null)

// Delivery-history pagination + filter (scale hardening). A busy
// webhook can have thousands of delivery records; pre-fix the view
// fetched them all and rendered each as a real DOM row. Now:
//   - cursor pagination via Load more (append)
//   - status filter (DELIVERED / FAILED / PENDING)
//   - virtualized rows so DOM stays bounded
// Polling still refreshes page 1 every 30s — operators who Load-
// more'd will see the tail reset, same trade-off documented on
// the other list views (ReservationsView / TenantsView).
const deliveriesHasMore = ref(false)
const deliveriesNextCursor = ref('')
const deliveriesLoadingMore = ref(false)
const deliveryStatusFilter = ref('')
const filteredDeliveries = computed(() =>
  deliveryStatusFilter.value
    ? deliveries.value.filter(d => d.status === deliveryStatusFilter.value)
    : deliveries.value,
)

async function executeAction() {
  if (!pendingAction.value) return
  try {
    if (pendingAction.value === 'reset') {
      // Re-enabling resets consecutive_failures per spec
      await updateWebhook(id, { status: 'ACTIVE' })
    } else {
      await updateWebhook(id, { status: pendingAction.value })
    }
    webhook.value = await getWebhook(id)
    const label = pendingAction.value === 'reset' ? 'Webhook re-enabled' : pendingAction.value === 'PAUSED' ? 'Webhook paused' : 'Webhook enabled'
    toast.success(label)
  } catch (e) {
    const msg = toMessage(e)
    error.value = msg
    toast.error(`Status change failed: ${msg}`)
  }
  finally { pendingAction.value = null }
}

// Delete webhook. Same close-on-success / stay-open-on-error / loading-
// spinner pattern as Rotate Secret. Without the loading state the user
// could cancel mid-DELETE (the network call still completes) or click
// the destructive button repeatedly while the first request is pending.
const pendingDelete = ref(false)
const deleteLoading = ref(false)
const deleteError = ref('')

function openDelete() {
  deleteError.value = ''
  pendingDelete.value = true
}

async function executeDelete() {
  if (deleteLoading.value) return // double-click guard
  deleteError.value = ''
  deleteLoading.value = true
  try {
    await deleteWebhook(id)
    pendingDelete.value = false
    toast.success('Webhook deleted')
    router.push('/webhooks')
  } catch (e) {
    const msg = toMessage(e)
    deleteError.value = msg
    toast.error(`Delete failed: ${msg}`)
  } finally {
    deleteLoading.value = false
  }
}

// Rotate signing secret. Keep the confirm dialog mounted (with a loading
// spinner) until the request settles. Previously we closed the dialog
// before awaiting the PATCH — on a 403 the user saw nothing happen, then
// a toast appeared seconds later with no UI context tying it to the
// click. The dialog now closes only on success; on error it stays open
// with an inline error so the user can read it next to the action they
// confirmed, and retry or cancel.
const pendingRotate = ref(false)
const rotateLoading = ref(false)
const rotateError = ref('')
const rotatedSecret = ref<string | null>(null)

function openRotate() {
  rotateError.value = ''
  pendingRotate.value = true
}

async function executeRotate() {
  if (rotateLoading.value) return // double-click guard
  rotateError.value = ''
  rotateLoading.value = true
  try {
    const { signing_secret, subscription } = await rotateWebhookSecret(id)
    // The secret is always returned by the client wrapper (generated
    // locally before PATCH). Display it once — the server will not echo
    // it back on subsequent reads.
    rotatedSecret.value = signing_secret
    webhook.value = subscription
    pendingRotate.value = false
    toast.success('Signing secret rotated — copy it now, it will not be shown again')
  } catch (e) {
    const msg = toMessage(e)
    rotateError.value = msg
    toast.error(`Rotate secret failed: ${msg}`)
  } finally {
    rotateLoading.value = false
  }
}

// Edit webhook
const showEdit = ref(false)
const editLoading = ref(false)
const editError = ref('')
const editForm = ref({ name: '', url: '', event_types: [] as string[], scope_filter: '', disable_after_failures: '' })

function openEdit() {
  if (!webhook.value) return
  editForm.value = {
    name: webhook.value.name || '',
    url: webhook.value.url,
    event_types: [...(webhook.value.event_types || [])],
    scope_filter: webhook.value.scope_filter || '',
    disable_after_failures: String(webhook.value.disable_after_failures ?? '10'),
  }
  editError.value = ''
  showEdit.value = true
}

async function submitEdit() {
  editError.value = ''
  if (!editForm.value.event_types.length) { editError.value = 'Select at least one event type'; return }
  editLoading.value = true
  try {
    const body: Record<string, unknown> = {
      url: editForm.value.url,
      event_types: editForm.value.event_types,
    }
    if (editForm.value.name) body.name = editForm.value.name
    if (editForm.value.scope_filter) body.scope_filter = editForm.value.scope_filter
    if (editForm.value.disable_after_failures) body.disable_after_failures = Number(editForm.value.disable_after_failures)
    await updateWebhook(id, body)
    toast.success('Webhook updated')
    webhook.value = await getWebhook(id)
    showEdit.value = false
  } catch (e) { editError.value = toMessage(e) }
  finally { editLoading.value = false }
}

// Test webhook
const testResult = ref<WebhookTestResponse | null>(null)
const testLoading = ref(false)
async function runTest() {
  testLoading.value = true
  testResult.value = null
  try {
    testResult.value = await testWebhook(id)
  } catch (e) {
    const msg = toMessage(e)
    error.value = msg
    toast.error(`Test failed: ${msg}`)
  }
  finally { testLoading.value = false }
}

// Replay events
const showReplay = ref(false)
const replayLoading = ref(false)
const replayError = ref('')
const replayForm = ref({ from: '', to: '', max_events: '100' })
const replayResult = ref<string | null>(null)

async function submitReplay() {
  replayError.value = ''
  // Client-side range sanity check. Server will also reject, but a
  // pre-flight avoids a wasted round-trip and surfaces the problem
  // next to the offending inputs.
  if (replayForm.value.from && replayForm.value.to) {
    const fromMs = new Date(replayForm.value.from).getTime()
    const toMs = new Date(replayForm.value.to).getTime()
    if (!isNaN(fromMs) && !isNaN(toMs) && fromMs > toMs) {
      replayError.value = '"From" must be before "To"'
      return
    }
  }
  replayLoading.value = true
  try {
    const body: Record<string, unknown> = {}
    if (replayForm.value.from) body.from = new Date(replayForm.value.from).toISOString()
    if (replayForm.value.to) body.to = new Date(replayForm.value.to).toISOString()
    if (replayForm.value.max_events) body.max_events = Number(replayForm.value.max_events)
    const res = await replayWebhookEvents(id, body as any)
    // Leave banner visible until the user dismisses it — previous 5s
    // auto-clear was easy to miss when scrolled into deliveries list.
    replayResult.value = `${res.events_queued} events queued for replay`
    showReplay.value = false
  } catch (e) { replayError.value = toMessage(e) }
  finally { replayLoading.value = false }
}

function buildDeliveryParams(): Record<string, string> {
  const p: Record<string, string> = {}
  if (deliveryStatusFilter.value) p.status = deliveryStatusFilter.value
  return p
}

const { refresh, isLoading, lastUpdated } = usePolling(async () => {
  try {
    webhook.value = await getWebhook(id)
    const res = await listDeliveries(id, buildDeliveryParams())
    deliveries.value = res.deliveries
    deliveriesHasMore.value = !!res.has_more
    deliveriesNextCursor.value = res.next_cursor ?? ''
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
}, 30000)

async function loadMoreDeliveries() {
  if (!deliveriesNextCursor.value || deliveriesLoadingMore.value) return
  deliveriesLoadingMore.value = true
  try {
    const params = { ...buildDeliveryParams(), cursor: deliveriesNextCursor.value }
    const res = await listDeliveries(id, params)
    deliveries.value = [...deliveries.value, ...res.deliveries]
    deliveriesHasMore.value = !!res.has_more
    deliveriesNextCursor.value = res.next_cursor ?? ''
  } catch (e) { error.value = toMessage(e) }
  finally { deliveriesLoadingMore.value = false }
}

// V1 virtualization on the delivery list. Simple fixed-height rows —
// no expandable details so the pattern from ReservationsView applies
// directly. 48px per row accommodates StatusBadge + mono event_id at
// text-sm.
const deliveryScrollEl = ref<HTMLElement | null>(null)
const DELIVERY_ROW_HEIGHT = 48
const deliveryVirt = useVirtualizer(computed(() => ({
  count: filteredDeliveries.value.length,
  getScrollElement: () => deliveryScrollEl.value,
  estimateSize: () => DELIVERY_ROW_HEIGHT,
  overscan: 8,
  getItemKey: (i: number) => filteredDeliveries.value[i]?.delivery_id ?? i,
})))
const deliveryVirtualRows = computed(() => deliveryVirt.value.getVirtualItems())
const deliveryTotalHeight = computed(() => deliveryVirt.value.getTotalSize())
const deliveryGridTemplate = '120px 100px 100px minmax(220px,1fr) 160px'

// Status filter refetches page 1 so the filter is server-enforced
// (not just client-side filtering of already-loaded data — that
// would let the filter miss matches from un-loaded pages). A select
// change is instant-apply; no debounce needed.
watch(deliveryStatusFilter, () => { refresh() })
</script>

<template>
  <div>
    <PageHeader title="Webhook Detail" :subtitle="webhook?.name || webhook?.subscription_id" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh">
      <template #back>
        <button @click="router.push('/webhooks')" aria-label="Back to webhooks" class="muted hover:text-gray-700 cursor-pointer">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
        </button>
      </template>
    </PageHeader>
    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg table-cell mb-4">{{ error }}</p>
    <template v-if="webhook">
      <div class="bg-white rounded-lg shadow p-6 mb-4">
        <div class="flex items-center gap-3 mb-4 flex-wrap">
          <h2 class="text-lg font-medium text-gray-900">{{ webhook.name || webhook.subscription_id }}</h2>
          <StatusBadge :status="webhook.status" />
          <span v-if="(webhook.consecutive_failures ?? 0) > 0" class="bg-red-100 text-red-700 px-2 py-0.5 rounded text-xs font-medium">{{ webhook.consecutive_failures }} failures</span>
          <span class="flex-1" />
          <div v-if="canManage" class="flex gap-2 flex-wrap">
            <button @click="openEdit"class="btn-pill-secondary">Edit</button>
            <button @click="runTest" :disabled="testLoading" class="btn-pill-secondary disabled:opacity-50">{{ testLoading ? 'Testing...' : 'Send Test' }}</button>
            <button @click="openRotate" class="btn-pill-secondary">Rotate Secret</button>
            <button @click="showReplay = true" class="btn-pill-secondary">Replay</button>
            <button v-if="(webhook.consecutive_failures ?? 0) > 0 && webhook.status !== 'ACTIVE'" @click="pendingAction = 'reset'" class="btn-pill-primary">Reset &amp; Re-enable</button>
            <button v-if="webhook.status === 'ACTIVE'" @click="pendingAction = 'PAUSED'" class="btn-pill-danger">Pause</button>
            <button v-if="webhook.status === 'DISABLED' || webhook.status === 'PAUSED'" @click="pendingAction = 'ACTIVE'" class="btn-pill-success">Enable</button>
            <button @click="openDelete" class="btn-pill-danger">Delete</button>
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <div class="info-panel"><span class="form-label">URL</span><span class="font-mono text-xs break-all">{{ webhook.url }}</span></div>
          <div class="info-panel"><span class="form-label">Tenant</span><TenantLink :tenant-id="webhook.tenant_id" /></div>
          <div class="info-panel"><span class="form-label">Subscribed Event Types</span><div class="flex flex-wrap gap-1 mt-1"><span v-for="et in (webhook.event_types || [])" :key="et" class="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-xs font-mono">{{ et }}</span><span v-if="!webhook.event_types?.length" class="muted-sm">all events</span></div></div>
          <div v-if="webhook.scope_filter" class="info-panel"><span class="form-label">Scope Filter</span><span class="font-mono text-xs">{{ webhook.scope_filter }}</span></div>
          <div v-if="webhook.last_success_at" class="info-panel"><span class="form-label">Last Success</span>{{ formatDateTime(webhook.last_success_at) }}</div>
          <div v-if="webhook.last_failure_at" class="info-panel"><span class="form-label">Last Failure</span>{{ formatDateTime(webhook.last_failure_at) }}</div>
          <!-- v0.1.25.21 (#10): expose disable_after_failures so ops can
               see the auto-disable threshold at a glance without
               opening the edit form. Color the consecutive_failures
               cell red as it approaches the threshold so a "trending
               toward auto-disable" subscription is visually obvious. -->
          <div class="info-panel">
            <span class="form-label">Failure threshold</span>
            <span class="tabular-nums">
              <!-- Danger zone = within 2 of the auto-disable threshold,
                   floored at 1 so a low threshold (e.g. 1 or 2) doesn't
                   make 0 failures show as red (false alarm on a
                   perfectly healthy webhook). -->
              <span :class="(webhook.consecutive_failures ?? 0) >= Math.max((webhook.disable_after_failures ?? 10) - 2, 1) ? 'text-red-600 font-medium' : 'text-gray-700'">{{ webhook.consecutive_failures ?? 0 }}</span>
              <span class="muted"> / {{ webhook.disable_after_failures ?? 10 }} consecutive</span>
            </span>
            <p class="muted-sm mt-0.5">Server auto-disables the subscription when threshold is reached.</p>
          </div>
        </div>
      </div>

      <!-- Test result -->
      <div v-if="testResult" class="mb-4 table-cell rounded-lg text-sm" :class="testResult.success ? 'bg-green-50 border border-green-200 text-green-700' : 'bg-red-50 border border-red-200 text-red-700'">
        <div class="flex items-center gap-2">
          <span class="font-medium">{{ testResult.success ? 'Test passed' : 'Test failed' }}</span>
          <span v-if="testResult.response_status" class="font-mono">HTTP {{ testResult.response_status }}</span>
          <span v-if="testResult.response_time_ms" class="text-xs opacity-75">({{ testResult.response_time_ms }}ms)</span>
        </div>
        <p v-if="testResult.error_message" class="mt-1">
          {{ testResult.error_message }}
          <span v-if="testResult.error_message.includes('Delivery failed') && !testResult.response_status" class="block mt-1 text-xs opacity-75">
            The server could not reach the webhook URL. Common causes: the endpoint is not running, the URL is incorrect, DNS cannot resolve the hostname, or the server cannot access the network.
          </span>
        </p>
        <p v-if="!testResult.success && !testResult.error_message" class="mt-1 text-xs">The endpoint did not return a 2xx status. Verify the URL is correct and the service is running.</p>
        <details v-if="testResult.event_id" class="mt-1 text-xs opacity-75">
          <summary class="cursor-pointer hover:opacity-100">Details</summary>
          <span class="font-mono">Event ID: {{ testResult.event_id }}</span>
        </details>
      </div>

      <!-- Replay result -->
      <div v-if="replayResult" class="mb-4 table-cell rounded-lg text-sm bg-blue-50 border border-blue-200 text-blue-700 flex items-start justify-between gap-3" role="status">
        <span>{{ replayResult }}</span>
        <button type="button" @click="replayResult = null" aria-label="Dismiss replay notification" class="text-blue-500 hover:text-blue-800 cursor-pointer shrink-0">✕</button>
      </div>

      <!-- V1 virtualized delivery history. Same pattern as the
           top-level list views. Status filter applied server-side
           so pagination stays consistent; Load-more appends. -->
      <div class="bg-white rounded-lg shadow overflow-hidden text-sm" role="table" :aria-rowcount="filteredDeliveries.length + 1" :aria-colcount="5">
        <div class="table-cell border-b border-gray-100 flex justify-between items-center gap-3 flex-wrap">
          <h3 class="text-sm font-medium text-gray-700">Delivery History</h3>
          <div class="flex items-center gap-3 ml-auto">
            <span class="muted-sm tabular-nums">
              {{ filteredDeliveries.length.toLocaleString() }} loaded
              <span v-if="deliveriesHasMore" class="text-amber-600 ml-1">(more available)</span>
            </span>
            <select v-model="deliveryStatusFilter" aria-label="Filter deliveries by status" class="form-select">
              <option value="">All statuses</option>
              <option>PENDING</option>
              <option>DELIVERED</option>
              <option>FAILED</option>
              <option>RETRYING</option>
            </select>
          </div>
        </div>

        <div role="rowgroup" class="table-header border-b border-gray-200 sticky top-0 z-10">
          <div role="row" class="grid text-xs font-bold uppercase tracking-wider" :style="{ gridTemplateColumns: deliveryGridTemplate }">
            <div role="columnheader" class="table-cell text-left">Status</div>
            <div role="columnheader" class="table-cell text-left">HTTP Code</div>
            <div role="columnheader" class="table-cell text-right">Attempts</div>
            <div role="columnheader" class="table-cell text-left">Event ID</div>
            <div role="columnheader" class="table-cell text-left">Time</div>
          </div>
        </div>

        <div
          v-if="filteredDeliveries.length > 0"
          ref="deliveryScrollEl"
          role="rowgroup"
          class="overflow-y-auto"
          style="max-height: calc(100vh - 520px); min-height: 200px;"
        >
          <div role="presentation" :style="{ height: deliveryTotalHeight + 'px', position: 'relative' }">
            <div
              v-for="v in deliveryVirtualRows"
              :key="filteredDeliveries[v.index].delivery_id"
              role="row"
              :aria-rowindex="v.index + 2"
              class="grid table-row-hover border-b border-gray-100 absolute left-0 right-0 items-center"
              :style="{ gridTemplateColumns: deliveryGridTemplate, transform: `translateY(${v.start}px)`, height: DELIVERY_ROW_HEIGHT + 'px' }"
            >
              <div role="cell" class="table-cell"><StatusBadge :status="filteredDeliveries[v.index].status" /></div>
              <div role="cell" class="table-cell font-mono text-xs" :class="filteredDeliveries[v.index].http_status && filteredDeliveries[v.index].http_status! >= 400 ? 'text-red-600' : 'muted'">{{ filteredDeliveries[v.index].http_status || '-' }}</div>
              <div role="cell" class="table-cell text-right muted tabular-nums">{{ filteredDeliveries[v.index].attempts }}</div>
              <div role="cell" class="table-cell font-mono muted-sm truncate" :title="filteredDeliveries[v.index].event_id">{{ filteredDeliveries[v.index].event_id }}</div>
              <div role="cell" class="table-cell muted-sm">{{ filteredDeliveries[v.index].attempted_at ? formatDateTime(filteredDeliveries[v.index].attempted_at!) : filteredDeliveries[v.index].created_at ? formatDateTime(filteredDeliveries[v.index].created_at!) : '-' }}</div>
            </div>
          </div>
        </div>

        <div v-else>
          <EmptyState
            item-noun="delivery"
            :has-active-filter="!!deliveryStatusFilter"
            :hint="deliveryStatusFilter ? undefined : 'Deliveries will appear here once events are dispatched.'"
          />
        </div>
      </div>

      <div v-if="deliveriesHasMore || deliveriesLoadingMore" class="mt-3 flex justify-end">
        <button @click="loadMoreDeliveries" :disabled="deliveriesLoadingMore" class="text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50 cursor-pointer">
          {{ deliveriesLoadingMore ? 'Loading…' : 'Load more deliveries' }}
        </button>
      </div>
    </template>

    <ConfirmAction
      v-if="pendingAction === 'PAUSED'"
      title="Pause this webhook?"
      :message="`Pausing will stop all event deliveries to '${webhook?.url}'. Events that occur while paused are not queued and will be silently dropped.`"
      confirm-label="Pause Webhook"
      :danger="true"
      @confirm="executeAction"
      @cancel="pendingAction = null"
    />

    <ConfirmAction
      v-if="pendingAction === 'ACTIVE'"
      title="Enable this webhook?"
      :message="`Re-enabling will resume event deliveries to '${webhook?.url}'. Events that occurred while paused/disabled are not retroactively delivered.`"
      confirm-label="Enable Webhook"
      @confirm="executeAction"
      @cancel="pendingAction = null"
    />

    <ConfirmAction
      v-if="pendingAction === 'reset'"
      title="Reset and re-enable?"
      :message="`This will re-enable the webhook and reset the consecutive failure count to 0 for '${webhook?.url}'. Delivery attempts will resume immediately.`"
      confirm-label="Reset &amp; Re-enable"
      @confirm="executeAction"
      @cancel="pendingAction = null"
    />

    <ConfirmAction
      v-if="pendingDelete"
      title="Delete this webhook?"
      :message="`Permanently delete webhook '${webhook?.name || webhook?.url}'. Pending deliveries will be cancelled. This cannot be undone.`"
      confirm-label="Delete Webhook"
      :danger="true"
      :loading="deleteLoading"
      :error="deleteError"
      @confirm="executeDelete"
      @cancel="pendingDelete = false"
    />

    <FormDialog v-if="showReplay" title="Replay Events" submit-label="Start Replay" :loading="replayLoading" :error="replayError" @submit="submitReplay" @cancel="showReplay = false">
      <p class="muted-sm">Re-delivers historical events to this webhook. May cause duplicate deliveries.</p>
      <div>
        <label for="rp-from" class="form-label">From</label>
        <input id="rp-from" v-model="replayForm.from" type="datetime-local" class="form-input" />
      </div>
      <div>
        <label for="rp-to" class="form-label">To</label>
        <input id="rp-to" v-model="replayForm.to" type="datetime-local" class="form-input" />
      </div>
      <div>
        <label for="rp-max" class="form-label">Max events (1–1000)</label>
        <input id="rp-max" v-model="replayForm.max_events" type="number" min="1" max="1000" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-32" />
      </div>
    </FormDialog>

    <ConfirmAction
      v-if="pendingRotate"
      title="Rotate signing secret?"
      :message="`This will generate a new signing secret for '${webhook?.name || webhook?.url}'. The old secret will be immediately invalidated. Any consumers verifying webhook signatures will need to update their secret.`"
      confirm-label="Rotate Secret"
      :danger="true"
      :loading="rotateLoading"
      :error="rotateError"
      @confirm="executeRotate"
      @cancel="pendingRotate = false"
    />

    <SecretReveal v-if="rotatedSecret" title="New Signing Secret" :secret="rotatedSecret" label="Signing Secret" @close="rotatedSecret = null" />

    <!-- Edit webhook dialog -->
    <FormDialog v-if="showEdit" title="Edit Webhook" submit-label="Save Changes" :loading="editLoading" :error="editError" @submit="submitEdit" @cancel="showEdit = false" :wide="true">
      <div>
        <label for="ew-name" class="form-label">Name</label>
        <input id="ew-name" v-model="editForm.name" class="form-input" />
      </div>
      <div>
        <label for="ew-url" class="form-label">URL</label>
        <input id="ew-url" v-model="editForm.url" type="url" required class="form-input-mono" />
      </div>
      <div>
        <label class="form-label">Event types</label>
        <div class="grid grid-cols-2 gap-1 max-h-48 overflow-y-auto border border-gray-200 rounded p-2">
          <label v-for="et in EVENT_TYPES" :key="et" class="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" :value="et" v-model="editForm.event_types" class="rounded" />
            {{ et }}
          </label>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label for="ew-scope" class="form-label">Scope filter</label>
          <input id="ew-scope" v-model="editForm.scope_filter" class="form-input-mono" placeholder="tenant:acme/*" />
        </div>
        <div>
          <label for="ew-failures" class="form-label">Disable after failures</label>
          <input id="ew-failures" v-model="editForm.disable_after_failures" type="number" min="1" class="form-input" />
        </div>
      </div>
    </FormDialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useRoute, useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { useListExport } from '../composables/useListExport'
import { useSort } from '../composables/useSort'
import { getWebhook, listDeliveries, updateWebhook, deleteWebhook, testWebhook, replayWebhookEvents, rotateWebhookSecret } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { WebhookSubscription, WebhookDelivery, WebhookTestResponse } from '../types'
import { EVENT_TYPES, EVENT_CATEGORIES } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import SortHeader from '../components/SortHeader.vue'
import TenantLink from '../components/TenantLink.vue'
import EmptyState from '../components/EmptyState.vue'
import ExportDialog from '../components/ExportDialog.vue'
import ExportProgressOverlay from '../components/ExportProgressOverlay.vue'
import DownloadIcon from '../components/icons/DownloadIcon.vue'
import BackArrowIcon from '../components/icons/BackArrowIcon.vue'
import ConfirmAction from '../components/ConfirmAction.vue'
import FormDialog from '../components/FormDialog.vue'
import SecretReveal from '../components/SecretReveal.vue'
import RowActionsMenu from '../components/RowActionsMenu.vue'
import { useToast } from '../composables/useToast'
import { toMessage } from '../utils/errors'
import { safeJsonStringify } from '../utils/safe'

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
//   - status filter (PENDING / SUCCESS / FAILED / RETRYING)
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
// Sort the filtered list. `time` accessor uses `attempted_at || created_at`
// so the rendered cell's value drives the sort (delivery's final-attempt
// time, falling back to creation time for never-attempted rows).
const {
  sortKey: deliverySortKey,
  sortDir: deliverySortDir,
  toggle: deliveryToggle,
  sorted: sortedDeliveries,
} = useSort<WebhookDelivery>(filteredDeliveries as import('vue').Ref<WebhookDelivery[]>, 'time', 'desc', {
  time: (d) => d.completed_at ?? d.attempted_at ?? d.created_at ?? null,
})

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
//
// Covers every spec-editable field (cycles-governance-admin WebhookSubscription §2719):
// name, description, url, event_types, event_categories, scope_filter,
// disable_after_failures, metadata. `headers`, `thresholds`, and
// `retry_policy` are returned by the server but not exposed as form
// controls (headers values are masked on GET so the form cannot
// round-trip them; thresholds/retry_policy are opaque server config
// only rarely used in practice — surfaced as read-only JSON on the
// detail page instead).
//
// Diff-before-patch: only the fields the operator actually changed go
// into the PATCH body. Sending every field unconditionally would
// overwrite server-owned fields (e.g. metadata keys set by another
// client) on every save — the spec's PATCH semantics treat null as
// "clear", so an echoing send of `name: ""` would wipe a name the
// user didn't touch. `pendingChanges()` reports what will be sent so
// the operator isn't surprised. Same pattern as ApiKeysView edit
// (v0.1.25.24 AUDIT entry).
const showEdit = ref(false)
const editLoading = ref(false)
const editError = ref('')
const editMetadataError = ref('')
interface EditForm {
  name: string
  description: string
  url: string
  event_types: string[]
  event_categories: string[]
  scope_filter: string
  disable_after_failures: string
  metadata: string  // JSON string — parsed on submit
}
const editForm = ref<EditForm>({ name: '', description: '', url: '', event_types: [], event_categories: [], scope_filter: '', disable_after_failures: '', metadata: '' })
const editInitial = ref<EditForm | null>(null)

function snapshotForm(w: WebhookSubscription): EditForm {
  return {
    name: w.name ?? '',
    description: w.description ?? '',
    url: w.url,
    event_types: [...(w.event_types || [])],
    event_categories: [...(w.event_categories || [])],
    scope_filter: w.scope_filter ?? '',
    disable_after_failures: String(w.disable_after_failures ?? 10),
    metadata: w.metadata && Object.keys(w.metadata).length ? JSON.stringify(w.metadata, null, 2) : '',
  }
}

function openEdit() {
  if (!webhook.value) return
  // Two independent snapshots: editForm gets mutated by the inputs;
  // editInitial stays frozen as the diff baseline. Sharing the same
  // object reference made every diff zero — the v-model writes hit
  // both refs.
  editForm.value = snapshotForm(webhook.value)
  editInitial.value = snapshotForm(webhook.value)
  editError.value = ''
  editMetadataError.value = ''
  showEdit.value = true
}

async function submitEdit() {
  editError.value = ''
  editMetadataError.value = ''
  if (!editForm.value.event_types.length) { editError.value = 'Select at least one event type'; return }
  const body: Record<string, unknown> = {}
  const init = editInitial.value
  if (!init) return
  // Diff each field. For strings, empty → undefined so we don't echo
  // an empty value that would overwrite a server default.
  if (editForm.value.name !== init.name) body.name = editForm.value.name || null
  if (editForm.value.description !== init.description) body.description = editForm.value.description || null
  if (editForm.value.url !== init.url) body.url = editForm.value.url
  if (JSON.stringify(editForm.value.event_types) !== JSON.stringify(init.event_types)) body.event_types = editForm.value.event_types
  if (JSON.stringify(editForm.value.event_categories) !== JSON.stringify(init.event_categories)) body.event_categories = editForm.value.event_categories
  if (editForm.value.scope_filter !== init.scope_filter) body.scope_filter = editForm.value.scope_filter || null
  if (editForm.value.disable_after_failures !== init.disable_after_failures) body.disable_after_failures = Number(editForm.value.disable_after_failures)
  if (editForm.value.metadata !== init.metadata) {
    if (editForm.value.metadata.trim() === '') {
      body.metadata = null
    } else {
      try {
        const parsed = JSON.parse(editForm.value.metadata)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          editMetadataError.value = 'Metadata must be a JSON object'
          return
        }
        body.metadata = parsed
      } catch { editMetadataError.value = 'Invalid JSON'; return }
    }
  }
  if (Object.keys(body).length === 0) { editError.value = 'No changes to save'; return }
  editLoading.value = true
  try {
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

// WebhooksView kebab "Edit" routes here with ?action=edit; apply once
// after the first successful webhook fetch (openEdit depends on
// webhook.value being populated). Guarded so polling-driven refetches
// don't keep re-opening the dialog if the user dismisses it.
let editIntentApplied = false

const { refresh, isLoading, lastUpdated } = usePolling(async () => {
  try {
    webhook.value = await getWebhook(id)
    if (!editIntentApplied && route.query.action === 'edit' && webhook.value) {
      editIntentApplied = true
      openEdit()
    }
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
  count: sortedDeliveries.value.length,
  getScrollElement: () => deliveryScrollEl.value,
  estimateSize: () => DELIVERY_ROW_HEIGHT,
  overscan: 8,
  getItemKey: (i: number) => sortedDeliveries.value[i]?.delivery_id ?? i,
})))
const deliveryVirtualRows = computed(() => deliveryVirt.value.getVirtualItems())
const deliveryTotalHeight = computed(() => deliveryVirt.value.getTotalSize())
// 7-column delivery grid. Error column added so operators can see
// *why* a delivery failed (response_status alone is ambiguous —
// 405 here is the receiver rejecting POST, but 'Subscription not
// active: DISABLED' comes from the server after auto-disable and
// also carries a response_status of 405 from the last real attempt).
// Error flexes to fill remaining width; trailing 40px is the kebab
// actions column (v0.1.25.40 — was 88px for the inline Copy JSON
// button, which wasted ~48px×every row for a single action).
const deliveryGridTemplate = '100px 80px 72px 200px minmax(240px,1fr) 150px 40px'

// Copy actions for the delivery-row kebab. Copy JSON covers the whole
// WebhookDelivery (for cross-referencing into /events or the receiver's
// logs); Copy delivery ID / Copy event ID cover the 80% case where the
// operator only needs the ID to paste elsewhere. Kebab auto-closes
// on click so confirmation goes to the toast, not a label swap.
async function copyDeliveryJson(d: WebhookDelivery) {
  try {
    await navigator.clipboard.writeText(safeJsonStringify(d))
    toast.success('Delivery JSON copied')
  } catch {
    toast.error('Copy failed — clipboard permission denied')
  }
}
async function copySubscriptionJson() {
  if (!webhook.value) return
  try {
    await navigator.clipboard.writeText(safeJsonStringify(webhook.value))
    toast.success('Subscription JSON copied')
  } catch {
    toast.error('Copy failed — clipboard permission denied')
  }
}
async function copyDeliveryId(d: WebhookDelivery) {
  try {
    await navigator.clipboard.writeText(d.delivery_id)
    toast.success('Delivery ID copied')
  } catch {
    toast.error('Copy failed — clipboard permission denied')
  }
}
async function copyEventId(d: WebhookDelivery) {
  try {
    await navigator.clipboard.writeText(d.event_id)
    toast.success('Event ID copied')
  } catch {
    toast.error('Copy failed — clipboard permission denied')
  }
}
function deliveryActions(d: WebhookDelivery) {
  return [
    { label: 'Copy as JSON', onClick: () => { void copyDeliveryJson(d) } },
    { label: 'Copy delivery ID', onClick: () => { void copyDeliveryId(d) } },
    { label: 'Copy event ID', onClick: () => { void copyEventId(d) } },
  ]
}

// Status filter refetches page 1 so the filter is server-enforced
// (not just client-side filtering of already-loaded data — that
// would let the filter miss matches from un-loaded pages). A select
// change is instant-apply; no debounce needed.
watch(deliveryStatusFilter, () => { refresh() })

// Export. Server-side status filter means the fetchPage adapter passes
// the same filter param — cursor pages stay consistent with what's
// on screen.
const {
  showExportConfirm,
  exporting,
  exportFetched,
  exportError,
  exportCancellable,
  maxRows: EXPORT_MAX_ROWS,
  confirmExport,
  cancelExport,
  cancelRunningExport,
  executeExport,
} = useListExport<WebhookDelivery>({
  itemNoun: 'delivery',
  filenameStem: 'webhook-deliveries',
  currentItems: sortedDeliveries,
  hasMore: deliveriesHasMore,
  nextCursor: deliveriesNextCursor,
  fetchPage: async (cursor) => {
    const res = await listDeliveries(id, { ...buildDeliveryParams(), cursor })
    return { items: res.deliveries, hasMore: !!res.has_more, nextCursor: res.next_cursor ?? '' }
  },
  columns: [
    { header: 'delivery_id',      value: d => d.delivery_id },
    { header: 'event_id',         value: d => d.event_id },
    { header: 'event_type',       value: d => d.event_type ?? '' },
    { header: 'status',           value: d => d.status },
    { header: 'response_status',  value: d => d.response_status ?? '' },
    { header: 'response_time_ms', value: d => d.response_time_ms ?? '' },
    { header: 'error_message',    value: d => d.error_message ?? '' },
    { header: 'attempts',         value: d => d.attempts },
    { header: 'attempted_at',     value: d => d.attempted_at ?? '' },
    { header: 'completed_at',     value: d => d.completed_at ?? '' },
    { header: 'next_retry_at',    value: d => d.next_retry_at ?? '' },
    { header: 'created_at',       value: d => d.created_at ?? '' },
    { header: 'trace_id',         value: d => d.trace_id ?? '' },
  ],
})

watch(exportError, (v) => { if (v) error.value = v })
</script>

<template>
  <div>
    <PageHeader title="Webhook Detail" :subtitle="webhook?.name || webhook?.subscription_id" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh">
      <template #back>
        <button @click="router.push('/webhooks')" aria-label="Back to webhooks" class="muted hover:text-gray-700 cursor-pointer">
          <BackArrowIcon class="w-5 h-5" />
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
            <!-- Send Test stays inline because it is the single "do-it-now"
                 action operators reach for most during webhook triage.
                 Everything else — edit, rotate, replay, state changes,
                 delete — lives in the overflow menu so the header no
                 longer wraps onto two rows. -->
            <button @click="runTest" :disabled="testLoading" class="btn-pill-secondary disabled:opacity-50">{{ testLoading ? 'Testing...' : 'Send Test' }}</button>
            <RowActionsMenu
              aria-label="More webhook actions"
              trigger-label="More actions"
              :items="[
                { label: 'Edit', onClick: openEdit },
                { label: 'Rotate Secret', onClick: openRotate },
                { label: 'Replay', onClick: () => { showReplay = true } },
                { label: 'Copy as JSON', onClick: () => copySubscriptionJson() },
                { label: 'Reset & Re-enable', onClick: () => { pendingAction = 'reset' }, hidden: !((webhook.consecutive_failures ?? 0) > 0 && webhook.status !== 'ACTIVE') },
                { label: 'Enable', onClick: () => { pendingAction = 'ACTIVE' }, hidden: webhook.status !== 'DISABLED' && webhook.status !== 'PAUSED' },
                { separator: true },
                { label: 'Pause', onClick: () => { pendingAction = 'PAUSED' }, danger: true, hidden: webhook.status !== 'ACTIVE' },
                { label: 'Delete', onClick: openDelete, danger: true },
              ]"
            />
          </div>
        </div>
        <!-- Compact metadata: rich content (URL, event types, headers, etc.)
             keeps panel cards; identifiers + timestamps + failure threshold
             collapse into single inline strips so Delivery History gets the
             vertical space below the fold. -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
          <div class="info-panel md:col-span-2"><span class="form-label">URL</span><span class="font-mono text-xs break-all">{{ webhook.url }}</span></div>
          <div v-if="webhook.description" class="info-panel md:col-span-2"><span class="form-label">Description</span><span class="text-gray-700 whitespace-pre-wrap">{{ webhook.description }}</span></div>
          <div class="info-panel"><span class="form-label">Subscribed Event Types</span><div class="flex flex-wrap gap-1 mt-1"><span v-for="et in (webhook.event_types || [])" :key="et" class="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-xs font-mono">{{ et }}</span><span v-if="!webhook.event_types?.length" class="muted-sm">all events</span></div></div>
          <div v-if="webhook.event_categories?.length" class="info-panel"><span class="form-label">Event Categories</span><div class="flex flex-wrap gap-1 mt-1"><span v-for="ec in webhook.event_categories" :key="ec" class="bg-blue-50 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded text-xs font-mono">{{ ec }}</span></div></div>
          <div v-if="webhook.scope_filter" class="info-panel"><span class="form-label">Scope Filter</span><span class="font-mono text-xs">{{ webhook.scope_filter }}</span></div>
          <div v-if="webhook.headers && Object.keys(webhook.headers).length > 0" class="info-panel"><span class="form-label">Custom Headers</span><div class="flex flex-wrap gap-1 mt-1"><span v-for="k in Object.keys(webhook.headers)" :key="k" class="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-xs font-mono">{{ k }}: ********</span></div></div>
          <div v-if="webhook.metadata && Object.keys(webhook.metadata).length > 0" class="info-panel md:col-span-2">
            <span class="form-label">Metadata</span>
            <pre class="font-mono text-xs whitespace-pre-wrap break-all bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 mt-1">{{ JSON.stringify(webhook.metadata, null, 2) }}</pre>
          </div>
        </div>

        <!-- Identity + auto-disable threshold row. One line, no panel
             chrome, monospace ID + tenant link + failure tally with the
             same red-near-threshold signal as before. -->
        <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs muted">
          <span><span class="muted-sm mr-1">ID</span><span class="font-mono text-gray-700 dark:text-gray-300 break-all">{{ webhook.subscription_id }}</span></span>
          <span><span class="muted-sm mr-1">Tenant</span><TenantLink :tenant-id="webhook.tenant_id" /></span>
          <span :title="`Server auto-disables the subscription when ${webhook.disable_after_failures ?? 10} consecutive failures are reached.`">
            <span class="muted-sm mr-1">Failures</span>
            <span class="tabular-nums">
              <span :class="(webhook.consecutive_failures ?? 0) >= Math.max((webhook.disable_after_failures ?? 10) - 2, 1) ? 'text-red-600 font-medium' : 'text-gray-700 dark:text-gray-300'">{{ webhook.consecutive_failures ?? 0 }}</span>
              <span class="muted"> / {{ webhook.disable_after_failures ?? 10 }}</span>
            </span>
          </span>
        </div>

        <!-- Timestamp footer. All five date stamps inline with dot
             separators. Previously each was its own ~50px info-panel
             card — five cards consumed ~250px of vertical space and
             pushed Delivery History below the fold. -->
        <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs muted">
          <span><span class="muted-sm mr-1">Created</span>{{ formatDateTime(webhook.created_at) }}</span>
          <span v-if="webhook.updated_at" class="before:content-['·'] before:mr-3"><span class="muted-sm mr-1">Updated</span>{{ formatDateTime(webhook.updated_at) }}</span>
          <span v-if="webhook.last_triggered_at" class="before:content-['·'] before:mr-3"><span class="muted-sm mr-1">Last triggered</span>{{ formatDateTime(webhook.last_triggered_at) }}</span>
          <span v-if="webhook.last_success_at" class="before:content-['·'] before:mr-3"><span class="muted-sm mr-1">Last success</span><span class="text-green-700 dark:text-green-400">{{ formatDateTime(webhook.last_success_at) }}</span></span>
          <span v-if="webhook.last_failure_at" class="before:content-['·'] before:mr-3"><span class="muted-sm mr-1">Last failure</span><span class="text-red-600 dark:text-red-400">{{ formatDateTime(webhook.last_failure_at) }}</span></span>
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

      <!-- V1 virtualized delivery history. Title on its own row at the
           top so it stays anchored even when the toolbar below wraps
           onto multiple lines at narrow viewports. Controls row holds
           the counter, status filter, and export buttons. Button
           labels say "Export CSV" / "Export JSON" for consistency with
           AuditView / WebhooksView / BudgetsView / every other list
           view — "CSV" / "JSON" was a lone abbreviation. Status filter
           applied server-side so pagination stays consistent;
           Load-more appends. -->
      <div class="bg-white rounded-lg shadow overflow-hidden text-sm" role="table" :aria-rowcount="filteredDeliveries.length + 1" :aria-colcount="5">
        <div class="table-cell border-b border-gray-100 space-y-2">
          <h3 class="text-sm font-medium text-gray-700">Delivery History</h3>
          <div class="flex items-center gap-x-3 gap-y-2 flex-wrap">
            <span class="muted-sm tabular-nums">
              {{ filteredDeliveries.length.toLocaleString() }} loaded
              <span v-if="deliveriesHasMore" class="text-amber-600 ml-1">(more available)</span>
            </span>
            <span class="flex-1" />
            <select v-model="deliveryStatusFilter" aria-label="Filter deliveries by status" class="form-select">
              <option value="">All statuses</option>
              <option>PENDING</option>
              <option>SUCCESS</option>
              <option>FAILED</option>
              <option>RETRYING</option>
            </select>
            <button @click="confirmExport('csv')" :disabled="filteredDeliveries.length === 0" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">
              <DownloadIcon class="w-3.5 h-3.5" />
              Export CSV
            </button>
            <button @click="confirmExport('json')" :disabled="filteredDeliveries.length === 0" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">
              <DownloadIcon class="w-3.5 h-3.5" />
              Export JSON
            </button>
          </div>
        </div>

        <div role="rowgroup" class="table-header border-b border-gray-200 sticky top-0 z-10">
          <div role="row" class="grid text-xs font-bold uppercase tracking-wider" :style="{ gridTemplateColumns: deliveryGridTemplate }">
            <SortHeader as="div" label="Status" column="status" :active-column="deliverySortKey" :direction="deliverySortDir" @sort="deliveryToggle" />
            <SortHeader as="div" label="HTTP" column="response_status" :active-column="deliverySortKey" :direction="deliverySortDir" @sort="deliveryToggle" />
            <SortHeader as="div" label="Tries" column="attempts" :active-column="deliverySortKey" :direction="deliverySortDir" @sort="deliveryToggle" align="right" />
            <SortHeader as="div" label="Event ID" column="event_id" :active-column="deliverySortKey" :direction="deliverySortDir" @sort="deliveryToggle" />
            <SortHeader as="div" label="Error" column="error_message" :active-column="deliverySortKey" :direction="deliverySortDir" @sort="deliveryToggle" />
            <SortHeader as="div" label="Time" column="time" :active-column="deliverySortKey" :direction="deliverySortDir" @sort="deliveryToggle" />
            <div role="columnheader" class="table-cell muted-sm text-right"><span class="sr-only">Actions</span></div>
          </div>
        </div>

        <div
          v-if="sortedDeliveries.length > 0"
          ref="deliveryScrollEl"
          role="rowgroup"
          class="overflow-y-auto max-h-[60vh] min-h-[200px]"
        >
          <div role="presentation" :style="{ height: deliveryTotalHeight + 'px', position: 'relative' }">
            <div
              v-for="v in deliveryVirtualRows"
              :key="sortedDeliveries[v.index].delivery_id"
              role="row"
              :aria-rowindex="v.index + 2"
              class="grid table-row-hover border-b border-gray-100 absolute left-0 right-0 items-center"
              :style="{ gridTemplateColumns: deliveryGridTemplate, transform: `translateY(${v.start}px)`, height: DELIVERY_ROW_HEIGHT + 'px' }"
            >
              <div role="cell" class="table-cell"><StatusBadge :status="sortedDeliveries[v.index].status" /></div>
              <div role="cell" class="table-cell font-mono text-xs" :class="sortedDeliveries[v.index].response_status && sortedDeliveries[v.index].response_status! >= 400 ? 'text-red-600' : 'muted'">{{ sortedDeliveries[v.index].response_status || '-' }}</div>
              <div role="cell" class="table-cell text-right muted tabular-nums">{{ sortedDeliveries[v.index].attempts }}</div>
              <div role="cell" class="table-cell font-mono muted-sm truncate" :title="sortedDeliveries[v.index].event_id">{{ sortedDeliveries[v.index].event_id }}</div>
              <!-- Error cell — the whole point of the column expansion.
                   Title tooltip shows the full message (can exceed row
                   width for HTTP body echoes); Copy JSON in the Actions
                   column also carries the full text. Red-tinted only
                   for FAILED rows so transient RETRYING errors don't
                   visually dominate the grid. -->
              <div
                role="cell"
                class="table-cell text-xs truncate"
                :class="sortedDeliveries[v.index].status === 'FAILED' ? 'text-red-600' : 'muted'"
                :title="sortedDeliveries[v.index].error_message || ''"
              >{{ sortedDeliveries[v.index].error_message || '—' }}</div>
              <div role="cell" class="table-cell muted-sm">{{ sortedDeliveries[v.index].completed_at ? formatDateTime(sortedDeliveries[v.index].completed_at!) : sortedDeliveries[v.index].attempted_at ? formatDateTime(sortedDeliveries[v.index].attempted_at!) : sortedDeliveries[v.index].created_at ? formatDateTime(sortedDeliveries[v.index].created_at!) : '-' }}</div>
              <div role="cell" class="table-cell flex justify-end">
                <RowActionsMenu
                  :items="deliveryActions(sortedDeliveries[v.index])"
                  :aria-label="`Actions for delivery ${sortedDeliveries[v.index].delivery_id}`"
                />
              </div>
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
          {{ deliveriesLoadingMore ? 'Loading…' : 'Load more' }}
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

    <ExportDialog
      :format="showExportConfirm"
      :loaded-count="filteredDeliveries.length"
      :has-more="deliveriesHasMore"
      :max-rows="EXPORT_MAX_ROWS"
      item-noun-plural="deliveries"
      @confirm="executeExport"
      @cancel="cancelExport"
    />
    <ExportProgressOverlay
      :open="exporting"
      :fetched="exportFetched"
      :cancellable="exportCancellable"
      item-noun-plural="deliveries"
      @cancel="cancelRunningExport"
    />

    <!-- Edit webhook dialog -->
    <FormDialog v-if="showEdit" title="Edit Webhook" submit-label="Save Changes" :loading="editLoading" :error="editError" @submit="submitEdit" @cancel="showEdit = false" :wide="true">
      <div>
        <label for="ew-name" class="form-label">Name</label>
        <input id="ew-name" v-model="editForm.name" class="form-input" placeholder="Human-readable name (optional)" maxlength="256" />
      </div>
      <div>
        <label for="ew-description" class="form-label">Description</label>
        <textarea id="ew-description" v-model="editForm.description" class="form-input" rows="2" placeholder="What this webhook is for (optional)" maxlength="1024" />
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
      <div>
        <label class="form-label">Event categories <span class="muted-sm">(additive — subscribes to all events in category, including future ones)</span></label>
        <div class="flex flex-wrap gap-2 border border-gray-200 rounded p-2">
          <label v-for="ec in EVENT_CATEGORIES" :key="ec" class="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" :value="ec" v-model="editForm.event_categories" class="rounded" />
            {{ ec }}
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
      <div>
        <label for="ew-metadata" class="form-label">Metadata <span class="muted-sm">(JSON object, optional)</span></label>
        <textarea id="ew-metadata" v-model="editForm.metadata" class="form-input-mono" rows="4" placeholder='{ "team": "payments", "env": "prod" }' />
        <p v-if="editMetadataError" class="text-xs text-red-600 mt-1">{{ editMetadataError }}</p>
      </div>
      <div v-if="webhook && webhook.headers && Object.keys(webhook.headers).length > 0" class="info-panel">
        <span class="form-label">Custom headers</span>
        <p class="muted-sm mb-1">Keys preserved, values encrypted on the server and masked on read. Rotating values requires re-creating the subscription.</p>
        <div class="flex flex-wrap gap-1 mt-1">
          <span v-for="k in Object.keys(webhook.headers)" :key="k" class="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-xs font-mono">{{ k }}: ********</span>
        </div>
      </div>
    </FormDialog>
  </div>
</template>

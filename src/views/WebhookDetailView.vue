<script setup lang="ts">
import { ref, computed, watch, defineAsyncComponent } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { isNavigationFailure, useRoute, useRouter } from 'vue-router'
import { useWebhookDetailData } from '../composables/useWebhookDetailData'
import { useWebhookEditor } from '../composables/useWebhookEditor'
import { useWebhookOperations } from '../composables/useWebhookOperations'
import type { AppliedQuerySnapshot } from '../composables/useAppliedQuery'
import { useChartTheme } from '../composables/useChartTheme'
// Lazy-loaded to keep ECharts + vue-echarts out of the detail-view
// initial chunk. Stats panel hides itself when deliveries.length === 0
// so the bundle split also delays network fetch until needed.
const BaseChart = defineAsyncComponent(() => import('../components/BaseChart.vue'))
import { useListExport } from '../composables/useListExport'
import { useSort } from '../composables/useSort'
import { useAuthStore } from '../stores/auth'
import type { WebhookDelivery } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import SortHeader from '../components/SortHeader.vue'
import TenantLink from '../components/TenantLink.vue'
import EmptyState from '../components/EmptyState.vue'
import LoadingSkeleton from '../components/LoadingSkeleton.vue'
import InlineErrorBanner from '../components/InlineErrorBanner.vue'
import ExportDialog from '../components/ExportDialog.vue'
import ExportProgressOverlay from '../components/ExportProgressOverlay.vue'
import DownloadIcon from '../components/icons/DownloadIcon.vue'
import BackArrowIcon from '../components/icons/BackArrowIcon.vue'
import ConfirmAction from '../components/ConfirmAction.vue'
import FormDialog from '../components/FormDialog.vue'
import WebhookEditDialog from '../components/WebhookEditDialog.vue'
import SecretReveal from '../components/SecretReveal.vue'
import RowActionsMenu from '../components/RowActionsMenu.vue'
import { useToast } from '../composables/useToast'
import { writeClipboardJson, writeClipboardText } from '../utils/clipboard'

const toast = useToast()
import { formatDateTime } from '../utils/format'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const id = route.params.id as string
const canManage = computed(() => auth.capabilities?.manage_webhooks !== false)

// Delivery-history pagination + filter (scale hardening). A busy
// webhook can have thousands of delivery records; pre-fix the view
// fetched them all and rendered each as a real DOM row. Now:
//   - cursor pagination via Load more (append)
//   - status filter (PENDING / SUCCESS / FAILED / RETRYING)
//   - virtualized rows so DOM stays bounded
const deliveryStatusFilter = ref('')
// Acquisition's initial tick can run while the sibling mutation owners are
// being constructed below. No mutation can exist during that synchronous
// bootstrap, so false is safe until the closure is replaced with their state.
let webhookMutationRunning = () => false
// Operations are constructed before the editor. This sibling gate is replaced
// synchronously after both owners exist, before a user can arm either one.
let webhookEditorArmed = () => false
const {
  webhook,
  deliveries,
  error,
  notFound,
  initialLoadDone,
  deliveriesHasMore,
  deliveriesNextCursor,
  deliveriesLoadingMore,
  deliveryFilterLoading,
  deliveryContinuationUsable,
  resultsMatchAppliedFilter,
  snapshotDeliveryQuery,
  ownsDeliveryQuery,
  applyDeliveryParams,
  loadMoreDeliveries,
  fetchDeliveryPage,
  beginSubscriptionMutation,
  publishWebhook,
  publishDeletedWebhook,
  reportError,
  dismissError,
  refreshAll,
  loading: dataLoading,
  lastSuccessAt,
} = useWebhookDetailData({
  webhookId: id,
  getDeliveryParams: buildDeliveryParams,
  isMutationRunning: () => webhookMutationRunning(),
})

const webhookOperations = useWebhookOperations({
  webhookId: id,
  webhook,
  beginSubscriptionMutation,
  publishWebhook,
  publishDeletedWebhook,
  reportError,
  navigateToList: async () => {
    const failure = await router.push({ name: 'webhooks' })
    if (isNavigationFailure(failure)) throw failure
  },
  notify: toast,
  canArm: () => !webhookEditorArmed(),
})

const {
  pendingStatusAction,
  statusActionLoading,
  statusActionError,
  requestStatusAction,
  cancelStatusAction,
  executeStatusAction,
  pendingDelete,
  deleteLoading,
  deleteError,
  openDelete,
  cancelDelete,
  executeDelete,
  pendingRotate,
  rotateLoading,
  rotateError,
  rotatedSecret,
  openRotate,
  cancelRotate,
  executeRotate,
  closeRotatedSecret,
  testResult,
  testLoading,
  runTest,
  showReplay,
  replayLoading,
  replayError,
  replayForm,
  replayResult,
  replayMaxEventsError,
  canSubmitReplay,
  openReplay,
  cancelReplay,
  submitReplay,
  dismissReplayResult,
  hasPendingOperation,
  isMutationRunning: webhookOperationBusy,
} = webhookOperations

const webhookEditor = useWebhookEditor({
  webhookId: id,
  webhook,
  canOpen: () => !hasPendingOperation.value && !webhookOperationBusy.value,
  beginSubscriptionMutation,
  publishWebhook,
  notifySuccess: toast.success,
})
const {
  showEdit,
  editLoading,
  editError,
  editMetadataError,
  editForm,
  editAdvanced,
  editAdvancedHasConfig,
  hiddenLegacySelectorCount,
  isTenantOwned,
  editEventTypes,
  editEventCategories,
  openEdit,
  cancelEdit,
  submitEdit,
} = webhookEditor
webhookEditorArmed = () => webhookEditor.editorArmed.value
webhookMutationRunning = () => webhookOperationBusy.value || editLoading.value
const operationBusyReason = 'Another webhook operation is in progress.'
const sendTestBusyReason = computed(() => (
  testLoading.value
    ? 'Webhook endpoint test is in progress.'
    : operationBusyReason
))

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

// v0.1.25.51 — Per-subscription delivery stats. All metrics are
// client-side reductions over the already-fetched `deliveries` ref
// (30s poll, no new request). Scope is the loaded page — on a busy
// webhook the operator sees the last N deliveries, which matches
// what the history table below renders, so the chart labels and the
// row detail stay consistent.
const { palette } = useChartTheme()

type OutcomeBuckets = { success: number; failed: number; retrying: number; pending: number }

const deliveryOutcomes = computed<OutcomeBuckets>(() => {
  const out: OutcomeBuckets = { success: 0, failed: 0, retrying: 0, pending: 0 }
  for (const d of deliveries.value) {
    if (d.status === 'SUCCESS') out.success++
    else if (d.status === 'FAILED') out.failed++
    else if (d.status === 'RETRYING') out.retrying++
    else if (d.status === 'PENDING') out.pending++
  }
  return out
})

const deliveryOutcomeOption = computed(() => {
  const o = deliveryOutcomes.value
  const slices = [
    { name: 'Success', value: o.success, itemStyle: { color: palette.value.success } },
    { name: 'Failed', value: o.failed, itemStyle: { color: palette.value.danger } },
    { name: 'Retrying', value: o.retrying, itemStyle: { color: palette.value.warning } },
    { name: 'Pending', value: o.pending, itemStyle: { color: palette.value.neutral } },
  ].filter(s => s.value > 0)
  return {
    tooltip: {
      trigger: 'item' as const,
      backgroundColor: palette.value.tooltipBg,
      borderColor: palette.value.tooltipBorder,
      textStyle: { color: palette.value.textPrimary },
    },
    legend: { bottom: 0, textStyle: { color: palette.value.textMuted, fontSize: 11 } },
    series: [{
      type: 'pie' as const,
      radius: ['55%', '78%'],
      center: ['50%', '45%'],
      avoidLabelOverlap: true,
      label: { show: false },
      labelLine: { show: false },
      data: slices,
    }],
  }
})

type ChartClickParams = { seriesName?: string; name?: string }

function onDeliveryOutcomeClick(p: ChartClickParams) {
  const name = (p?.name ?? '').toUpperCase()
  if (['SUCCESS', 'FAILED', 'RETRYING', 'PENDING'].includes(name)) {
    deliveryStatusFilter.value = name
  }
}

// Attempts histogram — x-axis is attempt count (1, 2, 3, 4, 5+),
// y-axis is delivery count. A long tail in 4/5+ means a retry
// storm on this subscription: a single slow/failing endpoint can
// eat disproportionate delivery budget. Caps at 5+ so a pathological
// row with attempts=99 doesn't blow up the axis.
type AttemptsBucket = { label: string; count: number }
const attemptsBuckets = computed<AttemptsBucket[]>(() => {
  const tallies = new Map<string, number>()
  for (const d of deliveries.value) {
    const a = d.attempts ?? 0
    const label = a >= 5 ? '5+' : String(a)
    tallies.set(label, (tallies.get(label) ?? 0) + 1)
  }
  const order = ['0', '1', '2', '3', '4', '5+']
  return order
    .filter(label => tallies.has(label))
    .map(label => ({ label, count: tallies.get(label) ?? 0 }))
})

// Response-time summary. Plain stats row (no chart) rather than a
// histogram because the attempts histogram already owns the bar-chart
// slot and response-time over a variable-size cursor page gives p50 /
// p95 more signal than fighting over bucket widths. Only includes
// deliveries that reached the endpoint (response_time_ms set).
type ResponseStats = { count: number; p50: number; p95: number; max: number }
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  // Nearest-rank method (NIST): ceil((p/100) * n) → 1-indexed rank.
  // Chosen over the floor variant so small pages still assign the
  // middle-or-better sample to p50 (for 4 samples, p50 = 2nd of 4
  // rather than 3rd, which is surprising to operators reading the
  // stat strip).
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[Math.min(rank, sorted.length) - 1]
}
const responseStats = computed<ResponseStats>(() => {
  const times: number[] = []
  for (const d of deliveries.value) {
    if (typeof d.response_time_ms === 'number' && d.response_time_ms >= 0) times.push(d.response_time_ms)
  }
  if (times.length === 0) return { count: 0, p50: 0, p95: 0, max: 0 }
  times.sort((a, b) => a - b)
  return {
    count: times.length,
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    max: times[times.length - 1],
  }
})

// Time-since-last-success indicator. Traffic lights mirror the
// oncall severity convention operators already know from PagerDuty /
// Grafana:
//   green  — < 1h (or no last_success_at yet on a fresh webhook)
//   amber  — 1h – 24h
//   red    — ≥ 24h OR disable_after_failures reached
// Returns the tuple so the template can render both chip + tooltip.
type HealthBand = { band: 'green' | 'amber' | 'red' | 'unknown'; label: string; detail: string }
function formatElapsed(ms: number): string {
  if (ms < 60_000) return '< 1 min'
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} hr`
  return `${Math.round(ms / 86_400_000)} d`
}
const lastSuccessBand = computed<HealthBand>(() => {
  const w = webhook.value
  if (!w) return { band: 'unknown', label: 'No data', detail: '' }
  const t = w.last_success_at
  if (!t) {
    return w.last_failure_at
      ? { band: 'red', label: 'No successful deliveries', detail: 'Only failures recorded' }
      : { band: 'unknown', label: 'No deliveries yet', detail: 'Waiting for first event' }
  }
  const ts = Date.parse(t)
  if (!Number.isFinite(ts)) return { band: 'unknown', label: 'Unknown', detail: '' }
  const elapsed = Date.now() - ts
  const elapsedLabel = formatElapsed(elapsed)
  if (elapsed < 3_600_000) return { band: 'green', label: `Success ${elapsedLabel} ago`, detail: t }
  if (elapsed < 86_400_000) return { band: 'amber', label: `Success ${elapsedLabel} ago`, detail: t }
  return { band: 'red', label: `Stale · ${elapsedLabel} since last success`, detail: t }
})

const attemptsChartOption = computed(() => {
  const buckets = attemptsBuckets.value
  return {
    tooltip: {
      trigger: 'axis' as const,
      backgroundColor: palette.value.tooltipBg,
      borderColor: palette.value.tooltipBorder,
      textStyle: { color: palette.value.textPrimary },
    },
    grid: { top: 16, right: 16, bottom: 24, left: 32 },
    xAxis: {
      type: 'category' as const,
      data: buckets.map(b => b.label),
      axisLabel: { color: palette.value.textMuted, fontSize: 11 },
      axisLine: { lineStyle: { color: palette.value.grid } },
    },
    yAxis: {
      type: 'value' as const,
      axisLabel: { color: palette.value.textMuted, fontSize: 11 },
      splitLine: { lineStyle: { color: palette.value.grid } },
    },
    series: [{
      type: 'bar' as const,
      data: buckets.map((b, i) => ({
        value: b.count,
        itemStyle: {
          color: i <= 1
            ? palette.value.success
            : i <= 2
              ? palette.value.warning
              : palette.value.danger,
        },
      })),
      barMaxWidth: 40,
    }],
  }
})

function buildDeliveryParams(): Record<string, string> {
  const p: Record<string, string> = {}
  if (deliveryStatusFilter.value) p.status = deliveryStatusFilter.value
  return p
}

// WebhooksView kebab "Edit" routes here with ?action=edit. Route intent
// stays in the view; the data owner only publishes the fetched row.
let editIntentApplied = false
watch(webhook, (value) => {
  if (!editIntentApplied && route.query.action === 'edit' && value) {
    editIntentApplied = true
    openEdit()
  }
})

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
// All four are built on the shared clipboard helpers (writeClipboardJson
// for payloads, writeClipboardText for bare ids) with the app-wide
// failure copy — 'clipboard unavailable' covers denied permission AND
// insecure contexts / missing API, which the old hand-rolled
// 'permission denied' wording misdiagnosed.
async function copyDeliveryJson(d: WebhookDelivery) {
  if (await writeClipboardJson(d)) toast.success('Delivery JSON copied')
  else toast.error('Copy failed — clipboard unavailable')
}
async function copySubscriptionJson() {
  if (!webhook.value) return
  if (await writeClipboardJson(webhook.value)) toast.success('Subscription JSON copied')
  else toast.error('Copy failed — clipboard unavailable')
}
async function copyDeliveryId(d: WebhookDelivery) {
  if (await writeClipboardText(d.delivery_id)) toast.success('Delivery ID copied')
  else toast.error('Copy failed — clipboard unavailable')
}
async function copyEventId(d: WebhookDelivery) {
  if (await writeClipboardText(d.event_id)) toast.success('Event ID copied')
  else toast.error('Copy failed — clipboard unavailable')
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
watch(deliveryStatusFilter, () => { void applyDeliveryParams() })

// Export. Server-side status filter means the fetchPage adapter passes
// the same filter param — cursor pages stay consistent with what's
// on screen.
let exportDeliverySnapshot: AppliedQuerySnapshot | null = null

const {
  showExportConfirm,
  exporting,
  exportFetched,
  exportError,
  exportCancellable,
  maxRows: EXPORT_MAX_ROWS,
  confirmExport: openExportConfirm,
  cancelExport: closeExportConfirm,
  cancelRunningExport,
  executeExport: runExport,
} = useListExport<WebhookDelivery>({
  itemNoun: 'delivery',
  filenameStem: 'webhook-deliveries',
  currentItems: sortedDeliveries,
  hasMore: deliveriesHasMore,
  nextCursor: deliveriesNextCursor,
  fetchPage: async (cursor, signal) => {
    const snapshot = exportDeliverySnapshot
    if (!snapshot || !ownsDeliveryQuery(snapshot)) {
      throw new Error('Export cancelled because the applied delivery filter changed.')
    }
    return fetchDeliveryPage(snapshot, cursor, signal)
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

const canExport = computed(() => (
  !dataLoading.value &&
  resultsMatchAppliedFilter.value &&
  deliveryContinuationUsable.value &&
  sortedDeliveries.value.length > 0
))

function confirmExport(format: 'csv' | 'json') {
  if (!canExport.value) return
  exportDeliverySnapshot = snapshotDeliveryQuery()
  openExportConfirm(format)
}

function cancelExport() {
  closeExportConfirm()
  exportDeliverySnapshot = null
}

async function executeExport() {
  const snapshot = exportDeliverySnapshot
  if (!canExport.value || !snapshot || !ownsDeliveryQuery(snapshot)) {
    cancelExport()
    return
  }
  try {
    await runExport()
  } finally {
    exportDeliverySnapshot = null
  }
}

function cancelDeliveryExport() {
  cancelRunningExport()
  closeExportConfirm()
  exportDeliverySnapshot = null
}

watch(exportError, (v) => { if (v) reportError(v) })
</script>

<template>
  <div>
    <PageHeader title="Webhook Detail" :subtitle="webhook?.name || webhook?.subscription_id" :loading="dataLoading" :last-updated-at="lastSuccessAt" @refresh="refreshAll">
      <template #back>
        <button @click="router.push({ name: 'webhooks' })" aria-label="Back to webhooks" class="muted hover:text-gray-700 cursor-pointer">
          <BackArrowIcon class="w-5 h-5" />
        </button>
      </template>
    </PageHeader>
    <InlineErrorBanner v-if="error" :message="error" @dismiss="dismissError" />

    <!-- P0-C2: not-found card. A stale link / typo'd URL for a webhook
         that doesn't exist (or was deleted) gets a clear "no such
         webhook" panel rather than a blank page-body. -->
    <div
      v-if="notFound"
      class="bg-white dark:bg-gray-900 rounded-lg shadow p-8 text-center"
      data-testid="webhook-not-found"
    >
      <p class="text-lg font-medium text-gray-900 dark:text-white">Webhook not found</p>
      <p class="muted-sm mt-2">
        No webhook with ID <span class="font-mono">{{ id }}</span> exists or is visible to your session.
      </p>
      <button
        type="button"
        class="btn-pill-primary mt-4"
        @click="router.push({ name: 'webhooks' })"
      >Back to webhooks</button>
    </div>

    <!-- P0-C2: cold-load skeleton. -->
    <LoadingSkeleton
      v-else-if="!initialLoadDone && !error"
      data-testid="webhook-initial-loading"
    />

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
            <button
              @click="runTest"
              :disabled="webhookOperationBusy"
              :title="webhookOperationBusy ? sendTestBusyReason : undefined"
              :aria-describedby="webhookOperationBusy ? 'webhook-operation-busy-reason' : undefined"
              class="btn-pill-secondary disabled:opacity-50 disabled:cursor-not-allowed"
            >{{ testLoading ? 'Testing...' : 'Send Test' }}</button>
            <span
              v-if="webhookOperationBusy"
              id="webhook-operation-busy-reason"
              class="sr-only"
            >{{ sendTestBusyReason }}</span>
            <RowActionsMenu
              aria-label="More webhook actions"
              trigger-label="More actions"
              :items="[
                { label: 'Edit', onClick: openEdit, disabled: webhookOperationBusy, disabledReason: operationBusyReason },
                { label: 'Rotate Secret', onClick: openRotate, disabled: webhookOperationBusy, disabledReason: operationBusyReason },
                { label: 'Replay', onClick: openReplay, disabled: webhookOperationBusy, disabledReason: operationBusyReason },
                { label: 'Copy as JSON', onClick: () => copySubscriptionJson() },
                { label: 'Reset & Re-enable', onClick: () => requestStatusAction('reset'), disabled: webhookOperationBusy, disabledReason: operationBusyReason, hidden: !((webhook.consecutive_failures ?? 0) > 0 && webhook.status !== 'ACTIVE') },
                { label: 'Enable', onClick: () => requestStatusAction('ACTIVE'), disabled: webhookOperationBusy, disabledReason: operationBusyReason, hidden: webhook.status !== 'DISABLED' && webhook.status !== 'PAUSED' },
                { separator: true },
                { label: 'Pause', onClick: () => requestStatusAction('PAUSED'), disabled: webhookOperationBusy, disabledReason: operationBusyReason, danger: true, hidden: webhook.status !== 'ACTIVE' },
                { label: 'Delete', onClick: openDelete, disabled: webhookOperationBusy, disabledReason: operationBusyReason, danger: true },
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
        <button type="button" @click="dismissReplayResult" aria-label="Dismiss replay notification" class="text-blue-500 hover:text-blue-800 cursor-pointer shrink-0">✕</button>
      </div>

      <!-- v0.1.25.51 — Per-subscription delivery stats. 4-up grid:
             • Time since last success (chip, green/amber/red)
             • Delivery outcome donut (SUCCESS/FAILED/RETRYING/PENDING) —
                 click → sets the status filter on the history table below
             • Attempts histogram — long tail in 4/5+ = retry storm
             • Response-time p50 / p95 / max (text stats, not a chart,
                 because fighting over bucket widths on a variable-size
                 cursor page gives p50/p95 better signal)
           All metrics are client-side reductions over the already-
           fetched `deliveries` page — no new requests. Hidden when
           the page has no deliveries yet. -->
      <div v-if="deliveries.length > 0" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4" data-testid="webhook-delivery-stats">
        <!-- Time-since-last-success chip. Traffic-light semantics
             match PagerDuty / Grafana convention so operators don't
             have to re-learn the palette. Tooltip reveals the exact
             timestamp for audit traceability. -->
        <div
          class="card p-3 flex flex-col justify-between"
          data-testid="webhook-last-success-band"
        >
          <div class="text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Last successful delivery</div>
          <div
            class="inline-flex items-center gap-2 text-sm"
            :title="lastSuccessBand.detail"
          >
            <span
              class="inline-block w-3 h-3 rounded-full shrink-0"
              :class="{
                'bg-green-500': lastSuccessBand.band === 'green',
                'bg-yellow-500': lastSuccessBand.band === 'amber',
                'bg-red-500': lastSuccessBand.band === 'red',
                'bg-gray-400': lastSuccessBand.band === 'unknown',
              }"
              aria-hidden="true"
            />
            <span
              :class="{
                'text-green-700 dark:text-green-400': lastSuccessBand.band === 'green',
                'text-yellow-700 dark:text-yellow-400': lastSuccessBand.band === 'amber',
                'text-red-700 dark:text-red-400': lastSuccessBand.band === 'red',
                'muted': lastSuccessBand.band === 'unknown',
              }"
            >{{ lastSuccessBand.label }}</span>
          </div>
        </div>

        <!-- Delivery outcome donut. Click a slice to narrow the history
             table below to that status — mirrors the Overview donut
             drill-down pattern, but stays on-page since the filter is
             local state rather than a separate route. -->
        <div
          v-if="deliveryOutcomeOption.series[0].data.length > 0"
          class="card p-3"
          data-testid="webhook-delivery-outcome-donut"
        >
          <div class="text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
            Delivery outcome
            <span class="muted text-xs font-normal">· click a slice</span>
          </div>
          <BaseChart
            :option="deliveryOutcomeOption"
            label="Delivery outcome donut chart — clickable"
            height="160px"
            @slice-click="onDeliveryOutcomeClick"
          />
        </div>

        <!-- Attempts histogram. Tiny bar chart over the number of
             attempts it took each delivery to settle. A long tail
             in 4 / 5+ means a retry storm — a flag that the
             endpoint is flaky or that disable_after_failures is
             too lenient. Color ramp mirrors severity. -->
        <div
          v-if="attemptsBuckets.length > 0"
          class="card p-3"
          data-testid="webhook-attempts-histogram"
        >
          <div class="text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Attempts per delivery</div>
          <BaseChart
            :option="attemptsChartOption"
            label="Attempts histogram bar chart"
            height="160px"
          />
        </div>

        <!-- Response-time stats. Text stats instead of a chart:
             p50/p95/max on a cursor page give sharper signal than a
             histogram with fighting bucket widths. Only counts
             deliveries where response_time_ms is set (i.e. the
             endpoint responded at least once). -->
        <div
          class="card p-3 flex flex-col"
          data-testid="webhook-response-time-stats"
        >
          <div class="text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Response time</div>
          <div v-if="responseStats.count > 0" class="space-y-1 text-sm">
            <div class="flex justify-between"><span class="muted">p50</span><span class="tabular-nums font-medium">{{ responseStats.p50 }} ms</span></div>
            <div class="flex justify-between"><span class="muted">p95</span><span class="tabular-nums font-medium">{{ responseStats.p95 }} ms</span></div>
            <div class="flex justify-between"><span class="muted">max</span><span class="tabular-nums font-medium">{{ responseStats.max }} ms</span></div>
            <div class="muted-sm pt-1">over {{ responseStats.count }} delivery{{ responseStats.count === 1 ? '' : 'ies' }}</div>
          </div>
          <div v-else class="text-sm muted">No timed responses yet</div>
        </div>
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
      <div class="bg-white rounded-lg shadow overflow-hidden text-sm" role="table" :aria-rowcount="filteredDeliveries.length + 1" :aria-colcount="7" :aria-busy="deliveryFilterLoading">
        <div class="table-cell border-b border-gray-100 space-y-2">
          <h3 class="text-sm font-medium text-gray-700">Delivery History</h3>
          <div class="flex items-center gap-x-3 gap-y-2 flex-wrap">
            <span class="muted-sm tabular-nums" role="status" aria-live="polite" aria-atomic="true">
              <template v-if="deliveryFilterLoading">Updating delivery history…</template>
              <template v-else>
                {{ filteredDeliveries.length.toLocaleString() }} loaded
                <span v-if="deliveriesHasMore" class="text-amber-600 ml-1">(more available)</span>
              </template>
            </span>
            <span class="flex-1" />
            <select v-model="deliveryStatusFilter" aria-label="Filter deliveries by status" class="form-select">
              <option value="">All statuses</option>
              <option>PENDING</option>
              <option>SUCCESS</option>
              <option>FAILED</option>
              <option>RETRYING</option>
            </select>
            <button @click="confirmExport('csv')" :disabled="!canExport" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">
              <DownloadIcon class="w-3.5 h-3.5" />
              Export CSV
            </button>
            <button @click="confirmExport('json')" :disabled="!canExport" class="inline-flex items-center gap-1 muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">
              <DownloadIcon class="w-3.5 h-3.5" />
              Export JSON
            </button>
          </div>
        </div>

        <div class="overflow-x-auto overflow-y-hidden">
        <div style="min-width: 882px" class="wide-table-canvas">
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
          class="overflow-y-auto overflow-x-hidden max-h-[60vh] min-h-[200px]"
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
        </div>
        </div>

        <div v-if="!deliveryFilterLoading && sortedDeliveries.length === 0" class="responsive-table-state">
          <EmptyState
            item-noun="delivery"
            :has-active-filter="!!deliveryStatusFilter"
            :hint="deliveryStatusFilter ? undefined : 'Deliveries will appear here once events are dispatched.'"
          />
        </div>
      </div>

      <div v-if="deliveriesHasMore || deliveriesLoadingMore" class="mt-3 flex justify-end">
        <button
          @click="loadMoreDeliveries"
          :disabled="deliveriesLoadingMore || !deliveryContinuationUsable"
          :title="!deliveryContinuationUsable ? 'The server did not provide a continuation cursor.' : undefined"
          class="text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
        >
          {{ deliveriesLoadingMore ? 'Loading…' : 'Load more' }}
        </button>
      </div>
    </template>

    <ConfirmAction
      v-if="pendingStatusAction === 'PAUSED'"
      title="Pause this webhook?"
      :message="`Pausing will stop all event deliveries to '${webhook?.url}'. Events that occur while paused are not queued and will be silently dropped.`"
      confirm-label="Pause Webhook"
      :danger="true"
      :loading="statusActionLoading"
      :error="statusActionError"
      @confirm="executeStatusAction"
      @cancel="cancelStatusAction"
    />

    <ConfirmAction
      v-if="pendingStatusAction === 'ACTIVE'"
      title="Enable this webhook?"
      :message="`Re-enabling will resume event deliveries to '${webhook?.url}'. Events that occurred while paused/disabled are not retroactively delivered.`"
      confirm-label="Enable Webhook"
      :loading="statusActionLoading"
      :error="statusActionError"
      @confirm="executeStatusAction"
      @cancel="cancelStatusAction"
    />

    <ConfirmAction
      v-if="pendingStatusAction === 'reset'"
      title="Reset and re-enable?"
      :message="`This will re-enable the webhook and reset the consecutive failure count to 0 for '${webhook?.url}'. Delivery attempts will resume immediately.`"
      confirm-label="Reset &amp; Re-enable"
      :loading="statusActionLoading"
      :error="statusActionError"
      @confirm="executeStatusAction"
      @cancel="cancelStatusAction"
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
      @cancel="cancelDelete"
    />

    <FormDialog
      v-if="showReplay"
      title="Replay Events"
      submit-label="Start Replay"
      :loading="replayLoading"
      :error="replayError"
      :submit-disabled="!canSubmitReplay"
      @submit="submitReplay"
      @cancel="cancelReplay"
    >
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
        <input
          id="rp-max"
          v-model="replayForm.max_events"
          type="number"
          min="1"
          max="1000"
          class="border border-gray-300 rounded px-2 py-1.5 text-sm w-32"
          :aria-invalid="!!replayMaxEventsError || undefined"
          aria-describedby="rp-max-error"
        />
        <p v-if="replayMaxEventsError" id="rp-max-error" class="text-xs text-red-600 mt-0.5" role="alert">{{ replayMaxEventsError }}</p>
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
      @cancel="cancelRotate"
    />

    <SecretReveal v-if="rotatedSecret" title="New Signing Secret" :secret="rotatedSecret" label="Signing Secret" @close="closeRotatedSecret" />

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
      @cancel="cancelDeliveryExport"
    />

    <WebhookEditDialog
      v-if="showEdit"
      :loading="editLoading"
      :error="editError"
      :metadata-error="editMetadataError"
      :form="editForm"
      :advanced="editAdvanced"
      :advanced-has-config="editAdvancedHasConfig"
      :event-types="editEventTypes"
      :event-categories="editEventCategories"
      :tenant-owned="isTenantOwned"
      :hidden-legacy-selector-count="hiddenLegacySelectorCount"
      :webhook="webhook"
      @submit="submitEdit"
      @cancel="cancelEdit"
    />
  </div>
</template>

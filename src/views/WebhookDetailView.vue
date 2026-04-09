<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { getWebhook, listDeliveries, updateWebhook, deleteWebhook, testWebhook, replayWebhookEvents } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { WebhookSubscription, WebhookDelivery, WebhookTestResponse } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import TenantLink from '../components/TenantLink.vue'
import EmptyState from '../components/EmptyState.vue'
import ConfirmAction from '../components/ConfirmAction.vue'
import FormDialog from '../components/FormDialog.vue'
import { useToast } from '../composables/useToast'

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
  } catch (e: any) { error.value = e.message }
  finally { pendingAction.value = null }
}

// Delete webhook
const pendingDelete = ref(false)
async function executeDelete() {
  try {
    await deleteWebhook(id)
    toast.success('Webhook deleted')
    router.push('/webhooks')
  } catch (e: any) { error.value = e.message; pendingDelete.value = false }
}

// Test webhook
const testResult = ref<WebhookTestResponse | null>(null)
const testLoading = ref(false)
async function runTest() {
  testLoading.value = true
  testResult.value = null
  try {
    testResult.value = await testWebhook(id)
  } catch (e: any) { error.value = e.message }
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
  replayLoading.value = true
  try {
    const body: Record<string, unknown> = {}
    if (replayForm.value.from) body.from = new Date(replayForm.value.from).toISOString()
    if (replayForm.value.to) body.to = new Date(replayForm.value.to).toISOString()
    if (replayForm.value.max_events) body.max_events = Number(replayForm.value.max_events)
    const res = await replayWebhookEvents(id, body as any)
    replayResult.value = `${res.events_queued} events queued for replay`
    showReplay.value = false
    setTimeout(() => { replayResult.value = null }, 5000)
  } catch (e: any) { replayError.value = e.message }
  finally { replayLoading.value = false }
}

const { refresh, isLoading, lastUpdated } = usePolling(async () => {
  try {
    webhook.value = await getWebhook(id)
    const res = await listDeliveries(id)
    deliveries.value = res.deliveries
    error.value = ''
  } catch (e: any) { error.value = e.message }
}, 30000)
</script>

<template>
  <div>
    <PageHeader title="Webhook Detail" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh">
      <template #back>
        <button @click="router.push('/webhooks')" aria-label="Back to webhooks" class="text-gray-400 hover:text-gray-700 cursor-pointer">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
        </button>
      </template>
    </PageHeader>
    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">{{ error }}</p>
    <template v-if="webhook">
      <div class="bg-white rounded-lg shadow p-6 mb-4">
        <div class="flex items-center gap-3 mb-4 flex-wrap">
          <h2 class="text-lg font-medium text-gray-900">{{ webhook.name || webhook.subscription_id }}</h2>
          <StatusBadge :status="webhook.status" />
          <span v-if="(webhook.consecutive_failures ?? 0) > 0" class="bg-red-100 text-red-700 px-2 py-0.5 rounded text-xs font-medium">{{ webhook.consecutive_failures }} failures</span>
          <span class="flex-1" />
          <div v-if="canManage" class="flex gap-2 flex-wrap">
            <button @click="runTest" :disabled="testLoading" class="text-xs text-gray-600 hover:text-gray-800 border border-gray-200 rounded px-2.5 py-1 hover:bg-gray-100 cursor-pointer transition-colors disabled:opacity-50">{{ testLoading ? 'Testing...' : 'Send Test' }}</button>
            <button @click="showReplay = true" class="text-xs text-gray-600 hover:text-gray-800 border border-gray-200 rounded px-2.5 py-1 hover:bg-gray-100 cursor-pointer transition-colors">Replay</button>
            <button v-if="(webhook.consecutive_failures ?? 0) > 0 && webhook.status !== 'ACTIVE'" @click="pendingAction = 'reset'" class="text-xs text-blue-600 hover:text-blue-800 border border-blue-200 rounded px-2.5 py-1 hover:bg-blue-50 cursor-pointer transition-colors">Reset &amp; Re-enable</button>
            <button v-if="webhook.status === 'ACTIVE'" @click="pendingAction = 'PAUSED'" class="text-xs text-red-600 hover:text-red-800 border border-red-200 rounded px-2.5 py-1 hover:bg-red-50 cursor-pointer transition-colors">Pause</button>
            <button v-if="webhook.status === 'DISABLED' || webhook.status === 'PAUSED'" @click="pendingAction = 'ACTIVE'" class="text-xs text-green-700 hover:text-green-900 border border-green-200 rounded px-2.5 py-1 hover:bg-green-50 cursor-pointer transition-colors">Enable</button>
            <button @click="pendingDelete = true" class="text-xs text-red-600 hover:text-red-800 border border-red-200 rounded px-2.5 py-1 hover:bg-red-50 cursor-pointer transition-colors">Delete</button>
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <div class="bg-gray-50 rounded p-3"><span class="text-gray-500 block text-xs mb-1">URL</span><span class="font-mono text-xs break-all">{{ webhook.url }}</span></div>
          <div class="bg-gray-50 rounded p-3"><span class="text-gray-500 block text-xs mb-1">Tenant</span><TenantLink :tenant-id="webhook.tenant_id" /></div>
          <div class="bg-gray-50 rounded p-3"><span class="text-gray-500 block text-xs mb-1">Events</span><span class="text-xs">{{ webhook.event_types?.join(', ') || 'all' }}</span></div>
          <div v-if="webhook.scope_filter" class="bg-gray-50 rounded p-3"><span class="text-gray-500 block text-xs mb-1">Scope Filter</span><span class="font-mono text-xs">{{ webhook.scope_filter }}</span></div>
          <div v-if="webhook.last_success_at" class="bg-gray-50 rounded p-3"><span class="text-gray-500 block text-xs mb-1">Last Success</span>{{ formatDateTime(webhook.last_success_at) }}</div>
          <div v-if="webhook.last_failure_at" class="bg-gray-50 rounded p-3"><span class="text-gray-500 block text-xs mb-1">Last Failure</span>{{ formatDateTime(webhook.last_failure_at) }}</div>
        </div>
      </div>

      <!-- Test result -->
      <div v-if="testResult" class="mb-4 px-4 py-3 rounded-lg text-sm" :class="testResult.success ? 'bg-green-50 border border-green-200 text-green-700' : 'bg-red-50 border border-red-200 text-red-700'">
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
      <div v-if="replayResult" class="mb-4 px-4 py-3 rounded-lg text-sm bg-blue-50 border border-blue-200 text-blue-700">{{ replayResult }}</div>

      <div class="bg-white rounded-lg shadow overflow-hidden overflow-x-auto">
        <div class="px-4 py-3 border-b border-gray-100 flex justify-between items-center">
          <h3 class="text-sm font-medium text-gray-700">Delivery History</h3>
          <span class="text-xs text-gray-400">{{ deliveries.length }} deliveries</span>
        </div>
        <table class="w-full text-sm min-w-[600px]">
          <thead class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
            <tr>
              <th class="px-4 py-3 text-left">Status</th>
              <th class="px-4 py-3 text-left">HTTP Code</th>
              <th class="px-4 py-3 text-right">Attempts</th>
              <th class="px-4 py-3 text-left">Event ID</th>
              <th class="px-4 py-3 text-left">Time</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="d in deliveries" :key="d.delivery_id" class="hover:bg-gray-50 transition-colors">
              <td class="px-4 py-3"><StatusBadge :status="d.status" /></td>
              <td class="px-4 py-3 font-mono text-xs" :class="d.http_status && d.http_status >= 400 ? 'text-red-600' : 'text-gray-500'">{{ d.http_status || '-' }}</td>
              <td class="px-4 py-3 text-right text-gray-500 tabular-nums">{{ d.attempts }}</td>
              <td class="px-4 py-3 font-mono text-xs text-gray-400">{{ d.event_id }}</td>
              <td class="px-4 py-3 text-gray-400 text-xs">{{ formatDateTime(d.created_at) }}</td>
            </tr>
            <tr v-if="deliveries.length === 0">
              <td colspan="5"><EmptyState message="No deliveries yet" hint="Deliveries will appear here once events are dispatched" /></td>
            </tr>
          </tbody>
        </table>
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
      @confirm="executeDelete"
      @cancel="pendingDelete = false"
    />

    <FormDialog v-if="showReplay" title="Replay Events" submit-label="Start Replay" :loading="replayLoading" :error="replayError" @submit="submitReplay" @cancel="showReplay = false">
      <p class="text-xs text-gray-500">Re-delivers historical events to this webhook. May cause duplicate deliveries.</p>
      <div>
        <label for="rp-from" class="block text-xs text-gray-500 mb-1">From</label>
        <input id="rp-from" v-model="replayForm.from" type="datetime-local" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full" />
      </div>
      <div>
        <label for="rp-to" class="block text-xs text-gray-500 mb-1">To</label>
        <input id="rp-to" v-model="replayForm.to" type="datetime-local" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full" />
      </div>
      <div>
        <label for="rp-max" class="block text-xs text-gray-500 mb-1">Max events (1–1000)</label>
        <input id="rp-max" v-model="replayForm.max_events" type="number" min="1" max="1000" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-32" />
      </div>
    </FormDialog>
  </div>
</template>

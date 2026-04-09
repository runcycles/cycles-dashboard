<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { getWebhook, listDeliveries, updateWebhook } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { WebhookSubscription, WebhookDelivery } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import TenantLink from '../components/TenantLink.vue'
import EmptyState from '../components/EmptyState.vue'
import ConfirmAction from '../components/ConfirmAction.vue'
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
  } catch (e: any) { error.value = e.message }
  finally { pendingAction.value = null }
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
          <div v-if="canManage" class="flex gap-2">
            <button v-if="(webhook.consecutive_failures ?? 0) > 0 && webhook.status !== 'ACTIVE'" @click="pendingAction = 'reset'" class="text-xs text-blue-600 hover:text-blue-800 border border-blue-200 rounded px-2.5 py-1 hover:bg-blue-50 cursor-pointer transition-colors">Reset &amp; Re-enable</button>
            <button v-if="webhook.status === 'ACTIVE'" @click="pendingAction = 'PAUSED'" class="text-xs text-red-600 hover:text-red-800 border border-red-200 rounded px-2.5 py-1 hover:bg-red-50 cursor-pointer transition-colors">Pause</button>
            <button v-if="webhook.status === 'DISABLED' || webhook.status === 'PAUSED'" @click="pendingAction = 'ACTIVE'" class="text-xs text-green-700 hover:text-green-900 border border-green-200 rounded px-2.5 py-1 hover:bg-green-50 cursor-pointer transition-colors">Enable</button>
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
  </div>
</template>

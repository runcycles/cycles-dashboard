<script setup lang="ts">
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { getWebhook, listDeliveries } from '../api/client'
import type { WebhookSubscription, WebhookDelivery } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import RefreshButton from '../components/RefreshButton.vue'

const route = useRoute()
const id = route.params.id as string

const webhook = ref<WebhookSubscription | null>(null)
const deliveries = ref<WebhookDelivery[]>([])
const error = ref('')

const { refresh, isLoading } = usePolling(async () => {
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
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-semibold text-gray-900">Webhook Detail</h1>
      <RefreshButton :loading="isLoading" @click="refresh" />
    </div>
    <p v-if="error" class="text-red-600 text-sm mb-4">{{ error }}</p>
    <template v-if="webhook">
      <div class="bg-white rounded-lg shadow p-6 mb-4">
        <div class="flex items-center gap-3 mb-4">
          <h2 class="text-lg font-medium text-gray-900">{{ webhook.name || webhook.subscription_id }}</h2>
          <StatusBadge :status="webhook.status" />
        </div>
        <div class="grid grid-cols-2 gap-3 text-sm">
          <div><span class="text-gray-500">URL:</span> {{ webhook.url }}</div>
          <div><span class="text-gray-500">Tenant:</span> {{ webhook.tenant_id }}</div>
          <div><span class="text-gray-500">Failures:</span> <span :class="(webhook.consecutive_failures ?? 0) > 0 ? 'text-red-600' : ''">{{ webhook.consecutive_failures ?? 0 }}</span></div>
          <div v-if="webhook.scope_filter"><span class="text-gray-500">Scope filter:</span> {{ webhook.scope_filter }}</div>
          <div><span class="text-gray-500">Events:</span> {{ webhook.event_types?.join(', ') || 'all' }}</div>
          <div v-if="webhook.last_success_at"><span class="text-gray-500">Last success:</span> {{ new Date(webhook.last_success_at).toLocaleString() }}</div>
          <div v-if="webhook.last_failure_at"><span class="text-gray-500">Last failure:</span> {{ new Date(webhook.last_failure_at).toLocaleString() }}</div>
        </div>
      </div>
      <div class="bg-white rounded-lg shadow overflow-hidden">
        <h3 class="text-sm font-medium text-gray-700 px-4 py-3 border-b border-gray-100">Delivery History</h3>
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-gray-500 text-xs uppercase">
            <tr>
              <th class="px-4 py-3 text-left">Status</th>
              <th class="px-4 py-3 text-left">HTTP Code</th>
              <th class="px-4 py-3 text-left">Attempts</th>
              <th class="px-4 py-3 text-left">Event ID</th>
              <th class="px-4 py-3 text-left">Time</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in deliveries" :key="d.delivery_id" class="border-t border-gray-100">
              <td class="px-4 py-3"><StatusBadge :status="d.status" /></td>
              <td class="px-4 py-3 text-gray-500">{{ d.http_status || '-' }}</td>
              <td class="px-4 py-3 text-gray-500">{{ d.attempts }}</td>
              <td class="px-4 py-3 font-mono text-xs text-gray-500">{{ d.event_id }}</td>
              <td class="px-4 py-3 text-gray-400">{{ new Date(d.created_at).toLocaleString() }}</td>
            </tr>
            <tr v-if="deliveries.length === 0">
              <td colspan="5" class="px-4 py-8 text-center text-gray-400">No deliveries</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

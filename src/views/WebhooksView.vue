<script setup lang="ts">
import { ref } from 'vue'
import { usePolling } from '../composables/usePolling'
import { useSort } from '../composables/useSort'
import { listWebhooks } from '../api/client'
import type { WebhookSubscription } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'

const webhooks = ref<WebhookSubscription[]>([])
const error = ref('')
const { sortKey, sortDir, toggle, sorted: sortedWebhooks } = useSort(webhooks)

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

const { refresh, isLoading, lastUpdated } = usePolling(async () => {
  try {
    const res = await listWebhooks()
    webhooks.value = res.subscriptions
    error.value = ''
  } catch (e: any) { error.value = e.message }
}, 60000)
</script>

<template>
  <div>
    <PageHeader title="Webhooks" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh" />
    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">{{ error }}</p>
    <div class="bg-white rounded-lg shadow overflow-hidden overflow-x-auto">
      <table class="w-full text-sm min-w-[600px]">
        <thead class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
          <tr>
            <th class="px-4 py-3 text-left w-10">Health</th>
            <SortHeader label="URL" column="url" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Status" column="status" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Failures" column="consecutive_failures" :active-column="sortKey" :direction="sortDir" @sort="toggle" align="right" />
            <th class="px-4 py-3 text-left">Events</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="w in sortedWebhooks" :key="w.subscription_id" class="hover:bg-gray-50 transition-colors">
            <td class="px-4 py-3"><span :class="healthColor(w)" class="inline-block w-2.5 h-2.5 rounded-full" :title="healthLabel(w)" /></td>
            <td class="px-4 py-3">
              <router-link :to="{ name: 'webhook-detail', params: { id: w.subscription_id } }" class="text-blue-600 hover:underline truncate block max-w-[300px]">{{ w.url }}</router-link>
              <span v-if="w.name" class="text-xs text-gray-400">{{ w.name }}</span>
            </td>
            <td class="px-4 py-3"><StatusBadge :status="w.status" /></td>
            <td class="px-4 py-3 text-right tabular-nums" :class="(w.consecutive_failures ?? 0) > 0 ? 'text-red-600 font-medium' : 'text-gray-400'">{{ w.consecutive_failures ?? 0 }}</td>
            <td class="px-4 py-3 text-xs text-gray-500">{{ w.event_types?.join(', ') || w.event_categories?.join(', ') || 'all' }}</td>
          </tr>
          <tr v-if="webhooks.length === 0">
            <td colspan="5"><EmptyState message="No webhook subscriptions" hint="Webhook subscriptions will appear here once configured" /></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

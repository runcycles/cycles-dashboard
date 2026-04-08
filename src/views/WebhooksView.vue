<script setup lang="ts">
import { ref } from 'vue'
import { usePolling } from '../composables/usePolling'
import { listWebhooks } from '../api/client'
import type { WebhookSubscription } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import RefreshButton from '../components/RefreshButton.vue'

const webhooks = ref<WebhookSubscription[]>([])
const error = ref('')

function healthColor(w: WebhookSubscription): string {
  if (w.status === 'DISABLED') return 'bg-red-500'
  if ((w.consecutive_failures ?? 0) >= 1) return 'bg-yellow-500'
  return 'bg-green-500'
}

const { refresh, isLoading } = usePolling(async () => {
  try {
    const res = await listWebhooks()
    webhooks.value = res.subscriptions
    error.value = ''
  } catch (e: any) { error.value = e.message }
}, 60000)
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-semibold text-gray-900">Webhooks</h1>
      <RefreshButton :loading="isLoading" @click="refresh" />
    </div>
    <p v-if="error" class="text-red-600 text-sm mb-4">{{ error }}</p>
    <div class="bg-white rounded-lg shadow overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 text-gray-500 text-xs uppercase">
          <tr>
            <th class="px-4 py-3 text-left">Health</th>
            <th class="px-4 py-3 text-left">URL</th>
            <th class="px-4 py-3 text-left">Status</th>
            <th class="px-4 py-3 text-left">Failures</th>
            <th class="px-4 py-3 text-left">Events</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="w in webhooks" :key="w.subscription_id" class="border-t border-gray-100 hover:bg-gray-50">
            <td class="px-4 py-3"><span :class="healthColor(w)" class="inline-block w-2.5 h-2.5 rounded-full" /></td>
            <td class="px-4 py-3">
              <router-link :to="{ name: 'webhook-detail', params: { id: w.subscription_id } }" class="text-blue-600 hover:underline truncate block max-w-[300px]">{{ w.url }}</router-link>
              <span v-if="w.name" class="text-xs text-gray-400">{{ w.name }}</span>
            </td>
            <td class="px-4 py-3"><StatusBadge :status="w.status" /></td>
            <td class="px-4 py-3" :class="(w.consecutive_failures ?? 0) > 0 ? 'text-red-600' : 'text-gray-500'">{{ w.consecutive_failures ?? 0 }}</td>
            <td class="px-4 py-3 text-xs text-gray-500">{{ w.event_types?.join(', ') || w.event_categories?.join(', ') || 'all' }}</td>
          </tr>
          <tr v-if="webhooks.length === 0">
            <td colspan="5" class="px-4 py-8 text-center text-gray-400">No webhooks found</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

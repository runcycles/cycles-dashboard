<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { listEvents } from '../api/client'
import type { Event } from '../types'
import RefreshButton from '../components/RefreshButton.vue'

const route = useRoute()
const router = useRouter()

const events = ref<Event[]>([])
const hasMore = ref(false)
const error = ref('')
const expanded = ref<string | null>(null)

// Filters from query
const category = ref((route.query.category as string) || '')
const eventType = ref((route.query.type as string) || '')
const tenantId = ref((route.query.tenant_id as string) || '')
const scope = ref((route.query.scope as string) || '')
const correlationId = ref((route.query.correlation_id as string) || '')

async function load() {
  try {
    const params: Record<string, string> = {}
    if (category.value) params.category = category.value
    if (eventType.value) params.event_type = eventType.value
    if (tenantId.value) params.tenant_id = tenantId.value
    if (scope.value) params.scope = scope.value
    if (correlationId.value) params.correlation_id = correlationId.value
    const res = await listEvents(params)
    events.value = res.events
    hasMore.value = res.has_more
    error.value = ''
  } catch (e: any) { error.value = e.message }
}

function applyFilters() {
  router.replace({ query: {
    ...(category.value && { category: category.value }),
    ...(eventType.value && { type: eventType.value }),
    ...(tenantId.value && { tenant_id: tenantId.value }),
    ...(scope.value && { scope: scope.value }),
    ...(correlationId.value && { correlation_id: correlationId.value }),
  }})
  load()
}

function viewCorrelated(cid: string) {
  correlationId.value = cid
  applyFilters()
}

const { refresh, isLoading } = usePolling(load, 15000)
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-semibold text-gray-900">Events</h1>
      <RefreshButton :loading="isLoading" @click="refresh" />
    </div>

    <p v-if="error" class="text-red-600 text-sm mb-4">{{ error }}</p>

    <!-- Filters -->
    <div class="flex gap-3 mb-4 flex-wrap items-end">
      <div>
        <label class="block text-xs text-gray-500 mb-1">Category</label>
        <select v-model="category" class="border border-gray-300 rounded px-2 py-1.5 text-sm">
          <option value="">All</option>
          <option>budget</option><option>reservation</option><option>tenant</option>
          <option>api_key</option><option>policy</option><option>system</option>
        </select>
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">Tenant ID</label>
        <input v-model="tenantId" placeholder="tenant id" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-32" />
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">Scope</label>
        <input v-model="scope" placeholder="scope prefix" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-40" />
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">Correlation ID</label>
        <input v-model="correlationId" placeholder="correlation_id" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-40" />
      </div>
      <button @click="applyFilters" class="bg-gray-900 text-white px-3 py-1.5 rounded text-sm hover:bg-gray-800">Filter</button>
    </div>

    <!-- Event table -->
    <div class="bg-white rounded-lg shadow overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 text-gray-500 text-xs uppercase">
          <tr>
            <th class="px-4 py-3 text-left">Type</th>
            <th class="px-4 py-3 text-left">Category</th>
            <th class="px-4 py-3 text-left">Scope</th>
            <th class="px-4 py-3 text-left">Tenant</th>
            <th class="px-4 py-3 text-left">Time</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="e in events" :key="e.event_id">
            <tr class="border-t border-gray-100 hover:bg-gray-50 cursor-pointer" @click="expanded = expanded === e.event_id ? null : e.event_id">
              <td class="px-4 py-3 font-mono text-xs">{{ e.event_type }}</td>
              <td class="px-4 py-3 text-gray-500">{{ e.category }}</td>
              <td class="px-4 py-3 text-gray-700 truncate max-w-[200px]">{{ e.scope || '-' }}</td>
              <td class="px-4 py-3">
                <router-link v-if="e.tenant_id" :to="{ name: 'tenant-detail', params: { id: e.tenant_id } }" class="text-blue-600 hover:underline" @click.stop>{{ e.tenant_id }}</router-link>
              </td>
              <td class="px-4 py-3 text-gray-400 whitespace-nowrap">{{ new Date(e.timestamp).toLocaleString() }}</td>
            </tr>
            <!-- Expanded detail -->
            <tr v-if="expanded === e.event_id" class="bg-gray-50">
              <td colspan="5" class="px-4 py-3">
                <div class="grid grid-cols-2 gap-2 text-xs mb-2">
                  <div><span class="text-gray-500">Event ID:</span> {{ e.event_id }}</div>
                  <div><span class="text-gray-500">Source:</span> {{ e.source }}</div>
                  <div v-if="e.request_id"><span class="text-gray-500">Request ID:</span> {{ e.request_id }}</div>
                  <div v-if="e.correlation_id">
                    <span class="text-gray-500">Correlation ID:</span>
                    <button @click.stop="viewCorrelated(e.correlation_id!)" class="text-blue-600 hover:underline ml-1">{{ e.correlation_id }}</button>
                  </div>
                  <div v-if="e.actor"><span class="text-gray-500">Actor:</span> {{ e.actor.type }} {{ e.actor.key_id || '' }}</div>
                </div>
                <div v-if="e.data" class="bg-gray-100 rounded p-2 text-xs font-mono overflow-auto max-h-40">
                  <pre>{{ JSON.stringify(e.data, null, 2) }}</pre>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="events.length === 0">
            <td colspan="5" class="px-4 py-8 text-center text-gray-400">No events found</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

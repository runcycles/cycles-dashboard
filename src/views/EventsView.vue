<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { listEvents } from '../api/client'
import type { Event } from '../types'
import PageHeader from '../components/PageHeader.vue'

const route = useRoute()
const router = useRouter()

const events = ref<Event[]>([])
const hasMore = ref(false)
const error = ref('')
const expanded = ref<string | null>(null)

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

function clearFilters() {
  category.value = ''; eventType.value = ''; tenantId.value = ''; scope.value = ''; correlationId.value = ''
  applyFilters()
}

const hasActiveFilters = computed(() => !!(category.value || eventType.value || tenantId.value || scope.value || correlationId.value))

const { refresh, isLoading } = usePolling(load, 15000)
</script>

<template>
  <div>
    <PageHeader title="Events" :loading="isLoading" @refresh="refresh" />

    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">{{ error }}</p>

    <!-- Filters -->
    <form @submit.prevent="applyFilters" class="bg-white rounded-lg shadow p-4 mb-4">
      <div class="flex gap-3 flex-wrap items-end">
        <div>
          <label class="block text-xs text-gray-500 mb-1">Category</label>
          <select v-model="category" class="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white">
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
        <button type="submit" class="bg-gray-900 text-white px-3 py-1.5 rounded text-sm hover:bg-gray-800 cursor-pointer">Filter</button>
        <button v-if="hasActiveFilters" type="button" @click="clearFilters" class="text-sm text-gray-500 hover:text-gray-700 cursor-pointer">Clear</button>
      </div>
    </form>

    <!-- Results count -->
    <p v-if="events.length > 0" class="text-xs text-gray-400 mb-2">{{ events.length }} events{{ hasMore ? ' (more available)' : '' }}</p>

    <!-- Event table -->
    <div class="bg-white rounded-lg shadow overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
          <tr>
            <th class="w-8"></th>
            <th class="px-4 py-3 text-left">Type</th>
            <th class="px-4 py-3 text-left">Category</th>
            <th class="px-4 py-3 text-left">Scope</th>
            <th class="px-4 py-3 text-left">Tenant</th>
            <th class="px-4 py-3 text-left">Time</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <template v-for="e in events" :key="e.event_id">
            <tr class="hover:bg-gray-50 cursor-pointer transition-colors" @click="expanded = expanded === e.event_id ? null : e.event_id">
              <td class="pl-3 py-3 text-gray-400">
                <svg class="w-3.5 h-3.5 transition-transform" :class="expanded === e.event_id ? 'rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </td>
              <td class="px-4 py-3 font-mono text-xs">{{ e.event_type }}</td>
              <td class="px-4 py-3"><span class="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-xs">{{ e.category }}</span></td>
              <td class="px-4 py-3 text-gray-700 truncate max-w-[200px] font-mono text-xs">{{ e.scope || '-' }}</td>
              <td class="px-4 py-3">
                <router-link v-if="e.tenant_id" :to="{ name: 'tenant-detail', params: { id: e.tenant_id } }" class="text-blue-600 hover:underline text-xs" @click.stop>{{ e.tenant_id }}</router-link>
              </td>
              <td class="px-4 py-3 text-gray-400 whitespace-nowrap text-xs">{{ new Date(e.timestamp).toLocaleString() }}</td>
            </tr>
            <tr v-if="expanded === e.event_id" class="bg-gray-50/70">
              <td colspan="6" class="px-4 py-3 pl-11">
                <div class="grid grid-cols-2 gap-x-6 gap-y-1 text-xs mb-3">
                  <div><span class="text-gray-400">Event ID:</span> <span class="font-mono">{{ e.event_id }}</span></div>
                  <div><span class="text-gray-400">Source:</span> {{ e.source }}</div>
                  <div v-if="e.request_id"><span class="text-gray-400">Request ID:</span> <span class="font-mono">{{ e.request_id }}</span></div>
                  <div v-if="e.correlation_id">
                    <span class="text-gray-400">Correlation ID:</span>
                    <button @click.stop="viewCorrelated(e.correlation_id!)" class="text-blue-600 hover:underline ml-1 font-mono cursor-pointer">{{ e.correlation_id }}</button>
                  </div>
                  <div v-if="e.actor"><span class="text-gray-400">Actor:</span> {{ e.actor.type }}<span v-if="e.actor.key_id" class="font-mono"> {{ e.actor.key_id }}</span></div>
                </div>
                <div v-if="e.data" class="bg-white border border-gray-200 rounded p-3 text-xs font-mono overflow-auto max-h-40">
                  <pre class="whitespace-pre-wrap">{{ JSON.stringify(e.data, null, 2) }}</pre>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="events.length === 0">
            <td colspan="6" class="px-4 py-12 text-center text-gray-400">
              <template v-if="hasActiveFilters">No events match your filters — <button @click="clearFilters" class="text-blue-600 hover:underline cursor-pointer">clear filters</button></template>
              <template v-else>No events found</template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

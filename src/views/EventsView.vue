<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { useSort } from '../composables/useSort'
import { listEvents } from '../api/client'
import type { Event } from '../types'
import PageHeader from '../components/PageHeader.vue'
import TenantLink from '../components/TenantLink.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import { formatDateTime } from '../utils/format'
import { toMessage } from '../utils/errors'
import { safeJsonStringify } from '../utils/safe'

const route = useRoute()
const router = useRouter()

const events = ref<Event[]>([])
const hasMore = ref(false)
const nextCursor = ref('')
const loadingMore = ref(false)
const error = ref('')
const expanded = ref<string | null>(null)
const { sortKey, sortDir, toggle, sorted: sortedEvents } = useSort(events)

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
    nextCursor.value = res.next_cursor ?? ''
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
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

async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return
  loadingMore.value = true
  try {
    const params: Record<string, string> = { cursor: nextCursor.value }
    if (category.value) params.category = category.value
    if (eventType.value) params.event_type = eventType.value
    if (tenantId.value) params.tenant_id = tenantId.value
    if (scope.value) params.scope = scope.value
    if (correlationId.value) params.correlation_id = correlationId.value
    const res = await listEvents(params)
    events.value = [...events.value, ...res.events]
    hasMore.value = res.has_more
    nextCursor.value = res.next_cursor ?? ''
  } catch (e) { error.value = toMessage(e) }
  finally { loadingMore.value = false }
}

function clearFilters() {
  category.value = ''; eventType.value = ''; tenantId.value = ''; scope.value = ''; correlationId.value = ''
  applyFilters()
}

const hasActiveFilters = computed(() => !!(category.value || eventType.value || tenantId.value || scope.value || correlationId.value))

const { refresh, isLoading, lastUpdated } = usePolling(load, 15000)
</script>

<template>
  <div>
    <PageHeader title="Events" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh" />

    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg table-cell mb-4">{{ error }}</p>

    <!-- Filters -->
    <form @submit.prevent="applyFilters" class="card p-4 mb-4">
      <div class="flex gap-3 flex-wrap items-end">
        <div>
          <label for="ev-category" class="form-label">Category</label>
          <select id="ev-category" v-model="category" class="form-select">
            <option value="">All</option>
            <option>budget</option><option>reservation</option><option>tenant</option>
            <option>api_key</option><option>policy</option><option>system</option>
          </select>
        </div>
        <div>
          <label for="ev-tenant" class="form-label">Tenant ID</label>
          <input id="ev-tenant" v-model="tenantId" placeholder="tenant id" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-32" />
        </div>
        <div>
          <label for="ev-scope" class="form-label">Scope</label>
          <input id="ev-scope" v-model="scope" placeholder="scope prefix" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-40" />
        </div>
        <div>
          <label for="ev-correlation" class="form-label">Correlation ID</label>
          <input id="ev-correlation" v-model="correlationId" placeholder="correlation_id" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-40" />
        </div>
        <button type="submit" class="bg-gray-900 text-white px-3 py-1.5 rounded text-sm hover:bg-gray-800 cursor-pointer">Filter</button>
        <button v-if="hasActiveFilters" type="button" @click="clearFilters" class="text-sm text-gray-600 dark:text-gray-500 hover:text-gray-700 cursor-pointer">Clear</button>
      </div>
    </form>

    <!-- Results count -->
    <p v-if="events.length > 0" class="text-xs text-gray-600 dark:text-gray-400 mb-2">{{ events.length }} events</p>

    <!-- Event table -->
    <div class="card-table">
      <table class="w-full text-sm min-w-[640px]">
        <thead class="table-header">
          <tr>
            <th class="w-8"></th>
            <SortHeader label="Type" column="event_type" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Category" column="category" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Scope" column="scope" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Tenant" column="tenant_id" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Time" column="timestamp" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <template v-for="e in sortedEvents" :key="e.event_id">
            <!-- Row is mouse-clickable for convenience but NOT a role=button
                 element — the chevron <button> in the first cell provides
                 keyboard + screen-reader access to the expand behavior.
                 Making the whole row a role=button would nest the inner
                 TenantLink/action buttons inside another interactive
                 element (axe rule: nested-interactive, WCAG 4.1.2). -->
            <tr class="hover:bg-gray-50 cursor-pointer transition-colors" @click="expanded = expanded === e.event_id ? null : e.event_id">
              <td class="pl-3 py-3 text-gray-600 dark:text-gray-400">
                <button
                  type="button"
                  :aria-expanded="expanded === e.event_id"
                  :aria-label="expanded === e.event_id ? `Collapse event details` : `Expand event details`"
                  class="p-0.5 -ml-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-400"
                  @click.stop="expanded = expanded === e.event_id ? null : e.event_id"
                >
                  <svg class="w-3.5 h-3.5 transition-transform" :class="expanded === e.event_id ? 'rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </td>
              <td class="table-cell font-mono text-xs">{{ e.event_type }}</td>
              <td class="table-cell"><span class="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-xs">{{ e.category }}</span></td>
              <td class="table-cell text-gray-700 truncate max-w-[200px] font-mono text-xs">{{ e.scope || '-' }}</td>
              <td class="table-cell">
                <TenantLink v-if="e.tenant_id" :tenant-id="e.tenant_id" @click.stop />
              </td>
              <td class="table-cell text-gray-600 dark:text-gray-400 whitespace-nowrap text-xs" :title="new Date(e.timestamp).toISOString()">{{ formatDateTime(e.timestamp) }}</td>
            </tr>
            <tr v-if="expanded === e.event_id" class="bg-gray-50/70">
              <td colspan="6" class="table-cell pl-11">
                <div class="grid grid-cols-2 gap-x-6 gap-y-1 text-xs mb-3">
                  <div><span class="text-gray-600 dark:text-gray-400">Event ID:</span> <span class="font-mono">{{ e.event_id }}</span></div>
                  <div><span class="text-gray-600 dark:text-gray-400">Source:</span> {{ e.source }}</div>
                  <div v-if="e.request_id"><span class="text-gray-600 dark:text-gray-400">Request ID:</span> <span class="font-mono">{{ e.request_id }}</span></div>
                  <div v-if="e.correlation_id">
                    <span class="text-gray-600 dark:text-gray-400">Correlation ID:</span>
                    <button @click.stop="viewCorrelated(e.correlation_id!)" class="text-blue-600 hover:underline ml-1 font-mono cursor-pointer">{{ e.correlation_id }}</button>
                  </div>
                  <div v-if="e.actor"><span class="text-gray-600 dark:text-gray-400">Actor:</span> {{ e.actor.type }}<span v-if="e.actor.key_id" class="font-mono"> {{ e.actor.key_id }}</span></div>
                </div>
                <div v-if="e.data" class="bg-white border border-gray-200 rounded p-3 text-xs font-mono overflow-auto max-h-40">
                  <pre class="whitespace-pre-wrap">{{ safeJsonStringify(e.data) }}</pre>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="events.length === 0">
            <td colspan="6">
              <EmptyState :message="hasActiveFilters ? 'No events match your filters' : 'No events found'" :hint="hasActiveFilters ? undefined : 'Events will appear here as they occur'">
                <button v-if="hasActiveFilters" @click="clearFilters" class="mt-2 text-xs text-blue-600 hover:underline cursor-pointer">Clear filters</button>
              </EmptyState>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="hasMore" class="table-cell border-t border-gray-100 text-center">
        <button @click="loadMore" :disabled="loadingMore" class="text-xs text-blue-600 hover:text-blue-800 cursor-pointer disabled:opacity-50">
          {{ loadingMore ? 'Loading...' : 'Load more events' }}
        </button>
      </div>
    </div>
  </div>
</template>

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

// Pre-R7: every 15s poll called load() which overwrote events.value,
// silently dropping any "Load more" pages the operator had accumulated.
// Post-R7: when extended (loadedMorePages=true), polls fetch page 1 and
// MERGE new events from the head via event_id dedup, preserving the
// loaded tail. Filter changes or an explicit Clear reset this flag.
const loadedMorePages = ref(false)

// V2 (scale-hardening): Copy JSON from expanded event detail. Complements
// the max-h-40 scroll cap by making the truncated view useful for triage
// — operators can pull the full data blob into their clipboard for
// grep/diff/pipe through jq rather than squinting at a capped viewport.
const copiedEventId = ref<string | null>(null)
let copiedResetTimer: ReturnType<typeof setTimeout> | null = null
async function copyEventData(e: Event) {
  try {
    await navigator.clipboard.writeText(safeJsonStringify(e.data))
    copiedEventId.value = e.event_id
    if (copiedResetTimer) clearTimeout(copiedResetTimer)
    copiedResetTimer = setTimeout(() => {
      if (copiedEventId.value === e.event_id) copiedEventId.value = null
    }, 2000)
  } catch {
    // Clipboard permission denied or insecure context — silently
    // fail rather than toast. The operator can still select-and-copy
    // from the pre element.
  }
}

const category = ref((route.query.category as string) || '')
const eventType = ref((route.query.type as string) || '')
const tenantId = ref((route.query.tenant_id as string) || '')
const scope = ref((route.query.scope as string) || '')
const correlationId = ref((route.query.correlation_id as string) || '')

function buildFilterParams(): Record<string, string> {
  const params: Record<string, string> = {}
  if (category.value) params.category = category.value
  if (eventType.value) params.event_type = eventType.value
  if (tenantId.value) params.tenant_id = tenantId.value
  if (scope.value) params.scope = scope.value
  if (correlationId.value) params.correlation_id = correlationId.value
  return params
}

async function load() {
  try {
    const res = await listEvents(buildFilterParams())
    if (loadedMorePages.value && events.value.length > 0) {
      // Extended view: merge page-1 results from the head, preserving
      // the already-loaded tail. Dedup by event_id — events are
      // immutable, so a repeated id is always a safe skip. Without
      // this, the poll would drop the tail and the operator's "Load
      // more" work would vanish every 15s.
      const known = new Set(events.value.map(e => e.event_id))
      const freshFromHead = res.events.filter(e => !known.has(e.event_id))
      if (freshFromHead.length > 0) {
        events.value = [...freshFromHead, ...events.value]
      }
      // Do NOT update hasMore/nextCursor here — they reflect the tail
      // cursor (from the user's last loadMore), not page 1's. Updating
      // them would break subsequent Load more clicks.
    } else {
      events.value = res.events
      hasMore.value = res.has_more
      nextCursor.value = res.next_cursor ?? ''
    }
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
  // Filter change resets the extended state — a new filter means the
  // previously-loaded tail is stale (events matching the OLD filter).
  loadedMorePages.value = false
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
    const params = { ...buildFilterParams(), cursor: nextCursor.value }
    const res = await listEvents(params)
    events.value = [...events.value, ...res.events]
    hasMore.value = res.has_more
    nextCursor.value = res.next_cursor ?? ''
    // Flip the flag so subsequent polls merge-from-head rather than
    // overwriting the tail we just loaded.
    loadedMorePages.value = true
  } catch (e) { error.value = toMessage(e) }
  finally { loadingMore.value = false }
}

function clearFilters() {
  category.value = ''; eventType.value = ''; tenantId.value = ''; scope.value = ''; correlationId.value = ''
  loadedMorePages.value = false
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
        <button v-if="hasActiveFilters" type="button" @click="clearFilters" class="text-sm muted hover:text-gray-700 cursor-pointer">Clear</button>
      </div>
    </form>

    <!-- Results count -->
    <p v-if="events.length > 0" class="muted-sm mb-2">{{ events.length }} events</p>

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
              <td class="pl-3 py-3 muted">
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
              <td class="table-cell muted whitespace-nowrap text-xs" :title="new Date(e.timestamp).toISOString()">{{ formatDateTime(e.timestamp) }}</td>
            </tr>
            <tr v-if="expanded === e.event_id" class="bg-gray-50/70">
              <td colspan="6" class="table-cell pl-11">
                <div class="grid grid-cols-2 gap-x-6 gap-y-1 text-xs mb-3">
                  <div><span class="muted">Event ID:</span> <span class="font-mono">{{ e.event_id }}</span></div>
                  <div><span class="muted">Source:</span> {{ e.source }}</div>
                  <div v-if="e.request_id"><span class="muted">Request ID:</span> <span class="font-mono">{{ e.request_id }}</span></div>
                  <div v-if="e.correlation_id">
                    <span class="muted">Correlation ID:</span>
                    <button @click.stop="viewCorrelated(e.correlation_id!)" class="text-blue-600 hover:underline ml-1 font-mono cursor-pointer">{{ e.correlation_id }}</button>
                  </div>
                  <div v-if="e.actor"><span class="muted">Actor:</span> {{ e.actor.type }}<span v-if="e.actor.key_id" class="font-mono"> {{ e.actor.key_id }}</span></div>
                </div>
                <div v-if="e.data" class="bg-white border border-gray-200 rounded text-xs font-mono">
                  <div class="flex items-center justify-between px-3 py-1.5 border-b border-gray-100">
                    <span class="muted text-xs font-sans">Data</span>
                    <button
                      type="button"
                      @click.stop="copyEventData(e)"
                      class="muted-sm hover:text-gray-700 cursor-pointer px-2 py-0.5 rounded hover:bg-gray-100"
                      :aria-label="`Copy data for event ${e.event_id}`"
                    >
                      {{ copiedEventId === e.event_id ? 'Copied!' : 'Copy' }}
                    </button>
                  </div>
                  <pre class="whitespace-pre-wrap p-3 overflow-auto max-h-40">{{ safeJsonStringify(e.data) }}</pre>
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

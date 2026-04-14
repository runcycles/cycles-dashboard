<script setup lang="ts">
import { ref } from 'vue'
import type { Event } from '../types'
import TenantLink from './TenantLink.vue'
import { formatDateTime } from '../utils/format'

defineProps<{ events: Event[]; compact?: boolean }>()

const expanded = ref<string | null>(null)

function toggle(id: string) {
  expanded.value = expanded.value === id ? null : id
}
</script>

<template>
  <div v-if="events.length === 0" class="text-sm muted py-6 text-center">No events</div>
  <div v-else class="divide-y divide-gray-100">
    <div v-for="e in events" :key="e.event_id">
      <div
        class="flex items-center gap-3 py-2 cursor-pointer table-row-hover -mx-1 px-1 rounded"
        role="button" tabindex="0"
        @click="toggle(e.event_id)"
        @keydown.enter.prevent="toggle(e.event_id)"
        @keydown.space.prevent="toggle(e.event_id)"
        :aria-expanded="expanded === e.event_id"
      >
        <svg class="w-3 h-3 muted shrink-0 transition-transform" :class="expanded === e.event_id ? 'rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span class="font-mono text-xs text-gray-700 flex-1">{{ e.event_type }}</span>
        <span class="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-xs shrink-0">{{ e.category }}</span>
        <span class="muted-sm shrink-0 whitespace-nowrap" :title="new Date(e.timestamp).toISOString()">{{ formatDateTime(e.timestamp) }}</span>
      </div>
      <div v-if="expanded === e.event_id" class="pl-6 pb-2 text-xs">
        <div class="grid grid-cols-2 gap-x-6 gap-y-1 mb-2">
          <div><span class="muted">Event ID:</span> <span class="font-mono">{{ e.event_id }}</span></div>
          <div><span class="muted">Source:</span> {{ e.source }}</div>
          <div v-if="e.scope"><span class="muted">Scope:</span> <span class="font-mono">{{ e.scope }}</span></div>
          <div v-if="e.tenant_id"><span class="muted">Tenant:</span> <TenantLink :tenant-id="e.tenant_id" /></div>
          <div v-if="e.request_id"><span class="muted">Request ID:</span> <span class="font-mono">{{ e.request_id }}</span></div>
          <div v-if="e.correlation_id"><span class="muted">Correlation ID:</span> <span class="font-mono">{{ e.correlation_id }}</span></div>
          <div v-if="e.actor"><span class="muted">Actor:</span> {{ e.actor.type }}<span v-if="e.actor.key_id" class="font-mono"> {{ e.actor.key_id }}</span></div>
        </div>
        <div v-if="e.data" class="bg-white border border-gray-200 rounded p-2 font-mono overflow-auto max-h-32">
          <pre class="whitespace-pre-wrap">{{ JSON.stringify(e.data, null, 2) }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

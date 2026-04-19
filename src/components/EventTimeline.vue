<script setup lang="ts">
import { computed, ref } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import type { Event } from '../types'
import TenantLink from './TenantLink.vue'
import CorrelationIdChip from './CorrelationIdChip.vue'
import CopyJsonIcon from './icons/CopyJsonIcon.vue'
import ChevronRightIcon from './icons/ChevronRightIcon.vue'
import { formatDateTime } from '../utils/format'
import { safeJsonStringify } from '../utils/safe'

// Phase 5 polish — virtualization parity with EventsView.
//
// Pre-fix this component rendered `v-for` over the full events array.
// Fine for the default 20-event page, but once an operator hits
// "Load older events" several times on a long-lived budget (chatty
// agents, months of history), the flat render grew unbounded —
// hundreds of DOM nodes per expand/collapse cycle and visible jank
// on scroll. Now matches the EventsView rendering pattern: row heights
// observed via measureElement, only visible rows in the DOM.
const props = defineProps<{ events: Event[] }>()

// Multi-row expansion — operators compare events side-by-side during
// triage (correlation_id match, payload diff), so keeping multiple
// rows open at once is the more useful default. Pre-fix, opening row
// B auto-collapsed row A; now each row toggles independently.
const expanded = ref(new Set<string>())

function toggle(id: string) {
  if (expanded.value.has(id)) expanded.value.delete(id)
  else expanded.value.add(id)
}

// Copy the full event as JSON — triage affordance matching EventsView's
// expanded-panel button. Copies the whole Event object (including
// metadata like actor, request_id, correlation_id) rather than just
// the data blob which is already select-and-copyable from the <pre>.
const copiedEventId = ref<string | null>(null)
let copiedResetTimer: ReturnType<typeof setTimeout> | null = null
async function copyEventJson(e: Event) {
  try {
    await navigator.clipboard.writeText(safeJsonStringify(e))
    copiedEventId.value = e.event_id
    if (copiedResetTimer) clearTimeout(copiedResetTimer)
    copiedResetTimer = setTimeout(() => {
      if (copiedEventId.value === e.event_id) copiedEventId.value = null
    }, 2000)
  } catch {
    // Clipboard permission denied or insecure context — silent fallback.
  }
}

// Virtualization. Collapsed rows are ~36px; expanded grow with the
// metadata grid + optional JSON block. measureElement observes real
// DOM height per row so expand/collapse re-lays out siblings smoothly.
const scrollEl = ref<HTMLElement | null>(null)
const COLLAPSED_ROW_HEIGHT = 36
const virtualizer = useVirtualizer(computed(() => ({
  count: props.events.length,
  getScrollElement: () => scrollEl.value,
  estimateSize: () => COLLAPSED_ROW_HEIGHT,
  overscan: 6,
  getItemKey: (index: number) => props.events[index]?.event_id ?? index,
})))
const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalHeight = computed(() => virtualizer.value.getTotalSize())

function measureRow(el: Element | { $el?: Element } | null) {
  const node = (el as { $el?: Element })?.$el ?? (el as Element | null)
  if (node instanceof Element && virtualizer.value) {
    virtualizer.value.measureElement(node)
  }
}
</script>

<template>
  <div v-if="events.length === 0" class="text-sm muted py-6 text-center">No events</div>
  <div
    v-else
    ref="scrollEl"
    class="flex-1 overflow-y-auto overflow-x-hidden min-h-[200px]"
  >
    <div role="presentation" :style="{ height: totalHeight + 'px', position: 'relative' }">
      <div
        v-for="v in virtualRows"
        :key="events[v.index].event_id"
        :ref="measureRow"
        :data-index="v.index"
        class="absolute left-0 right-0 border-b border-gray-100 last:border-b-0"
        :style="{ transform: `translateY(${v.start}px)` }"
      >
        <div
          class="flex items-center gap-3 py-2 cursor-pointer table-row-hover -mx-1 px-1 rounded"
          role="button" tabindex="0"
          @click="toggle(events[v.index].event_id)"
          @keydown.enter.prevent="toggle(events[v.index].event_id)"
          @keydown.space.prevent="toggle(events[v.index].event_id)"
          :aria-expanded="expanded.has(events[v.index].event_id)"
        >
          <ChevronRightIcon class="w-3 h-3 muted shrink-0 transition-transform" :class="expanded.has(events[v.index].event_id) ? 'rotate-90' : ''" />
          <span class="font-mono text-xs text-gray-700 flex-1 min-w-0 truncate" :title="events[v.index].event_type">{{ events[v.index].event_type }}</span>
          <span class="bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded text-xs shrink-0">{{ events[v.index].category }}</span>
          <span class="muted-sm shrink-0 whitespace-nowrap" :title="new Date(events[v.index].timestamp).toISOString()">{{ formatDateTime(events[v.index].timestamp) }}</span>
        </div>
        <div v-if="expanded.has(events[v.index].event_id)" class="relative pl-6 pb-2 text-xs">
          <button
            type="button"
            @click.stop="copyEventJson(events[v.index])"
            class="absolute top-0 right-1 p-1.5 rounded muted hover:text-gray-700 hover:bg-gray-200/70 dark:hover:bg-gray-700 cursor-pointer focus:outline-none focus:ring-2 focus:ring-gray-400"
            :aria-label="`Copy full JSON for event ${events[v.index].event_id}`"
            :title="copiedEventId === events[v.index].event_id ? 'Copied!' : 'Copy row as JSON'"
          >
            <CopyJsonIcon :copied="copiedEventId === events[v.index].event_id" />
            <span class="sr-only">{{ copiedEventId === events[v.index].event_id ? 'Copied!' : 'Copy JSON' }}</span>
          </button>
          <div class="grid grid-cols-2 gap-x-6 gap-y-1 mb-2 pr-8">
            <div><span class="muted">Event ID:</span> <span class="font-mono">{{ events[v.index].event_id }}</span></div>
            <div><span class="muted">Source:</span> {{ events[v.index].source }}</div>
            <div v-if="events[v.index].scope"><span class="muted">Scope:</span> <span class="font-mono">{{ events[v.index].scope }}</span></div>
            <div v-if="events[v.index].tenant_id"><span class="muted">Tenant:</span> <TenantLink :tenant-id="events[v.index].tenant_id!" /></div>
            <div v-if="events[v.index].trace_id"><span class="muted">Trace ID:</span>
              <CorrelationIdChip kind="trace" :value="events[v.index].trace_id!" pivot="events" class="ml-1" />
            </div>
            <div v-if="events[v.index].request_id"><span class="muted">Request ID:</span>
              <CorrelationIdChip kind="request" :value="events[v.index].request_id!" pivot="events" class="ml-1" />
            </div>
            <div v-if="events[v.index].correlation_id"><span class="muted">Correlation ID:</span>
              <CorrelationIdChip kind="correlation" :value="events[v.index].correlation_id!" pivot="events" class="ml-1" />
            </div>
            <div v-if="events[v.index].actor"><span class="muted">Actor:</span> {{ events[v.index].actor!.type }}<span v-if="events[v.index].actor!.key_id" class="font-mono"> {{ events[v.index].actor!.key_id }}</span></div>
          </div>
          <!-- max-h-48 matches AuditView's cap so typical 8-12 field
               event payloads (~180px rendered) fit without triggering
               an inner scrollbar. Pre-fix was max-h-32 = 128px which
               forced the scroll on most real events. The outer
               virtualizer's measureElement still measures real row
               height, so larger payloads cap visually at 48 and the
               operator scrolls within the JSON block for the overflow. -->
          <div v-if="events[v.index].data" class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-2 font-mono overflow-auto max-h-48">
            <pre class="whitespace-pre-wrap">{{ JSON.stringify(events[v.index].data, null, 2) }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'

// Cross-surface correlation-id chip. Renders one of three identifiers
// (trace_id, request_id, correlation_id) as a truncated monospace chip
// with tooltip + Copy-to-clipboard + click-to-pivot into a filtered
// view. One consistent affordance across EventTimeline / EventsView /
// AuditView / WebhookDetailView — prior to this we had inline <a> /
// <router-link> / <button> pivots diverging across files.

// Introduced for cycles-governance-admin v0.1.25.27-28 (cycles-server-
// admin v0.1.25.31): the server now auto-populates trace_id on every
// HTTP-originated event and audit entry, giving operators a W3C
// Trace Context pivot across AuditView → EventsView and
// WebhookDetailView → EventsView.

const props = defineProps<{
  // Which filter param to write when pivoting. Also drives the aria
  // label so screen-readers announce the semantic meaning.
  kind: 'trace' | 'request' | 'correlation'
  value: string
  // Destination view for the pivot click. Omit to render a non-clickable
  // chip (display-only) — useful when this chip is already rendered
  // inside the target view itself (no self-pivot).
  pivot?: 'audit' | 'events' | null
}>()

const router = useRouter()

// Truncation: first 8 + last 4 chars for 32-hex trace_ids (keeps the
// prefix/suffix disambiguation without the full 32 chars hogging the
// cell). For shorter ids (request_id, correlation_id are typically
// UUID-ish) the 12-char threshold below just shows them in full.
const display = computed(() => {
  const v = props.value
  if (v.length <= 16) return v
  return `${v.slice(0, 8)}…${v.slice(-4)}`
})

const paramKey = computed(() => {
  if (props.kind === 'trace') return 'trace_id'
  if (props.kind === 'request') return 'request_id'
  return 'correlation_id'
})

const labelKind = computed(() => {
  if (props.kind === 'trace') return 'trace id'
  if (props.kind === 'request') return 'request id'
  return 'correlation id'
})

const canPivot = computed(() => !!props.pivot)

const copied = ref(false)
let copyResetTimer: ReturnType<typeof setTimeout> | null = null

async function copy(e: Event) {
  e.stopPropagation()
  if (!navigator.clipboard) return
  try {
    await navigator.clipboard.writeText(props.value)
    copied.value = true
    if (copyResetTimer) clearTimeout(copyResetTimer)
    copyResetTimer = setTimeout(() => { copied.value = false }, 1500)
  } catch {
    // Clipboard permission denied or insecure context — silent fallback.
    // The tooltip still shows the full value for select-and-copy.
  }
}

async function pivot(e: Event) {
  e.stopPropagation()
  if (!props.pivot) return
  const path = props.pivot === 'audit' ? '/audit' : '/events'
  await router.push({ path, query: { [paramKey.value]: props.value } })
}
</script>

<template>
  <span class="inline-flex items-center gap-1">
    <component
      :is="canPivot ? 'button' : 'span'"
      :type="canPivot ? 'button' : undefined"
      @click="canPivot ? pivot($event) : undefined"
      class="font-mono text-xs"
      :class="canPivot
        ? 'text-blue-600 hover:underline cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-400 rounded'
        : 'text-gray-700 dark:text-gray-300'"
      :title="value"
      :aria-label="canPivot
        ? `Filter by ${labelKind} ${value}`
        : `${labelKind} ${value}`"
    >{{ display }}</component>
    <button
      type="button"
      @click="copy"
      class="muted-sm hover:text-gray-700 dark:hover:text-gray-200 cursor-pointer p-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-400"
      :aria-label="`Copy ${labelKind}`"
    >
      <span v-if="copied" class="text-[10px] leading-none px-1">Copied</span>
      <svg v-else class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
      </svg>
    </button>
  </span>
</template>

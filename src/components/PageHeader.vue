<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import RefreshButton from './RefreshButton.vue'
import { formatRelative } from '../utils/format'

// V6 (Phase 3): optional result-count display. Pre-fix, operators
// had no header-level readout of "how many rows in the current
// view" — they had to guess from the scroll position or the
// subtitle. Following the Linear / GitHub / Jira pattern where
// list views show an X-of-Y count (or just X + "more available"
// when the backend can't give a total) right next to the page
// title so it's the first thing the eye lands on.
const props = defineProps<{
  title: string
  subtitle?: string
  loading?: boolean
  // Count props. Pass whichever subset the view has:
  //   - `loaded` + `total`: renders "Showing X of Y tenants" (best case)
  //   - `loaded` + `hasMore`: renders "X tenants (more available)"
  //   - `loaded` alone: renders just "X tenants"
  // When none are passed, the count line is omitted entirely — views
  // that don't yet wire it up keep their pre-V6 appearance.
  loaded?: number
  total?: number
  hasMore?: boolean
  itemNoun?: string // e.g. "tenant", "webhook", "event" — pluralized automatically
  // Override the naive `${noun}s` pluralization. Pass when the noun
  // isn't a regular plural: "log entry" → "log entries", "policy" →
  // "policies". Unused for regular nouns ("tenant", "webhook").
  itemNounPlural?: string
  // P1-M2: surfaces "Last updated X ago" next to the refresh button on
  // polling views so operators can tell at a glance whether they're
  // looking at fresh data or a stale page after a network hiccup. null
  // → pill hidden (pre-first-success, or non-polling views).
  lastUpdatedAt?: Date | null
}>()
defineEmits<{ refresh: [] }>()

// P1-M2: ticking "now" so the relative label in `freshnessLabel` refreshes
// without relying on the parent polling callback. 15s cadence matches
// the resolution of formatRelative's minute-bucket bands and keeps the
// re-render cost negligible.
const nowTick = ref(Date.now())
let freshnessTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => { freshnessTimer = setInterval(() => { nowTick.value = Date.now() }, 15_000) })
onUnmounted(() => { if (freshnessTimer) clearInterval(freshnessTimer) })

const freshnessLabel = computed(() => {
  if (!props.lastUpdatedAt) return ''
  // Touch nowTick so the computed re-evaluates on the interval.
  void nowTick.value
  return formatRelative(props.lastUpdatedAt.toISOString())
})

const countLabel = computed(() => {
  if (props.loaded === undefined) return ''
  const noun = props.itemNoun ?? 'row'
  const plural = props.itemNounPlural ?? `${noun}s`
  const pluralize = (n: number) => (n === 1 ? noun : plural)
  const L = props.loaded.toLocaleString()
  if (props.total !== undefined) {
    return `Showing ${L} of ${props.total.toLocaleString()} ${pluralize(props.total)}`
  }
  if (props.hasMore) {
    return `${L} ${pluralize(props.loaded)} loaded (more available)`
  }
  return `${L} ${pluralize(props.loaded)}`
})
</script>

<template>
  <div class="flex items-center justify-between mb-6">
    <div class="flex items-center gap-3">
      <slot name="back" />
      <div>
        <h1 class="text-2xl font-semibold text-gray-900 dark:text-white">{{ title }}</h1>
        <p v-if="subtitle" class="muted-sm font-mono mt-0.5">{{ subtitle }}</p>
        <p v-if="countLabel" class="muted-sm mt-0.5 tabular-nums">{{ countLabel }}</p>
        <!-- W6 (Phase 4): a11y row-count live region. Mirrors the
             visible count label so screen readers announce pagination
             state changes ("Load more" appending rows, filter pruning
             rows, poll updating totals). aria-atomic=true re-reads the
             entire string on any change, not just the diff — clearer
             at scale where partial announcements mix with other
             updates. Visually hidden via sr-only; contents match the
             tabular-nums visible line above, so the sighted and
             screen-reader experiences stay in sync. -->
        <span v-if="countLabel" class="sr-only" aria-live="polite" aria-atomic="true">{{ countLabel }}</span>
      </div>
    </div>
    <div class="flex items-center gap-3">
      <!-- P1-M2: freshness pill. Title attribute carries the absolute
           timestamp for operators who need exact correlation with logs. -->
      <span
        v-if="freshnessLabel"
        class="muted-sm tabular-nums"
        :title="lastUpdatedAt?.toString()"
        data-testid="page-header-last-updated"
      >Updated {{ freshnessLabel }}</span>
      <RefreshButton v-if="loading !== undefined" :loading="loading ?? false" @click="$emit('refresh')" />
      <slot name="actions" />
    </div>
  </div>
</template>

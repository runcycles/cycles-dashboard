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
  // P1-M2 (revised): stale-only freshness signal. Pre-fix the pill
  // rendered "Updated just now" continuously during healthy polling —
  // pure visual noise that readers learned to ignore. Now the pill is
  // hidden when data is fresh and only surfaces (in amber) when the
  // last successful tick is older than STALE_THRESHOLD_MS — i.e. a
  // poll was missed. Absence = fresh; presence = "something's off,
  // trust this data less." null → pill hidden (pre-first-success, or
  // non-polling views).
  lastUpdatedAt?: Date | null
}>()

// Longer than the longest polling interval in the app (60s across
// Overview / Tenants / Webhooks / Budgets / TenantDetail, 30s for
// Events / Reservations / WebhookDetail). Gives one full interval of
// slack on the slowest poller before declaring data stale.
const STALE_THRESHOLD_MS = 90_000
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
  const age = Date.now() - props.lastUpdatedAt.getTime()
  if (age < STALE_THRESHOLD_MS) return ''
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
  <!-- Responsive reflow (v0.1.25.58). On narrow viewports the title block
       + actions (refresh, freshness pill, slotted buttons) don't fit on
       one line — `flex-col` below sm: stacks them vertically; gap-3
       preserves the rhythm. items-start on the outer flex prevents
       vertical centering from cramping multi-line titles. -->
  <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
    <div class="flex items-start gap-3 min-w-0">
      <slot name="back" />
      <div class="min-w-0">
        <h1 class="text-xl sm:text-2xl font-semibold text-gray-900 dark:text-white truncate">{{ title }}</h1>
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
    <div class="flex items-center gap-2 sm:gap-3 flex-wrap">
      <!-- P1-M2 (revised): stale-only freshness pill. Only renders when
           the most recent tick is older than STALE_THRESHOLD_MS. Amber
           because its presence means "trust this data less" — the data
           on screen is older than a single polling interval of slack.
           Title carries the absolute timestamp for log correlation. -->
      <span
        v-if="freshnessLabel"
        role="status"
        class="text-xs text-amber-700 dark:text-amber-400 tabular-nums"
        :title="lastUpdatedAt?.toString()"
        data-testid="page-header-last-updated"
      >Last updated {{ freshnessLabel }}</span>
      <RefreshButton v-if="loading !== undefined" :loading="loading ?? false" @click="$emit('refresh')" />
      <slot name="actions" />
    </div>
  </div>
</template>

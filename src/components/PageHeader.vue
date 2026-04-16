<script setup lang="ts">
import { computed } from 'vue'
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
  lastUpdated?: string | null
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
}>()
defineEmits<{ refresh: [] }>()

const countLabel = computed(() => {
  if (props.loaded === undefined) return ''
  const noun = props.itemNoun ?? 'row'
  const pluralize = (n: number) => (n === 1 ? noun : `${noun}s`)
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
      </div>
    </div>
    <div class="flex items-center gap-3">
      <span v-if="lastUpdated" class="muted-sm" :title="new Date(lastUpdated).toLocaleString()">
        Updated {{ formatRelative(lastUpdated) }}
      </span>
      <RefreshButton v-if="loading !== undefined" :loading="loading ?? false" @click="$emit('refresh')" />
      <slot name="actions" />
    </div>
  </div>
</template>

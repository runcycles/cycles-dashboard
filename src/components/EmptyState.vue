<script setup lang="ts">
import { computed } from 'vue'
import EmptyTrayIcon from './icons/EmptyTrayIcon.vue'

// V7 (Phase 3): filter-aware empty state.
//
// Pre-V7, callers decided the message via their own ternary
// (e.g. `:message="hasFilter ? 'No matches' : 'Empty'"`) which
// drifted subtly across views — "No tenants match your filters"
// in one, "No matches" in another, "No data" in a third. Users
// also lost the subtle cue that "no matches" and "no data" mean
// different things: one says "clear a filter to see more," the
// other says "nothing to show you yet."
//
// Callers can now pass just `hasActiveFilter` + `itemNoun` and
// get the canonical copy for free. Explicit `message` / `hint`
// still win (backward compatible) for views that need bespoke
// wording.
const props = defineProps<{
  /** Explicit message overrides the filter-aware default. */
  message?: string
  /** Explicit hint overrides the filter-aware default. */
  hint?: string
  /** Drives which default copy is used. */
  hasActiveFilter?: boolean
  /**
   * Used to fill the default copy templates: e.g. itemNoun="tenant" →
   * "No tenants found" or "No tenants match your filters". Pluralized
   * by appending "s" by default — pass `itemNounPlural` for irregular
   * plurals ("log entry" → "log entries", "policy" → "policies").
   */
  itemNoun?: string
  /** Override the naive `${noun}s` plural for irregular nouns. */
  itemNounPlural?: string
}>()

const resolvedMessage = computed(() => {
  if (props.message) return props.message
  const plural = props.itemNounPlural ?? (props.itemNoun ? `${props.itemNoun}s` : 'results')
  return props.hasActiveFilter
    ? `No ${plural} match your filters`
    : `No ${plural} found`
})

const resolvedHint = computed(() => {
  if (props.hint) return props.hint
  // Only auto-hint for the filtered-empty case — "try clearing filters"
  // is always useful advice there. For truly empty data we don't know
  // what a helpful hint would be without domain knowledge (e.g.
  // "create one" vs "wait for events"); leave hint blank and let
  // callers provide specific copy.
  if (props.hasActiveFilter) return 'Clearing filters may show more results.'
  return undefined
})
</script>

<template>
  <div class="py-12 text-center">
    <EmptyTrayIcon class="mx-auto w-10 h-10 text-gray-300 mb-3" />
    <p class="text-sm muted">{{ resolvedMessage }}</p>
    <p v-if="resolvedHint" class="muted-sm mt-1">{{ resolvedHint }}</p>
    <slot />
  </div>
</template>

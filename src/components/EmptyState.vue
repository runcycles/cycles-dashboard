<script setup lang="ts">
import { computed } from 'vue'

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
   * by appending "s" — good enough for our current nouns (tenant,
   * webhook, event, key, reservation, log entry, budget).
   */
  itemNoun?: string
}>()

const resolvedMessage = computed(() => {
  if (props.message) return props.message
  const plural = props.itemNoun ? `${props.itemNoun}s` : 'results'
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
    <svg class="mx-auto w-10 h-10 text-gray-300 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
      <path stroke-linecap="round" stroke-linejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
    </svg>
    <p class="text-sm muted">{{ resolvedMessage }}</p>
    <p v-if="resolvedHint" class="muted-sm mt-1">{{ resolvedHint }}</p>
    <slot />
  </div>
</template>

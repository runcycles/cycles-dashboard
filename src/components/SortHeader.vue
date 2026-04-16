<script setup lang="ts">
import { computed } from 'vue'

// `as` prop added for V1 virtualization support (Phase 2b): virtualized
// views build ARIA grids from divs rather than a semantic <table>, because
// we inject absolute-positioned rows that would break the HTML table
// layout model. The default stays 'th' so every pre-virtualization view
// is unaffected.
const props = defineProps<{
  label: string
  column: string
  activeColumn: string
  direction: 'asc' | 'desc'
  align?: 'left' | 'right'
  as?: 'th' | 'div'
}>()
defineEmits<{ sort: [column: string] }>()

const ariaSortValue = computed(() => {
  if (props.activeColumn !== props.column) return 'none'
  return props.direction === 'asc' ? 'ascending' : 'descending'
})

const tag = computed(() => props.as ?? 'th')
</script>

<template>
  <component
    :is="tag"
    :class="['table-cell cursor-pointer select-none hover:text-gray-700 transition-colors', align === 'right' ? 'text-right' : 'text-left']"
    :aria-sort="ariaSortValue"
    :aria-label="`Sort by ${label}`"
    role="columnheader"
    @click="$emit('sort', column)"
  >
    <span class="inline-flex items-center gap-1">
      {{ label }}
      <svg v-if="activeColumn === column" class="w-3 h-3" :class="direction === 'desc' ? 'rotate-180' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7" />
      </svg>
      <svg v-else class="w-3 h-3 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M8 9l4-4 4 4m0 6l-4 4-4-4" />
      </svg>
    </span>
  </component>
</template>

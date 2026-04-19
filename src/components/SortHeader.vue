<script setup lang="ts">
import { computed } from 'vue'
import SortAscIcon from './icons/SortAscIcon.vue'
import SortUnsortedIcon from './icons/SortUnsortedIcon.vue'

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
    :class="['table-cell cursor-pointer select-none hover:text-gray-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-inset rounded-sm', align === 'right' ? 'text-right' : 'text-left']"
    :aria-sort="ariaSortValue"
    :aria-label="`Sort by ${label}`"
    role="columnheader"
    :tabindex="0"
    @click="$emit('sort', column)"
    @keydown.enter.prevent="$emit('sort', column)"
    @keydown.space.prevent="$emit('sort', column)"
  >
    <span class="inline-flex items-center gap-1 whitespace-nowrap">
      {{ label }}
      <SortAscIcon v-if="activeColumn === column" class="w-3 h-3" :class="direction === 'desc' ? 'rotate-180' : ''" />
      <SortUnsortedIcon v-else class="w-3 h-3 text-gray-300" />
    </span>
  </component>
</template>

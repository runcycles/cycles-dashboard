<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  label: string
  column: string
  activeColumn: string
  direction: 'asc' | 'desc'
  align?: 'left' | 'right'
}>()
defineEmits<{ sort: [column: string] }>()

const ariaSortValue = computed(() => {
  if (props.activeColumn !== props.column) return 'none'
  return props.direction === 'asc' ? 'ascending' : 'descending'
})
</script>

<template>
  <th
    :class="['px-4 py-3 cursor-pointer select-none hover:text-gray-700 transition-colors', align === 'right' ? 'text-right' : 'text-left']"
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
  </th>
</template>

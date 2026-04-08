<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ used: number; total: number; label?: string }>()

const pct = computed(() => {
  if (props.total <= 0) return 0
  return Math.min(100, Math.max(0, ((props.total - props.used) / props.total) * 100))
})

const barColor = computed(() => {
  const remaining = pct.value
  if (remaining <= 10) return 'bg-red-500'
  if (remaining <= 25) return 'bg-yellow-500'
  return 'bg-green-500'
})
</script>

<template>
  <div>
    <div class="flex justify-between text-xs text-gray-500 mb-1">
      <span>{{ label || 'Utilization' }}</span>
      <span>{{ (100 - pct).toFixed(0) }}%</span>
    </div>
    <div class="w-full bg-gray-200 rounded-full h-2">
      <div :class="barColor" class="h-2 rounded-full transition-all" :style="{ width: (100 - pct) + '%' }" />
    </div>
  </div>
</template>

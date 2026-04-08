<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ remaining: number; allocated: number; label?: string }>()

const usedPct = computed(() => {
  if (props.allocated <= 0) return 0
  const used = Math.max(0, props.allocated - props.remaining)
  return Math.min(100, (used / props.allocated) * 100)
})

const barColor = computed(() => {
  if (usedPct.value >= 90) return 'bg-red-500'
  if (usedPct.value >= 75) return 'bg-yellow-500'
  return 'bg-green-500'
})
</script>

<template>
  <div>
    <div class="flex justify-between text-xs text-gray-500 mb-1">
      <span>{{ label || 'Utilization' }}</span>
      <span>{{ usedPct.toFixed(0) }}%</span>
    </div>
    <div class="w-full bg-gray-200 rounded-full h-2">
      <div :class="barColor" class="h-2 rounded-full transition-all" :style="{ width: usedPct + '%' }" />
    </div>
  </div>
</template>

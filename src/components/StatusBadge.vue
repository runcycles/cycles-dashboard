<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ status: string }>()

const colorClass = computed(() => {
  switch (props.status.toUpperCase()) {
    case 'ACTIVE': return 'bg-green-100 text-green-800'
    case 'FROZEN': case 'PAUSED': case 'SUSPENDED': return 'bg-yellow-100 text-yellow-800'
    case 'CLOSED': case 'DISABLED': case 'REVOKED': return 'bg-red-100 text-red-800'
    default: return 'bg-gray-100 text-gray-800'
  }
})
</script>

<template>
  <span :class="colorClass" class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium">
    {{ status }}
  </span>
</template>

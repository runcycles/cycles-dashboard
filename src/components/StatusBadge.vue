<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ status: string }>()

const colorClass = computed(() => {
  switch (props.status.toUpperCase()) {
    case 'ACTIVE': case 'SUCCESS': return 'bg-green-100 text-green-800'
    case 'FROZEN': case 'PAUSED': case 'SUSPENDED': case 'RETRYING': case 'PENDING': return 'bg-yellow-100 text-yellow-800'
    // Terminal-but-not-error states render neutral gray (same palette
    // as the Overview counter-strip's chip-neutral): CLOSED / REVOKED /
    // EXPIRED mean "done, nothing actionable", not "broken". Red is
    // reserved for failure signals — FAILED (delivery failed) and
    // DISABLED (webhooks are auto-disabled by the server after repeated
    // delivery failures, so DISABLED reads as "broken endpoint").
    case 'CLOSED': case 'REVOKED': case 'EXPIRED': return 'bg-gray-100 text-gray-800'
    case 'DISABLED': case 'FAILED': return 'bg-red-100 text-red-800'
    default: return 'bg-gray-100 text-gray-800'
  }
})
</script>

<template>
  <span :class="colorClass" class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium">
    {{ status }}
  </span>
</template>

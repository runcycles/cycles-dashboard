<script setup lang="ts">
defineProps<{ copied?: boolean }>()
</script>

<template>
  <svg v-if="copied" aria-hidden="true" class="w-4 h-4 text-green-600" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 10l4 4 8-8" />
  </svg>
  <svg v-else aria-hidden="true" class="w-4 h-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <rect x="11" y="2" width="5.5" height="6" rx="0.8" stroke-width="1.25" />
    <rect x="3" y="5.5" width="11" height="12" rx="1.2" />
    <path d="M7.5 8 Q5.5 8 5.5 10 V11 Q5.5 11.5 4.5 11.5 Q5.5 11.5 5.5 12 V13 Q5.5 15 7.5 15" stroke-width="1.4" />
    <path d="M9.5 8 Q11.5 8 11.5 10 V11 Q11.5 11.5 12.5 11.5 Q11.5 11.5 11.5 12 V13 Q11.5 15 9.5 15" stroke-width="1.4" />
  </svg>
</template>

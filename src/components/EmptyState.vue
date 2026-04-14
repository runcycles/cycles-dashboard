<script setup lang="ts">
defineProps<{
  message: string
  hint?: string
}>()
</script>

<template>
  <div class="py-12 text-center">
    <svg class="mx-auto w-10 h-10 text-gray-300 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
      <path stroke-linecap="round" stroke-linejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
    </svg>
    <p class="text-sm muted">{{ message }}</p>
    <p v-if="hint" class="muted-sm mt-1">{{ hint }}</p>
    <slot />
  </div>
</template>

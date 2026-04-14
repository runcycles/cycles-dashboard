<script setup lang="ts">
defineProps<{ loading: boolean }>()
defineEmits<{ click: [] }>()
</script>

<template>
  <button
    @click="$emit('click')"
    :disabled="loading"
    class="inline-flex items-center gap-1.5 text-sm muted hover:text-gray-900 cursor-pointer disabled:cursor-wait disabled:opacity-50 transition-colors px-2 py-1 rounded hover:bg-gray-100"
  >
    <svg
      class="w-3.5 h-3.5"
      :class="loading ? 'animate-spin' : ''"
      fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
    >
      <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h5M20 20v-5h-5M4 9a8 8 0 0113.292-3.293M20 15a8 8 0 01-13.292 3.293" />
    </svg>
    Refresh
  </button>
</template>

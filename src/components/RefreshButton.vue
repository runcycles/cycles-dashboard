<script setup lang="ts">
import RefreshIcon from './icons/RefreshIcon.vue'

defineProps<{ loading: boolean }>()
defineEmits<{ click: [] }>()
</script>

<template>
  <button
    @click="$emit('click')"
    :disabled="loading"
    class="inline-flex items-center gap-1.5 text-sm muted hover:text-gray-900 cursor-pointer disabled:cursor-wait disabled:opacity-50 transition-colors px-2 py-1 rounded hover:bg-gray-100"
  >
    <RefreshIcon class="w-3.5 h-3.5" :class="loading ? 'animate-spin' : ''" />
    Refresh
  </button>
</template>

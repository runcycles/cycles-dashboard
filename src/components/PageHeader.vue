<script setup lang="ts">
import RefreshButton from './RefreshButton.vue'

defineProps<{
  title: string
  loading?: boolean
  lastUpdated?: string | null
}>()
defineEmits<{ refresh: [] }>()

function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  if (diffMs < 60000) return 'just now'
  if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`
  return d.toLocaleTimeString()
}
</script>

<template>
  <div class="flex items-center justify-between mb-6">
    <div class="flex items-center gap-3">
      <slot name="back" />
      <h1 class="text-2xl font-semibold text-gray-900">{{ title }}</h1>
    </div>
    <div class="flex items-center gap-3">
      <span v-if="lastUpdated" class="text-xs text-gray-400">
        Updated {{ formatTime(lastUpdated) }}
      </span>
      <RefreshButton v-if="loading !== undefined" :loading="loading ?? false" @click="$emit('refresh')" />
    </div>
  </div>
</template>

<script setup lang="ts">
import RefreshButton from './RefreshButton.vue'
import { formatRelative } from '../utils/format'

defineProps<{
  title: string
  loading?: boolean
  lastUpdated?: string | null
}>()
defineEmits<{ refresh: [] }>()
</script>

<template>
  <div class="flex items-center justify-between mb-6">
    <div class="flex items-center gap-3">
      <slot name="back" />
      <h1 class="text-2xl font-semibold text-gray-900 dark:text-white">{{ title }}</h1>
    </div>
    <div class="flex items-center gap-3">
      <span v-if="lastUpdated" class="text-xs text-gray-400" :title="new Date(lastUpdated).toLocaleString()">
        Updated {{ formatRelative(lastUpdated) }}
      </span>
      <RefreshButton v-if="loading !== undefined" :loading="loading ?? false" @click="$emit('refresh')" />
    </div>
  </div>
</template>

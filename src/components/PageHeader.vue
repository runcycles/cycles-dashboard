<script setup lang="ts">
import RefreshButton from './RefreshButton.vue'
import { formatRelative } from '../utils/format'

defineProps<{
  title: string
  subtitle?: string
  loading?: boolean
  lastUpdated?: string | null
}>()
defineEmits<{ refresh: [] }>()
</script>

<template>
  <div class="flex items-center justify-between mb-6">
    <div class="flex items-center gap-3">
      <slot name="back" />
      <div>
        <h1 class="text-2xl font-semibold text-gray-900 dark:text-white">{{ title }}</h1>
        <p v-if="subtitle" class="muted-sm font-mono mt-0.5">{{ subtitle }}</p>
      </div>
    </div>
    <div class="flex items-center gap-3">
      <span v-if="lastUpdated" class="muted-sm" :title="new Date(lastUpdated).toLocaleString()">
        Updated {{ formatRelative(lastUpdated) }}
      </span>
      <RefreshButton v-if="loading !== undefined" :loading="loading ?? false" @click="$emit('refresh')" />
      <slot name="actions" />
    </div>
  </div>
</template>

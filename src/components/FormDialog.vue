<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'

defineProps<{
  title: string
  submitLabel?: string
  loading?: boolean
  error?: string
  wide?: boolean
}>()
const emit = defineEmits<{ submit: []; cancel: [] }>()

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('cancel')
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="fixed inset-0 bg-black/40 flex items-center justify-center z-50 overflow-y-auto py-8" @click.self="$emit('cancel')">
    <div :class="wide ? 'max-w-xl' : 'max-w-lg'" class="bg-white dark:bg-gray-900 dark:border dark:border-gray-700 rounded-lg shadow-lg p-6 mx-4 w-full" role="dialog" aria-modal="true" :aria-label="title">
      <h3 class="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">{{ title }}</h3>
      <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded px-3 py-2 mb-4">{{ error }}</p>
      <form @submit.prevent="$emit('submit')">
        <div class="space-y-3">
          <slot />
        </div>
        <div class="flex justify-end gap-2 mt-5 pt-4 border-t border-gray-200 dark:border-gray-700">
          <button type="button" @click="$emit('cancel')" class="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-gray-100 rounded hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer">Cancel</button>
          <button
            type="submit"
            :disabled="loading"
            class="px-4 py-1.5 text-sm rounded cursor-pointer bg-gray-900 hover:bg-gray-800 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ loading ? 'Saving...' : (submitLabel || 'Save') }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

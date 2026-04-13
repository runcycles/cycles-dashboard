<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useFocusTrap } from '../composables/useFocusTrap'

const props = defineProps<{
  title: string
  message: string
  confirmLabel: string
  danger?: boolean
  // When true, the confirm button is disabled and shows a spinner; the
  // dialog backdrop / Cancel / Escape are also blocked. Lets callers do
  // `await mutateThing()` *with the dialog still open* instead of the
  // old anti-pattern of closing the dialog before the request starts
  // (which left users staring at nothing during 403/timeout flows).
  loading?: boolean
  // When set, renders an inline error block above the action buttons.
  // Keeps the dialog open so the user can read the error in context
  // (rather than guessing which toast belonged to which click).
  error?: string
}>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()

const dialogRef = ref<HTMLElement | null>(null)
useFocusTrap(dialogRef)

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && !props.loading) emit('cancel')
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="fixed inset-0 bg-black/40 flex items-center justify-center z-50" @click.self="!loading && $emit('cancel')">
    <div ref="dialogRef" class="bg-white dark:bg-gray-900 dark:border dark:border-gray-700 rounded-lg shadow-lg p-6 max-w-sm mx-4" role="dialog" aria-modal="true" :aria-label="title">
      <h3 class="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">{{ title }}</h3>
      <p class="text-sm text-gray-600 dark:text-gray-300 mb-4">{{ message }}</p>
      <div v-if="error" class="mb-4 px-3 py-2 rounded text-xs bg-red-50 border border-red-200 text-red-700 dark:bg-red-950 dark:border-red-800 dark:text-red-300" role="alert">{{ error }}</div>
      <div class="flex justify-end gap-2">
        <button @click="$emit('cancel')" :disabled="loading" class="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 rounded hover:bg-gray-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">Cancel</button>
        <button
          @click="$emit('confirm')"
          :disabled="loading"
          :class="danger
            ? 'bg-red-600 hover:bg-red-700 text-white'
            : 'bg-gray-900 hover:bg-gray-800 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300'"
          class="px-3 py-1.5 text-sm rounded cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
        >
          <svg v-if="loading" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" stroke-opacity="0.25" /><path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" stroke-width="3" /></svg>
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

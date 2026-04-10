<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useFocusTrap } from '../composables/useFocusTrap'

defineProps<{
  title: string
  message: string
  confirmLabel: string
  danger?: boolean
}>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()

const dialogRef = ref<HTMLElement | null>(null)
useFocusTrap(dialogRef)

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('cancel')
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="fixed inset-0 bg-black/40 flex items-center justify-center z-50" @click.self="$emit('cancel')">
    <div ref="dialogRef" class="bg-white dark:bg-gray-900 dark:border dark:border-gray-700 rounded-lg shadow-lg p-6 max-w-sm mx-4" role="dialog" aria-modal="true" :aria-label="title">
      <h3 class="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">{{ title }}</h3>
      <p class="text-sm text-gray-600 dark:text-gray-300 mb-4">{{ message }}</p>
      <div class="flex justify-end gap-2">
        <button @click="$emit('cancel')" class="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 rounded hover:bg-gray-100 cursor-pointer">Cancel</button>
        <button
          @click="$emit('confirm')"
          :class="danger
            ? 'bg-red-600 hover:bg-red-700 text-white'
            : 'bg-gray-900 hover:bg-gray-800 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300'"
          class="px-3 py-1.5 text-sm rounded cursor-pointer"
        >
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

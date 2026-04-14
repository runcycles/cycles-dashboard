<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

defineProps<{
  title: string
  secret: string
  label: string
}>()
const emit = defineEmits<{ close: [] }>()

const copied = ref(false)
const confirmed = ref(false)
let clipboardTimer: ReturnType<typeof setTimeout> | null = null

function copy(value: string) {
  navigator.clipboard.writeText(value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
  if (clipboardTimer) clearTimeout(clipboardTimer)
  clipboardTimer = setTimeout(() => {
    navigator.clipboard.readText().then(text => {
      if (text === value) navigator.clipboard.writeText('')
    }).catch(() => {})
  }, 60_000)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && confirmed.value) emit('close')
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
  if (clipboardTimer) clearTimeout(clipboardTimer)
})
</script>

<template>
  <div class="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
    <div class="bg-white dark:bg-gray-900 dark:border dark:border-gray-700 rounded-lg shadow-lg p-6 max-w-lg mx-4 w-full" role="dialog" aria-modal="true" :aria-label="title">
      <h3 class="text-sm font-semibold text-gray-900 mb-1">{{ title }}</h3>
      <p class="text-xs text-red-600 mb-4">This secret will not be shown again. Copy it now.</p>

      <div class="mb-1 text-xs text-gray-600 dark:text-gray-500">{{ label }}</div>
      <div class="flex items-center gap-2 bg-gray-50 dark:bg-gray-800 rounded p-3 mb-4">
        <code class="flex-1 text-sm font-mono break-all text-gray-900 dark:text-gray-100 select-all">{{ secret }}</code>
        <button @click="copy(secret)" class="shrink-0 text-xs text-blue-600 hover:text-blue-800 cursor-pointer px-2 py-1 rounded hover:bg-blue-50 border border-blue-200 transition-colors">
          {{ copied ? 'Copied!' : 'Copy' }}
        </button>
      </div>

      <label class="flex items-center gap-2 text-sm text-gray-600 mb-4 cursor-pointer">
        <input v-model="confirmed" type="checkbox" class="rounded" />
        I have copied and saved this secret
      </label>

      <div class="flex justify-end">
        <button
          @click="$emit('close')"
          :disabled="!confirmed"
          class="px-4 py-1.5 text-sm rounded cursor-pointer bg-gray-900 hover:bg-gray-800 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Close
        </button>
      </div>
    </div>
  </div>
</template>

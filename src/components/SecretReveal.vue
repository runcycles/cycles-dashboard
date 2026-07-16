<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useFocusTrap } from '../composables/useFocusTrap'
import { writeClipboardText } from '../utils/clipboard'

defineProps<{
  title: string
  secret: string
  label: string
}>()
const emit = defineEmits<{ close: [] }>()

const copied = ref(false)
const copying = ref(false)
const copyError = ref('')
const confirmed = ref(false)
const dialogRef = ref<HTMLElement | null>(null)
useFocusTrap(dialogRef)
// W5 (scale-hardening): track BOTH the 60s clipboard-clear timer and
// the 2s "Copied!" badge timer. Rapid re-clicks previously leaked the
// badge timer; closing the dialog during its window fired setTimeout
// on a dead instance.
let clipboardTimer: ReturnType<typeof setTimeout> | null = null
let copiedBadgeTimer: ReturnType<typeof setTimeout> | null = null

async function copy(value: string) {
  if (copying.value) return
  copying.value = true
  copyError.value = ''
  try {
    if (!await writeClipboardText(value)) throw new Error('clipboard unavailable')
    copied.value = true
    if (copiedBadgeTimer) clearTimeout(copiedBadgeTimer)
    copiedBadgeTimer = setTimeout(() => { copied.value = false }, 2000)
    if (clipboardTimer) clearTimeout(clipboardTimer)
    clipboardTimer = setTimeout(() => {
      navigator.clipboard.readText().then(text => {
        if (text === value) void writeClipboardText('')
      }).catch(() => {})
    }, 60_000)
  } catch {
    copied.value = false
    copyError.value = 'Copy failed — clipboard unavailable. Select the secret and copy it manually.'
  } finally {
    copying.value = false
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && confirmed.value) emit('close')
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
  // Do not clear clipboardTimer here. Closing a one-time-secret dialog is the
  // normal path and must not cancel the promised 60-second security wipe.
  // The callback is self-guarding: it only clears when our secret is still on
  // the clipboard, so later user content remains untouched.
  if (copiedBadgeTimer) clearTimeout(copiedBadgeTimer)
})
</script>

<template>
  <div class="fixed inset-0 bg-black/40 flex items-center justify-center z-50 overflow-y-auto p-4 sm:p-8">
    <div ref="dialogRef" class="bg-white dark:bg-gray-900 dark:border dark:border-gray-700 rounded-lg shadow-lg p-6 max-w-lg w-full max-h-[calc(100dvh-2rem)] overflow-y-auto" role="dialog" aria-modal="true" :aria-label="title">
      <h3 class="text-sm font-semibold text-gray-900 mb-1">{{ title }}</h3>
      <p class="text-xs text-red-600 mb-4">This secret will not be shown again. Copy it now.</p>

      <div class="mb-1 muted-sm">{{ label }}</div>
      <div class="flex items-center gap-2 bg-gray-50 dark:bg-gray-800 rounded p-3 mb-4">
        <code class="flex-1 text-sm font-mono break-all text-gray-900 dark:text-gray-100 select-all">{{ secret }}</code>
        <button @click="copy(secret)" :disabled="copying" class="shrink-0 text-xs text-blue-600 hover:text-blue-800 cursor-pointer px-2 py-1 rounded hover:bg-blue-50 border border-blue-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
          {{ copying ? 'Copying…' : copied ? 'Copied!' : 'Copy' }}
        </button>
      </div>
      <p v-if="copyError" role="alert" aria-atomic="true" class="text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded px-3 py-2 mb-4">{{ copyError }}</p>

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

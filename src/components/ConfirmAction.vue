<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useFocusTrap } from '../composables/useFocusTrap'
import Spinner from './icons/Spinner.vue'

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
  // Opt-in for bounded batch operations that can stop scheduling remaining
  // rows through an AbortSignal. Backdrop and Escape stay blocked so an
  // in-flight cancellation is always an explicit button action.
  cancellableWhileLoading?: boolean
  // When set, renders an inline error block above the action buttons.
  // Keeps the dialog open so the user can read the error in context
  // (rather than guessing which toast belonged to which click).
  error?: string
}>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()

const dialogRef = ref<HTMLElement | null>(null)
useFocusTrap(dialogRef)

// Focus sink for the ordinary loading window. When cancellation is not
// supported, both buttons are disabled and the trap needs this programmatic
// target. Cancellable batches instead move focus to their explicit Stop
// remaining button. On settlement, focus returns to Confirm for retry/dismiss.
const loadingSink = ref<HTMLElement | null>(null)
const cancelBtn = ref<HTMLButtonElement | null>(null)
const confirmBtn = ref<HTMLButtonElement | null>(null)

watch(() => props.loading, async (now, before) => {
  await nextTick()
  if (now) {
    if (props.cancellableWhileLoading) cancelBtn.value?.focus()
    else loadingSink.value?.focus()
  } else if (before) {
    // Loading just finished — return focus to the confirm button so the
    // user can either retry (if an error rendered) or close via Escape.
    confirmBtn.value?.focus()
  }
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && !props.loading) emit('cancel')
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="fixed inset-0 bg-black/40 flex items-center justify-center z-50 overflow-y-auto p-4 sm:p-8" @click.self="!loading && $emit('cancel')">
    <div ref="dialogRef" class="bg-white dark:bg-gray-900 dark:border dark:border-gray-700 rounded-lg shadow-lg p-6 w-full max-w-sm max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain" role="dialog" aria-modal="true" :aria-label="title" :aria-busy="loading || undefined">
      <h3 class="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">{{ title }}</h3>
      <p class="text-sm text-gray-600 dark:text-gray-300 mb-4">{{ message }}</p>
      <div v-if="error" class="mb-4 px-3 py-2 rounded text-xs bg-red-50 border border-red-200 text-red-700 dark:bg-red-950 dark:border-red-800 dark:text-red-300" role="alert">{{ error }}</div>
      <!--
        Visually-hidden focus sink: target for programmatic focus while the
        action is in flight (both buttons are :disabled, so the focus trap
        otherwise has nothing to hold). aria-live="polite" announces the
        loading state to screen readers without interrupting current speech.
      -->
      <div
        ref="loadingSink"
        tabindex="-1"
        aria-live="polite"
        class="sr-only"
      >{{ loading ? `${confirmLabel} in progress, please wait` : '' }}</div>
      <div class="flex flex-wrap justify-end gap-2">
        <button
          ref="cancelBtn"
          @click="$emit('cancel')"
          :disabled="loading && !cancellableWhileLoading"
          class="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 rounded hover:bg-gray-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >{{ loading && cancellableWhileLoading ? 'Stop remaining' : 'Cancel' }}</button>
        <button
          ref="confirmBtn"
          @click="$emit('confirm')"
          :disabled="loading"
          :class="danger
            ? 'bg-red-600 hover:bg-red-700 text-white'
            : 'bg-gray-900 hover:bg-gray-800 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300'"
          class="px-3 py-1.5 text-sm rounded cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
        >
          <Spinner v-if="loading" class="w-3.5 h-3.5" />
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

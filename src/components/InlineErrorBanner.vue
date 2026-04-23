<script setup lang="ts">
// P1-M3: shared top-of-view error banner. Pre-fix, every view inlined
// the same `<p class="bg-red-50 ...">` markup but without a dismiss
// affordance — a stale error lingered until a subsequent fetch
// happened to succeed. This component adds an explicit close button,
// so operators can clear a one-off network blip without reaching for
// the Refresh action.
//
// Auto-clear on the next successful fetch is the view's
// responsibility — keep doing `error.value = ''` in the polling
// callback. The dismiss button covers the other case: an error that
// the operator has already read and would like to get out of the way.
defineProps<{ message: string }>()
defineEmits<{ dismiss: [] }>()
</script>

<template>
  <div
    role="alert"
    class="bg-red-50 border border-red-200 text-red-700 dark:bg-red-950 dark:border-red-800 dark:text-red-300 text-sm rounded-lg table-cell mb-4 flex items-start gap-3"
    data-testid="inline-error-banner"
  >
    <span class="flex-1 min-w-0 break-words">{{ message }}</span>
    <button
      type="button"
      @click="$emit('dismiss')"
      aria-label="Dismiss error"
      class="shrink-0 inline-flex items-center justify-center w-8 h-8 -mr-1 rounded text-red-600 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 cursor-pointer text-xl leading-none"
    >×</button>
  </div>
</template>

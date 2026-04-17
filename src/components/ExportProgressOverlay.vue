<script setup lang="ts">
// Progress overlay shown during a multi-page export — the browser only
// flushes the Blob once every page is gathered, so the operator has to
// keep the tab open in the meantime. Cancel button bails out of the
// cursor-follow loop on the next iteration (the in-flight request
// still completes, but no blob is written) — useful when an operator
// realizes mid-export that they forgot to narrow a filter and the
// export is heading for the 50k-row cap.
defineProps<{
  open: boolean
  fetched: number
  itemNounPlural: string
  cancellable?: boolean
}>()
defineEmits<{ cancel: [] }>()
</script>

<template>
  <div v-if="open" class="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
    <div class="bg-white dark:bg-gray-900 dark:border dark:border-gray-700 rounded-lg shadow-lg p-6 max-w-sm mx-4">
      <h3 class="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">Assembling export…</h3>
      <p class="text-sm text-gray-600 dark:text-gray-300 mb-1">
        Fetched <strong>{{ fetched.toLocaleString() }}</strong> {{ itemNounPlural }} so far.
      </p>
      <p class="muted-sm">Keep this tab open until the download begins.</p>
      <div v-if="cancellable" class="mt-4 flex justify-end">
        <button
          type="button"
          class="text-xs px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
          @click="$emit('cancel')"
        >Cancel export</button>
      </div>
    </div>
  </div>
</template>

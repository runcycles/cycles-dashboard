<script setup lang="ts">
// Blocking progress overlay shown during a multi-page export — the
// browser only flushes the Blob once every page is gathered, so the
// operator has to keep the tab open in the meantime. Non-dismissible
// by design; the fetch loop has EXPORT_MAX_ROWS / MAX_PAGES safety
// caps to prevent it from running forever.
defineProps<{
  open: boolean
  fetched: number
  itemNounPlural: string
}>()
</script>

<template>
  <div v-if="open" class="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
    <div class="bg-white dark:bg-gray-900 dark:border dark:border-gray-700 rounded-lg shadow-lg p-6 max-w-sm mx-4">
      <h3 class="text-sm font-semibold text-gray-900 mb-2">Assembling export…</h3>
      <p class="text-sm text-gray-600 mb-1">
        Fetched <strong>{{ fetched.toLocaleString() }}</strong> {{ itemNounPlural }} so far.
      </p>
      <p class="muted-sm">Keep this tab open until the download begins.</p>
    </div>
  </div>
</template>

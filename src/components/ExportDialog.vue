<script setup lang="ts">
// Confirmation dialog for list-view exports. Renders the correct copy
// for single-page vs multi-page exports so operators know when the
// click is going to trigger additional network fetches. Backdrop click
// and Escape both dismiss.
defineProps<{
  /** When non-null, dialog is visible; format indicates CSV vs JSON. */
  format: 'csv' | 'json' | null
  /** Rows currently loaded (page 1 count). */
  loadedCount: number
  /** True when the server has more rows than loadedCount. */
  hasMore: boolean
  /** Upper bound on rows the slow path will fetch before aborting. */
  maxRows: number
  /** Plural noun for copy: "tenants", "events", etc. */
  itemNounPlural: string
  /**
   * Optional sensitive-data warning — compliance-heavy exports
   * (audit logs, API keys) should flip this on so operators see a
   * "handle with care" note next to the row count.
   */
  warning?: string
}>()
defineEmits<{
  confirm: []
  cancel: []
}>()
</script>

<template>
  <div
    v-if="format"
    class="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
    @click.self="$emit('cancel')"
    @keyup.esc="$emit('cancel')"
  >
    <div class="bg-white dark:bg-gray-900 dark:border dark:border-gray-700 rounded-lg shadow-lg p-6 max-w-sm mx-4">
      <h3 class="text-sm font-semibold text-gray-900 mb-2">Export {{ itemNounPlural }}?</h3>
      <p v-if="!hasMore" class="text-sm text-gray-600 mb-1">
        This export contains <strong>{{ loadedCount.toLocaleString() }}</strong> {{ itemNounPlural }}.
      </p>
      <p v-else class="text-sm text-gray-600 mb-1">
        The current filter matches <strong>more than {{ loadedCount.toLocaleString() }}</strong> {{ itemNounPlural }}.
        The export will paginate through all remaining results (up to {{ maxRows.toLocaleString() }}) before the download starts.
      </p>
      <p v-if="warning" class="muted-sm mb-4">{{ warning }}</p>
      <div class="flex justify-end gap-2">
        <button @click="$emit('cancel')" class="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 rounded hover:bg-gray-100 cursor-pointer">Cancel</button>
        <button @click="$emit('confirm')" class="px-3 py-1.5 text-sm bg-gray-900 text-white rounded hover:bg-gray-800 cursor-pointer">Export {{ format.toUpperCase() }}</button>
      </div>
    </div>
  </div>
</template>

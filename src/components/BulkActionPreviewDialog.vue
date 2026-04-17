<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useFocusTrap } from '../composables/useFocusTrap'
import type { PreviewSample } from '../composables/useBulkActionPreview'

// O1 (UI/UX P0): operator-facing preview before a filter-apply bulk
// action commits. Mirrors ConfirmAction's a11y wiring (focus trap, focus
// sink while loading, Escape to cancel) but renders the preview body
// inline: filter description, live count, first-10 sample rows, and
// a Confirm whose label adapts to count/cap state.

const props = defineProps<{
  /** Single-word verb shown in the title and Confirm button: "Suspend", "Reactivate", "Pause", etc. */
  actionVerb: string
  /** Plural noun for the rows: "tenants", "webhooks". */
  itemNounPlural: string
  /** Plain-language filter summary, e.g. "status=ACTIVE AND parent_tenant_id=acme". */
  filterDescription: string
  /** True while the cursor walk is in progress. Confirm is disabled. */
  loading: boolean
  /** Live count of matched items found so far during the walk. */
  count: number
  /** First N (default 10) sample rows. Updated as the walk progresses. */
  samples: PreviewSample[]
  /** True iff the walk hit the maxMatches cap (count is a lower bound; submit would LIMIT_EXCEEDED). */
  cappedAtMax: boolean
  /** True iff the walk hit maxPages without finishing (count is partial; do not send expected_count). */
  cappedAtPages: boolean
  /**
   * True iff the walk completed naturally (count is exact). Callers
   * should send this value as `expected_count` on the bulk submit so
   * the server's COUNT_MISMATCH gate fires on drift.
   */
  reachedEnd: boolean
  /** Server cap on rows per bulk request. Default 500. Only used in copy. */
  serverMaxPerRequest?: number
  /** Walk error (network etc.). Renders an inline alert. */
  error?: string
  /** Submit error (after Confirm). Renders an inline alert. */
  submitError?: string
  /** True while the bulk-action POST is in flight after Confirm. Confirm spinner. */
  submitting: boolean
  /** Use red Confirm button styling for destructive actions (suspend, delete). */
  confirmDanger?: boolean
}>()

const emit = defineEmits<{ confirm: []; cancel: [] }>()

const dialogRef = ref<HTMLElement | null>(null)
useFocusTrap(dialogRef)

const loadingSink = ref<HTMLElement | null>(null)
const confirmBtn = ref<HTMLButtonElement | null>(null)

// Mirror ConfirmAction's loading-state focus dance: while submitting,
// both Cancel and Confirm are disabled — the focus trap has nothing to
// hold, so Tab would escape. Park focus on the sr-only sink and announce
// "in progress" via aria-live; restore focus to Confirm when it ends.
watch(() => props.submitting, async (now, before) => {
  await nextTick()
  if (now) {
    loadingSink.value?.focus()
  } else if (before) {
    confirmBtn.value?.focus()
  }
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && !props.submitting) emit('cancel')
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))

const SERVER_MAX = props.serverMaxPerRequest ?? 500
</script>

<template>
  <div
    class="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
    @click.self="!submitting && $emit('cancel')"
  >
    <div
      ref="dialogRef"
      class="bg-white dark:bg-gray-900 dark:border dark:border-gray-700 rounded-lg shadow-lg p-6 w-full max-w-md mx-4"
      role="dialog"
      aria-modal="true"
      :aria-label="`${actionVerb} ${itemNounPlural} matching filter`"
      :aria-busy="loading || submitting || undefined"
    >
      <h3 class="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
        Preview — {{ actionVerb }} {{ itemNounPlural }} matching filter
      </h3>

      <div class="mb-3 px-2.5 py-1.5 rounded bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-xs font-mono text-gray-700 dark:text-gray-300 break-all">
        {{ filterDescription || '(no filter)' }}
      </div>

      <!-- Walk error -->
      <div
        v-if="error"
        role="alert"
        class="mb-3 px-3 py-2 rounded text-xs bg-red-50 border border-red-200 text-red-700 dark:bg-red-950 dark:border-red-800 dark:text-red-300"
      >
        {{ error }}
      </div>

      <!-- Loading: count walk in progress. Spinner + live count. -->
      <div
        v-if="loading"
        role="status"
        aria-live="polite"
        class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300 mb-3"
      >
        <svg class="w-4 h-4 animate-spin shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" stroke-opacity="0.25" />
          <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" stroke-width="3" />
        </svg>
        <span>Counting matches… {{ count }} found so far</span>
      </div>

      <!-- Done: empty -->
      <div
        v-else-if="!error && count === 0"
        class="mb-3 px-3 py-2 rounded text-sm bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200"
      >
        No {{ itemNounPlural }} match the current filter — close and adjust the filter.
      </div>

      <!-- Done: count + samples -->
      <div v-else-if="!error" class="mb-3">
        <p class="text-sm text-gray-800 dark:text-gray-100 mb-2">
          <strong class="tabular-nums">
            <template v-if="cappedAtMax">{{ SERVER_MAX }}+</template>
            <template v-else>{{ count.toLocaleString() }}</template>
          </strong>
          {{ itemNounPlural }} will be affected.
          <span v-if="cappedAtPages" class="muted-sm">(partial count — narrow the filter for an exact total)</span>
        </p>

        <ul
          class="border border-gray-200 dark:border-gray-700 rounded divide-y divide-gray-100 dark:divide-gray-800 bg-gray-50/50 dark:bg-gray-800/30 max-h-48 overflow-auto"
          aria-label="Sample of matching items"
        >
          <li
            v-for="s in samples"
            :key="s.id"
            class="px-2.5 py-1.5 text-xs flex items-center gap-2"
          >
            <span class="font-mono text-gray-900 dark:text-gray-100 truncate">{{ s.id }}</span>
            <span v-if="s.primary && s.primary !== s.id" class="text-gray-600 dark:text-gray-300 truncate">{{ s.primary }}</span>
            <span v-if="s.status" class="ml-auto text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 shrink-0">{{ s.status }}</span>
          </li>
        </ul>
        <p v-if="count > samples.length" class="mt-1 muted-sm">
          Showing first {{ samples.length }} of {{ cappedAtMax ? `${SERVER_MAX}+` : count.toLocaleString() }} matching {{ itemNounPlural }}.
        </p>
      </div>

      <!-- Cap warning: server bulk endpoint will refuse a >500 count -->
      <div
        v-if="cappedAtMax"
        role="alert"
        class="mb-3 px-3 py-2 rounded text-xs bg-amber-50 border border-amber-200 text-amber-800 dark:bg-amber-950 dark:border-amber-800 dark:text-amber-200"
      >
        Server applies bulk actions to a maximum of {{ SERVER_MAX }} {{ itemNounPlural }} per request.
        Narrow the filter before retrying.
      </div>

      <!-- Submit error (renders after Confirm) -->
      <div
        v-if="submitError"
        role="alert"
        class="mb-3 px-3 py-2 rounded text-xs bg-red-50 border border-red-200 text-red-700 dark:bg-red-950 dark:border-red-800 dark:text-red-300"
      >
        {{ submitError }}
      </div>

      <!-- sr-only focus sink for the submitting window -->
      <div
        ref="loadingSink"
        tabindex="-1"
        aria-live="polite"
        class="sr-only"
      >{{ submitting ? `${actionVerb} ${itemNounPlural} in progress, please wait` : '' }}</div>

      <div class="flex justify-end gap-2">
        <button
          type="button"
          @click="$emit('cancel')"
          :disabled="submitting"
          class="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 rounded hover:bg-gray-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >Cancel</button>
        <button
          ref="confirmBtn"
          type="button"
          @click="$emit('confirm')"
          :disabled="loading || submitting || count === 0 || cappedAtMax"
          :class="confirmDanger
            ? 'bg-red-600 hover:bg-red-700 text-white'
            : 'bg-gray-900 hover:bg-gray-800 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300'"
          class="px-3 py-1.5 text-sm rounded cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
        >
          <svg v-if="submitting" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" stroke-opacity="0.25" /><path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" stroke-width="3" /></svg>
          <template v-if="submitting">{{ actionVerb }}…</template>
          <template v-else-if="loading">Counting…</template>
          <template v-else-if="count === 0">{{ actionVerb }}</template>
          <template v-else-if="cappedAtMax">Too many matches</template>
          <template v-else>{{ actionVerb }} {{ count.toLocaleString() }} {{ itemNounPlural }}</template>
        </button>
      </div>
    </div>
  </div>
</template>

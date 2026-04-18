<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useFocusTrap } from '../composables/useFocusTrap'
import { formatErrorCode } from '../utils/errorCodeMessages'
import type { BulkActionRowOutcome } from '../types'

// Per-row outcome dialog for filter-apply bulk actions. Opens after the
// server returns a response with any non-empty failed[] or skipped[]
// array so the operator can triage per-row results beyond the brief
// toast summary (succeeded[] stays summary-only; we don't enumerate
// successes — the freshly-refreshed list already reflects them).
//
// cycles-governance-admin v0.1.25.23 widened the per-row error_code
// catalogue (BUDGET_EXCEEDED added) in preparation for v0.1.25.26's
// budget bulk-action endpoint, where per-row failures will be the rule
// not the exception. See src/utils/errorCodeMessages.ts for prose.

const props = defineProps<{
  /** Verb used in the title ("Suspend", "Reactivate", "Pause", "Credit"). */
  actionVerb: string
  /** Plural noun for the rows ("tenants", "webhooks", "budgets"). */
  itemNounPlural: string
  /** Bulk response body. All three arrays are enumerated when operator expands them. */
  response: {
    succeeded: BulkActionRowOutcome[]
    failed: BulkActionRowOutcome[]
    skipped: BulkActionRowOutcome[]
    total_matched?: number
  }
  /**
   * Optional id→label lookup, typically the scope for BudgetsView (whose
   * row ids are opaque UUIDs) or any other surface where the id alone
   * doesn't identify the row to an operator. When provided, each
   * enumerated row renders the label as the primary line and the id as
   * a smaller secondary mono line. When omitted, the id is the only
   * identifier rendered — preserves the existing TenantsView /
   * WebhooksView behaviour where ids are already human-readable.
   */
  labelById?: Record<string, string>
  /**
   * Tenant id the bulk was scoped to. Required by spec for budget
   * bulk-action (BudgetBulkFilter.tenant_id is mandatory) — when
   * supplied alongside `itemNounPlural === 'budgets'`, each enumerated
   * row renders a pair of triage router-links:
   *   • View budget → /budgets?tenant_id=<t>&search=<scope> (scope from
   *     labelById; the server's search matches tenant_id + scope, NOT
   *     the opaque ledger_id, so we pass the human-readable scope).
   *   • View audit  → /audit?tenant_id=<t>&operation=bulkActionBudgets
   *     (the bulk invocation writes a single audit entry with
   *     resource_id='bulk-action' and per-row outcomes in metadata;
   *     operation is the only searchable hook to that entry).
   * Suppressed when absent — tenants/webhooks surfaces don't need
   * per-row routing (ids are already human-readable and the audit
   * trail is already searchable by those ids).
   */
  tenantId?: string
}>()

function labelFor(id: string): string | undefined {
  return props.labelById?.[id]
}

// Only budgets rows benefit from triage links — tenants/webhooks
// surfaces have readable ids and per-row audit rows searchable by id.
const showTriageLinks = computed(() =>
  props.itemNounPlural === 'budgets' && !!props.tenantId,
)

function budgetTriageLink(id: string) {
  const scope = labelFor(id)
  // Fall back to the id when labelById wasn't supplied for this row —
  // the server search won't match on id, but the operator at least
  // lands on the correct tenant's list rather than a 404.
  return {
    path: '/budgets',
    query: { tenant_id: props.tenantId, search: scope ?? id },
  }
}

function auditTriageLink() {
  return {
    path: '/audit',
    query: { tenant_id: props.tenantId, operation: 'bulkActionBudgets' },
  }
}

// Download the full response as JSON so operators can retain triage
// context after the dialog closes (the enumerated rows + per-row
// error codes + scope labels are not reconstructable from the toast
// summary or the refreshed list view). Filename carries verb + noun
// + ISO timestamp for easy correlation with incident tickets.
function downloadJson() {
  const payload = {
    actionVerb: props.actionVerb,
    itemNounPlural: props.itemNounPlural,
    tenantId: props.tenantId,
    exportedAt: new Date().toISOString(),
    labelById: props.labelById,
    response: props.response,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `bulk-${props.itemNounPlural}-${props.actionVerb.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

const emit = defineEmits<{ close: [] }>()

const dialogRef = ref<HTMLElement | null>(null)
useFocusTrap(dialogRef)

// Open the section with rows first (failed takes precedence since it's
// the most actionable; skipped only opens by default when there are no
// failures to look at). Succeeded stays collapsed by default — the list
// view refresh reflects the new state, and keeping it collapsed signals
// that attention belongs on failed rows. Operator can click to verify.
const failedOpen = ref(props.response.failed.length > 0)
const skippedOpen = ref(props.response.failed.length === 0 && props.response.skipped.length > 0)
const succeededOpen = ref(false)

// Clipboard button state: brief "Copied" flash per row id. Keyed by
// row id so two adjacent Copy clicks don't race.
const copiedId = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

function copyId(id: string) {
  navigator.clipboard.writeText(id).then(() => {
    copiedId.value = id
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copiedId.value = null }, 2000)
  }).catch(() => {
    // Clipboard permission denied — leave state untouched. The dialog's
    // plain row ID is still visible and selectable.
  })
}

const totalRows = computed(() =>
  props.response.succeeded.length + props.response.failed.length + props.response.skipped.length,
)

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
  if (copiedTimer) clearTimeout(copiedTimer)
})
</script>

<template>
  <div
    class="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
    @click.self="$emit('close')"
  >
    <div
      ref="dialogRef"
      class="bg-white dark:bg-gray-900 dark:border dark:border-gray-700 rounded-lg shadow-lg p-6 w-full max-w-lg mx-4"
      role="dialog"
      aria-modal="true"
      :aria-label="`${actionVerb} ${itemNounPlural} — results`"
    >
      <h3 class="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {{ actionVerb }} {{ itemNounPlural }} — results
      </h3>
      <p class="text-xs text-gray-500 dark:text-gray-400 mb-3">
        {{ totalRows.toLocaleString() }} row{{ totalRows === 1 ? '' : 's' }} processed<span v-if="typeof response.total_matched === 'number' && response.total_matched !== totalRows"> of {{ response.total_matched.toLocaleString() }} matched</span>.
      </p>

      <!-- Succeeded: collapsed by default. When there are any failures
           the operator's attention belongs on the failed block, not on
           verifying successes; but for partial-failure runs the operator
           often wants to know which specific rows did succeed so they
           can plan the retry on just the failed ones. -->
      <details
        v-if="response.succeeded.length"
        :open="succeededOpen"
        @toggle="succeededOpen = ($event.target as HTMLDetailsElement).open"
        class="mb-2 rounded border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/40"
      >
        <summary class="px-3 py-2 text-xs text-green-800 dark:text-green-200 cursor-pointer flex items-center gap-2 list-none">
          <span
            class="inline-block transition-transform shrink-0"
            :class="succeededOpen ? 'rotate-90' : ''"
            aria-hidden="true"
          >▶</span>
          <svg class="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <strong class="tabular-nums">{{ response.succeeded.length.toLocaleString() }}</strong>
          <span>succeeded</span>
        </summary>
        <ul class="divide-y divide-green-100 dark:divide-green-900/60 max-h-64 overflow-auto">
          <li
            v-for="s in response.succeeded"
            :key="s.id"
            class="px-3 py-2 text-xs"
          >
            <div class="flex items-center gap-2 min-w-0">
              <div class="min-w-0 flex-1">
                <span v-if="labelFor(s.id)" class="block text-gray-900 dark:text-gray-100 break-all">{{ labelFor(s.id) }}</span>
                <span class="block font-mono text-gray-500 dark:text-gray-400 truncate" :class="labelFor(s.id) ? 'text-[10px] mt-0.5' : ''" :title="s.id">{{ s.id }}</span>
              </div>
              <button
                type="button"
                @click="copyId(s.id)"
                class="shrink-0 px-1.5 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer"
                :aria-label="`Copy ID ${s.id}`"
              >{{ copiedId === s.id ? 'Copied' : 'Copy ID' }}</button>
            </div>
            <div v-if="showTriageLinks" class="mt-1 flex items-center gap-3">
              <router-link
                :to="budgetTriageLink(s.id)"
                class="text-[10px] text-blue-700 dark:text-blue-300 hover:underline"
                :aria-label="`View budget ${labelFor(s.id) ?? s.id}`"
                @click="$emit('close')"
              >View budget</router-link>
              <router-link
                :to="auditTriageLink()"
                class="text-[10px] text-blue-700 dark:text-blue-300 hover:underline"
                :aria-label="`View audit for bulk action on tenant ${tenantId}`"
                @click="$emit('close')"
              >View audit</router-link>
            </div>
          </li>
        </ul>
      </details>

      <!-- Failed: per-row error_code + message, each with a copy button. -->
      <details
        v-if="response.failed.length"
        :open="failedOpen"
        @toggle="failedOpen = ($event.target as HTMLDetailsElement).open"
        class="mb-2 rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40"
      >
        <summary class="px-3 py-2 text-xs text-red-800 dark:text-red-200 cursor-pointer flex items-center gap-2 list-none">
          <span
            class="inline-block transition-transform shrink-0"
            :class="failedOpen ? 'rotate-90' : ''"
            aria-hidden="true"
          >▶</span>
          <svg class="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <strong class="tabular-nums">{{ response.failed.length.toLocaleString() }}</strong>
          <span>failed</span>
        </summary>
        <ul class="divide-y divide-red-100 dark:divide-red-900/60 max-h-64 overflow-auto">
          <li
            v-for="f in response.failed"
            :key="f.id"
            class="px-3 py-2 text-xs"
          >
            <div class="flex items-center gap-2 min-w-0">
              <div class="min-w-0 flex-1">
                <span v-if="labelFor(f.id)" class="block text-gray-900 dark:text-gray-100 break-all">{{ labelFor(f.id) }}</span>
                <span class="block font-mono text-gray-500 dark:text-gray-400 truncate" :class="labelFor(f.id) ? 'text-[10px] mt-0.5' : 'text-gray-900 dark:text-gray-100'" :title="f.id">{{ f.id }}</span>
              </div>
              <button
                type="button"
                @click="copyId(f.id)"
                class="shrink-0 px-1.5 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer"
                :aria-label="`Copy ID ${f.id}`"
              >{{ copiedId === f.id ? 'Copied' : 'Copy ID' }}</button>
            </div>
            <p class="mt-0.5 text-red-700 dark:text-red-300 break-words">
              {{ formatErrorCode(f.error_code, f.message) }}
            </p>
            <div v-if="showTriageLinks" class="mt-1 flex items-center gap-3">
              <router-link
                :to="budgetTriageLink(f.id)"
                class="text-[10px] text-blue-700 dark:text-blue-300 hover:underline"
                :aria-label="`View budget ${labelFor(f.id) ?? f.id}`"
                @click="$emit('close')"
              >View budget</router-link>
              <router-link
                :to="auditTriageLink()"
                class="text-[10px] text-blue-700 dark:text-blue-300 hover:underline"
                :aria-label="`View audit for bulk action on tenant ${tenantId}`"
                @click="$emit('close')"
              >View audit</router-link>
            </div>
          </li>
        </ul>
      </details>

      <!-- Skipped: per-row reason (server tells us why the row was a no-op;
           e.g. tenant already SUSPENDED during a SUSPEND bulk). -->
      <details
        v-if="response.skipped.length"
        :open="skippedOpen"
        @toggle="skippedOpen = ($event.target as HTMLDetailsElement).open"
        class="mb-3 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40"
      >
        <summary class="px-3 py-2 text-xs text-gray-700 dark:text-gray-200 cursor-pointer flex items-center gap-2 list-none">
          <span
            class="inline-block transition-transform shrink-0"
            :class="skippedOpen ? 'rotate-90' : ''"
            aria-hidden="true"
          >▶</span>
          <svg class="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 8v4m0 4h.01M12 2a10 10 0 100 20 10 10 0 000-20z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <strong class="tabular-nums">{{ response.skipped.length.toLocaleString() }}</strong>
          <span>skipped</span>
        </summary>
        <ul class="divide-y divide-gray-200 dark:divide-gray-700 max-h-64 overflow-auto">
          <li
            v-for="s in response.skipped"
            :key="s.id"
            class="px-3 py-2 text-xs"
          >
            <div class="flex items-center gap-2 min-w-0">
              <div class="min-w-0 flex-1">
                <span v-if="labelFor(s.id)" class="block text-gray-900 dark:text-gray-100 break-all">{{ labelFor(s.id) }}</span>
                <span class="block font-mono text-gray-500 dark:text-gray-400 truncate" :class="labelFor(s.id) ? 'text-[10px] mt-0.5' : 'text-gray-900 dark:text-gray-100'" :title="s.id">{{ s.id }}</span>
              </div>
              <button
                type="button"
                @click="copyId(s.id)"
                class="shrink-0 px-1.5 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer"
                :aria-label="`Copy ID ${s.id}`"
              >{{ copiedId === s.id ? 'Copied' : 'Copy ID' }}</button>
            </div>
            <p v-if="s.reason" class="mt-0.5 text-gray-600 dark:text-gray-300 break-words">
              {{ s.reason }}
            </p>
            <div v-if="showTriageLinks" class="mt-1 flex items-center gap-3">
              <router-link
                :to="budgetTriageLink(s.id)"
                class="text-[10px] text-blue-700 dark:text-blue-300 hover:underline"
                :aria-label="`View budget ${labelFor(s.id) ?? s.id}`"
                @click="$emit('close')"
              >View budget</router-link>
              <router-link
                :to="auditTriageLink()"
                class="text-[10px] text-blue-700 dark:text-blue-300 hover:underline"
                :aria-label="`View audit for bulk action on tenant ${tenantId}`"
                @click="$emit('close')"
              >View audit</router-link>
            </div>
          </li>
        </ul>
      </details>

      <div class="flex justify-end gap-2">
        <button
          type="button"
          @click="downloadJson"
          class="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer"
          aria-label="Save results as JSON"
          title="Download full response as JSON for triage after dialog closes"
        >Save JSON</button>
        <button
          type="button"
          @click="$emit('close')"
          class="px-3 py-1.5 text-sm rounded bg-gray-900 hover:bg-gray-800 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300 cursor-pointer"
        >Close</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { formatErrorCode } from '../utils/errorCodeMessages'
import { hasBulkAuditShape } from '../utils/auditMetadata'
import TenantLink from './TenantLink.vue'
import type { BulkActionRowOutcome } from '../types'

// Structured renderer for cycles-governance-admin v0.1.25.30 bulk-action
// audit metadata. The admin server enriches AuditLogEntry.metadata for
// bulkActionTenants / bulkActionWebhooks / bulkActionBudgets with per-row
// outcomes + filter echo + duration. A 500-row bulk's raw-JSON blob is
// hostile to scan; this component maps the new keys into a scannable
// summary: header strip + filter grid + succeeded/failed/skipped
// collapsibles. Emits nothing when metadata lacks the expected shape
// (pre-.30 entries) so the caller's raw-JSON <pre> fallback kicks in.

const props = defineProps<{
  operation: string
  metadata: Record<string, unknown>
}>()

function nounFor(op: string): string {
  if (op === 'bulkActionTenants') return 'tenants'
  if (op === 'bulkActionWebhooks') return 'webhooks'
  if (op === 'bulkActionBudgets') return 'budgets'
  return 'rows'
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

function asArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

const action = computed(() =>
  typeof props.metadata.action === 'string' ? props.metadata.action : '',
)
const filterObj = computed(() => asObject(props.metadata.filter))
const succeededIds = computed(() => asArray<string>(props.metadata.succeeded_ids))
const failedRows = computed(() => asArray<BulkActionRowOutcome>(props.metadata.failed_rows))
const skippedRows = computed(() => asArray<BulkActionRowOutcome>(props.metadata.skipped_rows))
const durationMs = computed(() => {
  const v = props.metadata.duration_ms
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
})

const shapeOk = computed(() => hasBulkAuditShape(props.operation, props.metadata))

// Sub-second renders as "Xms" (server round-trips are typically <1s);
// >=1s renders as "X.XXs" so an operator scanning for outliers sees
// the magnitude change immediately.
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

// Filter-echo entries. Keep falsy-but-meaningful values (false, 0) and
// only strip empty strings / null / undefined / empty arrays/objects —
// an auditor comparing two bulk runs needs to know whether `has_debt`
// was explicitly false or unset.
const filterEntries = computed(() =>
  Object.entries(filterObj.value).filter(([, v]) => {
    if (v === '' || v === null || v === undefined) return false
    if (Array.isArray(v) && v.length === 0) return false
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0) return false
    return true
  }),
)

function stringify(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

// Tenant-ish filter keys that get a TenantLink render instead of bare
// mono text. `tenant_id` (required on BudgetBulkFilter, optional on
// WebhookBulkFilter) and `parent_tenant_id` (TenantBulkFilter) both
// identify real tenants operators may want to click through to.
const TENANT_FILTER_KEYS = new Set(['tenant_id', 'parent_tenant_id'])

// Per-row / copy-all flash state. Keyed by row id; `__all__` is the
// sentinel for the "Copy all succeeded ids" button. Mirrors the copy
// affordance in BulkActionResultDialog so the two surfaces feel the
// same to operators.
const copiedId = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null
function flash(key: string) {
  copiedId.value = key
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    if (copiedId.value === key) copiedId.value = null
  }, 2000)
}
function copyId(id: string) {
  // Guard explicitly — `navigator.clipboard?.writeText(id).then(...)` would
  // throw synchronously if clipboard is undefined (optional chain returns
  // undefined, then .then() crashes). Insecure contexts / older browsers
  // fall through; the row id is still selectable from the rendered text.
  if (!navigator.clipboard) return
  navigator.clipboard.writeText(id).then(() => flash(id)).catch(() => {})
}
function copyAllSucceeded() {
  if (!succeededIds.value.length) return
  if (!navigator.clipboard) return
  navigator.clipboard.writeText(succeededIds.value.join(',')).then(() => flash('__all__')).catch(() => {})
}
</script>

<template>
  <div v-if="shapeOk" class="mb-3 space-y-3" data-testid="bulk-action-audit-detail">
    <!-- Header strip: action verb + noun + duration + three-count summary -->
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-700 dark:text-gray-300">
      <span class="font-semibold text-gray-900 dark:text-gray-100">
        <template v-if="action">{{ titleCase(action) }} {{ nounFor(operation) }}</template>
        <template v-else>{{ nounFor(operation) }} bulk action</template>
      </span>
      <span v-if="durationMs !== undefined" class="muted tabular-nums">· {{ formatDuration(durationMs) }}</span>
      <span class="tabular-nums">
        ·
        <span class="text-green-700 dark:text-green-300">{{ succeededIds.length.toLocaleString() }} succeeded</span>
        ·
        <span :class="failedRows.length ? 'text-red-700 dark:text-red-300' : 'muted'">{{ failedRows.length.toLocaleString() }} failed</span>
        ·
        <span :class="skippedRows.length ? 'text-amber-700 dark:text-amber-300' : 'muted'">{{ skippedRows.length.toLocaleString() }} skipped</span>
      </span>
    </div>

    <!-- Filter echo — 2-column key/value grid. Keys render in mono to
         match the AuditView wire-style convention; known tenant keys
         get a TenantLink so operators can drill into the subject. -->
    <div v-if="filterEntries.length" class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-3">
      <div class="muted mb-1 text-xs font-sans">Filter</div>
      <dl class="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-3 gap-y-1 text-xs">
        <template v-for="[k, v] in filterEntries" :key="k">
          <dt class="font-mono muted">{{ k }}</dt>
          <dd class="font-mono text-gray-900 dark:text-gray-100 break-all">
            <TenantLink v-if="TENANT_FILTER_KEYS.has(k) && typeof v === 'string'" :tenant-id="v" />
            <template v-else>{{ stringify(v) }}</template>
          </dd>
        </template>
      </dl>
    </div>

    <!-- Succeeded — collapsed by default. Operator attention belongs
         on failed rows; succeeded is available for handoff (copy-all
         pipes into a follow-up filter or ticket). -->
    <details v-if="succeededIds.length" class="rounded border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/40">
      <summary class="px-3 py-2 text-xs text-green-800 dark:text-green-200 cursor-pointer flex items-center gap-2 list-none">
        <span class="inline-block transition-transform shrink-0" aria-hidden="true">▶</span>
        <strong class="tabular-nums">{{ succeededIds.length.toLocaleString() }}</strong>
        <span>succeeded</span>
        <button
          type="button"
          class="ml-auto shrink-0 px-1.5 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer"
          @click.stop.prevent="copyAllSucceeded"
          aria-label="Copy all succeeded IDs"
        >{{ copiedId === '__all__' ? 'Copied' : 'Copy all' }}</button>
      </summary>
      <ul class="divide-y divide-green-100 dark:divide-green-900/60 max-h-48 overflow-auto">
        <li v-for="id in succeededIds" :key="id" class="px-3 py-1.5 text-xs flex items-center gap-2">
          <span class="font-mono text-gray-900 dark:text-gray-100 truncate flex-1" :title="id">{{ id }}</span>
          <button
            type="button"
            @click.stop="copyId(id)"
            class="shrink-0 px-1.5 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer"
            :aria-label="`Copy ID ${id}`"
          >{{ copiedId === id ? 'Copied' : 'Copy' }}</button>
        </li>
      </ul>
    </details>

    <!-- Failed — open by default; this is the row triage hook -->
    <details v-if="failedRows.length" open class="rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40">
      <summary class="px-3 py-2 text-xs text-red-800 dark:text-red-200 cursor-pointer flex items-center gap-2 list-none">
        <span class="inline-block transition-transform shrink-0" aria-hidden="true">▶</span>
        <strong class="tabular-nums">{{ failedRows.length.toLocaleString() }}</strong>
        <span>failed</span>
      </summary>
      <ul class="divide-y divide-red-100 dark:divide-red-900/60 max-h-48 overflow-auto">
        <li v-for="f in failedRows" :key="f.id" class="px-3 py-1.5 text-xs">
          <div class="flex items-center gap-2">
            <span class="font-mono text-gray-900 dark:text-gray-100 truncate flex-1" :title="f.id">{{ f.id }}</span>
            <span v-if="f.error_code" class="shrink-0 px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-200 font-mono text-[10px]">{{ f.error_code }}</span>
            <button
              type="button"
              @click.stop="copyId(f.id)"
              class="shrink-0 px-1.5 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer"
              :aria-label="`Copy ID ${f.id}`"
            >{{ copiedId === f.id ? 'Copied' : 'Copy' }}</button>
          </div>
          <p class="mt-0.5 text-red-700 dark:text-red-300 break-words">
            {{ formatErrorCode(f.error_code, f.message) }}
          </p>
        </li>
      </ul>
    </details>

    <!-- Skipped — collapsed by default; reasons are typically
         "already in target state" and rarely need per-row inspection -->
    <details v-if="skippedRows.length" class="rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40">
      <summary class="px-3 py-2 text-xs text-gray-700 dark:text-gray-200 cursor-pointer flex items-center gap-2 list-none">
        <span class="inline-block transition-transform shrink-0" aria-hidden="true">▶</span>
        <strong class="tabular-nums">{{ skippedRows.length.toLocaleString() }}</strong>
        <span>skipped</span>
      </summary>
      <ul class="divide-y divide-gray-200 dark:divide-gray-700 max-h-48 overflow-auto">
        <li v-for="s in skippedRows" :key="s.id" class="px-3 py-1.5 text-xs">
          <div class="flex items-center gap-2">
            <span class="font-mono text-gray-900 dark:text-gray-100 truncate flex-1" :title="s.id">{{ s.id }}</span>
            <button
              type="button"
              @click.stop="copyId(s.id)"
              class="shrink-0 px-1.5 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer"
              :aria-label="`Copy ID ${s.id}`"
            >{{ copiedId === s.id ? 'Copied' : 'Copy' }}</button>
          </div>
          <p v-if="s.reason" class="mt-0.5 text-gray-600 dark:text-gray-300 break-words">{{ s.reason }}</p>
        </li>
      </ul>
    </details>
  </div>
</template>

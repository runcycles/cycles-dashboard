// Shape check for cycles-governance-admin v0.1.25.30 bulk-action audit
// metadata enrichment. The server writes succeeded_ids / failed_rows /
// skipped_rows / filter / duration_ms into AuditLogEntry.metadata for
// the three bulk-action ops; pre-.30 entries carry none of those keys
// and must fall back to the caller's raw-JSON renderer.
//
// Kept here (not inside the component) so AuditView's conditional
// `<BulkActionAuditDetail v-if="…">` and the component's own no-op
// render path share one source of truth.

export const BULK_ACTION_OPERATIONS = [
  'bulkActionTenants',
  'bulkActionWebhooks',
  'bulkActionBudgets',
] as const

export type BulkActionOperation = typeof BULK_ACTION_OPERATIONS[number]

const BULK_OP_SET: ReadonlySet<string> = new Set(BULK_ACTION_OPERATIONS)

export function isBulkActionOperation(op: string | undefined): op is BulkActionOperation {
  return !!op && BULK_OP_SET.has(op)
}

// True iff the audit entry is one of the three bulk-action ops AND its
// metadata carries at least one of the five v0.1.25.30 keys. A missing
// `metadata` object (pre-.30 entries, or entries from an older admin
// server) returns false so the caller renders its raw-JSON fallback.
export function hasBulkAuditShape(
  operation: string | undefined,
  metadata: Record<string, unknown> | undefined | null,
): boolean {
  if (!isBulkActionOperation(operation)) return false
  if (!metadata || typeof metadata !== 'object') return false
  return (
    Array.isArray(metadata.succeeded_ids) ||
    Array.isArray(metadata.failed_rows) ||
    Array.isArray(metadata.skipped_rows) ||
    (typeof metadata.filter === 'object' && metadata.filter !== null && !Array.isArray(metadata.filter)) ||
    typeof metadata.duration_ms === 'number'
  )
}

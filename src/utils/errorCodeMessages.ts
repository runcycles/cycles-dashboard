// Centralized mapping of bulk-action + request-level error codes to
// operator-facing strings. Covers the two surfaces touching these codes:
//   1. Per-row failures inside a bulk response's failed[] array.
//   2. Request-level ApiError codes from the bulk-action endpoints themselves
//      (COUNT_MISMATCH, LIMIT_EXCEEDED — currently humanized inline in the
//      views; this module is the migration target).
//
// Forward-compat: unknown codes fall through to `${code}: ${message}` —
// the UI never throws on a newly-introduced server code. Keep the
// per-row catalogue minimal; only add a code here when its canonical
// prose differs usefully from the server's plain `message`.

// Per-row codes that benefit from a canonical prose template. Each
// returns a string from (message, context). Keep these side-effect free.
const PER_ROW_CODES: Record<string, (message: string | undefined, context: Record<string, unknown>) => string> = {
  // cycles-governance-admin v0.1.25.26 — emitted per-row when a DEBIT
  // or RESET exceeds the remaining balance. Server populates `message`
  // with human-readable detail (e.g. "requested 100, remaining 42").
  BUDGET_EXCEEDED: (message) =>
    message ? `Budget exceeded — ${message}` : 'Budget exceeded (insufficient remaining balance).',

  // cycles-governance-admin v0.1.25.22 — emitted per-row when the row's
  // current status disallows the requested action (e.g. SUSPEND on an
  // already-SUSPENDED tenant, DEBIT on a PAUSED budget).
  INVALID_TRANSITION: (message) =>
    message ? `Invalid state for this action — ${message}` : 'Invalid state for this action.',

  // cycles-governance-admin v0.1.25.21 — generic server-side failure.
  // Surface whatever prose the server sent; fall back to a generic note.
  INTERNAL_ERROR: (message) =>
    message ? `Server error — ${message}` : 'Server error — retry or contact support.',
}

// Format a single per-row outcome's error_code into operator-facing prose.
// Returns the canonical string for known codes; for unknown codes, returns
// `${code}: ${message}` (or bare `${code}` if message is empty) so the
// operator still sees enough detail to triage.
export function formatErrorCode(
  code: string | undefined,
  message?: string,
  context: Record<string, unknown> = {},
): string {
  if (!code) return message?.trim() || 'Unknown error'
  const fmt = PER_ROW_CODES[code]
  if (fmt) return fmt(message, context)
  return message?.trim() ? `${code}: ${message}` : code
}

// Request-level humanization for the two bulk-action safety gates. These
// mirror the inline branches currently in TenantsView / WebhooksView so
// both views can route through one helper.
//
//   - LIMIT_EXCEEDED (400): filter matched more than serverMaxPerRequest
//     rows. Server echoes `total_matched` in details when available.
//   - COUNT_MISMATCH (409): preview-time count differed from server's
//     count at submit — another writer mutated a matching row mid-flight.
export function formatBulkRequestError(
  code: string | undefined,
  itemNounPlural: string,
  serverMaxPerRequest: number = 500,
  details?: Record<string, unknown>,
): string | null {
  if (code === 'LIMIT_EXCEEDED') {
    const matched = typeof details?.total_matched === 'number'
      ? ` (server matched ${(details.total_matched as number).toLocaleString()})`
      : ''
    return `Filter matches more than ${serverMaxPerRequest} ${itemNounPlural}${matched} — narrow the filter before retrying.`
  }
  if (code === 'COUNT_MISMATCH') {
    return `${itemNounPlural.charAt(0).toUpperCase()}${itemNounPlural.slice(1)} list changed between preview and submit — close and reopen the preview to retry.`
  }
  return null
}

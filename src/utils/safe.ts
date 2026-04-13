// Defensive helpers for content that originates from the server (or
// from arbitrary user-controlled fields like audit-log operation/path).
// Each helper isolates one specific failure mode that has burned us in
// production-style scenarios — circular JSON, CSV-formula injection,
// scope-string parsing.

// ────────────────────────────────────────────────────────────────────
// safeJsonStringify — never throws.
//
// JSON.stringify throws TypeError on circular references, BigInt, etc.
// EventsView renders payloads inside <pre>{{ ... }}</pre>; an uncaught
// throw inside a render expression would blank the entire details panel.
// We swap a sentinel string for cycles via a WeakSet replacer.
// ────────────────────────────────────────────────────────────────────
export function safeJsonStringify(value: unknown, indent = 2): string {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') return `${v.toString()}n`
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]'
        seen.add(v)
      }
      return v
    }, indent) ?? ''
  } catch (e) {
    return `[Unserializable: ${e instanceof Error ? e.message : String(e)}]`
  }
}

// ────────────────────────────────────────────────────────────────────
// csvEscape — quote + neutralize Excel formula injection.
//
// CSV cells beginning with =, +, -, @, TAB, or CR are interpreted as
// formulas by Excel/LibreOffice/Sheets. An attacker who can land a
// crafted operation/scope/key_id string into the audit log can then
// pop a calc.exe (or worse, exfiltrate data via WEBSERVICE/IMPORTHTML)
// when an admin opens the export. OWASP CWE-1236.
//
// Mitigation: prefix dangerous leading chars with a single quote so the
// cell is treated as text. Also escape embedded quotes per RFC 4180.
// ────────────────────────────────────────────────────────────────────
const CSV_INJECT = /^[=+\-@\t\r]/
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '""'
  let s = String(value)
  if (CSV_INJECT.test(s)) s = "'" + s
  return '"' + s.replace(/"/g, '""') + '"'
}

// ────────────────────────────────────────────────────────────────────
// tenantFromScope — extract canonical tenant id from a scope path.
//
// Cycles scopes are slash-joined identifiers like "tenant:acme",
// "tenant:acme/workspace:prod", or "tenant:acme-corp/agent:summarizer".
// The fund-budget endpoint requires tenant_id as a query param; deep
// links into a budget detail don't carry it, so we derive it from the
// loaded ledger's scope. Returns '' for non-tenant scopes (system, etc).
// ────────────────────────────────────────────────────────────────────
export function tenantFromScope(scope: string | null | undefined): string {
  if (!scope) return ''
  const m = /^tenant:([^/]+)/.exec(scope)
  return m ? m[1] : ''
}

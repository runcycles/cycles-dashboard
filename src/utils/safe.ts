// Defensive helpers for content that originates from the server (or
// from arbitrary user-controlled fields like audit-log operation/path).
// Each helper isolates one specific failure mode that has burned us in
// production-style scenarios — circular JSON, CSV-formula injection,
// scope-string parsing.

// ────────────────────────────────────────────────────────────────────
// safeJsonStringify — never throws.
//
// JSON.stringify throws TypeError on circular references and on BigInt.
// EventsView and AuditView render payloads inside <pre>{{ ... }}</pre>; an
// uncaught throw inside a render expression blanks the entire details panel.
//
// Cycle detection uses a per-call ancestor STACK (not a WeakSet) so that a
// non-circular shared reference — `{a: X, b: X}` where X is the same object
// — is serialized twice, just like vanilla JSON.stringify does. A naive
// WeakSet "has-ever-seen" check would over-flag the second occurrence as
// `[Circular]` and corrupt the output. The stack is trimmed each call by
// matching the replacer's `this` (the holder object), which gives us the
// current ancestor chain because JSON.stringify recurses depth-first.
// ────────────────────────────────────────────────────────────────────
export function safeJsonStringify(value: unknown, indent = 2): string {
  const ancestors: object[] = []
  function replacer(this: unknown, _key: string, val: unknown): unknown {
    if (typeof val === 'bigint') return `${val.toString()}n`
    if (val && typeof val === 'object') {
      // Pop until the top of the stack is the current parent — JSON.stringify
      // walks depth-first, so anything past `this` is a sibling that already
      // returned. Without trimming, sibling subtrees would inherit each
      // other's ancestors and produce false-positive "[Circular]" markers.
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
        ancestors.pop()
      }
      if (ancestors.includes(val as object)) return '[Circular]'
      ancestors.push(val as object)
    }
    return val
  }
  try {
    return JSON.stringify(value, replacer, indent) ?? ''
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
// parsePositiveAmount — coerce a form-bound amount field to a positive
// finite number, or return null if invalid.
//
// Vue 3's v-model on `<input type="number">` auto-coerces user input to
// a number (via looseToNumber), but the initial value we bind is often
// an empty string — so the field can be either type at runtime. A
// previous version of submitFund called .trim() on this field, which
// threw `TypeError: trim is not a function` once the user typed and Vue
// coerced. Form-handler exceptions kill the submit silently from the
// user's POV ("Execute does nothing"). This helper has one job: turn
// whatever the input gave us into a validated number, or null.
//
//   parsePositiveAmount("100")  → 100
//   parsePositiveAmount(100)    → 100
//   parsePositiveAmount("")     → null  (empty)
//   parsePositiveAmount(0)      → null  (must be > 0)
//   parsePositiveAmount(-5)     → null
//   parsePositiveAmount("abc")  → null
//   parsePositiveAmount(NaN)    → null
//   parsePositiveAmount(null)   → null
//   parsePositiveAmount(undef)  → null
// ────────────────────────────────────────────────────────────────────
export function parsePositiveAmount(input: unknown): number | null {
  if (input === null || input === undefined || input === '') return null
  const n = Number(input)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
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

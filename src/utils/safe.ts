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
// validateScope — mirror of the server's ScopeValidator (cycles-server-
// admin v0.1.25.15). Client-side scope grammar check so users get
// instant feedback in the Create Budget / Create Policy dialogs
// instead of waiting for a 400 round-trip. Kept intentionally
// permissive-and-fail-fast: the server remains the source of truth,
// and anything the client accepts must still pass server validation.
//
// Canonical kind order per cycles-protocol-v0.yaml SCOPE DERIVATION:
//   tenant -> workspace -> app -> workflow -> agent -> toolset
//
// Returns null if valid, or a human-readable error message pointing
// at the offending segment. Usage:
//   const err = validateScope(form.scope, { allowWildcards: false })
//   if (err) { formError.value = err; return }
// ────────────────────────────────────────────────────────────────────
const CANONICAL_KINDS = ['tenant', 'workspace', 'app', 'workflow', 'agent', 'toolset'] as const
const ID_REGEX = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/
const MAX_ID_LEN = 128

export interface ValidateScopeOptions {
  // Policy scope_patterns allow terminal `*` (all descendants) and
  // id-wildcard (`agent:*`). Budget scopes must be concrete.
  allowWildcards?: boolean
  fieldName?: string
}

export function validateScope(
  scope: string | null | undefined,
  opts: ValidateScopeOptions = {},
): string | null {
  const field = opts.fieldName ?? 'scope'
  const allowWildcards = opts.allowWildcards ?? false
  if (!scope || !scope.trim()) return `${field} must not be blank`
  const segments = scope.split('/')
  let lastKindIdx = -1
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    if (segment === '') {
      return `${field} has an empty segment (leading, trailing, or consecutive '/')`
    }
    // Bare-* terminal (tenant:acme/* = all descendants)
    if (segment === '*') {
      if (!allowWildcards) return `${field} wildcards are not allowed in budget scopes (segment '*')`
      if (i !== segments.length - 1) return `${field} wildcard '*' must be the final segment`
      if (i === 0) return `${field} must start with 'tenant:<id>' before any wildcard`
      return null
    }
    const colon = segment.indexOf(':')
    if (colon <= 0 || colon === segment.length - 1) {
      return `${field} segment '${segment}' must be of form '<kind>:<id>'`
    }
    const kind = segment.slice(0, colon)
    const id = segment.slice(colon + 1)
    const kindIdx = (CANONICAL_KINDS as readonly string[]).indexOf(kind)
    if (kindIdx < 0) {
      return `${field} segment '${segment}' uses non-canonical kind '${kind}'. Allowed: ${CANONICAL_KINDS.join(', ')}`
    }
    if (i === 0 && kindIdx !== 0) {
      return `${field} must start with 'tenant:<id>' (got '${kind}:...')`
    }
    if (kindIdx <= lastKindIdx) {
      return `${field} kind '${kind}' appears out of canonical order (order is ${CANONICAL_KINDS.join(', ')}; same kind may not repeat)`
    }
    lastKindIdx = kindIdx
    if (id === '*') {
      if (!allowWildcards) return `${field} wildcards are not allowed in budget scopes (segment '${segment}')`
      if (i !== segments.length - 1) return `${field} wildcard '*' must be the final segment's id`
    } else {
      if (id.length > MAX_ID_LEN) return `${field} segment '${segment}' id exceeds ${MAX_ID_LEN} characters`
      if (!ID_REGEX.test(id)) {
        return `${field} segment '${segment}' id contains disallowed characters (must start and end with letter/digit; middle can include '.', '_', '-')`
      }
    }
  }
  return null
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

// Pure converters between the flat string-typed form model used by the
// PolicyAdvancedFields editor and the spec-shaped request/response
// objects (Caps / RateLimits / ReservationTtlOverride + effective
// window). Kept framework-free so they unit-test without mounting a
// component, and shared by both the create and edit policy dialogs so
// the two never drift.
import type { Caps, RateLimits, ReservationTtlOverride, Policy } from '../types'

// All inputs are strings (text/number/textarea bound), parsed at submit.
export interface PolicyAdvancedForm {
  max_tokens: string
  max_steps_remaining: string
  cooldown_ms: string
  tool_allowlist: string // newline- or comma-separated
  tool_denylist: string
  max_reservations_per_minute: string
  max_commits_per_minute: string
  default_ttl_ms: string
  max_ttl_ms: string
  max_extensions: string
  effective_from: string // datetime-local
  effective_until: string // datetime-local
}

export interface PolicyAdvancedRequest {
  caps?: Caps
  rate_limits?: RateLimits
  reservation_ttl_override?: ReservationTtlOverride
  effective_from?: string
  effective_until?: string
}

interface NumericRule {
  field: keyof PolicyAdvancedForm
  label: string
  minimum: number
  maximum?: number
}

const NUMERIC_RULES: readonly NumericRule[] = [
  { field: 'max_tokens', label: 'Max tokens', minimum: 0 },
  { field: 'max_steps_remaining', label: 'Max steps remaining', minimum: 0 },
  { field: 'cooldown_ms', label: 'Cooldown', minimum: 0 },
  { field: 'max_reservations_per_minute', label: 'Max reservations per minute', minimum: 1 },
  { field: 'max_commits_per_minute', label: 'Max commits per minute', minimum: 1 },
  { field: 'default_ttl_ms', label: 'Default TTL', minimum: 1000, maximum: 86400000 },
  { field: 'max_ttl_ms', label: 'Max TTL', minimum: 1000, maximum: 86400000 },
  { field: 'max_extensions', label: 'Max extensions', minimum: 0 },
]

export function emptyPolicyAdvancedForm(): PolicyAdvancedForm {
  return {
    max_tokens: '', max_steps_remaining: '', cooldown_ms: '',
    tool_allowlist: '', tool_denylist: '',
    max_reservations_per_minute: '', max_commits_per_minute: '',
    default_ttl_ms: '', max_ttl_ms: '', max_extensions: '',
    effective_from: '', effective_until: '',
  }
}

/** Validate the spec constraints that native inputs cannot enforce for direct calls. */
export function validatePolicyAdvancedForm(f: PolicyAdvancedForm): string | null {
  for (const rule of NUMERIC_RULES) {
    const text = String(f[rule.field]).trim()
    if (!text) continue
    const value = Number(text)
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      return `${rule.label} must be a whole number.`
    }
    if (value < rule.minimum || (rule.maximum !== undefined && value > rule.maximum)) {
      const range = rule.maximum === undefined
        ? `at least ${rule.minimum.toLocaleString()}`
        : `between ${rule.minimum.toLocaleString()} and ${rule.maximum.toLocaleString()}`
      return `${rule.label} must be ${range}.`
    }
  }

  for (const [field, label] of [
    ['tool_allowlist', 'Tool allowlist'],
    ['tool_denylist', 'Tool denylist'],
  ] as const) {
    const tooLong = f[field]
      .split(/[\n,]/)
      .map(value => value.trim())
      .find(value => value.length > 256)
    if (tooLong) return `${label} entries must be 256 characters or fewer.`
  }

  for (const [field, label] of [
    ['effective_from', 'Effective from'],
    ['effective_until', 'Effective until'],
  ] as const) {
    const value = f[field]
    if (value && Number.isNaN(new Date(value).getTime())) return `${label} must be a valid date and time.`
  }
  if (f.effective_from && f.effective_until) {
    const from = new Date(f.effective_from).getTime()
    const until = new Date(f.effective_until).getTime()
    if (until <= from) return 'Effective until must be later than effective from.'
  }
  return null
}

function numOrUndef(s: string): number | undefined {
  const t = s.trim()
  if (t === '') return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

function listOrUndef(s: string): string[] | undefined {
  const items = s.split(/[\n,]/).map(x => x.trim()).filter(Boolean)
  return items.length ? items : undefined
}

function isoOrUndef(s: string): string | undefined {
  if (!s) return undefined
  const d = new Date(s)
  return isNaN(d.getTime()) ? undefined : d.toISOString()
}

// Drop undefined values; return undefined if nothing remains so the
// caller can omit the whole sub-object (don't send `caps: {}`).
function compact<T extends object>(o: T): T | undefined {
  const entries = Object.entries(o).filter(([, v]) => v !== undefined)
  return entries.length ? (Object.fromEntries(entries) as T) : undefined
}

export function policyAdvancedToRequest(f: PolicyAdvancedForm): PolicyAdvancedRequest {
  const out: PolicyAdvancedRequest = {}
  const caps = compact<Caps>({
    max_tokens: numOrUndef(f.max_tokens),
    max_steps_remaining: numOrUndef(f.max_steps_remaining),
    cooldown_ms: numOrUndef(f.cooldown_ms),
    tool_allowlist: listOrUndef(f.tool_allowlist),
    tool_denylist: listOrUndef(f.tool_denylist),
  })
  if (caps) out.caps = caps
  const rate_limits = compact<RateLimits>({
    max_reservations_per_minute: numOrUndef(f.max_reservations_per_minute),
    max_commits_per_minute: numOrUndef(f.max_commits_per_minute),
  })
  if (rate_limits) out.rate_limits = rate_limits
  const ttl = compact<ReservationTtlOverride>({
    default_ttl_ms: numOrUndef(f.default_ttl_ms),
    max_ttl_ms: numOrUndef(f.max_ttl_ms),
    max_extensions: numOrUndef(f.max_extensions),
  })
  if (ttl) out.reservation_ttl_override = ttl
  const ef = isoOrUndef(f.effective_from)
  if (ef) out.effective_from = ef
  const eu = isoOrUndef(f.effective_until)
  if (eu) out.effective_until = eu
  return out
}

// ISO 8601 → datetime-local input value (local time, minute precision).
function isoToLocalInput(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Pre-fill the editor from an existing policy (edit flow).
export function policyToAdvancedForm(p: Policy): PolicyAdvancedForm {
  const f = emptyPolicyAdvancedForm()
  if (p.caps) {
    if (p.caps.max_tokens !== undefined) f.max_tokens = String(p.caps.max_tokens)
    if (p.caps.max_steps_remaining !== undefined) f.max_steps_remaining = String(p.caps.max_steps_remaining)
    if (p.caps.cooldown_ms !== undefined) f.cooldown_ms = String(p.caps.cooldown_ms)
    if (p.caps.tool_allowlist) f.tool_allowlist = p.caps.tool_allowlist.join('\n')
    if (p.caps.tool_denylist) f.tool_denylist = p.caps.tool_denylist.join('\n')
  }
  if (p.rate_limits) {
    if (p.rate_limits.max_reservations_per_minute !== undefined) f.max_reservations_per_minute = String(p.rate_limits.max_reservations_per_minute)
    if (p.rate_limits.max_commits_per_minute !== undefined) f.max_commits_per_minute = String(p.rate_limits.max_commits_per_minute)
  }
  if (p.reservation_ttl_override) {
    if (p.reservation_ttl_override.default_ttl_ms !== undefined) f.default_ttl_ms = String(p.reservation_ttl_override.default_ttl_ms)
    if (p.reservation_ttl_override.max_ttl_ms !== undefined) f.max_ttl_ms = String(p.reservation_ttl_override.max_ttl_ms)
    if (p.reservation_ttl_override.max_extensions !== undefined) f.max_extensions = String(p.reservation_ttl_override.max_extensions)
  }
  f.effective_from = isoToLocalInput(p.effective_from)
  f.effective_until = isoToLocalInput(p.effective_until)
  return f
}

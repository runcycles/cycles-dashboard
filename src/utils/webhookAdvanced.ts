// Pure converters between the flat string-typed form model used by the
// WebhookAdvancedFields editor and the spec-shaped WebhookThresholdConfig
// / WebhookRetryPolicy objects. Framework-free for unit-testing, shared
// by the webhook create (WebhooksView) and edit (WebhookDetailView) flows.
import type { WebhookThresholdConfig, WebhookRetryPolicy, WebhookSubscription } from '../types'

export interface WebhookAdvancedForm {
  // thresholds
  budget_utilization: string // comma-separated fractions, e.g. "0.8, 0.95"
  burn_rate_multiplier: string
  burn_rate_window_seconds: string
  denial_rate_threshold: string
  expiry_rate_threshold: string
  auth_failure_rate_threshold: string
  rate_window_seconds: string
  // retry policy
  max_retries: string
  initial_delay_ms: string
  backoff_multiplier: string
  max_delay_ms: string
}

export interface WebhookAdvancedRequest {
  thresholds?: WebhookThresholdConfig
  retry_policy?: WebhookRetryPolicy
}

export function emptyWebhookAdvancedForm(): WebhookAdvancedForm {
  return {
    budget_utilization: '', burn_rate_multiplier: '', burn_rate_window_seconds: '',
    denial_rate_threshold: '', expiry_rate_threshold: '', auth_failure_rate_threshold: '',
    rate_window_seconds: '',
    max_retries: '', initial_delay_ms: '', backoff_multiplier: '', max_delay_ms: '',
  }
}

function numOrUndef(s: string): number | undefined {
  const t = s.trim()
  if (t === '') return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

function numListOrUndef(s: string): number[] | undefined {
  const tokens = s.split(/[\n,]/).map(x => x.trim()).filter(Boolean)
  if (!tokens.length) return undefined
  const nums = tokens.map(Number)
  // Drop the whole list if any token isn't a finite number — partial
  // parsing would silently send a malformed threshold set.
  if (nums.some(n => !Number.isFinite(n))) return undefined
  return nums
}

function compact<T extends object>(o: T): T | undefined {
  const entries = Object.entries(o).filter(([, v]) => v !== undefined)
  return entries.length ? (Object.fromEntries(entries) as T) : undefined
}

// Validate the free-text fields before submit. Returns an error string,
// or null when the form is acceptable. Only budget_utilization needs
// this — it's a comma-separated text field, so a typo (e.g. "0.8, nope")
// would otherwise be silently dropped by numListOrUndef and the webhook
// saved without the intended threshold. The other numeric fields are
// type=number inputs the browser constrains, so they don't need it.
export function webhookAdvancedError(f: WebhookAdvancedForm): string | null {
  const tokens = f.budget_utilization.split(/[\n,]/).map(x => x.trim()).filter(Boolean)
  for (const t of tokens) {
    const n = Number(t)
    if (!Number.isFinite(n)) return `Budget utilization "${t}" is not a number.`
    if (n < 0 || n > 1) return `Budget utilization "${t}" must be between 0 and 1.`
  }
  return null
}

export function webhookAdvancedToRequest(f: WebhookAdvancedForm): WebhookAdvancedRequest {
  const out: WebhookAdvancedRequest = {}
  const thresholds = compact<WebhookThresholdConfig>({
    budget_utilization: numListOrUndef(f.budget_utilization),
    burn_rate_multiplier: numOrUndef(f.burn_rate_multiplier),
    burn_rate_window_seconds: numOrUndef(f.burn_rate_window_seconds),
    denial_rate_threshold: numOrUndef(f.denial_rate_threshold),
    expiry_rate_threshold: numOrUndef(f.expiry_rate_threshold),
    auth_failure_rate_threshold: numOrUndef(f.auth_failure_rate_threshold),
    rate_window_seconds: numOrUndef(f.rate_window_seconds),
  })
  if (thresholds) out.thresholds = thresholds
  const retry_policy = compact<WebhookRetryPolicy>({
    max_retries: numOrUndef(f.max_retries),
    initial_delay_ms: numOrUndef(f.initial_delay_ms),
    backoff_multiplier: numOrUndef(f.backoff_multiplier),
    max_delay_ms: numOrUndef(f.max_delay_ms),
  })
  if (retry_policy) out.retry_policy = retry_policy
  return out
}

export function webhookToAdvancedForm(w: WebhookSubscription): WebhookAdvancedForm {
  const f = emptyWebhookAdvancedForm()
  const t = w.thresholds
  if (t) {
    if (t.budget_utilization) f.budget_utilization = t.budget_utilization.join(', ')
    if (t.burn_rate_multiplier !== undefined) f.burn_rate_multiplier = String(t.burn_rate_multiplier)
    if (t.burn_rate_window_seconds !== undefined) f.burn_rate_window_seconds = String(t.burn_rate_window_seconds)
    if (t.denial_rate_threshold !== undefined) f.denial_rate_threshold = String(t.denial_rate_threshold)
    if (t.expiry_rate_threshold !== undefined) f.expiry_rate_threshold = String(t.expiry_rate_threshold)
    if (t.auth_failure_rate_threshold !== undefined) f.auth_failure_rate_threshold = String(t.auth_failure_rate_threshold)
    if (t.rate_window_seconds !== undefined) f.rate_window_seconds = String(t.rate_window_seconds)
  }
  const r = w.retry_policy
  if (r) {
    if (r.max_retries !== undefined) f.max_retries = String(r.max_retries)
    if (r.initial_delay_ms !== undefined) f.initial_delay_ms = String(r.initial_delay_ms)
    if (r.backoff_multiplier !== undefined) f.backoff_multiplier = String(r.backoff_multiplier)
    if (r.max_delay_ms !== undefined) f.max_delay_ms = String(r.max_delay_ms)
  }
  return f
}

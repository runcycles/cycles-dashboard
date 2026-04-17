import { useAuthStore } from '../stores/auth'
import router from '../router'

const BASE = '/v1'
const DEFAULT_TIMEOUT_MS = 30_000

// Structured error matching the admin spec's ErrorResponse schema
// ({ error, message, request_id, details? }). When the server returns a
// 4xx/5xx with a conformant JSON body, callers can `instanceof ApiError`
// to surface the specific `errorCode` (e.g. DUPLICATE_RESOURCE,
// ALREADY_REVOKED, BUDGET_EXCEEDED) in UI toasts instead of a generic
// "API error: 409". `message` is set to a human-friendly combination of
// the server's message + code so existing `err.message` consumers get a
// better string for free.
export class ApiError extends Error {
  readonly status: number
  readonly errorCode?: string
  readonly requestId?: string
  readonly details?: Record<string, unknown>

  constructor(
    status: number,
    message: string,
    errorCode?: string,
    requestId?: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.errorCode = errorCode
    this.requestId = requestId
    this.details = details
  }
}

// Parses a non-2xx response into an ApiError. Tries to read the
// ErrorResponse JSON body; falls back to a generic "API error: <status>"
// when the body is missing, empty, or not JSON (e.g. an upstream proxy
// returned an HTML error page).
async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return new ApiError(res.status, `API error: ${res.status}`)
  }
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    const code = typeof b.error === 'string' ? b.error : undefined
    const msg = typeof b.message === 'string' ? b.message : undefined
    const reqId = typeof b.request_id === 'string' ? b.request_id : undefined
    const details = b.details && typeof b.details === 'object'
      ? (b.details as Record<string, unknown>)
      : undefined
    const friendly = msg && code ? `${msg} (${code})`
      : msg ?? code ?? `API error: ${res.status}`
    return new ApiError(res.status, friendly, code, reqId, details)
  }
  return new ApiError(res.status, `API error: ${res.status}`)
}

// Wraps `fetch` with an AbortController-backed timeout. A hung backend should
// fail after `timeoutMs` rather than spin the UI forever. Translates the
// timeout-triggered AbortError into a clear error message so callers don't
// need to pattern-match on the low-level DOMException.
//
// Callers may pass an external `signal` (e.g. from usePolling's per-tick
// controller) — if that signal is aborted, the fetch is cancelled and the
// original AbortError is re-thrown unchanged (so callers that specifically
// handle cancellation via name==='AbortError' still see it). The timeout
// path wraps the AbortError in a friendly message as before.
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs)
  // If caller passed a signal, abort when *either* it fires OR the timeout
  // fires. Use a linked controller to merge the two.
  const externalSignal = init.signal ?? null
  const linkedController = new AbortController()
  const onTimeout = () => linkedController.abort(new Error('timeout'))
  const onExternal = () => linkedController.abort(externalSignal?.reason)
  timeoutController.signal.addEventListener('abort', onTimeout)
  externalSignal?.addEventListener('abort', onExternal)
  // Propagate an already-aborted external signal immediately.
  if (externalSignal?.aborted) linkedController.abort(externalSignal.reason)
  try {
    return await fetch(url, { ...init, signal: linkedController.signal })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      // Distinguish timeout from external abort. Timeout gets a
      // human-readable message; external abort (e.g. from usePolling on
      // unmount) rethrows the original so callers can detect it by name.
      if (timeoutController.signal.aborted && !externalSignal?.aborted) {
        throw new Error(`Request timed out after ${timeoutMs}ms`)
      }
      throw e
    }
    throw e
  } finally {
    clearTimeout(timer)
    timeoutController.signal.removeEventListener('abort', onTimeout)
    externalSignal?.removeEventListener('abort', onExternal)
  }
}

async function request<T>(
  method: string,
  path: string,
  params?: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const auth = useAuthStore()
  const url = new URL(path, window.location.origin)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v)
    }
  }
  const res = await fetchWithTimeout(url.toString(), {
    method,
    headers: { 'X-Admin-API-Key': auth.apiKey, 'Content-Type': 'application/json' },
    signal,
  })
  // 401 = key missing/invalid → end session.
  // 403 = authenticated but not permitted for THIS op → keep session,
  // surface an ApiError so the view shows the error (logging out on 403
  // destroyed the session on e.g. webhook-security PUT attempts where
  // the key lacked admin:webhooks:write but the rest of the app worked).
  if (res.status === 401) {
    handleUnauthorized()
    throw new Error('Unauthorized')
  }
  if (!res.ok) throw await toApiError(res)
  try {
    return await res.json()
  } catch {
    throw new Error('Invalid response from server')
  }
}

// Centralized 401 handling. Logs out and redirects to /login — but only
// if we're not already there. This avoids a race where an in-flight fetch
// from an unmounting protected view resolves *after* logout has already
// navigated to /login, producing `/login?redirect=/login`.
// NOTE: 403 is intentionally NOT handled here — "forbidden for this op"
// must not end the whole session.
export function handleUnauthorized() {
  const auth = useAuthStore()
  auth.logout()
  const current = router.currentRoute.value
  if (current.name === 'login') return
  router.push({ name: 'login', query: { redirect: current.fullPath } })
}

function get<T>(
  path: string,
  params?: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  return request<T>('GET', path, params, signal)
}

async function mutate<T>(method: string, path: string, body?: Record<string, unknown>, params?: Record<string, string>): Promise<T> {
  const auth = useAuthStore()
  const url = new URL(path, window.location.origin)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v)
    }
  }
  const res = await fetchWithTimeout(url.toString(), {
    method,
    headers: { 'X-Admin-API-Key': auth.apiKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  // 401 = key missing/invalid → end session.
  // 403 = authenticated but not permitted for THIS op → keep session,
  // surface an ApiError so the view shows the error (logging out on 403
  // destroyed the session on e.g. webhook-security PUT attempts where
  // the key lacked admin:webhooks:write but the rest of the app worked).
  if (res.status === 401) {
    handleUnauthorized()
    throw new Error('Unauthorized')
  }
  if (!res.ok) throw await toApiError(res)
  if (res.status === 204) return undefined as T
  try { return await res.json() } catch { throw new Error('Invalid response from server') }
}

function patch<T>(path: string, body: Record<string, unknown>): Promise<T> {
  return mutate<T>('PATCH', path, body)
}

function post<T>(path: string, body: Record<string, unknown>, params?: Record<string, string>): Promise<T> {
  return mutate<T>('POST', path, body, params)
}

function del<T>(path: string, params?: Record<string, string>): Promise<T> {
  return mutate<T>('DELETE', path, undefined, params)
}

// Auth
export const introspect = () => get<import('../types').AuthIntrospectResponse>(`${BASE}/auth/introspect`)

// Overview
export const getOverview = () => get<import('../types').AdminOverviewResponse>(`${BASE}/admin/overview`)

// Budgets
export const listBudgets = (params: Record<string, string>) =>
  get<import('../types').BudgetListResponse>(`${BASE}/admin/budgets`, params)

export const lookupBudget = (scope: string, unit: string) =>
  get<import('../types').BudgetLedger>(`${BASE}/admin/budgets/lookup`, { scope, unit })

// Events
export const listEvents = (params: Record<string, string>) =>
  get<import('../types').EventListResponse>(`${BASE}/admin/events`, params)

// Webhooks
export const listWebhooks = (params?: Record<string, string>) =>
  get<import('../types').WebhookListResponse>(`${BASE}/admin/webhooks`, params)

export const getWebhook = (id: string) =>
  get<import('../types').WebhookSubscription>(`${BASE}/admin/webhooks/${id}`)

export const listDeliveries = (id: string, params?: Record<string, string>) =>
  get<import('../types').WebhookDeliveryListResponse>(`${BASE}/admin/webhooks/${id}/deliveries`, params)

// Audit
export const listAuditLogs = (params: Record<string, string>) =>
  get<import('../types').AuditLogListResponse>(`${BASE}/admin/audit/logs`, params)

// Tenants
export const listTenants = (params?: Record<string, string>) =>
  get<import('../types').TenantListResponse>(`${BASE}/admin/tenants`, params)

export const getTenant = (id: string) =>
  get<import('../types').Tenant>(`${BASE}/admin/tenants/${id}`)

// API Keys
export const listApiKeys = (params?: Record<string, string>) =>
  get<import('../types').ApiKeyListResponse>(`${BASE}/admin/api-keys`, params)

// Policies
export const listPolicies = (params: Record<string, string>) =>
  get<import('../types').PolicyListResponse>(`${BASE}/admin/policies`, params)

// v0.1.25.20: createPolicy — admin-on-behalf-of (spec v0.1.25.13). Same
// shape as createBudget — tenant_id required in body, server uses it to
// scope the new policy to the target tenant.
export function createPolicy(
  tenantId: string,
  body: import('../types').PolicyCreateRequest,
): Promise<import('../types').Policy> {
  return post<import('../types').Policy>(
    `${BASE}/admin/policies`,
    { ...(body as unknown as Record<string, unknown>), tenant_id: tenantId },
  )
}

// v0.1.25.20: updatePolicy — admin-on-behalf-of. Unlike create, no
// tenant_id is needed in the body — policy_id pins the owning tenant
// in the persistence layer, server resolves it server-side.
export const updatePolicy = (policyId: string, body: import('../types').PolicyUpdateRequest) =>
  patch<import('../types').Policy>(`${BASE}/admin/policies/${policyId}`, body as unknown as Record<string, unknown>)

// ── Write operations ────────────────────────────────────────────────

// Tenants
export const createTenant = (body: import('../types').TenantCreateRequest) =>
  post<import('../types').Tenant>(`${BASE}/admin/tenants`, body as unknown as Record<string, unknown>)

export const updateTenant = (id: string, body: import('../types').TenantUpdateRequest) =>
  patch<import('../types').Tenant>(`${BASE}/admin/tenants/${id}`, body as unknown as Record<string, unknown>)

export const updateTenantStatus = (id: string, status: string) =>
  patch<import('../types').Tenant>(`${BASE}/admin/tenants/${id}`, { status })

// API Keys
export const createApiKey = (body: import('../types').ApiKeyCreateRequest) =>
  post<import('../types').ApiKeyCreateResponse>(`${BASE}/admin/api-keys`, body as unknown as Record<string, unknown>)

export const updateApiKey = (keyId: string, body: import('../types').ApiKeyUpdateRequest) =>
  patch<import('../types').ApiKey>(`${BASE}/admin/api-keys/${keyId}`, body as unknown as Record<string, unknown>)

export const revokeApiKey = (keyId: string, reason?: string) =>
  del<import('../types').ApiKey>(`${BASE}/admin/api-keys/${keyId}`, reason ? { reason } : undefined)

// Webhooks
export const createWebhook = (body: import('../types').WebhookCreateRequest, tenantId?: string) =>
  post<import('../types').WebhookCreateResponse>(`${BASE}/admin/webhooks`, body as unknown as Record<string, unknown>, tenantId ? { tenant_id: tenantId } : undefined)

export const updateWebhook = (id: string, body: Record<string, unknown>) =>
  patch<import('../types').WebhookSubscription>(`${BASE}/admin/webhooks/${id}`, body)

export const deleteWebhook = (id: string) =>
  del<void>(`${BASE}/admin/webhooks/${id}`)

export const testWebhook = (id: string) =>
  post<import('../types').WebhookTestResponse>(`${BASE}/admin/webhooks/${id}/test`, {})

export const replayWebhookEvents = (id: string, body: import('../types').ReplayEventsRequest) =>
  post<import('../types').ReplayEventsResponse>(`${BASE}/admin/webhooks/${id}/replay`, body as unknown as Record<string, unknown>)

// Budgets

// v0.1.25.20: createBudget — admin-on-behalf-of (spec v0.1.25.13, server
// v0.1.25.14). Dashboard authenticates with admin key, so tenant_id MUST
// be in the body — the server uses it to route the create to the correct
// tenant. The wrapper stitches the field in to keep the call sites tidy.
export function createBudget(
  tenantId: string,
  body: import('../types').BudgetCreateRequest,
): Promise<import('../types').BudgetLedger> {
  return post<import('../types').BudgetLedger>(
    `${BASE}/admin/budgets`,
    { ...(body as unknown as Record<string, unknown>), tenant_id: tenantId },
  )
}

export const updateBudgetConfig = (scope: string, unit: string, body: Record<string, unknown>) =>
  mutate<import('../types').BudgetLedger>('PATCH', `${BASE}/admin/budgets`, body, { scope, unit })

export const freezeBudget = (scope: string, unit: string, reason?: string) =>
  post<import('../types').BudgetLedger>(`${BASE}/admin/budgets/freeze`, reason ? { reason } : {}, { scope, unit })

export const unfreezeBudget = (scope: string, unit: string, reason?: string) =>
  post<import('../types').BudgetLedger>(`${BASE}/admin/budgets/unfreeze`, reason ? { reason } : {}, { scope, unit })

// v0.1.25.27: adds optional `spent` for the RESET_SPENT operation introduced
// in cycles-server-admin 0.1.25.18 (billing-period rollover). Server
// semantics (per FUND_LUA in admin BudgetRepository): RESET_SPENT sets
// allocated = amount AND spent = `spent` override (default 0). So `amount`
// is the NEW allocated for the new period — callers should typically pass
// the budget's current allocated for a pure rollover. The server only reads
// `spent` when operation === 'RESET_SPENT'; for all other operations it's
// omitted from the body so we don't send payload the server would ignore.
export function fundBudget(
  tenantId: string,
  scope: string,
  unit: string,
  operation: string,
  amount: number,
  idempotencyKey: string,
  reason?: string,
  spent?: number,
): Promise<import('../types').BudgetLedger> {
  const body: Record<string, unknown> = { operation, amount: { unit, amount }, idempotency_key: idempotencyKey }
  if (reason) body.reason = reason
  if (operation === 'RESET_SPENT' && typeof spent === 'number') {
    body.spent = { unit, amount: spent }
  }
  return post<import('../types').BudgetLedger>(`${BASE}/admin/budgets/fund`, body, { tenant_id: tenantId, scope, unit })
}

// Webhook — rotate signing secret (generate cryptographically strong secret).
// The secret is generated client-side and PATCHed to the server; the server
// response typically does NOT echo the secret back (secrets are write-only
// by design). We return the locally-generated value alongside the updated
// subscription so the caller can display it once — callers that rely on
// `res.signing_secret` from the server response would see `undefined` and
// silently render nothing.
export async function rotateWebhookSecret(id: string): Promise<{
  subscription: import('../types').WebhookSubscription
  signing_secret: string
}> {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const secret = 'whsec_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  const subscription = await patch<import('../types').WebhookSubscription>(`${BASE}/admin/webhooks/${id}`, { signing_secret: secret })
  return { subscription, signing_secret: secret }
}

// Webhook security config
export const getWebhookSecurityConfig = () =>
  get<import('../types').WebhookSecurityConfig>(`${BASE}/admin/config/webhook-security`)

export const updateWebhookSecurityConfig = (body: import('../types').WebhookSecurityConfig) =>
  mutate<import('../types').WebhookSecurityConfig>('PUT', `${BASE}/admin/config/webhook-security`, body as unknown as Record<string, unknown>)

// v0.1.25.22: reservations (runtime plane — cycles-server v0.1.25.8+,
// cycles-protocol revision 2026-04-13). Three dual-auth endpoints the
// admin dashboard uses to surface and force-release hung reservations.
// Routed through the same `/v1/*` proxy as admin calls (dashboard
// nginx forwards `/v1/*` to the runtime server; admin-key auth is
// accepted on this allowlisted subset).
//
// listReservations under admin auth requires `tenant` as a filter
// (server returns 400 INVALID_REQUEST otherwise). The wrapper
// enforces this client-side so a missing tenantId never reaches the
// server — callers pass it as a separate positional arg rather than
// stuffing it into the params record, matching the explicit-scoping
// feel of fundBudget / createBudget.

// Reservations use /v1/reservations (runtime plane), NOT /v1/admin/*.
// Server interceptor accepts X-Admin-API-Key on this allowlisted subset.
export function listReservations(
  tenantId: string,
  params?: {
    status?: string
    limit?: number
    cursor?: string
    // v0.1.25.12 (cycles-server): server-side sort on GET /v1/reservations.
    // Valid sort_by: reservation_id | tenant | scope_path | status | reserved
    //              | created_at_ms  | expires_at_ms
    // Valid sort_dir: asc | desc (server defaults to desc when sort_by is
    // provided; omit both for legacy SCAN-order pagination).
    sort_by?: string
    sort_dir?: 'asc' | 'desc'
  },
): Promise<import('../types').ReservationListResponse> {
  const q: Record<string, string> = { tenant: tenantId }
  if (params?.status) q.status = params.status
  if (params?.limit !== undefined) q.limit = String(params.limit)
  if (params?.cursor) q.cursor = params.cursor
  if (params?.sort_by) q.sort_by = params.sort_by
  if (params?.sort_dir) q.sort_dir = params.sort_dir
  return get<import('../types').ReservationListResponse>(`/v1/reservations`, q)
}

export const getReservation = (reservationId: string) =>
  get<import('../types').ReservationSummary>(`/v1/reservations/${reservationId}`)

// Force-release a reservation. Optional `reason` is passed through to
// the server (surfaced in the audit-log entry's metadata); the
// dashboard nudges callers toward a structured prefix per the spec's
// SHOULD guidance ("[INCIDENT_FORCE_RELEASE] ..."). idempotencyKey is
// generated client-side — the runtime plane requires it on every
// release, even when admin-driven.
export function releaseReservation(
  reservationId: string,
  idempotencyKey: string,
  reason?: string,
): Promise<unknown> {
  const body: Record<string, unknown> = { idempotency_key: idempotencyKey }
  if (reason) body.reason = reason
  return post<unknown>(`/v1/reservations/${reservationId}/release`, body)
}


import { useAuthStore } from '../stores/auth'
import router from '../router'

const BASE = '/v1'

async function request<T>(method: string, path: string, params?: Record<string, string>): Promise<T> {
  const auth = useAuthStore()
  const url = new URL(path, window.location.origin)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v)
    }
  }
  const res = await fetch(url.toString(), {
    method,
    headers: { 'X-Admin-API-Key': auth.apiKey, 'Content-Type': 'application/json' },
  })
  if (res.status === 401 || res.status === 403) {
    auth.logout()
    router.push({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } })
    throw new Error('Unauthorized')
  }
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  try {
    return await res.json()
  } catch {
    throw new Error('Invalid response from server')
  }
}

function get<T>(path: string, params?: Record<string, string>): Promise<T> {
  return request<T>('GET', path, params)
}

function patch<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const auth = useAuthStore()
  return fetch(`${window.location.origin}${path}`, {
    method: 'PATCH',
    headers: { 'X-Admin-API-Key': auth.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => {
    if (res.status === 401 || res.status === 403) {
      auth.logout()
      router.push({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } })
      throw new Error('Unauthorized')
    }
    if (!res.ok) throw new Error(`API error: ${res.status}`)
    try { return await res.json() } catch { throw new Error('Invalid response from server') }
  })
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

// Write operations — Tenant
export const updateTenantStatus = (id: string, status: string) =>
  patch<import('../types').Tenant>(`${BASE}/admin/tenants/${id}`, { status })

// Write operations — API Keys (DELETE per spec, not PATCH)
export function revokeApiKey(keyId: string, reason?: string): Promise<import('../types').ApiKey> {
  const auth = useAuthStore()
  const url = new URL(`${BASE}/admin/api-keys/${keyId}`, window.location.origin)
  if (reason) url.searchParams.set('reason', reason)
  return fetch(url.toString(), {
    method: 'DELETE',
    headers: { 'X-Admin-API-Key': auth.apiKey, 'Content-Type': 'application/json' },
  }).then(async (res) => {
    if (res.status === 401 || res.status === 403) {
      auth.logout()
      router.push({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } })
      throw new Error('Unauthorized')
    }
    if (!res.ok) throw new Error(`API error: ${res.status}`)
    try { return await res.json() } catch { throw new Error('Invalid response from server') }
  })
}

// Write operations — Webhooks (PATCH with status ACTIVE/PAUSED per spec)
export const updateWebhook = (id: string, body: Record<string, unknown>) =>
  patch<import('../types').WebhookSubscription>(`${BASE}/admin/webhooks/${id}`, body)

// Write operations — Budget freeze/unfreeze (POST, AdminKeyAuth, scope+unit query params)
export function freezeBudget(scope: string, unit: string, reason?: string): Promise<import('../types').BudgetLedger> {
  return postAction(`${BASE}/admin/budgets/freeze`, { scope, unit }, reason ? { reason } : undefined)
}

export function unfreezeBudget(scope: string, unit: string, reason?: string): Promise<import('../types').BudgetLedger> {
  return postAction(`${BASE}/admin/budgets/unfreeze`, { scope, unit }, reason ? { reason } : undefined)
}

// Write operations — Budget funding (POST, dual-auth, scope+unit+tenant_id query params)
export function fundBudget(tenantId: string, scope: string, unit: string, operation: string, amount: number, idempotencyKey: string, reason?: string): Promise<import('../types').BudgetLedger> {
  const body: Record<string, unknown> = {
    operation,
    amount: { unit, amount },
    idempotency_key: idempotencyKey,
  }
  if (reason) body.reason = reason
  return postAction(`${BASE}/admin/budgets/fund`, { tenant_id: tenantId, scope, unit }, body)
}

// Shared POST helper for budget action endpoints
function postAction<T>(path: string, params: Record<string, string>, body?: Record<string, unknown>): Promise<T> {
  const auth = useAuthStore()
  const url = new URL(path, window.location.origin)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return fetch(url.toString(), {
    method: 'POST',
    headers: { 'X-Admin-API-Key': auth.apiKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => {
    if (res.status === 401 || res.status === 403) {
      auth.logout()
      router.push({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } })
      throw new Error('Unauthorized')
    }
    if (!res.ok) throw new Error(`API error: ${res.status}`)
    try { return await res.json() } catch { throw new Error('Invalid response from server') }
  })
}


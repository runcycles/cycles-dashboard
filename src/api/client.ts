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

async function mutate<T>(method: string, path: string, body?: Record<string, unknown>, params?: Record<string, string>): Promise<T> {
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
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401 || res.status === 403) {
    auth.logout()
    router.push({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } })
    throw new Error('Unauthorized')
  }
  if (!res.ok) throw new Error(`API error: ${res.status}`)
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
export const freezeBudget = (scope: string, unit: string, reason?: string) =>
  post<import('../types').BudgetLedger>(`${BASE}/admin/budgets/freeze`, reason ? { reason } : {}, { scope, unit })

export const unfreezeBudget = (scope: string, unit: string, reason?: string) =>
  post<import('../types').BudgetLedger>(`${BASE}/admin/budgets/unfreeze`, reason ? { reason } : {}, { scope, unit })

export function fundBudget(tenantId: string, scope: string, unit: string, operation: string, amount: number, idempotencyKey: string, reason?: string): Promise<import('../types').BudgetLedger> {
  const body: Record<string, unknown> = { operation, amount: { unit, amount }, idempotency_key: idempotencyKey }
  if (reason) body.reason = reason
  return post<import('../types').BudgetLedger>(`${BASE}/admin/budgets/fund`, body, { tenant_id: tenantId, scope, unit })
}

// Webhook — rotate signing secret
export const rotateWebhookSecret = (id: string) =>
  patch<import('../types').WebhookSubscription & { signing_secret?: string }>(`${BASE}/admin/webhooks/${id}`, { signing_secret: crypto.randomUUID() })

// Webhook security config
export const getWebhookSecurityConfig = () =>
  get<import('../types').WebhookSecurityConfig>(`${BASE}/admin/config/webhook-security`)

export const updateWebhookSecurityConfig = (body: import('../types').WebhookSecurityConfig) =>
  mutate<import('../types').WebhookSecurityConfig>('PUT', `${BASE}/admin/config/webhook-security`, body as unknown as Record<string, unknown>)


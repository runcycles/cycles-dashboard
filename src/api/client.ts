import { useAuthStore } from '../stores/auth'

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
    throw new Error('Unauthorized')
  }
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

function get<T>(path: string, params?: Record<string, string>): Promise<T> {
  return request<T>('GET', path, params)
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

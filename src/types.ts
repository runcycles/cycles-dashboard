// API response types matching the governance spec

export interface Capabilities {
  view_overview: boolean
  view_budgets: boolean
  view_events: boolean
  view_webhooks: boolean
  view_audit: boolean
  view_tenants: boolean
  view_api_keys: boolean
  view_policies: boolean
  manage_budgets?: boolean
  manage_tenants?: boolean
  manage_api_keys?: boolean
  manage_webhooks?: boolean
  // v0.1.25.20: introspect surfaces a manage_policies flag so the dashboard
  // can hide Create/Edit Policy buttons for keys that lack policies:write.
  // Older servers don't return this flag — undefined defaults to "allow"
  // so existing deployments keep working; a stricter setup can return
  // explicit false to gate the UI.
  manage_policies?: boolean
}

export interface AuthIntrospectResponse {
  authenticated: boolean
  auth_type: string
  permissions: string[]
  capabilities: Capabilities
}

// Overview types
export interface TenantCounts {
  total: number; active: number; suspended: number; closed: number
}

export interface BudgetCounts {
  total: number; active: number; frozen: number; closed: number
  over_limit: number; with_debt: number
  by_unit: Record<string, number>
}

export interface OverLimitScope {
  scope: string; unit: string; allocated: number; remaining: number; debt: number
}

export interface DebtScope {
  scope: string; unit: string; debt: number; overdraft_limit: number
}

export interface WebhookCounts {
  total: number; active: number; disabled: number; with_failures: number
}

export interface FailingWebhook {
  subscription_id: string; url: string; consecutive_failures: number; last_failure_at?: string
}

export interface EventCounts {
  total_recent: number; by_category: Record<string, number>
}

export interface AdminOverviewResponse {
  as_of: string
  event_window_seconds: number
  tenant_counts: TenantCounts
  budget_counts: BudgetCounts
  over_limit_scopes: OverLimitScope[]
  debt_scopes: DebtScope[]
  webhook_counts: WebhookCounts
  failing_webhooks: FailingWebhook[]
  event_counts: EventCounts
  recent_denials: Event[]
  recent_expiries: Event[]
}

// Budget types
export interface Amount {
  unit: string; amount: number
}

export interface BudgetLedger {
  ledger_id: string
  scope: string
  unit: string
  allocated: Amount
  remaining: Amount
  reserved?: Amount
  spent?: Amount
  debt?: Amount
  overdraft_limit?: Amount
  is_over_limit?: boolean
  status: string
  commit_overage_policy?: string
  rollover_policy?: string
  period_start?: string
  period_end?: string
  created_at: string
  updated_at?: string
}

export interface BudgetListResponse {
  ledgers: BudgetLedger[]
  has_more: boolean
  next_cursor?: string
}

// Event types
export interface Actor {
  type: string
  key_id?: string
  source_ip?: string
}

export interface Event {
  event_id: string
  event_type: string
  category: string
  timestamp: string
  tenant_id: string
  scope?: string
  actor?: Actor
  source: string
  data?: Record<string, unknown>
  correlation_id?: string
  request_id?: string
}

export interface EventListResponse {
  events: Event[]
  has_more: boolean
  next_cursor?: string
}

// Webhook types
export interface WebhookSubscription {
  subscription_id: string
  tenant_id: string
  name?: string
  url: string
  event_types: string[]
  event_categories?: string[]
  scope_filter?: string
  status: string
  consecutive_failures?: number
  created_at: string
  last_success_at?: string
  last_failure_at?: string
  // v0.1.25.21: server-controlled auto-disable threshold. Surfaced on
  // the WebhookDetail summary so operators can see how close a failing
  // subscription is to being auto-disabled.
  disable_after_failures?: number
}

export interface WebhookListResponse {
  subscriptions: WebhookSubscription[]
  has_more: boolean
  next_cursor?: string
}

export interface WebhookDelivery {
  delivery_id: string
  subscription_id?: string
  event_id: string
  event_type?: string
  status: string
  http_status?: number
  attempts: number
  attempted_at?: string
  created_at?: string
  delivered_at?: string
}

export interface WebhookDeliveryListResponse {
  deliveries: WebhookDelivery[]
  has_more: boolean
  next_cursor?: string
}

// Tenant types
export interface Tenant {
  tenant_id: string
  name: string
  status: string
  parent_tenant_id?: string
  created_at: string
}

export interface TenantListResponse {
  tenants: Tenant[]
  has_more: boolean
  next_cursor?: string
}

// Policy types
export interface Policy {
  policy_id: string
  name: string
  scope_pattern: string
  status: string
  priority?: number
  created_at: string
}

export interface PolicyListResponse {
  policies: Policy[]
  has_more: boolean
  next_cursor?: string
}

// API Key types
export interface ApiKey {
  key_id: string
  tenant_id: string
  name?: string
  status: string
  permissions: string[]
  scope_filter?: string[]
  created_at: string
  expires_at?: string
}

export interface ApiKeyListResponse {
  keys: ApiKey[]
  has_more: boolean
  next_cursor?: string
}

// Create/update request types

export interface ApiKeyCreateRequest {
  tenant_id: string
  name: string
  description?: string
  permissions?: string[]
  scope_filter?: string[]
  expires_at?: string
  metadata?: Record<string, unknown>
}

export interface ApiKeyCreateResponse {
  key_id: string
  key_secret: string
  key_prefix: string
  tenant_id: string
  name?: string
  permissions?: string[]
  created_at: string
  expires_at?: string
}

export interface ApiKeyUpdateRequest {
  name?: string
  description?: string
  permissions?: string[]
  scope_filter?: string[]
  metadata?: Record<string, unknown>
}

export interface TenantCreateRequest {
  tenant_id: string
  name: string
  parent_tenant_id?: string
  metadata?: Record<string, string>
  default_commit_overage_policy?: string
  default_reservation_ttl_ms?: number
}

export interface TenantUpdateRequest {
  name?: string
  status?: string
  metadata?: Record<string, string>
  default_commit_overage_policy?: string
  default_reservation_ttl_ms?: number
}

export interface WebhookCreateRequest {
  url: string
  event_types: string[]
  event_categories?: string[]
  name?: string
  description?: string
  scope_filter?: string
  signing_secret?: string
  headers?: Record<string, string>
  disable_after_failures?: number
  metadata?: Record<string, unknown>
}

export interface WebhookCreateResponse {
  subscription: WebhookSubscription
  signing_secret?: string
}

export interface WebhookTestResponse {
  success: boolean
  response_status?: number
  response_time_ms?: number
  error_message?: string
  event_id?: string
}

export interface ReplayEventsRequest {
  from?: string
  to?: string
  event_types?: string[]
  max_events?: number
}

export interface ReplayEventsResponse {
  replay_id: string
  events_queued: number
}

// Well-known enums

export const PERMISSIONS = [
  'reservations:create', 'reservations:commit', 'reservations:release', 'reservations:extend', 'reservations:list',
  'balances:read', 'budgets:read', 'budgets:write', 'policies:read', 'policies:write',
  'webhooks:read', 'webhooks:write', 'events:read',
] as const

export const EVENT_TYPES = [
  'budget.created', 'budget.updated', 'budget.funded', 'budget.debited', 'budget.reset',
  'budget.debt_repaid', 'budget.frozen', 'budget.unfrozen', 'budget.closed',
  'budget.threshold_crossed', 'budget.exhausted', 'budget.over_limit_entered', 'budget.over_limit_exited',
  'budget.debt_incurred', 'budget.burn_rate_anomaly',
  'reservation.denied', 'reservation.denial_rate_spike', 'reservation.expired',
  'reservation.expiry_rate_spike', 'reservation.commit_overage',
  'tenant.created', 'tenant.updated', 'tenant.suspended', 'tenant.reactivated', 'tenant.closed', 'tenant.settings_changed',
  'api_key.created', 'api_key.revoked', 'api_key.expired', 'api_key.permissions_changed',
  'api_key.auth_failed', 'api_key.auth_failure_rate_spike',
  'policy.created', 'policy.updated', 'policy.deleted',
  'system.store_connection_lost', 'system.store_connection_restored', 'system.high_latency',
  'system.webhook_delivery_failed', 'system.webhook_test',
] as const

export const EVENT_CATEGORIES = ['budget', 'tenant', 'api_key', 'policy', 'reservation', 'system'] as const

export const COMMIT_OVERAGE_POLICIES = ['REJECT', 'ALLOW_IF_AVAILABLE', 'ALLOW_WITH_OVERDRAFT'] as const

// v0.1.25.20: write-op request types for create-budget / create-policy /
// update-policy admin-on-behalf-of flows (server v0.1.25.14, spec
// v0.1.25.13). tenant_id is set by the API client wrapper, not by the
// caller — keeps the form types tenant-agnostic.
export interface BudgetCreateRequest {
  scope: string
  unit: string
  allocated: { unit: string; amount: number }
  overdraft_limit?: { unit: string; amount: number }
  commit_overage_policy?: string
  rollover_policy?: string
}

export interface PolicyCreateRequest {
  name: string
  description?: string
  scope_pattern: string
  priority?: number
  commit_overage_policy?: string
}

export interface PolicyUpdateRequest {
  name?: string
  description?: string
  priority?: number
  commit_overage_policy?: string
  status?: string
}

export interface WebhookSecurityConfig {
  blocked_cidr_ranges?: string[]
  allowed_url_patterns?: string[]
  allow_http?: boolean
}

// Audit types
export interface AuditLogEntry {
  log_id: string
  timestamp: string
  operation: string
  tenant_id?: string
  key_id?: string
  status: number
  request_id?: string
  source_ip?: string
  user_agent?: string
  error_code?: string
  resource_type?: string
  resource_id?: string
  metadata?: Record<string, unknown>
}

export interface AuditLogListResponse {
  logs: AuditLogEntry[]
  has_more: boolean
  next_cursor?: string
}

// v0.1.25.22 (runtime spec cycles-protocol@main, server v0.1.25.8+):
// reservation types for admin-on-behalf-of read/force-release flows.
// `status` is the runtime plane's ReservationStatus — ACTIVE is the
// operationally-interesting state (active reservations past their
// grace window are the "stuck" ones that ops force-releases).
export const RESERVATION_STATUSES = ['ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED'] as const
export type ReservationStatus = typeof RESERVATION_STATUSES[number]

// Minimal shape — the runtime spec's ReservationSummary / ReservationDetail
// carry more (Subject, Action, balances). Dashboard only renders what ops
// need to identify and force-release hung reservations; extra fields are
// kept opaque to stay resilient to spec additions.
export interface ReservationSummary {
  reservation_id: string
  status: ReservationStatus
  scope_path: string
  reserved: { unit: string; amount: number }
  created_at_ms: number
  expires_at_ms: number
  idempotency_key?: string
  affected_scopes?: string[]
}

export interface ReservationListResponse {
  reservations: ReservationSummary[]
  has_more?: boolean
  next_cursor?: string
}

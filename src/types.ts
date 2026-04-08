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
}

export interface WebhookListResponse {
  subscriptions: WebhookSubscription[]
  has_more: boolean
  next_cursor?: string
}

export interface WebhookDelivery {
  delivery_id: string
  event_id: string
  status: string
  http_status?: number
  attempts: number
  created_at: string
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
}

export interface AuditLogListResponse {
  logs: AuditLogEntry[]
  has_more: boolean
  next_cursor?: string
}

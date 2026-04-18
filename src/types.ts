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
  // v0.1.25.22: reservations (runtime plane). Older servers (pre-0.1.25.8)
  // don't surface these flags — undefined defaults to "allow" in Sidebar
  // + ReservationsView so existing deployments keep working.
  view_reservations?: boolean
  manage_reservations?: boolean
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
  // v0.1.25.8+ server computes a denial breakdown by reason_code across
  // the event window. Optional because the field is only populated when
  // the denial sample has at least one row with reason_code set — the
  // admin server omits the key entirely on an empty/null result.
  recent_denials_by_reason?: Record<string, number>
}

// Budget types
export interface Amount {
  unit: string; amount: number
}

export interface BudgetLedger {
  ledger_id: string
  // Populated by servers implementing cycles-governance-admin v0.1.25.19+
  // (cycles-server-admin v0.1.25.23+). Optional so pre-upgrade servers
  // and legacy stored ledgers without a tenant_id render without breaking
  // — callers that depend on it must degrade gracefully.
  tenant_id?: string
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
//
// Mirrors the full `WebhookSubscription` schema in
// cycles-admin-service-api/target/contract/spec.yaml (§WebhookSubscription,
// line 2719). The server uses `@JsonInclude(NON_NULL)` on most fields, so
// any optional field not set will be absent from the GET response (not
// `null`) — every Optional here matches that convention.
//
// `signing_secret` is `writeOnly` per spec and never echoed on GET.
// `headers` values are masked to `"********"` on GET (keys are preserved).
export interface WebhookSubscription {
  subscription_id: string
  tenant_id: string
  name?: string
  description?: string
  url: string
  event_types: string[]
  event_categories?: string[]
  scope_filter?: string
  // Opaque server-managed blobs — surfaced on the detail view as JSON
  // but not edited via the dashboard (edit flow would need a dedicated
  // builder; both are rarely set). Kept as `unknown`-typed records to
  // avoid stale shape drift.
  thresholds?: Record<string, unknown>
  retry_policy?: Record<string, unknown>
  // Custom headers: server masks values on GET (keys preserved). Edit
  // flow writes new keys but can't round-trip masked values back — the
  // form treats existing headers as read-only keys + an "Add header"
  // affordance for new entries.
  headers?: Record<string, string>
  status: string
  consecutive_failures?: number
  created_at: string
  updated_at?: string
  last_triggered_at?: string
  last_success_at?: string
  last_failure_at?: string
  // v0.1.25.21: server-controlled auto-disable threshold. Surfaced on
  // the WebhookDetail summary so operators can see how close a failing
  // subscription is to being auto-disabled.
  disable_after_failures?: number
  metadata?: Record<string, unknown>
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

// Full permission enum per cycles-governance-admin-v0.1.25 spec
// (schemas.Permission, lines 1337-1384). MUST match the admin server's
// Permission.java — if a stored key carries a permission not listed here,
// the edit form will filter it out on openEdit and warn the operator
// (see ApiKeysView.openEdit / TenantDetailView edit paths). Adding an
// admin-plane permission that's in the spec but missing here means the
// checkbox for it never renders and operators can't toggle it.
export const PERMISSIONS = [
  // Tenant runtime permissions
  'reservations:create', 'reservations:commit', 'reservations:release', 'reservations:extend', 'reservations:list',
  'balances:read', 'budgets:read', 'budgets:write', 'policies:read', 'policies:write',
  'webhooks:read', 'webhooks:write', 'events:read',
  // Admin wildcard (backward compatible)
  'admin:read', 'admin:write',
  // Granular admin permissions
  'admin:tenants:read', 'admin:tenants:write',
  'admin:budgets:read', 'admin:budgets:write',
  'admin:policies:read', 'admin:policies:write',
  'admin:apikeys:read', 'admin:apikeys:write',
  'admin:webhooks:read', 'admin:webhooks:write',
  'admin:events:read', 'admin:audit:read',
] as const

// Grouped view of PERMISSIONS for the edit/create picker. Purely a UI
// concern — the canonical flat list is PERMISSIONS above. A unit test
// guards against drift between the two. Structure: plane -> sections ->
// items. A section with label=null renders items at the plane level
// without a sub-header (used by the wildcard plane).
export const PERMISSION_GROUPS = [
  {
    plane: 'Tenant',
    sections: [
      { label: 'Reservations', items: ['reservations:create', 'reservations:commit', 'reservations:release', 'reservations:extend', 'reservations:list'] },
      { label: 'Balances', items: ['balances:read'] },
      { label: 'Budgets', items: ['budgets:read', 'budgets:write'] },
      { label: 'Policies', items: ['policies:read', 'policies:write'] },
      { label: 'Webhooks', items: ['webhooks:read', 'webhooks:write'] },
      { label: 'Events', items: ['events:read'] },
    ],
  },
  {
    plane: 'Admin (wildcard)',
    sections: [
      { label: null, items: ['admin:read', 'admin:write'] },
    ],
  },
  {
    plane: 'Admin (per-resource)',
    sections: [
      { label: 'Tenants', items: ['admin:tenants:read', 'admin:tenants:write'] },
      { label: 'Budgets', items: ['admin:budgets:read', 'admin:budgets:write'] },
      { label: 'Policies', items: ['admin:policies:read', 'admin:policies:write'] },
      { label: 'API Keys', items: ['admin:apikeys:read', 'admin:apikeys:write'] },
      { label: 'Webhooks', items: ['admin:webhooks:read', 'admin:webhooks:write'] },
      { label: 'Events', items: ['admin:events:read'] },
      { label: 'Audit', items: ['admin:audit:read'] },
    ],
  },
] as const

export const EVENT_TYPES = [
  'budget.created', 'budget.updated', 'budget.funded', 'budget.debited', 'budget.reset',
  'budget.reset_spent',
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

// cycles-governance-admin v0.1.25.yaml ErrorCode enum. Used as the suggestion
// set for the AuditView error_code filter datalist (v0.1.25.24 listAuditLogs
// filter DSL). Free-text entry still accepted — values are NOT validated
// against the enum on the server per the spec's forward-compat rule: unknown
// codes match nothing at the filter layer, but newer clients sending a
// newly-added enum value MUST NOT cause a 400 against an older server.
export const ERROR_CODES = [
  'INVALID_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND',
  'BUDGET_EXCEEDED', 'RESERVATION_EXPIRED', 'RESERVATION_FINALIZED',
  'IDEMPOTENCY_MISMATCH', 'UNIT_MISMATCH', 'OVERDRAFT_LIMIT_EXCEEDED',
  'DEBT_OUTSTANDING', 'INTERNAL_ERROR',
  'TENANT_NOT_FOUND', 'TENANT_SUSPENDED', 'TENANT_CLOSED',
  'BUDGET_NOT_FOUND', 'BUDGET_FROZEN', 'POLICY_VIOLATION',
  'INSUFFICIENT_PERMISSIONS', 'KEY_REVOKED', 'KEY_EXPIRED',
  'DUPLICATE_RESOURCE', 'BUDGET_CLOSED',
  'WEBHOOK_NOT_FOUND', 'WEBHOOK_URL_INVALID', 'EVENT_NOT_FOUND',
  'REPLAY_IN_PROGRESS',
  'COUNT_MISMATCH', 'LIMIT_EXCEEDED',
] as const

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

// cycles-governance-admin v0.1.25.21: server-side bulk-action endpoints
// for tenants and webhook subscriptions. Replace the client's
// rateLimitedBatch loop (one PATCH per row) with a single POST that
// takes a filter + action + idempotency_key and returns split
// succeeded/failed/skipped arrays. Enables W1 (select-all-matching
// at scale) and removes the 429-backoff complexity client-side —
// the server is the natural rate-limit boundary for a filter-wide op.

// Per-row outcome in any bulk-action response's succeeded / failed /
// skipped arrays. error_code + message populated only in failed[];
// reason populated only in skipped[]. `id` is the affected row's PK
// (tenant_id or subscription_id depending on the endpoint).
export interface BulkActionRowOutcome {
  id: string
  error_code?: string
  message?: string
  reason?: string
}

export const TENANT_BULK_ACTIONS = ['SUSPEND', 'REACTIVATE', 'CLOSE'] as const
export type TenantBulkAction = typeof TENANT_BULK_ACTIONS[number]

// Filter selecting target tenants. At least one property MUST be
// present per spec (empty filter is rejected 400 to prevent an
// accidental all-tenants action). AND combination across properties.
// `status` mirrors Tenant.status (string-typed in this codebase to
// stay resilient to server enum additions).
export interface TenantBulkFilter {
  status?: string
  parent_tenant_id?: string
  observe_mode?: string
  search?: string
}

export interface TenantBulkActionRequest {
  filter: TenantBulkFilter
  action: TenantBulkAction
  // Operator-supplied count of filter matches. When present, server
  // MUST count first and reject 409 COUNT_MISMATCH if the actual
  // count differs — no writes. UIs should always populate this
  // from a preview query to prevent accidental over-apply.
  expected_count?: number
  // Required. Operator-supplied replay key (UUID v4). Server
  // remembers the first response for 15 minutes; repeat submits
  // return the original response without re-applying.
  idempotency_key: string
}

export interface TenantBulkActionResponse {
  action: TenantBulkAction
  total_matched: number
  succeeded: BulkActionRowOutcome[]
  failed: BulkActionRowOutcome[]
  skipped: BulkActionRowOutcome[]
  idempotency_key: string
}

export const WEBHOOK_BULK_ACTIONS = ['PAUSE', 'RESUME', 'DELETE'] as const
export type WebhookBulkAction = typeof WEBHOOK_BULK_ACTIONS[number]

export interface WebhookBulkFilter {
  tenant_id?: string
  status?: 'ACTIVE' | 'PAUSED' | 'DISABLED'
  event_type?: string
  search?: string
}

export interface WebhookBulkActionRequest {
  filter: WebhookBulkFilter
  action: WebhookBulkAction
  expected_count?: number
  idempotency_key: string
}

export interface WebhookBulkActionResponse {
  action: WebhookBulkAction
  total_matched: number
  succeeded: BulkActionRowOutcome[]
  failed: BulkActionRowOutcome[]
  skipped: BulkActionRowOutcome[]
  idempotency_key: string
}

// cycles-governance-admin v0.1.25.26 (admin-server v0.1.25.29+):
// POST /v1/admin/budgets/bulk-action — filter-driven bulk balance
// mutation. Same 500-row cap / expected_count / idempotency contract
// as the tenants + webhooks endpoints, with one structural difference:
// BudgetBulkFilter.tenant_id is REQUIRED (no cross-tenant fan-out).
// The operator must choose a single tenant before arming a bulk action
// — the dashboard's cross-tenant listing modes (over_limit, has_debt)
// continue to work for list-only use (scanning an incident), but the
// Bulk-action button is disabled until a tenant is selected.
//
// One audit log entry per invocation with actor_type=ADMIN_ON_BEHALF_OF.
export const BUDGET_BULK_ACTIONS = ['CREDIT', 'DEBIT', 'RESET', 'RESET_SPENT', 'REPAY_DEBT'] as const
export type BudgetBulkAction = typeof BUDGET_BULK_ACTIONS[number]

// Filter selecting target budgets. `tenant_id` is required by the
// server (spec v0.1.25.26) — enforced client-side so the UI never
// sends an empty/missing value (would 400 VALIDATION_FAILED).
export interface BudgetBulkFilter {
  tenant_id: string
  scope_prefix?: string
  unit?: string
  // Mirrors BudgetLedger.status — server-side enum is ACTIVE / FROZEN /
  // CLOSED, string-typed in this codebase to stay forward-compatible
  // with future status additions without forcing a client release.
  status?: string
  over_limit?: boolean
  has_debt?: boolean
  utilization_min?: number   // 0–1 ratio, matches listBudgets wire shape
  utilization_max?: number   // 0–1 ratio
  search?: string
}

export interface BudgetBulkActionRequest {
  filter: BudgetBulkFilter
  action: BudgetBulkAction
  // Required for all five actions (CREDIT / DEBIT / RESET /
  // RESET_SPENT / REPAY_DEBT). Spec v0.1.25.26 wraps this as an
  // Amount object — the server rejects scalar numbers with 400
  // INVALID_REQUEST. For RESET_SPENT, `amount` is the new allocated
  // value; `spent` (below) is what the spent counter resets to.
  amount?: Amount
  // Only honoured for RESET_SPENT; server ignores it for other
  // actions. Optional even there — server defaults to 0 when omitted
  // (fresh billing period). Also wrapped as Amount per spec.
  spent?: Amount
  // Optional operator-supplied note recorded on the audit entry.
  reason?: string
  // Preflight count-gate — when present, server counts first and
  // rejects 409 COUNT_MISMATCH if the actual count differs; no writes.
  expected_count?: number
  // Required. UUID v4 replay key; server remembers the first response
  // for 15 minutes and returns it verbatim on repeat submits.
  idempotency_key: string
}

export interface BudgetBulkActionResponse {
  action: BudgetBulkAction
  total_matched: number
  succeeded: BulkActionRowOutcome[]
  failed: BulkActionRowOutcome[]
  skipped: BulkActionRowOutcome[]
  idempotency_key: string
}

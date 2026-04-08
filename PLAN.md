# Cycles Admin Dashboard v1 — Implementation Plan

## Context

Building the first visual surface for the Cycles budget enforcement platform. Currently everything is API-only. Two rounds of review corrected three structural problems:

1. **Auth model mismatch** — the governance spec uses `AdminKeyAuth` for tenants/api-keys/webhooks/events/audit but `ApiKeyAuth` for budgets/policies. A single admin key can't read budgets/policies without a backend change.

2. **No server-side aggregation** — overview depended on crawling paginated endpoints client-side.

3. **CRUD-shaped, not operations-shaped** — the UI was organized around entity lists instead of operator workflows.

Second review further refined: use an explicit dual-auth allowlist (not generic prefix fallback), add exact budget lookup, enrich the overview payload with top-offender arrays, and make the introspect endpoint return effective capabilities.

Third review (Phase 0 validation) caught three additional issues:

4. **Overview endpoint has no auth routing** — `/v1/admin/overview` doesn't match any `requiresAdminKey()` or `requiresApiKey()` prefix check in `AuthInterceptor`, causing unauthenticated access.

5. **Budget list returns empty for admin key** — `BudgetController.list()` uses `authenticated_tenant_id` (null for admin auth) to query `BudgetRepository.list()`, which does `jedis.smembers("budgets:" + tenantId)` → `"budgets:null"` → empty set.

6. **Policy list has the same problem** — `PolicyController.list()` uses the same null-tenantId pattern, plus the spec lacks a `tenant_id` query param for policies.

---

## Part 1: Backend Changes (cycles-server-admin)

### 1A. Auth Routing for New Endpoints

**Problem**: Two new endpoints (`/v1/admin/overview` and `/v1/auth/introspect`) need auth routing added to `AuthInterceptor.requiresAdminKey()`. Without this, `/v1/admin/overview` falls through both `requiresAdminKey()` and `requiresApiKey()` checks, reaching `return true` at `AuthInterceptor.java:77` — **unauthenticated access**.

**File**: `cycles-server-admin/.../config/AuthInterceptor.java`

```java
// In requiresAdminKey(String method, String path):
if (path.startsWith("/v1/admin/tenants") ||
       path.startsWith("/v1/admin/api-keys") ||
       path.startsWith("/v1/auth/validate") ||
       path.startsWith("/v1/auth/introspect") ||   // ← new
       path.startsWith("/v1/admin/audit") ||
       path.startsWith("/v1/admin/webhooks") ||
       path.startsWith("/v1/admin/events") ||
       path.startsWith("/v1/admin/overview") ||     // ← new
       path.startsWith("/v1/admin/config")) {
    return true;
}
```

**Tests** (`AuthInterceptorTest.java`):
- `GET /v1/admin/overview` without admin key → 401
- `GET /v1/admin/overview` with valid admin key → 200
- `GET /v1/auth/introspect` without admin key → 401
- `GET /v1/auth/introspect` with valid admin key → 200

### 1B. Explicit Dual-Auth Allowlist for Dashboard Reads

**Problem**: `GET /v1/admin/budgets` and `GET /v1/admin/policies` require `ApiKeyAuth`, making cross-tenant admin reads impossible with one credential.

**Fix**: Add an explicit `ADMIN_READABLE_ENDPOINTS` set in `AuthInterceptor` — not a generic `path.startsWith("/v1/admin/") && GET` rule that would drift silently.

**File**: `cycles-server-admin/.../config/AuthInterceptor.java`

```java
// Explicit allowlist of ApiKeyAuth endpoints that also accept AdminKeyAuth for reads.
// Each entry MUST be reflected in the governance spec and API docs.
// Uses exact method:path matching — no prefix matching, no wildcards.
private static final Set<String> ADMIN_READABLE_ENDPOINTS = Set.of(
    "GET:/v1/admin/budgets",
    "GET:/v1/admin/budgets/lookup",
    "GET:/v1/admin/policies"
);

// In preHandle():
} else if (requiresApiKey(path)) {
    // Exact match against allowlist — normalize path to remove trailing slash
    String normalizedPath = path.endsWith("/") ? path.substring(0, path.length() - 1) : path;
    String lookupKey = method + ":" + normalizedPath;
    if (ADMIN_READABLE_ENDPOINTS.contains(lookupKey) && hasAdminKeyHeader(request)) {
        return validateAdminKey(request, response);
    }
    return validateApiKey(request, response);
}
```

New helper method:
```java
private boolean hasAdminKeyHeader(HttpServletRequest request) {
    String key = request.getHeader(ADMIN_KEY_HEADER);
    return key != null && !key.isBlank();
}
```

**Scope**: Exact `Set.contains()` match — not `startsWith`, not prefix matching. Future routes like `/v1/admin/budgets/foo` will not accidentally inherit admin-readable status. Every addition to this set requires a spec update.

**Note on query strings**: `request.getRequestURI()` returns the path WITHOUT query string, so `GET /v1/admin/budgets?scope_prefix=foo` normalizes to `GET:/v1/admin/budgets` and matches correctly.

**Tests** (`AuthInterceptorTest.java`):
- Admin key accepted on `GET /v1/admin/budgets` → 200
- Admin key accepted on `GET /v1/admin/budgets/lookup?scope=...&unit=...` → 200
- Admin key accepted on `GET /v1/admin/policies` → 200
- Admin key rejected on `POST /v1/admin/budgets` → 401
- Admin key rejected on `POST /v1/admin/budgets/fund` → 401
- ApiKeyAuth still works unchanged on all existing paths
- Admin key on `GET /v1/admin/budgets/lookup` bypasses scope filtering (regression test: `ScopeFilterUtil.enforceScopeFilter()` no-ops when `authenticated_scope_filter` attribute is null, which is the case for admin-auth since `validateAdminKey()` sets no request attributes)

**Spec update**: Add note to governance spec YAML sections for `GET /v1/admin/budgets` and `GET /v1/admin/policies` documenting that AdminKeyAuth is accepted as an alternative for read access.

### 1C. Fix Budget List Tenant Scoping for Admin Callers

**Problem**: When admin key auth is used on `GET /v1/admin/budgets`, `authenticated_tenant_id` is null (since `validateAdminKey()` sets no request attributes, `AuthInterceptor.java:113-128`). `BudgetRepository.list()` (`BudgetRepository.java:284`) does `jedis.smembers("budgets:" + tenantId)` which becomes `"budgets:null"` → empty set → zero results.

**Fix**: Modify `BudgetController.list()` to use the `tenant_id` query param as fallback for admin callers. The spec already defines `tenant_id` as a query param (`complete-budget-governance-v0.1.25.yaml:2304-2309`) with the note "Ignored when using ApiKeyAuth — the authenticated tenant from the API key is always used for scoping." For AdminKeyAuth callers, it becomes the required scoping mechanism.

**File**: `BudgetController.java` — modify the `list()` method:

```java
@GetMapping @Operation(operationId = "listBudgets")
public ResponseEntity<BudgetListResponse> list(
        @RequestParam(required = false) String tenant_id,
        @RequestParam(required = false) String scope_prefix,
        @RequestParam(required = false) UnitEnum unit,
        @RequestParam(required = false) BudgetStatus status,
        @RequestParam(required = false) String cursor,
        @RequestParam(defaultValue = "50") int limit,
        HttpServletRequest httpRequest) {
    ScopeFilterUtil.enforceScopeFilter(httpRequest, scope_prefix);
    String tenantId = (String) httpRequest.getAttribute("authenticated_tenant_id");
    if (tenantId == null) {
        // Admin key auth — tenant_id query param is required for scoping
        if (tenant_id == null || tenant_id.isBlank()) {
            throw new GovernanceException(
                ErrorCode.INVALID_REQUEST,
                "tenant_id query parameter is required when using admin key authentication",
                400);
        }
        tenantId = tenant_id;
    }
    int effectiveLimit = Math.max(1, Math.min(limit, 100));
    var ledgers = repository.list(tenantId, scope_prefix, unit, status, cursor, effectiveLimit);
    BudgetListResponse response = BudgetListResponse.builder()
        .ledgers(ledgers)
        .hasMore(ledgers.size() >= effectiveLimit)
        .nextCursor(ledgers.size() >= effectiveLimit ? ledgers.get(ledgers.size() - 1).getLedgerId() : null)
        .build();
    return ResponseEntity.ok(response);
}
```

**Tests** (`BudgetControllerTest.java`):
- Admin key + `tenant_id=acme` → returns acme's budgets
- Admin key + no `tenant_id` → 400 with clear error message
- API key + `tenant_id=acme` → ignores query param, uses authenticated tenant (existing behavior preserved)
- API key + no `tenant_id` → uses authenticated tenant (existing behavior preserved)

### 1D. Fix Policy List Tenant Scoping for Admin Callers

**Problem**: Same as budgets — `PolicyController.list()` (`PolicyController.java:89`) gets null `tenantId` for admin callers. `PolicyRepository.list()` (`PolicyRepository.java:152`) does `jedis.smembers("policies:" + tenantId)` → empty.

Additionally, the spec (`GET /v1/admin/policies`, `complete-budget-governance-v0.1.25.yaml:2514-2548`) does **not** currently have a `tenant_id` query parameter, unlike budgets.

**Fix**: Two changes:
1. Add `tenant_id` query param to the spec for `GET /v1/admin/policies`
2. Modify `PolicyController.list()` with the same admin-key fallback pattern

**File**: `PolicyController.java` — modify the `list()` method:

```java
@GetMapping @Operation(operationId = "listPolicies")
public ResponseEntity<PolicyListResponse> list(
        @RequestParam(required = false) String tenant_id,      // ← new param
        @RequestParam(required = false) String scope_pattern,
        @RequestParam(required = false) PolicyStatus status,
        @RequestParam(required = false) String cursor,
        @RequestParam(defaultValue = "50") int limit,
        HttpServletRequest httpRequest) {
    ScopeFilterUtil.enforceScopeFilter(httpRequest, scope_pattern);
    String tenantId = (String) httpRequest.getAttribute("authenticated_tenant_id");
    if (tenantId == null) {
        // Admin key auth — tenant_id query param is required for scoping
        if (tenant_id == null || tenant_id.isBlank()) {
            throw new GovernanceException(
                ErrorCode.INVALID_REQUEST,
                "tenant_id query parameter is required when using admin key authentication",
                400);
        }
        tenantId = tenant_id;
    }
    int effectiveLimit = Math.max(1, Math.min(limit, 100));
    var policies = repository.list(tenantId, scope_pattern, status, cursor, effectiveLimit);
    PolicyListResponse response = PolicyListResponse.builder()
        .policies(policies)
        .hasMore(policies.size() >= effectiveLimit)
        .nextCursor(policies.size() >= effectiveLimit ? policies.get(policies.size() - 1).getPolicyId() : null)
        .build();
    return ResponseEntity.ok(response);
}
```

**Tests** (`PolicyControllerTest.java`):
- Admin key + `tenant_id=acme` → returns acme's policies
- Admin key + no `tenant_id` → 400 with clear error message
- API key + `tenant_id=acme` → ignores query param, uses authenticated tenant
- API key + no `tenant_id` → uses authenticated tenant

### 1E. Add Exact Budget Lookup Endpoint

**Problem**: `GET /v1/admin/budgets` only supports `scope_prefix` (prefix match), not exact scope. Budget detail view can return descendants and become ambiguous.

**Redis key pattern (verified)**: `BudgetRepository.create()` at `BudgetRepository.java:132` uses:
```java
String key = "budget:" + normalizedScope + ":" + request.getUnit();
```
So the key is `budget:{lowercase_scope}:{UNIT_ENUM}` stored as a Redis HASH.

**Fix**: Add `GET /v1/admin/budgets/lookup?scope=X&unit=Y` for exact single-budget retrieval.

**File**: `BudgetRepository.java` — add method:

```java
public BudgetLedger getByExactScope(String scope, UnitEnum unit) {
    String normalizedScope = normalizeScope(scope);
    String key = "budget:" + normalizedScope + ":" + unit;
    try (Jedis jedis = jedisPool.getResource()) {
        Map<String, String> hash = jedis.hgetAll(key);
        if (hash.isEmpty()) throw GovernanceException.budgetNotFound(scope);
        return hashToBudgetLedger(hash, key);
    }
}
```

**File**: `BudgetController.java` — add endpoint:

```java
@GetMapping("/lookup")
@Operation(operationId = "lookupBudget")
public ResponseEntity<BudgetLedger> lookup(
    @RequestParam String scope, @RequestParam UnitEnum unit,
    HttpServletRequest httpRequest) {
    // ScopeFilterUtil.enforceScopeFilter() is safe for admin-key callers:
    // when auth is AdminKeyAuth, no request attributes are set, so
    // request.getAttribute("authenticated_scope_filter") returns null,
    // and enforceScopeFilter() no-ops (ScopeFilterUtil.java:30-31).
    ScopeFilterUtil.enforceScopeFilter(httpRequest, scope);
    BudgetLedger ledger = repository.getByExactScope(scope, unit);
    return ResponseEntity.ok(ledger);
}
```

**Auth**: Accepts both ApiKeyAuth (with `ScopeFilterUtil.enforceScopeFilter()` applied — enforces scope restrictions when `authenticated_scope_filter` attribute is present) and AdminKeyAuth (via the dual-auth allowlist — `enforceScopeFilter` no-ops because admin auth sets no request attributes, confirmed by `ScopeFilterUtil.java:30-31`).

**Note**: Unlike the list endpoint, the lookup endpoint does NOT need tenant scoping — the Redis key is deterministic from scope+unit, and scope_filter enforcement provides the access control for API key callers. Admin key callers can look up any budget.

### 1F. Add `GET /v1/admin/overview` Endpoint (Enriched)

**Problem**: Overview needs server-aggregated counts + top-offender lists in a single round trip.

**Fix**: New controller + service that queries through existing repositories (not direct Redis — avoids hard-coding key layout into a UI-only endpoint).

**Response model** (`AdminOverviewResponse.java`):

```json
{
  "as_of": "2026-04-08T10:30:00Z",
  "event_window_seconds": 3600,
  "tenant_counts": {
    "total": 12, "active": 10, "suspended": 1, "closed": 1
  },
  "budget_counts": {
    "total": 45, "active": 38, "frozen": 4, "closed": 3,
    "over_limit": 3, "with_debt": 1,
    "by_unit": { "USD_MICROCENTS": 20, "TOKENS": 15, "CREDITS": 10 }
  },
  "over_limit_scopes": [
    { "scope": "tenant:acme/agent:summarizer", "unit": "USD_MICROCENTS", "allocated": 10000000, "remaining": -500000, "debt": 500000 }
  ],
  "debt_scopes": [
    { "scope": "tenant:acme/agent:coder", "unit": "TOKENS", "debt": 15000, "overdraft_limit": 50000 }
  ],
  "webhook_counts": {
    "total": 8, "active": 6, "disabled": 2, "with_failures": 1
  },
  "failing_webhooks": [
    { "subscription_id": "wh_abc", "url": "https://...", "consecutive_failures": 7, "last_failure_at": "..." }
  ],
  "event_counts": {
    "total_recent": 127,
    "by_category": { "budget": 45, "reservation": 62, "tenant": 5, "api_key": 3, "policy": 2, "system": 10 }
  },
  "recent_denials": [
    { "event_id": "...", "event_type": "reservation.denied", "scope": "...", "tenant_id": "...", "timestamp": "2026-04-08T10:29:00Z", "data": { "reason_code": "BUDGET_EXCEEDED" } }
  ],
  "recent_expiries": [
    { "event_id": "...", "event_type": "reservation.expired", "scope": "...", "tenant_id": "...", "timestamp": "2026-04-08T10:28:00Z" }
  ]
}
```

**Implementation** (`AdminOverviewService.java`):

All aggregation goes through repositories, not direct Redis.

**Pagination model**: Repository `list()` methods return raw `List<T>`, not response DTOs. Pagination is position-based: the cursor is the last item's ID (tenant_id, ledger_id, etc.), passed back to the next `list()` call. `has_more` is determined by `page.size() >= limit`. This matches how controllers build response DTOs (see `TenantController.java:59-63`).

For **entity counts** (tenants, budgets, webhooks): page until `page.size() < PAGE_SIZE` to get accurate totals:

```java
// Correct pagination using the repository's ID-based cursor model
private List<Tenant> listAllTenants() {
    List<Tenant> all = new ArrayList<>();
    String cursor = null;
    int pageSize = 100;
    List<Tenant> page;
    do {
        page = tenantRepository.list(null, null, cursor, pageSize);
        all.addAll(page);
        if (page.size() >= pageSize) {
            cursor = page.get(page.size() - 1).getTenantId();
        }
    } while (page.size() >= pageSize);
    return all;
}
```

For **budgets**: iterate per-tenant (BudgetRepository requires tenantId for SET lookup):

```java
private List<BudgetLedger> listAllBudgets(List<Tenant> tenants) {
    List<BudgetLedger> all = new ArrayList<>();
    for (Tenant tenant : tenants) {
        // list(tenantId) is a convenience overload: list(tenantId, null, null, null, null, 1000)
        all.addAll(budgetRepository.list(tenant.getTenantId()));
    }
    return all;
}
```

For **webhooks**: use `WebhookRepository.listAll(status, eventType, cursor, limit)` which queries the global `webhooks:_all` SET.

For **event_counts** (`total_recent` and `by_category`): page through ALL events in the time window, not just the first page. EventRepository returns `List<Event>` with time-range filtering via `from`/`to`. Iterate until `page.size() < pageSize`:

```java
private List<Event> listEventsInWindow(Instant from, Instant to) {
    List<Event> all = new ArrayList<>();
    String cursor = null;
    int pageSize = 100;
    List<Event> page;
    do {
        page = eventRepository.list(null, null, null, null, null, from, to, cursor, pageSize);
        all.addAll(page);
        if (page.size() >= pageSize) {
            cursor = page.get(page.size() - 1).getEventId();
        }
    } while (page.size() >= pageSize);
    return all;
}
```

Then count by `event.getCategory()` in memory.

For **top-offender arrays**: intentionally capped at 10 items each (`over_limit_scopes`, `debt_scopes`, `failing_webhooks`). These are display widgets, not exhaustive lists. Collected during the entity count pagination loop.

For **recent denials/expiries**: capped at 10 each within the `event_window_seconds` window. Uses event type filter on repository query (no full pagination needed — just `limit=10`).

**Note on event field names**: The overview embeds Event objects directly using the canonical Event model. The `timestamp` field (not `created_at`) matches `Event.java:29-30`. Overview response DTOs reuse the Event class for `recent_denials[]` and `recent_expiries[]` — no dashboard-specific field name variants.

**Note on event type string format**: `EventRepository.list()` at `EventRepository.java:78` takes `eventType` as a `String`. Verify during implementation that the repository compares against `EventType.name()` (e.g., `"RESERVATION_DENIED"`) or the serialized form (e.g., `"reservation.denied"`). Use whichever format the repository's in-memory filter expects.

Summary of repository calls:
- `TenantRepository.list()` — paginate all → count by status
- `BudgetRepository.list(tenantId)` per tenant — paginate all → count by status/unit, collect over_limit (cap 10) and debt (cap 10) scopes
- `WebhookRepository.listAll()` — paginate all → count by status, collect failing (cap 10)
- `EventRepository.list(null, null, null, null, null, windowStart, now, cursor, 100)` — paginate ALL in window → count by category for `event_counts`
- `EventRepository.list(null, "reservation.denied", null, null, null, windowStart, now, null, 10)` — recent denials (cap 10)
- `EventRepository.list(null, "reservation.expired", null, null, null, windowStart, now, null, 10)` — recent expiries (cap 10)

**Performance note**: This endpoint pages through ALL tenants, budgets, webhooks, and events in the time window. For deployments with 100+ tenants and 1000+ budgets, response time may reach seconds. Mitigations (implement if needed, not in v1):
- Cache the overview response with a short TTL (10-15s)
- Add Redis-level counters per category per hour for event counts
- Add a global budget index SET (avoids per-tenant iteration)

**Auth**: AdminKeyAuth only (routed via `requiresAdminKey()`, see section 1A).

**Files to create**:
- `model/shared/AdminOverviewResponse.java` — response DTO (nested DTOs inline or as static inner classes)
- `service/AdminOverviewService.java` — aggregation using injected repositories
- `controller/AdminOverviewController.java` — `GET /v1/admin/overview`
- Tests for all three

### 1G. Add `GET /v1/auth/introspect` Endpoint

**Problem**: Login validation via `GET /v1/admin/tenants?limit=1` doesn't verify permissions.

**Fix**: New endpoint returning effective capabilities derived from permissions.

**V1 scope: AdminKeyAuth only.** The dashboard is admin-key only. Supporting ApiKeyAuth on introspect is useful but not required for this v1 dashboard. Ship admin-only now; widen to dual-auth later when a tenant console is built.

**Auth routing**: Handled in section 1A — `path.startsWith("/v1/auth/introspect")` added to `requiresAdminKey()`.

**File**: `AuthController.java` — extend with:

```java
@GetMapping("/introspect")
@Operation(operationId = "introspectAuth")
public ResponseEntity<AuthIntrospectResponse> introspect(HttpServletRequest request) {
    // Admin key already validated by interceptor
    return ResponseEntity.ok(AuthIntrospectResponse.builder()
        .authenticated(true)
        .authType("admin")
        .permissions(List.of("*"))
        .capabilities(deriveCapabilities(List.of("*")))
        .build());
}
```

**Response model** (`AuthIntrospectResponse.java`):

```json
{
  "authenticated": true,
  "auth_type": "admin",
  "permissions": ["*"],
  "capabilities": {
    "view_overview": true,
    "view_budgets": true,
    "view_events": true,
    "view_webhooks": true,
    "view_audit": true,
    "view_tenants": true,
    "view_api_keys": true,
    "view_policies": true
  }
}
```

**Capability derivation logic** (in controller or service, derived from actual permissions):

```java
private Map<String, Boolean> deriveCapabilities(List<String> permissions) {
    boolean isAdmin = permissions.contains("*");
    return Map.of(
        "view_overview",  isAdmin,
        "view_budgets",   isAdmin || permissions.contains("admin:read") || permissions.contains("admin:budgets:read"),
        "view_events",    isAdmin || permissions.contains("events:read") || permissions.contains("admin:events:read"),
        "view_webhooks",  isAdmin || permissions.contains("webhooks:read") || permissions.contains("admin:webhooks:read"),
        "view_audit",     isAdmin || permissions.contains("admin:audit:read"),
        "view_tenants",   isAdmin || permissions.contains("admin:tenants:read"),
        "view_api_keys",  isAdmin || permissions.contains("admin:apikeys:read"),
        "view_policies",  isAdmin || permissions.contains("admin:read") || permissions.contains("admin:policies:read")
    );
}
```

Both `permissions` and `capabilities` are returned: the frontend uses booleans, operators can debug raw permissions. For v1, admin key always returns all-true capabilities, but the derivation logic is ready for when ApiKeyAuth support is added later — it maps real permissions to booleans rather than hardcoding.

---

## Part 2: Dashboard Information Architecture (Operations-First)

### Navigation (Priority Order)

| Route | Page | Purpose |
|-------|------|---------|
| `/` | Overview | Operational health at a glance |
| `/budgets` | Budgets | Over-limit, debt, utilization across all tenants |
| `/budgets?scope=X&unit=Y` | Budget Detail | Single budget deep-dive via exact lookup |
| `/events` | Events | Investigation tool with correlation |
| `/webhooks` | Webhooks | Subscription health, failures, deliveries |
| `/webhooks/:id` | Webhook Detail | Single subscription + delivery history |
| `/audit` | Audit | Compliance trail, queryable by tenant/key/op/time |
| `/tenants` | Tenants | Tenant list + detail (budgets, keys, policies) |
| `/tenants/:id` | Tenant Detail | Single tenant deep-dive |
| `/login` | Login | Admin key + introspection |

### Overview Page — Single-Request Operational Dashboard

Powered entirely by `GET /v1/admin/overview` (one round trip). No client-side aggregation.

| Section | Source field | What it renders |
|---------|-------------|-----------------|
| Over-limit budgets | `over_limit_scopes[]` | List of scopes with utilization bars, links to budget detail |
| Budgets with debt | `debt_scopes[]` | Scopes with debt/overdraft_limit ratio, links to budget detail |
| Frozen budgets | `budget_counts.frozen` | Count badge; click filters budgets page to `status=FROZEN` |
| Webhook failures | `failing_webhooks[]` | Subscriptions with consecutive failure count, links to webhook detail |
| Recent denials | `recent_denials[]` | Events with reason codes, scope, tenant — links to events/budgets |
| Recent expiries | `recent_expiries[]` | Expired reservations with scope context |
| Summary counters | `tenant_counts`, `budget_counts`, `webhook_counts` | Small status distribution at page top |
| Event volume | `event_counts.by_category` | Category breakdown for the event window |

Future: add `reservation.commit_overage`, `budget.threshold_crossed`, `budget.burn_rate_anomaly` event widgets when the runtime emits these consistently.

### Budgets Page — The Core View

The most important page. Organized around operational state, not just records.

**Tenant scoping for admin callers**: The budgets page lists budgets per tenant. The dashboard must send `tenant_id` as a query param on `GET /v1/admin/budgets` (required for admin key auth, see section 1C). The UI should either:
- Default to the first tenant from the tenants list
- Provide a tenant selector dropdown at the top of the page
- Or aggregate across tenants by calling the endpoint once per tenant (expensive, use sparingly)

**Columns/fields per budget**:
- Scope (full path, linked to detail)
- Unit badge
- Status badge (ACTIVE/FROZEN/CLOSED)
- Utilization bar (remaining/allocated)
- Debt bar (debt/overdraft_limit) — only shown when debt > 0
- `is_over_limit` indicator — red badge when true, meaning new reservations are blocked
- Overage policy
- Last relevant event for scope (if available)

**Filters**: scope prefix, unit, status, `is_over_limit=true`, `debt>0`
**Sorting**: utilization %, debt amount, scope alphabetical

**Budget detail** (`/budgets?scope=X&unit=Y`):
- Uses `GET /v1/admin/budgets/lookup?scope=X&unit=Y` (exact match, new endpoint)
- Full breakdown: allocated, remaining, reserved, spent, debt, overdraft_limit
- Debt utilization = debt / overdraft_limit (with warning/critical thresholds)
- Overage policy, rollover policy, period dates
- Event timeline: `GET /v1/admin/events?scope=X` returns events matching scope prefix. Since the admin events API uses prefix matching, the frontend **must post-filter to exact scope matches** client-side (`event.scope === budgetScope`) to avoid showing descendant-scope events in the budget timeline. This is documented as a known limitation — a backend exact-scope event filter can be added later if needed.

### Events Page — Correlation-First Investigation Tool

Not just a list. Built for "what happened and why?"

**Filters** (all supported by existing `EventAdminController`):
- `category` — budget, reservation, tenant, api_key, policy, system
- `event_type` — specific type within category
- `tenant_id` — scope to tenant
- `scope` — prefix match on scope string
- `correlation_id` — **first-class** (EventRepository already supports SET-based correlation lookup)
- `from` / `to` — time range with date pickers

**Detail view** (expandable row or dedicated panel):
- Raw JSON payload (`data` field)
- Actor (type + key_id)
- Both `request_id` and `correlation_id` displayed
- Source (which service emitted)
- Links: tenant_id → tenant detail, scope → budget detail

**Correlation view**:
- When `correlation_id` is present, show "View correlated events" link
- Groups events sharing the same `correlation_id` for multi-step incident reconstruction
- Groups by `request_id` for single-request tracing

### Webhooks Page — First-Class

One of the most differentiated parts of the v0.1.25 spec:

**Subscription list**:
- URL, name, status, event types/categories, scope filter
- Consecutive failures count, last success/failure timestamps
- Health indicator: Active (green), recently failing (yellow, 1-9 failures), disabled (red, 10+ failures)

**Webhook detail** (`/webhooks/:id`):
- Full subscription config
- Delivery history (`GET /v1/admin/webhooks/{id}/deliveries`)
- Per-delivery: status, HTTP response code, attempt count, timestamps
- Test result visibility

**Security overview** (sidebar or section):
- Current SSRF protection settings (`GET /v1/admin/config/webhook-security`)
- Blocked CIDR ranges, HTTPS requirement, allowed URL patterns

### Audit Page — First-Class

For compliance and incident investigation:

**Filters**: tenant_id, key_id, operation, status (HTTP code range), from/to time range
**Columns**: timestamp, operation, tenant, key (prefix), status, request_id, IP
**No auto-refresh** — historical data, manual query only
**Use cases**: "What happened to tenant X's budget yesterday?", "Which key made this change?", "Show all 4xx errors in the last hour"

### Tenants Page — Lower Priority

Kept but last in build order. List + detail with tabs for budgets, API keys, policies.

---

## Part 3: Frontend Architecture

### Tech Stack

- Vue 3 + TypeScript + Vite (matches docs site)
- Pinia for state management
- Tailwind CSS for styling (no component library for MVP — keep it lean)
- Chart.js via vue-chartjs if charting needed later
- Vitest for unit/component tests

### Auth Flow

1. User navigates to `/login`
2. Enters admin API key
3. Dashboard calls `GET /v1/auth/introspect` with `X-Admin-API-Key` header
4. Response returns `capabilities` object — booleans for each page
5. Key stored in Pinia `auth` store (memory only, cleared on tab close)
6. Sidebar renders nav items conditionally based on `capabilities`
7. On 401/403 from any API call → clear store, redirect to `/login`

### Polling Strategy

Route-scoped, not global. Each view manages its own polling lifecycle.

| Page | Interval | Behavior |
|------|----------|----------|
| Overview | 30s | Pause on Page Visibility API `hidden`; back off 2x on error (max 5min) |
| Events | 15s | Same visibility/backoff rules |
| Budgets list | 60s | Same |
| Budget detail | 30s | Same |
| Webhooks | 60s | Same |
| Audit | Manual only | Explicit "Run query" button, no auto-refresh |
| Tenants | 60s | Same |

Implemented via `usePolling(callback, interval)` composable that:
- Calls callback immediately on mount
- Sets interval, clears on unmount
- Pauses when `document.visibilityState === 'hidden'`
- On error: doubles interval (max 5min), resets to normal on next success
- Returns `{ isPolling, refresh }` for manual trigger

### Route Map

```typescript
const routes = [
  { path: '/login', name: 'login', meta: { public: true } },
  { path: '/', name: 'overview' },
  { path: '/budgets', name: 'budgets' },         // query: scope, unit (when both present = detail mode)
  { path: '/events', name: 'events' },            // query: category, type, tenant_id, scope, correlation_id, from, to
  { path: '/webhooks', name: 'webhooks' },
  { path: '/webhooks/:id', name: 'webhook-detail' },
  { path: '/audit', name: 'audit' },              // query: tenant_id, key_id, operation, status, from, to
  { path: '/tenants', name: 'tenants' },
  { path: '/tenants/:id', name: 'tenant-detail' },
]
```

Budget detail: when both `scope` and `unit` query params are present, the budgets view switches from list mode to detail mode. Uses `GET /v1/admin/budgets/lookup?scope=X&unit=Y` for exact match.

### API Client

```typescript
// src/api/client.ts — admin-key only
// Only sends X-Admin-API-Key header. No X-Cycles-API-Key.
// Backend dual-auth allowlist ensures admin key is accepted for budget/policy reads.
// Budget/policy list calls MUST include tenant_id query param.
```

### CORS Config

The current `WebConfig.java` only registers the auth interceptor — it has no CORS configuration. For the dashboard to make cross-origin requests, add CORS support:

**File**: `WebConfig.java` — add `addCorsMappings()`:

```java
@Override
public void addCorsMappings(CorsRegistry registry) {
    registry.addMapping("/v1/**")
        .allowedOrigins(dashboardOrigin)       // from config: e.g., "http://localhost:5173"
        .allowedMethods("GET", "POST", "PATCH", "DELETE", "OPTIONS")
        .allowedHeaders("X-Admin-API-Key", "Content-Type")
        .maxAge(3600);
}
```

The `dashboardOrigin` should be configurable via application property (e.g., `dashboard.cors.origin`). In development, this is `http://localhost:5173` (Vite default). In production, it's the dashboard's deployed URL.

### Store Design

```
stores/
  auth.ts       — apiKey, capabilities, login(), logout(), isAuthenticated
  overview.ts   — single GET /v1/admin/overview → all overview data
  budgets.ts    — list with filters (includes tenant_id param) + detail via lookup endpoint
  events.ts     — list with filters including correlation_id + time range
  webhooks.ts   — list + per-subscription delivery history
  audit.ts      — list with filters, manual-only refresh
  tenants.ts    — list + detail (budgets, keys, policies per tenant)
```

---

## Part 4: Implementation Order

### Phase 1: Backend — Auth + New Endpoints (cycles-server-admin)

**Files to modify**:
- `config/AuthInterceptor.java` — add `/v1/admin/overview` and `/v1/auth/introspect` to `requiresAdminKey()`; add explicit `ADMIN_READABLE_ENDPOINTS` allowlist with `hasAdminKeyHeader()` helper
- `config/AuthInterceptorTest.java` — dual-auth tests + new endpoint auth tests
- `config/WebConfig.java` — CORS configuration with configurable origin
- `controller/BudgetController.java` — fix tenant scoping for admin callers on `list()`; add `lookup()` endpoint
- `controller/PolicyController.java` — fix tenant scoping for admin callers on `list()`; add `tenant_id` param

**Files to create**:
- `model/shared/AdminOverviewResponse.java` — enriched overview DTO with top-offender arrays
- `service/AdminOverviewService.java` — aggregation through repositories
- `controller/AdminOverviewController.java` — `GET /v1/admin/overview`
- `controller/AdminOverviewControllerTest.java` — tests
- `model/auth/AuthIntrospectResponse.java` — capabilities-based response
- `controller/AuthController.java` (modify) — add `GET /v1/auth/introspect`
- `data/repository/BudgetRepository.java` (modify) — add `getByExactScope(scope, unit)`

**Spec files to update (BEFORE or WITH code, not after)**:
- `complete-budget-governance-v0.1.25.yaml` — the dashboard depends on behavior not in the current spec. All of the following must be documented before the code ships:
  - `GET /v1/admin/budgets` and `GET /v1/admin/policies`: add `AdminKeyAuth` as alternative security scheme for read access
  - `GET /v1/admin/policies`: add `tenant_id` query parameter (budgets already has it)
  - `GET /v1/admin/budgets/lookup`: new endpoint definition with `scope` and `unit` query params, 200/404 responses
  - `GET /v1/admin/overview`: new endpoint definition with full response schema
  - `GET /v1/auth/introspect`: new endpoint definition with AdminKeyAuth only (v1), capabilities response
  - Update the security schemes section to document the explicit dual-auth allowlist semantics

### Phase 2: Dashboard Skeleton

1. Vue 3 + Vite + TypeScript project init
2. API client (admin-key only, `X-Admin-API-Key` header)
3. Auth store with `GET /v1/auth/introspect` + capabilities
4. Login view
5. App layout with capability-aware sidebar nav
6. Router with auth guard
7. `usePolling` composable with visibility API + exponential backoff

### Phase 3: Overview

1. Overview store calling `GET /v1/admin/overview` (single request)
2. Over-limit scopes section with utilization bars + links
3. Debt scopes section with debt/overdraft ratio
4. Failing webhooks section with links to webhook detail
5. Recent denials + expiries with reason codes
6. Summary counters (tenants, budgets, webhooks by status)

### Phase 4: Budgets

1. Tenant selector (dropdown or derived from overview data)
2. Budget list with filters (scope prefix, unit, status, over-limit, has-debt) — includes `tenant_id` param
3. Sorting (utilization %, debt, scope)
4. Per-budget: utilization bar, debt bar, status/over-limit indicators
5. Budget detail mode (query params) using exact lookup endpoint
6. Detail: full breakdown + debt utilization + event timeline for scope

### Phase 5: Events

1. Event list with filters (category, type, tenant_id, scope, correlation_id, from/to)
2. Detail: raw JSON payload, actor, request_id, correlation_id, source
3. Links from event fields → tenant/budget/webhook detail
4. "View correlated events" link when correlation_id present

### Phase 6: Webhooks

1. Subscription list with health indicators (green/yellow/red based on failure count)
2. Webhook detail page with full config + delivery history
3. Per-delivery: status, HTTP code, attempt count, timestamps
4. Webhook security config display

### Phase 7: Audit

1. Query interface with filters (tenant, key, operation, status code, time range)
2. Results table: timestamp, operation, tenant, key prefix, status, request_id, IP
3. Manual-only refresh (no polling)

### Phase 8: Tenants

1. Tenant list with status badges
2. Tenant detail with tabs: budgets, API keys, policies
3. Lower priority — last to build

### Phase 9: Docker + Polish

1. Dockerfile (multi-stage: node build → nginx static serve)
2. nginx.conf (SPA routing + reverse proxy `/v1/` to admin server)
3. docker-compose.yml with dashboard service
4. Loading skeletons, error states, empty states
5. Responsive sidebar

---

## Part 5: Testing Strategy

Priority order (not vanity coverage):

1. **Backend auth tests** — new endpoint auth routing: `/v1/admin/overview` and `/v1/auth/introspect` require admin key; dual-auth allowlist: admin key accepted/rejected on correct endpoints, no write escalation
2. **Backend tenant scoping tests** — admin key + tenant_id param on budgets/policies list; admin key without tenant_id → 400; API key still uses authenticated tenant (regression)
3. **Backend contract tests** — overview, introspect, budget lookup responses match documented shapes
4. **Frontend API contract tests** — response parsing matches expected types
5. **Frontend auth/capability tests** — login flow, capability-based nav hiding, 401 redirect
6. **Component tests** — utilization bar rendering at various thresholds, status badges, event type badges, filter interactions
7. **Store tests** — state transitions, polling backoff behavior, error handling
8. **E2E flows** (Playwright, stretch goal) — login → overview → click over-limit budget → see events → filter by correlation

---

## Verification

### Backend (cycles-server-admin)
1. `mvn-proxy -B verify` — all existing + new tests pass
2. `GET /v1/admin/overview` without admin key → 401 (auth routing works)
3. `GET /v1/admin/overview` with admin key → 200 enriched response with `over_limit_scopes[]`, `failing_webhooks[]`, etc.
4. `GET /v1/admin/budgets` with `X-Admin-API-Key` + `tenant_id=acme` → 200 (dual-auth + tenant scoping works)
5. `GET /v1/admin/budgets` with `X-Admin-API-Key` without `tenant_id` → 400 (tenant scoping enforced)
6. `GET /v1/admin/policies` with `X-Admin-API-Key` + `tenant_id=acme` → 200 (dual-auth + tenant scoping works)
7. `POST /v1/admin/budgets` with `X-Admin-API-Key` → 401 (write not escalated)
8. `GET /v1/admin/budgets/lookup?scope=tenant:acme&unit=USD_MICROCENTS` → single budget or 404
9. `GET /v1/auth/introspect` with admin key → `{"authenticated": true, "auth_type": "admin", "permissions": ["*"], "capabilities": {...all true}}`
10. `GET /v1/auth/introspect` without admin key → 401 (v1 is admin-only; ApiKeyAuth support deferred)

### Frontend (cycles-dashboard)
1. `npm run build` — compiles with zero errors
2. `npm run test` — all tests pass
3. Login with admin key → introspection succeeds → overview loads in one request
4. Overview shows over-limit scopes, debt scopes, failing webhooks, recent denials
5. Click over-limit scope → budgets page with exact budget detail via lookup
6. Budgets list page shows tenant selector, loads budgets with `tenant_id` param
7. Events page: filter by correlation_id → correlated events grouped
8. Webhooks page: subscription list with health colors, click → delivery history
9. Audit page: query by tenant + time range → results table, no auto-refresh

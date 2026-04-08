# Cycles Admin Dashboard — Audit

**Date:** 2026-04-08 (v0.1.25.5 initial release)
**Spec:** `complete-budget-governance-v0.1.25.yaml` (OpenAPI 3.1.0, v0.1.25.5)
**Stack:** Vue 3 + TypeScript + Vite + Pinia + Tailwind CSS v4

### 2026-04-08 — v0.1.25.5: Initial release

First visual surface for the Cycles budget governance platform. Operations-first design — organized around operator workflows, not CRUD entity lists.

**Pages:**

| Page | API Endpoint | Features |
|------|-------------|----------|
| Login | `GET /v1/auth/introspect` | Admin key auth, capability discovery |
| Overview | `GET /v1/admin/overview` | Single-request aggregated dashboard, clickable summary cards, drill-down links to all sections |
| Tenants | `GET /v1/admin/tenants[/{id}]` | List + detail with tabbed budgets/keys/policies |
| Budgets | `GET /v1/admin/budgets`, `/lookup` | Tenant-scoped list with filters, exact scope detail, utilization/debt bars, event timeline |
| Events | `GET /v1/admin/events` | Correlation-first investigation, expandable rows with JSON payload, filter by category/type/scope/tenant/correlation_id |
| Webhooks | `GET /v1/admin/webhooks[/{id}]`, `/deliveries` | Health indicators (green/yellow/red), delivery history, subscription detail |
| Audit | `GET /v1/admin/audit/logs` | Manual-only query, CSV/JSON export, status code badges |

**Architecture:**

| Component | Details |
|-----------|---------|
| API client | `src/api/client.ts` — admin-key only (`X-Admin-API-Key`), auto-redirect on 401 |
| Auth store | `src/stores/auth.ts` — Pinia, memory-only key storage, capability-gated sidebar |
| Polling | `src/composables/usePolling.ts` — visibility API pause, exponential backoff (2x, max 5min), isLoading state |
| Router | `src/router.ts` — auth guard, lazy-loaded routes |
| Types | `src/types.ts` — matches governance spec schemas (AdminOverviewResponse, AuthIntrospectResponse, BudgetLedger, Event, etc.) |

**Components:**

| Component | Purpose |
|-----------|---------|
| `Sidebar.vue` | Nav with icons, exact route matching, active indicator, version display, capability gating |
| `PageHeader.vue` | Title, "Updated Xm ago" timestamp, refresh button, optional back arrow |
| `RefreshButton.vue` | Spinning icon during load, disabled state |
| `StatusBadge.vue` | Color-coded status badges (green/yellow/red) |
| `UtilizationBar.vue` | Budget utilization bar with color thresholds |
| `LoadingSkeleton.vue` | Animated pulse skeleton for initial page load |

**UX decisions:**

- Overview summary cards link directly to their respective pages
- Every section has "View all" drill-down links
- Budget/policy list endpoints require `tenant_id` param (per spec dual-auth allowlist)
- Budget detail uses exact `(scope, unit)` lookup, not prefix search
- Events use client-side exact scope filtering in budget detail timeline (server uses prefix match)
- Audit is manual-only — no auto-refresh, explicit "Run Query" button
- Audit export: CSV with proper quoting, JSON with pretty-print

**Spec compliance:** Audited against `complete-budget-governance-v0.1.25.yaml` — all 13 API paths match spec, all response types match schemas, `event.timestamp` (not `created_at`), `tenant_id` required on budget/policy list calls for AdminKeyAuth.

**Tests:** 15 pass (auth store login/logout/error, polling backoff logic, StatusBadge color mapping). Build: zero TypeScript errors.

**Docker:** Multi-stage Dockerfile (node:20-alpine build, nginx:alpine serve), SPA routing + `/v1/` reverse proxy, docker-compose with admin server + Redis.

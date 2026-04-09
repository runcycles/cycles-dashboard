# Cycles Admin Dashboard — Audit

**Date:** 2026-04-08 (v0.1.25.8)
**Spec:** `complete-budget-governance-v0.1.25.yaml` (OpenAPI 3.1.0, v0.1.25.8)
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

---

### 2026-04-08 — v0.1.25.5 (polish): Post-merge improvements

| Category | Changes |
|----------|---------|
| **Security** | Open redirect fix in login; JSON parse error handling in API client; 401 redirect navigates to login with redirect path; session idle timeout (30min) + absolute timeout (8h); `.env` in `.gitignore` |
| **Session** | Key persisted in `sessionStorage` (survives refresh, cleared on tab close); activity tracking via mousedown/keydown/scroll/touchstart; timeout check every 60s; expired session shows banner on login |
| **New page** | API Keys — cross-tenant key list with status badges, masked key IDs (reveal/copy), permissions as wrapped pills, tenant links, scope filters |
| **UX** | Sidebar icons + exact route matching; PageHeader with "Updated Xm ago" on all views; LoadingSkeleton; back buttons on detail views; event chevron expand indicators; audit auto-query on mount; audit time range presets (1h/6h/24h/7d); events empty state suggests clearing filters; webhook health tooltips for colorblind |
| **Drill-down** | Overview "View all" on over-limit/debt sections filters budgets page cross-tenant; page title changes to match filter; blue filter banner with "Clear filter" |
| **Consistency** | Shared format utils (formatDateTime/formatDate/formatTime/formatRelative); all views use them; TenantLink component prevents 404 on `__system__` tenant; key_id masked in UI, plain text in exports |
| **Bugs fixed** | UtilizationBar always 0% (DEBIT reduces both allocated+remaining); audit "Querying..." stuck (response field `logs` not `entries`; `log_id` not `entry_id`); format.ts created but never imported |
| **Docs** | README: badges, HTTPS/TLS guide, production deployment with Caddy, hardening checklist (7 areas), dev vs prod comparison table; CORS clarified as dev-only concern |
| **Files** | docker-compose.prod.yml, Caddyfile.example, nginx-ssl.conf.example |

---

### 2026-04-08 — v0.1.25.6: UX/UI + Security hardening

Comprehensive review addressing 8 security gaps and 12 usability improvements.

**Security fixes:**

| ID | Issue | Fix |
|----|-------|-----|
| S1 | No login rate limiting | Client-side exponential backoff after 3 failures (5s→10s→20s→…60s cap); locked button with countdown |
| S2+S3 | No security headers in default nginx.conf | Added CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy to `nginx.conf` |
| S4 | Exports leak sensitive data without confirmation | Confirmation dialog before CSV/JSON export showing record count and sensitivity warning |
| S5 | No Subresource Integrity on build assets | Added `vite-plugin-sri-gen` to Vite build for SRI hash injection |
| S6 | Session timeout check too slow (60s) | Tightened check interval to 15s — max stale session window reduced 4x |
| S7 | No HSTS header | Added `Strict-Transport-Security` with `max-age=63072000; includeSubDomains; preload` to both nginx configs |
| S8 | Clipboard retains copied keys indefinitely | Auto-clear clipboard 30s after copy if value still matches |

**UX/Usability fixes:**

| ID | Issue | Fix |
|----|-------|-----|
| U1 | No responsive breakpoints | Added `sm:`, `md:`, `lg:` grid breakpoints to Overview cards, alert panels, detail grids, loading skeleton |
| U2 | Tables overflow on narrow viewports | Added `overflow-x-auto` + `min-w-[Xpx]` to all 8+ data tables |
| U3 | No column sorting | New `useSort` composable + `SortHeader` component; sortable columns on Tenants, Budgets, Events, API Keys, Webhooks, Audit tables |
| U4 | No pagination controls | "Load more" button with cursor-based pagination on Budgets and Events tables |
| U5 | Expandable event rows not keyboard-accessible | Added `role="button"`, `tabindex="0"`, `Enter`/`Space` handlers, `aria-expanded` to event rows |
| U6 | No dark mode | Dark mode via `prefers-color-scheme` + manual toggle in sidebar; CSS-level overrides for surfaces, text, borders, inputs |
| U7 | Form labels not associated with inputs | Added `for`/`id` bindings on all filter form labels (Events, Audit, Budgets, API Keys) |
| U8 | No export confirmation | Covered by S4 — confirmation dialog with sensitivity warning |
| U9 | No loading feedback on filter changes | Inline spinner appears in filter bar during refetch (Budgets, API Keys) |
| U10 | Relative timestamps lack absolute tooltip | Added `title` attribute with ISO timestamp to all `formatRelative`, `formatDateTime`, `formatTime` displays |
| U11 | Plain text empty states | New `EmptyState` component with inbox SVG illustration, contextual message, and optional hint/action slot |
| U12 | No skip-to-content link | Added visually-hidden skip link in `AppLayout` for WCAG compliance |

**New files:**

| File | Purpose |
|------|---------|
| `src/composables/useSort.ts` | Generic client-side column sorting composable |
| `src/composables/useDarkMode.ts` | Dark mode toggle with localStorage persistence + system preference sync |
| `src/components/SortHeader.vue` | Sortable table header with direction indicators |
| `src/components/EmptyState.vue` | Illustrated empty state with message, hint, and slot |

**Post-review fixes (same version):**

| Category | Fix |
|----------|-----|
| **Bug** | `useDarkMode` memory leak — refactored to singleton pattern; system preference listener registered once globally, no duplicate registrations |
| **Bug** | `LoginView` timer leak — `lockTimer` now cleared on successful login and in `onUnmounted` hook |
| **Bug** | `BudgetsView` stale cursor — `nextCursor` reset when entering cross-tenant filter mode |
| **Bug** | `MaskedValue` clipboard timer leak — `onUnmounted` now clears `clipboardClearTimer` |
| **A11y** | `SortHeader` — added `aria-sort`, `aria-label`, and `role="columnheader"` attributes |
| **A11y** | `EmptyState` — applied consistently to TenantDetailView tabs (budgets/keys/policies) and WebhookDetailView deliveries |
| **Dark mode** | Full CSS dark theme: all gray text scale inverted for readability (gray-900→100, 800→200, …, 400→400); semantic colors (red/blue/yellow) brightened; status badges, UtilizationBar, RefreshButton, LoadingSkeleton, alert banners, export dialog all adapted |
| **Dark mode** | Table row hover toned down (40% blend); CTA buttons switched to ghost/outlined style; focus ring overrides; link blue brightened for contrast |
| **Dark mode** | Alert banner borders (red-200, yellow-200, blue-200) mapped to dark equivalents |
| **Responsive** | Mobile sidebar — hamburger menu with slide-out drawer on `<md` screens; overlay dismiss; nav items emit `navigate` to auto-close drawer; mobile header bar with logo |
| **Security** | HSTS header removed from HTTP-only `nginx.conf` (spec violation); kept in `nginx-ssl.conf.example` only |

**Tier 1 operational actions (write):**

| Action | Endpoint | Location | Capability gate |
|--------|----------|----------|-----------------|
| Suspend / reactivate tenant | `PATCH /v1/admin/tenants/{id}` | Tenant detail view | `manage_tenants` |
| Revoke API key | `DELETE /v1/admin/api-keys/{id}` | API Keys list + Tenant detail keys tab | `manage_api_keys` |

All actions require confirmation dialog with explicit description of impact. Revoke is marked as irreversible. Actions are capability-gated — buttons hidden when capability is `false`.

**New files:**

| File | Purpose |
|------|---------|
| `src/components/ConfirmAction.vue` | Reusable confirmation dialog with danger/normal variants, dark mode support |

**Build:** Zero TypeScript errors. 15 tests pass. Version 0.1.25.6.

---

### 2026-04-08 — v0.1.25.7: Tier 2 operational actions

Adds convenience write actions for day-to-day operations.

**Spec-aligned corrections (from v0.1.25.6 review):**

All write operations audited against `complete-budget-governance-v0.1.25.yaml` and corrected:

| Action | Spec endpoint | Method | Key correction |
|--------|---------------|--------|----------------|
| Suspend/reactivate tenant | `/v1/admin/tenants/{tenant_id}` | PATCH `{ status }` | Correct as-is |
| Revoke API key | `/v1/admin/api-keys/{key_id}` | **DELETE** (not PATCH) | Spec uses DELETE with optional `reason` query param |
| Pause / enable webhook | `/v1/admin/webhooks/{subscription_id}` | PATCH `{ status: 'PAUSED'/'ACTIVE' }` | Spec enum is ACTIVE/PAUSED (not DISABLED); re-enabling resets `consecutive_failures` |
| Reset & re-enable webhook | `/v1/admin/webhooks/{subscription_id}` | PATCH `{ status: 'ACTIVE' }` | Same as enable — spec resets failures on ACTIVE transition |
| Freeze budget | `POST /v1/admin/budgets/freeze?scope&unit` | POST (optional `{ reason }`) | Spec v0.1.25 added dedicated freeze endpoint with `AdminKeyAuth` |
| Unfreeze budget | `POST /v1/admin/budgets/unfreeze?scope&unit` | POST (optional `{ reason }`) | Spec v0.1.25 added dedicated unfreeze endpoint with `AdminKeyAuth` |
| Adjust budget allocation | `POST /v1/admin/budgets/fund?tenant_id&scope&unit` | POST `BudgetFundingRequest` | Spec v0.1.25 added `AdminKeyAuth` to fund endpoint (dual-auth); `tenant_id` required for admin callers |

**UX details:**
- Webhook pause/enable and reset use `ConfirmAction` dialog with spec-accurate descriptions
- Budget allocation uses inline form with RESET operation, auto-generated idempotency key, audit reason
- API key revoke sends reason string for audit trail
- All actions capability-gated and refresh data inline after success

**Post-review fixes (same version):**

| Category | Fix |
|----------|-----|
| **Bug** | Login→logout→login showed blank layout — `App.vue` now checks `$route.name !== 'login'` before rendering `AppLayout`; `LoginView` awaits `router.push` before clearing loading state |
| **Bug** | ConfirmAction dialog not dismissable via Escape — added `keydown` listener with cleanup, `role="dialog"`, `aria-modal`, `aria-label` |
| **Bug** | Budget tenant filter defaulted to first tenant instead of "All tenants" — dropdown now starts empty with "All tenants" option; loads across all tenants when none selected |
| **Bug** | Status/Unit/Scope filters had no effect in all-tenant mode — filters now applied client-side via `applyClientFilters()` after cross-tenant aggregation |
| **Defensive** | `submitAdjustment` guards against empty `selectedTenant` |

**Build:** Zero TypeScript errors. 15 tests pass. Version 0.1.25.7.

---

### 2026-04-08 — v0.1.25.8: Admin CRUD operations

Full admin management UI — create, update, and delete resources directly from the dashboard.

**New shared components:**

| Component | Purpose |
|-----------|---------|
| `FormDialog.vue` | Reusable modal form with Escape dismiss, dark mode, loading/error states |
| `SecretReveal.vue` | One-time secret display with copy button, confirmation checkbox, auto-clear |

**New CRUD operations:**

| Action | Endpoint | Location |
|--------|----------|----------|
| Create tenant | `POST /v1/admin/tenants` | Tenants list |
| Edit tenant (name) | `PATCH /v1/admin/tenants/{id}` | Tenant detail |
| Create API key | `POST /v1/admin/api-keys` | API Keys list + Tenant detail keys tab |
| Edit API key (name, permissions, scope) | `PATCH /v1/admin/api-keys/{id}` | API Keys list |
| Create webhook | `POST /v1/admin/webhooks` | Webhooks list |
| Delete webhook | `DELETE /v1/admin/webhooks/{id}` | Webhook detail |
| Test webhook | `POST /v1/admin/webhooks/{id}/test` | Webhook detail |
| Replay events | `POST /v1/admin/webhooks/{id}/replay` | Webhook detail |

**UX details:**
- Create API key and create webhook show one-time secret via SecretReveal (copy + confirm before close)
- Create tenant navigates to the new tenant detail page on success
- Create webhook navigates to webhook detail after secret is acknowledged
- Tenant edit is a simple name edit modal
- API key edit supports permissions checkbox grid and scope filter
- Webhook delete uses ConfirmAction danger dialog (irreversible)
- Test webhook shows inline result (success/fail badge, HTTP status, response time)
- Replay uses FormDialog with from/to datetime range and max_events
- All create/edit actions use FormDialog with inline error display
- All actions capability-gated (`manage_tenants`, `manage_api_keys`, `manage_webhooks`)

**Infrastructure:**
- New `mutate<T>` helper in api/client.ts consolidates POST/PATCH/DELETE with consistent auth/error handling
- New `post<T>` and `del<T>` wrappers
- New types: `ApiKeyCreateRequest/Response`, `ApiKeyUpdateRequest`, `TenantCreateRequest/UpdateRequest`, `WebhookCreateRequest/Response`, `WebhookTestResponse`, `ReplayEventsRequest/Response`
- Well-known enums exported: `PERMISSIONS`, `EVENT_TYPES`, `EVENT_CATEGORIES`, `COMMIT_OVERAGE_POLICIES`

**Build:** Zero TypeScript errors. 15 tests pass. Version 0.1.25.8.

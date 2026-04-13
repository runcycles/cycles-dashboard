# Cycles Admin Dashboard — Audit

**Date:** 2026-04-13 (v0.1.25.18)
**Spec:** `cycles-governance-admin-v0.1.25.yaml` (OpenAPI 3.1.0, **v0.1.25.12** — additive error-response docs only since v0.1.25.10; no schema or endpoint changes)
**Stack:** Vue 3 + TypeScript + Vite + Pinia + Tailwind CSS v4

### 2026-04-13 — v0.1.25.18: Round-3 audit fixes (write-op hardening + CSV injection + circular JSON + pagination)

Follow-up to v0.1.25.17. Systematic audit of every write operation across detail views, plus security review of export paths. Six fixes; all client-side.

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| 1 | **Fund Budget**: empty amount field silently `return`'d (`!fundForm.value.amount` was the only guard); `Number('') === 0` would have submitted a zero-fund had it gotten past, leaving an audit-log artifact. | Critical | Trim + explicit "Amount is required" / "Amount must be a positive number" errors. Fail-loud instead of silent return; reset `fundError` up-front so stale errors don't flash on retry. |
| 2 | **Fund Budget**: `idempotencyKey = ${...}-${Date.now()}` collided when two clicks landed in the same millisecond — two distinct mutations got the same key, so the server treated the second as a replay of the first. | Critical | Append 64 bits of `crypto.getRandomValues` to every key; add an in-flight `fundLoading` re-entry guard as defense in depth. |
| 3 | **AuditView CSV export**: cells starting with `=`, `+`, `-`, `@`, TAB, or CR are interpreted as formulas by Excel/Sheets/LibreOffice (CWE-1236, CSV injection). Server-controlled `operation`/`source_ip`/`user_agent` fields were unprotected. | Important (security) | Centralized `csvEscape()` prefixes dangerous leading chars with a single quote; double-quotes content per RFC 4180. JSON export now uses `safeJsonStringify` too. |
| 4 | **EventsView payload panel**: `JSON.stringify(e.data, null, 2)` in template — a server payload with a circular ref (or a BigInt) would throw inside the render expression and blank the entire details panel. | Important | `safeJsonStringify` with WeakSet replacer marks cycles `"[Circular]"`, BigInts get an `n` suffix; falls back to `[Unserializable: ...]` on any other throw. |
| 5 | **BudgetsView pagination**: filter changes refetched page 1 but did not reset `nextCursor`; clicking "Load more" between the watcher firing and the fetch returning sent a cursor scoped to the previous filter — server returns misaligned results or a stale-cursor error. | Important | Reset `nextCursor` and `hasMore` at the top of `loadList()`. |
| 6 | **WebhooksView Security Config dialog**: form was populated only after the GET resolved, so on slow networks the dialog briefly showed prior-session values that the user might edit before the real config arrived. | Minor | Synchronous reset of `securityForm` / `securityConfig` before showing the dialog. |

**New helper module** `src/utils/safe.ts` — three small, single-purpose functions (`safeJsonStringify`, `csvEscape`, `tenantFromScope`) used by the fixes above. `tenantFromScope` was previously inline in `BudgetsView.vue`; extracted so it's testable in isolation.

**Tests.** +24 new cases in `src/__tests__/safe.test.ts`:

- `safeJsonStringify` — plain-object parity with `JSON.stringify`, circular ref → `[Circular]`, BigInt → `Ns`, indent param, undefined/null edges (6 cases).
- `csvEscape` — RFC 4180 quoting, embedded quotes, commas/newlines, null/undefined, number/boolean coercion, all 6 formula-injection prefixes (`=` / `+` / `-` / `@` / TAB / CR), no-prefix when `=` is mid-string (10 cases).
- `tenantFromScope` — bare scope, compound scope, dashes/dots/underscores in id, non-tenant scopes, null/undefined/empty, no false positive when `tenant:` is mid-string (8 cases).

**Gates.** typecheck clean; **177/177 tests pass** (was 153); build clean.

**Spec compliance.** Unchanged. No endpoint, schema, or wire-format changes.

---

### 2026-04-13 — v0.1.25.17: Three reported write-op bugs

Reported by user: Fund Budget Execute does nothing; Rotate Secret doesn't display the new secret; Save Config on Webhook Security logs the user out.

| Bug | Root cause | Fix |
|-----|-----------|-----|
| **Fund Budget Execute button is a no-op (no logs, no change)** | `submitFund()` in `BudgetsView.vue` silently `return`'d when `selectedTenant.value` was empty. The detail page is typically reached via deep link / drill-down where the tenant dropdown is never touched, so `selectedTenant` was always `''`. | Derive tenant from the canonical scope (`tenant:<id>[/...]`) when the dropdown hasn't been used. Surface an explicit error ("Cannot determine tenant for scope …") instead of silently dropping the click. |
| **Rotate Secret generates a secret but never displays it** | The secret is generated client-side in `rotateWebhookSecret()` and PATCHed; the previous implementation read `res.signing_secret` from the server response, but admin servers typically don't echo write-only secrets on PATCH. The UI then silently displayed nothing and the secret was effectively unrecoverable. | Changed the wrapper to return `{ subscription, signing_secret }` — the secret is always returned, sourced from the locally-generated value. Toast also warns "copy it now, it will not be shown again". |
| **Save Config on Webhook Security logs user out** | `api/client.ts` treated both **401** and **403** as a session end via `handleUnauthorized()`. A 403 on PUT `/v1/admin/config/webhook-security` (key present but lacks `admin:webhooks:write`) was killing the entire session instead of surfacing a permission error on that one operation. | Removed 403 from the logout path. 401 still ends the session; 403 now flows through `toApiError()` and surfaces as an `ApiError` with `errorCode: "FORBIDDEN"` in the form's error slot — rest of the UI keeps working. |

**Tests.** +4 cases in `client.test.ts`: rotate secret returns secret even when server response omits it, rotate secret returns `{ subscription, signing_secret }` shape, 403 does NOT logout / does throw `ApiError`, 401 still logs out.

**Spec compliance.** Unchanged. No endpoint, schema, or wire-format changes — these were all client bugs.

---

### 2026-04-13 — v0.1.25.16: UI bug fixes + polish

Targeted fixes from the post-v0.1.25.15 UI review. No spec or API surface changes.

| Area | Change |
|------|--------|
| **`usePolling`** | Post-unmount leak: if a `tick()` was awaiting a fetch when the view unmounted, the completing tick would call `reschedule()` and install a fresh `setInterval` that nobody cleared. Added a `mounted` flag — `tick()`/`reschedule()`/`refresh()` now bail out once unmounted, so no state mutations and no timer leaks past teardown. |
| **`utils/format`** | All four formatters (`formatDateTime` / `formatDate` / `formatTime` / `formatRelative`) now accept `string \| null \| undefined` and return `'—'` for null-ish or unparseable input. Prior to this, views that skipped the `v-if` check rendered a literal `"Invalid Date"` string. |
| **`BudgetsView`** | Tenant-list fetch failure was silently `console.error`'d, leaving the filter dropdown empty with no explanation. Added a `tenantsError` ref and an inline `role="alert"` message under the filter. |
| **`WebhookDetailView` — replay** | Added client-side `from <= to` sanity check (avoids a wasted round-trip to a server that also rejects). Replay success banner no longer auto-dismisses after 5s (easy to miss when scrolled into the deliveries list); now shows until the user clicks the dismiss ✕. |
| **`MaskedValue`** | Reveal and copy icon-only buttons now carry `aria-label` (`"Reveal credential"` / `"Hide credential"`, `"Copy credential to clipboard"` / `"Copied to clipboard"`). |

**Tests.** +7 cases: null/garbage/empty guards across all four formatters (`format.test.ts`), real-lifecycle unmount-safety regression for `usePolling` via `@vue/test-utils` (`usePolling.test.ts`).

---

### 2026-04-13 — v0.1.25.15: Structured ErrorResponse parsing + spec refresh

**Spec tracking.** Admin spec advanced v0.1.25.10 → v0.1.25.11 → v0.1.25.12 since our last review. Both bumps are **purely additive error-response documentation** — no schema changes, no new endpoints, no behavior change:

- **v0.1.25.11** — documented `400 Bad Request` on all 28 admin operations that previously lacked it (all 43 ops now document 400).
- **v0.1.25.12** — documented targeted `404` on `PATCH /v1/admin/tenants/{id}`; `409` on `POST /v1/admin/policies` (DUPLICATE_RESOURCE); `409` on `DELETE /v1/admin/api-keys/{id}` (ALREADY_REVOKED).

No dashboard surface changes required. Previously-valid responses remain valid.

**Dashboard change — `ApiError` class** (`src/api/client.ts`). `request()` / `mutate()` now parse non-2xx `ErrorResponse` bodies (`{ error, message, request_id, details? }`) and throw a typed `ApiError` with `status`, `errorCode`, `requestId`, `details`. The friendly `.message` combines server message + code (e.g. `"Policy already exists for this tenant (DUPLICATE_RESOURCE)"`), so existing `err.message` consumers in write-op views get better toasts for free without code changes. Falls back to `"API error: <status>"` when the body is missing, empty, or non-JSON.

**Tests.** 4 new cases covering: structured parse → ApiError with errorCode+requestId, `details` passthrough, empty-object fallback, non-JSON fallback. Existing non-2xx propagation test retained with JSON-rejection mock.

---

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

### 2026-04-08 — v0.1.25.10: Admin CRUD operations

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

**Build:** Zero TypeScript errors. 15 tests pass. Version 0.1.25.10.

---

### 2026-04-09 — v0.1.25.10: Full ops coverage + UX polish

**Operational coverage (closes all AdminKeyAuth spec gaps):**

| Category | Actions added |
|----------|-------------|
| **Budgets** | Fund (credit/debit/reset/repay_debt), edit config (overdraft limit, overage policy), sortable utilization + debt columns |
| **Tenants** | Close (irreversible, GitHub-style name confirmation), expanded edit (TTL, overage policy), list suspend/reactivate |
| **Webhooks** | Edit (name, URL, events, scope, failure threshold), rotate signing secret, pause/enable on list, security config (CIDR, URL patterns, allow_http) |
| **Audit** | Server-side resource_type + resource_id filters |

**UX improvements:**

| Feature | Details |
|---------|---------|
| Toast notifications | Success toast on all write actions (4s auto-dismiss, animated) |
| Detail page subtitles | Tenant ID, webhook name, budget scope shown below page title |
| Tenant search | Filter by ID or name on tenants list |
| Create button prominence | Solid blue buttons for primary create actions |
| PageHeader #actions slot | Create buttons inside header flex (fixes spacing) |
| EventTimeline component | Shared rich expandable event display (replaces bare list on budget detail) |
| Budget sort accessors | `useSort` extended with custom value accessors for computed/nested fields |
| Audit hint | Improved empty state guidance |
| Webhook label fix | "Subscribed Event Types" with badges (was ambiguous "Events") |
| Webhook secret strength | `crypto.getRandomValues(32)` instead of `crypto.randomUUID()` |

**New components:**

| Component | Purpose |
|-----------|---------|
| `ToastContainer.vue` | Fixed-position toast notifications with enter/exit transitions |
| `EventTimeline.vue` | Reusable expandable event list with full detail (ID, source, actor, JSON data) |

**New composable:**

| Composable | Purpose |
|-----------|---------|
| `useToast.ts` | Global toast notification state with auto-dismiss |

**Build:** Zero TypeScript errors. 15 tests pass. Version 0.1.25.10.

---

### 2026-04-10 — v0.1.25.11: Bug fixes (dashboard-only minor)

No spec changes — dashboard-only patch bundle.

**Fixes:**

| # | Area | Issue | Fix |
|---|------|-------|-----|
| 1 | Audit tab | Clicking Reveal icon on masked Key ID also toggled parent row expansion (#19) | Added `.stop` modifier on the Reveal button in `MaskedValue.vue`; also added `type="button"` to both Reveal and Copy buttons |
| 2 | Logout flow | After sidebar logout, URL became `/login?redirect=/login` and login looped back to login page | Centralized 401/403 handler in `api/client.ts` now skips the redirect push if current route is already `/login`; `LoginView.submit` additionally rejects `/login` as a redirect target |
| 3 | Login button | Visible flicker on click (dim + "Connecting..." text) when the backend responded faster than perception threshold | `showLoading` visual state is now delayed 200ms; fast responses never flip it. Opacity moved to class binding with `transition-opacity duration-150` for smooth change |
| 4 | Dark mode | Webhook test-success banner rendered in bright `bg-green-50` while test-failure banner correctly tinted via global override | Added `.dark .bg-green-50` rule to `style.css` matching the existing red/yellow/blue banner overrides |

**Files touched:**

- `src/components/MaskedValue.vue` — fix #1
- `src/api/client.ts` — fix #2 (extracted `handleUnauthorized()`)
- `src/views/LoginView.vue` — fixes #2, #3
- `src/style.css` — fix #4
- `package.json`, `README.md` — version bump

**Build:** Zero TypeScript errors. 15 tests pass. Version 0.1.25.11.

---

### 2026-04-10 — v0.1.25.12: API client hardening + test coverage (round 1)

No spec changes. Addresses the fetch-timeout gap and establishes the test-coverage baseline for the API client and the redirect sanitizer.

**Code changes:**

| Area | Change |
|------|--------|
| `src/api/client.ts` | New `fetchWithTimeout()` helper backed by `AbortController` with a 30s default timeout. Translates `AbortError` → clear `Request timed out after Nms` message. Wired into both `request()` and `mutate()`. `handleUnauthorized` is now exported for testing. |
| `src/utils/sanitize.ts` | **NEW.** Extracted `sanitizeRedirect()` from `LoginView.vue` into a pure module. Accepts `(raw: unknown, origin: string)` so it can be tested without `window.location`. |
| `src/views/LoginView.vue` | Import `sanitizeRedirect` from `utils/sanitize`; pass `window.location.origin` explicitly. |

**New tests (+35):**

| Suite | Count | Covers |
|-------|-------|--------|
| `sanitize.test.ts` | 25 | Happy path (path/search/hash preservation), empty/null/undefined/non-string inputs, open-redirect attack vectors (`//evil.com`, `javascript:`, `data:`, absolute URLs), `/login` loop rejection, edge cases (URL-encoded slashes, malformed input, arbitrary origins) |
| `client.test.ts` | 10 | `fetchWithTimeout` success, signal injection, timeout via `AbortController`, non-abort error propagation, timer cleanup on success; `handleUnauthorized` logout effect, redirect push on protected routes, **no** push when already on `/login` (the logout-loop regression from v0.1.25.11 is now guarded by a test) |

**Test suite total:** 15 → **50** (3.3× increase). Focus on the highest-bug-density module (`api/client.ts`) per the code-review recommendation — the logout-loop and 401-race bugs that shipped in earlier PRs would all have been caught by these tests.

**Files touched:**

- `src/api/client.ts` — timeout helper, export `handleUnauthorized`
- `src/utils/sanitize.ts` — new file
- `src/views/LoginView.vue` — import extracted util
- `src/__tests__/sanitize.test.ts` — new file
- `src/__tests__/client.test.ts` — new file
- `package.json`, `README.md` — version bump

**Deferred from the code review (explicit non-goals for this PR):**

- **Single-flight login + serialize checkTimeout/restore** — the two real bugs we hit in this area (2-click login, logout loop) were both fixed without introducing concurrency primitives. The narrow theoretical race in `auth.ts` should be motivated by a failing test before adding mutexes.
- **95%+ overall coverage** — diminishing returns on view templates. Target 95%+ on logic-heavy files (stores, composables, API client) incrementally. Round 2 will target `auth.ts` race scenarios and `composables/*`.

**Build:** Zero TypeScript errors. 50 tests pass (was 15). Version 0.1.25.12.

---

### 2026-04-10 — v0.1.25.13: CI hygiene + error handling + test coverage round 2

Three independent improvements in one bundle, covering the open code-review gaps by category (C → B → A).

#### C. CI / branch hygiene

Prevents the silent-revert class of bug that hit PR #22 when PR #21 merged on an older base.

- **Branch protection on `main`** updated via `gh api` with `required_status_checks.strict: true`. Branches must be up to date with main before merge, and both CI checks (`ci / Test (Node 20)`, `ci / Test (Node 22)`) must pass.
- **Coverage thresholds** added to `vitest.config.ts`. Scoped to logic-heavy directories (`src/api/**`, `src/stores/**`, `src/composables/**`, `src/utils/**`) — view templates are excluded because declarative Vue templates have diminishing returns on tests. Thresholds: 70% lines/functions/branches/statements. CI will now fail on coverage regressions.

#### B. Error handling + focus management

Addresses HIGH-priority gaps from the code review.

- **`src/utils/errors.ts`** — new `toMessage(e, fallback)` helper that normalizes `unknown` caught values (`Error`, strings, plain objects with `message`, anything else) into a readable string. Kills the `e.message` → `undefined` class of bug in catch blocks.
- **Mutation-failure toasts** — swept every view (~26 catch sites) to:
  - Replace `catch (e: any) { error.value = e.message }` with `catch (e) { error.value = toMessage(e) }`
  - Add `toast.error(...)` on every mutation failure path (freeze/unfreeze, tenant suspend/reactivate, API key revoke, webhook pause/enable/delete/rotate/test). Mutations with dialog-level error banners (create/edit flows) keep their inline error but can extend later.
- **`src/composables/useFocusTrap.ts`** — new composable providing proper modal accessibility:
  - Focuses the first focusable child on mount
  - Cycles focus within the container on Tab / Shift+Tab
  - Restores focus to the previously-focused element on unmount
  - Falls back to a `tabindex=-1` container focus when no focusable children
- **`FormDialog.vue`** and **`ConfirmAction.vue`** now use `useFocusTrap` and gain proper dark-mode text colors on title/body. Affects every CRUD dialog across the app.

#### A. Test coverage round 2

Tests for the highest-risk logic files. The concurrent-login test documents the current imperfect behavior as a regression guard — it settles whether the "single-flight auth login" deferred item from the code review is a real need (yes, but only when LoginView's re-entrancy guard is bypassed, which is not currently reachable).

| Suite | Count | Covers |
|-------|-------|--------|
| `auth-extended.test.ts` | 16 | `restore()` (happy path, absolute timeout, idle timeout, network failure during re-introspect), `checkTimeout()` (fresh, expired, exact-boundary strict comparison), `touchActivity()` (no-op when logged out, updates timestamp when logged in), concurrent login behavior (two successes, success-races-failure documented), sessionStorage clear on logout |
| `errors.test.ts` | 14 | `toMessage` on Error / string / plain-object-with-message / null / undefined / number / boolean / custom fallback / Error subclasses |
| `useSort.test.ts` | 13 | asc/desc/toggle, switching columns, numeric vs lexicographic, null placement (asc/desc), both-null stability, custom accessors, default key/dir, non-mutation of source, reactivity to source changes |
| `useToast.test.ts` | 7 | show/success/error, 4s auto-dismiss, stacking, independent FIFO dismissal, unique ids, return-value exposure |
| `useDarkMode.test.ts` | 4 | default light when system light, default dark when system dark, stored preference overrides system, toggle flips state + persists |
| `format.test.ts` | 9 | `formatDateTime` / `formatDate` / `formatTime` happy paths, `Invalid Date` handling, `formatRelative` boundaries (< 60s = "just now", < 1h = "Nm ago", < 24h = "Nh ago", > 24h = date fallback, exact 60s) |
| `useFocusTrap.test.ts` | 8 | first-focusable on mount, container-fallback, restore-on-unmount, Tab wrap from last to first, Shift+Tab wrap from first to last, non-Tab keys ignored, disabled element skip, keydown listener cleanup |
| `client.test.ts` (expanded) | +20 | Endpoint smoke tests: URL + method + body for introspect, overview, listBudgets (with empty-param skip), createTenant, updateTenant, updateTenantStatus, createApiKey, revokeApiKey (with/without reason), createWebhook, deleteWebhook, testWebhook, freezeBudget, unfreezeBudget, fundBudget, rotateWebhookSecret (verifies `whsec_` prefix + 32-byte hex), 500 error, 204 no-content, invalid JSON |

**Test suite total:** 50 → **141** (2.8× increase).

**Coverage (scoped to logic dirs):**

| Directory | Lines | Branches | Functions | Statements |
|-----------|-------|----------|-----------|------------|
| `api/` (client.ts) | 81.3% | 83.3% | 61.0% | 81.7% |
| `stores/` (auth.ts) | **100%** | 86.8% | **100%** | 96.6% |
| `composables/` | 70.8% | 74.3% | 69.7% | 69.3% |
| `utils/` | **100%** | **100%** | **100%** | **100%** |
| **All files** | **81.7%** | **83.7%** | **70.5%** | **80.9%** |

All four metrics clear the 70% floor. CI will now block regressions.

**Deferred to round 3:**
- `usePolling.ts` — 0% coverage. Requires component mounting + fake timers + visibility API mocking. Doable but non-trivial.
- `FormDialog`/`ConfirmAction`/`SecretReveal`/`MaskedValue` component tests — behavioral tests (escape close, copy button, reveal clean DOM). Round 3.
- **Single-flight auth login** — the `auth-extended.test.ts > concurrent login where one fails` test documents the race as a real gap. Still deferred until it's reachable from the UI (currently blocked by LoginView's loading guard).

**Files touched:**

New:
- `src/utils/errors.ts`
- `src/composables/useFocusTrap.ts`
- `src/__tests__/errors.test.ts`
- `src/__tests__/auth-extended.test.ts`
- `src/__tests__/useSort.test.ts`
- `src/__tests__/useToast.test.ts`
- `src/__tests__/useDarkMode.test.ts`
- `src/__tests__/format.test.ts`
- `src/__tests__/useFocusTrap.test.ts`

Modified:
- `vitest.config.ts` — coverage config + thresholds
- `src/components/FormDialog.vue` — focus trap + dark-mode text fix
- `src/components/ConfirmAction.vue` — focus trap + dark-mode text fix
- `src/views/*.vue` (9 files) — `toMessage(e)` + mutation error toasts
- `src/__tests__/client.test.ts` — +20 endpoint smoke tests
- `package.json`, `README.md` — version bump

**Build:** Zero TypeScript errors. **141 tests pass** (was 50). Coverage gate enforced at 70%. Version 0.1.25.13.

---

### 2026-04-10 — v0.1.25.14: Release-readiness chore

Small cleanup PR to address release-shipping findings from the pre-release audit. No code changes, no behavior changes — just build/deploy hygiene.

**Changes:**

| # | Area | Fix |
|---|------|-----|
| 1 | `AUDIT.md` header | Updated stale `Date` line (was 2026-04-08 / v0.1.25.10) to reflect current version |
| 2 | `package-lock.json` | Regenerated via `npm install` to match `package.json` version (was stuck at 0.1.25.10) |
| 3 | `Dockerfile` | Pinned base images to specific minor versions: `node:20-alpine` → `node:20.19-alpine`, `nginx:alpine` → `nginx:1.27-alpine`. Prevents silent supply-chain drift between builds. Node 20.19 is the floor required by vite 8 / rolldown (caught during local Docker build — 20.18 fails with `MODULE_NOT_FOUND` on rolldown's native binding). |
| 4 | `.dockerignore` | **NEW.** Excludes `node_modules`, `dist`, `coverage`, tests, `.env*`, `.git`, docs, and `.github` from the Docker build context. Smaller build context, prevents leaking dev/CI artifacts into image layers. |
| 5 | `package.json` | Added `"engines": { "node": ">=20.19.0" }` to self-document the Node version requirement (matches rolldown's `engines` constraint). |
| — | `README.md` | Docker image tag bumped to 0.1.25.14 |

**Verification** (first PR to include an end-to-end local Docker test):

- `vue-tsc -b --noEmit` — clean
- `vitest run` — 141/141 pass
- `npm run test:coverage` — all thresholds pass (exit 0)
- `vite build` — clean
- **`docker build .`** — succeeds end-to-end (caught the rolldown engines bug that unpinned `node:20-alpine` was silently hiding)
- **`docker run`** — container serves HTTP 200, security headers present (`X-Frame-Options`, `X-Content-Type-Options`, CSP from `nginx.conf`)

**Release version jump:** This PR is the fourth dashboard-only minor since v0.1.25.10, the last GitHub release. The next GitHub release (v0.1.25.14) will cover all the work from v0.1.25.11 through v0.1.25.14 in a single release:

- **v0.1.25.11** — logout loop fix, login flicker fix, dark-mode green banner, audit reveal click-bubble (#19)
- **v0.1.25.12** — fetch timeout helper, test coverage round 1 (sanitize + client)
- **v0.1.25.13** — CI hygiene (strict branch protection + coverage thresholds), error handling sweep (26 catch sites + toMessage helper), focus trap composable, test coverage round 2 (auth-extended, composables, format, client smoke tests: 50 → 141 tests)
- **v0.1.25.14** — this PR: build/deploy hygiene, no behavior changes

**Deferred to a later PR:**
- `usePolling.ts` tests (round 3)
- Component behavioral tests for `SecretReveal` / `MaskedValue`
- Docker image SBOM + signing (release.yml enhancement)
- Dashboard container healthcheck in docker-compose

**Build:** Zero TypeScript errors. 141 tests pass. Coverage gate passing (81.7% lines / 83.7% branches on scoped logic dirs). Version 0.1.25.14.

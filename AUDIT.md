# Cycles Admin Dashboard — Audit

**Date:** 2026-04-14 (v0.1.25.25 complete PERMISSIONS + unknown-filter on edit), 2026-04-14 (v0.1.25.24 API-key edit diff-before-patch), 2026-04-14 (Playwright E2E layer), 2026-04-13 (v0.1.25.23 nginx hotfix), 2026-04-13 (v0.1.25.22)
**Requires:** cycles-server v0.1.25.8+ (runtime plane, reservations dual-auth). Admin server v0.1.25.17+ continues to satisfy the governance plane.

### 2026-04-14 — v0.1.25.25 default sort: newest-first on reservations / api-keys / budgets / tenants

Also shipping in v0.1.25.25: all four list views now default to newest-first ordering by `created_at`. Previously they defaulted to either unsorted (api-keys, tenants), created_at asc (reservations), or unsorted (budgets) — all wrong for the typical "what changed recently" operator workflow.

**Changes:**
- `ApiKeysView.vue` / `TenantsView.vue` — `useSort(items, 'created_at', 'desc')`.
- `BudgetsView.vue` — same. Visible columns don't include Created, but the initial order still matters.
- `ReservationsView.vue` — `useSort(reservations, 'created_at_ms', 'desc')` (was `'asc'`). Empty-state hint rewritten: default is newest-first; click Created once to flip to asc to find oldest-stuck "hung" reservations.

**Why `created_at` desc is safe for these types:** all four carry `created_at` as an ISO-8601 string (or `created_at_ms` as a number on ReservationSummary). ISO-8601 sorts lexicographically in chronological order, so `desc` means newest first without any custom accessor.

The existing `reservations-sort-reserved.spec.ts` e2e test toggles the Reserved column explicitly, so it's independent of the default sort direction. No test breakage.

### 2026-04-14 — v0.1.25.25 complete PERMISSIONS enum + unknown-value filter on API-key edit

Follow-up to v0.1.25.24 after the dev still hit `Unrecognized permission: decide (INVALID_REQUEST)` on edit. Root cause: the dashboard's `PERMISSIONS` constant in `src/types.ts` was incomplete — only the 13 tenant-runtime permissions, missing all 14 admin-prefix permissions that the spec (cycles-governance-admin-v0.1.25.yaml, `schemas.Permission`, lines 1337-1384) and admin server enum have. Operators editing any key whose stored `permissions` included a value not rendered as a checkbox (admin permissions, or legacy orphans like `decide` from pre-enum direct Redis writes) would inadvertently round-trip that value — the stored string sits in `editForm.permissions` but has no corresponding checkbox in the UI, so `v-model` can't toggle it off. The v0.1.25.24 diff-before-PATCH fix only helped when the operator never touched the permissions UI; a single checkbox click mutated the array length and re-triggered the send.

**Changes:**
- `src/types.ts` — `PERMISSIONS` now lists all 27 spec permissions (13 tenant + `admin:read`/`admin:write` wildcard + 12 granular admin). Comment ties the constant to the spec and the admin server enum so future drift is obvious.
- `src/views/ApiKeysView.vue` — `openEdit()` filters any stored permission not in `PERMISSIONS` out of `editForm.permissions` at load time and toasts a visible error naming the dropped values. Saving the form then cleans up the stored record (the PATCH sends only recognized values). Cancel leaves the stored record untouched.

**Behavioral consequences:**
- Operator with a key that has `decide` (or any other non-spec value) stored: opens Edit → sees the warning toast → Save writes the cleaned list → key now conforms to spec.
- Operator with a key that has only-valid stored permissions: no warning, no filtering — identical to v0.1.25.24 behavior.
- Operator wanting to keep a non-spec permission on a key: no UI path anymore. By design — these are invalid per spec and the admin server rejects them on write.

**Not in this release:** an admin-side "sweep" to proactively clean up legacy stored permissions. Still per-key via the edit flow.

### 2026-04-14 — v0.1.25.24 API-key edit: only PATCH changed fields

Fixes runcycles/cycles-dashboard#43 from the client side. `ApiKeysView.submitEdit` was always including the full stored permissions list in every PATCH body, even when the operator only changed the name. If any stored permission string differed from the admin server's current closed enum (legacy records, schema drift), the server rejected the whole request with an opaque 400 — the operator had no way to rename a key whose stored permissions included a legacy value.

Companion to the server-side fix in cycles-server-admin v0.1.25.17 (widens `ApiKeyUpdateRequest.permissions` to `List<String>` and returns an actionable 400 naming the bad permission). Even with the server fix, the right default here is to not send fields the user didn't touch.

**Changes:**
- `src/views/ApiKeysView.vue` — `submitEdit()` now diffs each form field against `editingKey.value` and only includes fields that actually changed. Permissions and scope_filter use a set-equality helper (`sameStringSet`) so reordering alone doesn't count as a change. If nothing changed, the dialog closes without issuing a request. Out of scope: the form still allows clearing permissions to an empty list or clearing scope_filter — both are legitimate edits and are correctly distinguished from "unchanged."

### 2026-04-14 — Playwright E2E layer

Closes a long-standing test-coverage gap: bugs in JavaScript/DOM behavior that pass unit tests and HTTP probes but break the UI. The v0.1.25.22 sort-accessor regression is the canonical example — Vue stringified `{unit, amount}` to `"[object Object]"` for every row, silently making the Reserved column header a no-op. Unit tests (mocked fetch) didn't exercise the DOM; the HTTP probe suite (`scripts/e2e-probes.sh`) doesn't drive the JavaScript at all. Only manual review caught it.

**What landed:**

| File | Purpose |
|---|---|
| `playwright.config.ts` | Chromium only, compose-owned lifecycle (no `webServer`), HTML + list reporters, traces/screenshots/video retained only on failure. |
| `tests/e2e/global.setup.ts` | Seeds a tenant, tenant API key, budget, and three reservations (30k, 50k, 75k) via the admin API. All calls route through the dashboard nginx proxy (same path the browser takes), so a proxy misconfig fails loudly at setup, not in cryptic spec failures. |
| `tests/e2e/fixtures.ts` | Reads `test-results/fixtures.json`; exposes typed getters and a reusable `loginAsAdmin(page)` helper. |
| `tests/e2e/login.spec.ts` | Flow 1 — admin key login → introspect → all 8 capability-gated sidebar entries render → direct-nav to `/tenants` works. Plus an invalid-key test asserting the `/login` URL stays put + the red error message renders. |
| `tests/e2e/reservations-force-release.spec.ts` | Flow 2 — navigate to Reservations, select seeded tenant, click Force release on the seeded reservation, confirm, verify the request carried a UUID `idempotency_key` (side-channel assertion via `waitForResponse`), verify the dialog closes and the row drops out of the list on refresh. |
| `tests/e2e/reservations-sort-reserved.spec.ts` | Flow 3 — the direct v0.1.25.22 regression lock. Click the Reserved column header, assert the 30k reservation row comes first; click again, assert the 75k row comes first; verify `aria-sort` attribute flipped correspondingly. |
| `.github/workflows/e2e.yml` | Runs Playwright after the existing HTTP probes in the same compose-stack job. Browser install cached by `package-lock.json` hash. Playwright HTML report + `test-results/` uploaded as an artifact on failure (separate from the compose logs artifact). Path trigger extended to include `tests/e2e/**` and `playwright.config.ts`. |
| `package.json` | Adds `@playwright/test` devDep; `test:e2e`, `test:e2e:install`, `test:e2e:ui` scripts. |
| `README.md` | New **E2E tests** section documenting the two-layer approach and the local dev loop. |

**Design decisions:**

- **No data-testid additions.** Role-based selectors (`getByRole('columnheader', { name: /sort by reserved/i })`, `getByRole('dialog', { name: /force release this reservation/i })`) work against the current markup. Adding testids site-wide couples tests to implementation details and adds markup noise; targeted selectors read better and exercise real accessibility.
- **Global seed, single worker, `fullyParallel: false`.** All three specs share one fixture set. Per-test seeding would triple runtime with no isolation benefit. If one spec mutates state in a way that breaks another, that IS a bug we want to surface — the alternative hides the class of regression we built the suite for.
- **Compose owns lifecycle.** Playwright's `webServer` option is NOT used — double-management is error-prone. CI step `docker compose up -d --wait` brings up the stack; Playwright runs after HTTP probes.
- **Chromium only in CI.** Firefox/WebKit double runtime and add flake without catching the bug classes we care about here.
- **Fixture TTL of 1 hour** on seeded reservations — comfortably longer than any realistic suite runtime so the force-release spec's "must be ACTIVE" precondition doesn't race with expiry.

**Regression-catch validation (one-time):** re-introduced the v0.1.25.22 sort-accessor bug locally (`{ reserved: (r) => r.reserved.amount }` → `undefined`), rebuilt the dashboard image, re-ran `npm run test:e2e`. Confirmed `reservations-sort-reserved.spec.ts` fails with "element not found / unexpected order" as designed. Restored the fix; all 4 tests pass in ~4.5s.

**What's still uncovered** (file as follow-up issues if needed):
- Login rate-limit / lockout UX (countdown timer + form re-enable).
- Create tenant → duplicate 409 → error toast path (parsed ApiError body).
- Webhook bulk pause with cancel mid-operation.
- Cross-browser (Firefox/WebKit) — would need a separate weekly workflow.

---



### 2026-04-13 — v0.1.25.23: hotfix — nginx proxy_pass dropped path for non-reservations /v1/*

Discovered while running the full compose stack end-to-end against the v0.1.25.22 release images. Every `/v1/admin/*` call through the published dashboard container's built-in nginx returned `500` with admin-side error `No static resource v1.` — nginx was sending just `/v1/` upstream and stripping the rest of the path. Only `/v1/reservations*` worked.

**Root cause.** When `proxy_pass` mixes a variable (`$upstream`) with a URI suffix (`/v1/`), nginx does **not** perform automatic URI substitution — the literal suffix replaces the entire path. Documented nginx behavior but subtle. The `/v1/reservations` block added in v0.1.25.22 accidentally used the correct pattern (`proxy_pass $upstream$request_uri`), which is how the admin block's long-standing bug hid behind the new routing split.

**Fix.** Switch the catch-all `/v1/` block to `proxy_pass $upstream$request_uri;`, matching the reservations block.

**Why this wasn't caught before:**
- Vite dev proxy uses a different implementation and handles this correctly — `npm run dev` always worked.
- Production deployments have historically been fronted by Caddy or a cloud LB doing their own path rewriting, masking the issue.
- The compose stack's nginx path wasn't being exercised as a full end-to-end test until today's release validation.

**Severity: high.** Anyone pulling the published `ghcr.io/runcycles/cycles-dashboard:0.1.25.22` image and terminating at the container's built-in nginx (no upstream rewriting proxy) has a broken dashboard — only Reservations works, every other tab 500s. The v0.1.25.22 release image should be treated as unsafe; v0.1.25.23 is the fixed replacement.

**Verified.** Full compose stack (redis + cycles-server 0.1.25.8 + cycles-server-admin 0.1.25.16 + dashboard) — all four probes now return valid JSON:

| Probe | Before | After |
|---|---|---|
| `GET /v1/admin/tenants` | 500 | `{"tenants":[],"has_more":false}` |
| `GET /v1/admin/audit/logs?limit=3` | 500 | `{"logs":[],"has_more":false}` |
| `GET /v1/reservations?tenant=...&status=ACTIVE` | ✅ already worked | ✅ |
| `GET /v1/webhooks?tenant=...` (admin key, Stage 3 dual-auth) | 500 | `{"subscriptions":[],"has_more":false}` |

---

### 2026-04-13 — v0.1.25.22: Stage 2.3 — Reservations management (closes ops Blocker #1)

Closes the biggest remaining ops gap surfaced in the post-v0.1.25.20 review: operators couldn't find or force-release hung reservations in the UI — had to shell out to curl against the runtime plane's API key. Third piece of a 3-PR rollout (spec + server + dashboard):

1. [cycles-protocol#37](https://github.com/runcycles/cycles-protocol/pull/37) revision 2026-04-13 — dual-auth on list/get/release reservations
2. [cycles-protocol#39](https://github.com/runcycles/cycles-protocol/pull/39) — NORMATIVE clause: admin audit entries MUST be discoverable via the governance audit-query surface
3. [cycles-server#91](https://github.com/runcycles/cycles-server/pull/91) v0.1.25.8 — filter allowlist, controller branching, audit-log writes to the shared store so dashboard's existing Audit view picks them up
4. **This PR** — UI surface for the runtime-plane dual-auth endpoints

**Dashboard changes:**

| File | Change |
|---|---|
| `src/types.ts` | `RESERVATION_STATUSES` const + `ReservationStatus` / `ReservationSummary` / `ReservationListResponse` types. Shape intentionally minimal — only what the UI renders, so spec additions don't require matching dashboard changes. |
| `src/api/client.ts` | `listReservations(tenantId, params?)`, `getReservation(id)`, `releaseReservation(id, idempotencyKey, reason?)`. Route through `/v1/*` (runtime plane), not `/v1/admin/*`. Client-enforces `tenant` query param on list (server returns 400 otherwise per spec). |
| `src/views/ReservationsView.vue` | New view. Tenant-required filter (first tenant auto-selected), status filter (defaults to `ACTIVE` — operationally-interesting set). Sortable table with **age** (relative-time) and **expiry** columns; overdue indicator (⚠) when status=ACTIVE and past expiry_at_ms. Force-release via `FormDialog` with pre-filled `[INCIDENT_FORCE_RELEASE]` reason tag per spec's SHOULD guidance. |
| `src/router.ts` | `/reservations` route. |
| `src/components/Sidebar.vue` | Sidebar entry (clock icon). Capability-gated via `view_reservations` (defaults to allow when introspect doesn't surface the flag — older admin servers pre-v0.1.25.15 just work). |

**Ops workflow closed**: paged → open Reservations tab → pick tenant → sort by Created asc → overdue (⚠) row at top → click Force release → structured reason → confirm → audit entry lands in dashboard's existing Audit view with `actor_type=admin_on_behalf_of`. End-to-end in the UI, no curl.

**Tests** (+6 in `src/__tests__/client.test.ts` `reservation wrappers` suite):
- `listReservations` query-param shape + filter passthrough
- `listReservations` omits undefined filters cleanly
- `getReservation` GET path
- `releaseReservation` POST body with idempotency_key + reason
- `releaseReservation` without reason → body omits field (not null/empty)
- `listReservations` 400 INVALID_REQUEST pass-through as ApiError

**Spec compliance.** Aligned with cycles-protocol@main (post-#37 + #39). Client-side `tenant` requirement matches the server's NORMATIVE behavior. Force-release audit entries surface via the governance audit endpoint (guaranteed by the shared-store implementation in server PR #91 + the #39 NORMATIVE).

**Deployment topology change (dual backend).** The dashboard now fronts **two** backends — governance plane (cycles-admin:7979) for everything historical, and runtime plane (cycles-server:7878) for reservations. Routing is split at the reverse proxy, not in client code:

| File | Split rule |
|---|---|
| `nginx.conf` | `~ ^/v1/reservations(/\|$)` → `cycles-server:7878`; catch-all `/v1/` → `cycles-admin:7979` (unchanged). Specific block precedes catch-all. |
| `vite.config.ts` | `/v1/reservations` → `localhost:7878`; `/v1` → `localhost:7979`. Vite matches longer prefix first. |
| `docker-compose.prod.yml` | New `cycles-server` service (image `ghcr.io/runcycles/cycles-server:0.1.25.8`, shared `ADMIN_API_KEY` + Redis, `/actuator/health` probe). Dashboard `depends_on` both. |
| `docker-compose.yml` | Same addition for local dev, port 7878 exposed, CORS origin `http://localhost:8080`. |

Shared `ADMIN_API_KEY`: both backends accept the same admin key for their respective dual-auth endpoints — `cycles-server` only needs it to satisfy `X-Admin-API-Key` on `/v1/reservations*`, no separate rotation surface.

**Gates.** typecheck clean; **273/273 tests pass** (was 267; +6); build clean.

**Stage 3 ahead** — tenant-scoped webhooks (same dual-auth pattern applied to 6 more endpoints).

---

### 2026-04-13 — v0.1.25.21: Stage 1 ops QoL (8 dashboard-only gaps closed)

First of three planned stages addressing day-2 ops workflow gaps surfaced in the post-v0.1.25.20 ops review. This stage covers everything achievable against the current admin server (v0.1.25.15) without spec/server changes — the cross-repo work for **#1 Reservations management** and **#3 Tenant webhooks** is deferred to Stages 2 and 3.

| # | Gap | Where | What changed |
|---|-----|-------|--------------|
| **#2** | No tenant hierarchy visibility | `TenantsView` + `TenantDetailView` | New "Parent" + "Children" columns on the list (count is clickable to filter to that subtree). Detail page header card now shows parent link and an inline list of up to 6 children with a "View all" link to the filtered list. Parent filter dropdown lists only tenants that actually have children. |
| **#4** | Cannot bulk-suspend tenants | `TenantsView` | Per-row checkboxes + "select all visible" header checkbox. Bulk action bar appears on selection with **Suspend selected** / **Reactivate selected** buttons. Sequential per-tenant calls (avoids rate-limit bursts) with live progress in the confirm dialog and a cancel-between-requests path. Skips tenants already in the target state and CLOSED tenants (terminal). Summary toast reports done/failed. |
| **#5** | No way to bulk-pause webhooks by tenant | `WebhooksView` | Tenant filter dropdown (lists only tenants that have subscriptions). Per-row checkboxes + bulk **Pause selected** / **Enable selected** with the same sequential-with-cancel pattern as #4. **DISABLED** subscriptions are skipped from bulk Enable — auto-disabled webhooks should be re-enabled per-row after operator verifies the endpoint. |
| **#6** | Tenant spend rollup missing | `TenantDetailView` | New "Spend rollup (ACTIVE budgets)" card aggregates allocated / remaining / spent / debt across the tenant's budgets, **grouped by unit** (USD_MICROCENTS, TOKENS, etc — adding across units would be meaningless). Debt cell turns red when nonzero. |
| **#7** | No emergency freeze | `TenantDetailView` | "Emergency Freeze (N)" button on the tenant header (only shown when N>0 ACTIVE budgets exist). Confirm dialog spells out blast radius before commit; sequential per-budget calls record `Emergency freeze — tenant lockdown via admin dashboard` as the audit reason. Same loader / cancel pattern as bulk ops. |
| **#8** | Audit drill-down from key row | `ApiKeysView` + `TenantDetailView` keys tab + `AuditView` | Per-key **Activity** link that routes to `/audit?key_id=…`. AuditView reads `key_id`, `tenant_id`, `operation`, `resource_type`, `resource_id` from the URL on mount, pre-fills the form, and auto-runs the query — saves the copy-paste-and-click ritual. Available regardless of key status (investigating revoked keys is the most common reason). |
| **#9** | No utilization range filter | `BudgetsView` | New min/max % inputs in the filter row. Pure client-side — `utilizationPercent()` matches the formula UtilizationBar uses. Empty-string inputs mean "no bound" (so `min=80, max=` filters ≥80%). Triggers re-load via existing filter pipeline so cross-tenant queries also respect the range. |
| **#10** | Webhook auto-disable threshold not visible | `WebhookDetailView` + `types.ts` | Added `disable_after_failures?: number` to `WebhookSubscription` type. Detail summary now shows "Failure threshold: N/M consecutive" with the failure count colored red as it approaches the threshold (within 2 of M). Lets ops see "this webhook is one bad delivery away from auto-disable" at a glance. |

**Architectural notes for the bulk-action pattern.** All three new bulk flows (tenant suspend/reactivate, webhook pause/enable, emergency freeze) share the same shape: sequential per-item calls (not parallel — keeps progress honest, avoids rate-limit bursts), live progress in the confirm dialog's message slot, cancel-between-requests via a flag the loop checks, summary toast at the end (success / "N failed" / "cancelled by user"). Failures are `console.warn`'d per-item rather than toasted to keep the UI quiet — one summary toast is less noisy than 20.

**Defensive choices**:
- Bulk actions skip items already in target state (avoids noisy 409s).
- DISABLED webhooks are excluded from bulk Enable — re-enabling those should be a per-row decision.
- Emergency Freeze button only renders when there are ACTIVE budgets to freeze.
- Bulk ops respect filtered visibility — the count in the bar reflects only what the user can see, so a hidden-by-filter row never gets unexpectedly affected.

**Spec compliance.** Unchanged. Stage 1 uses only existing endpoints.

**Gates.** typecheck clean; **267/267 tests pass** (no test changes — all features are integrative, none of them touch testable utility code). Build clean.

**Coming next**: Stage 2 (3-repo) — admin-path support for Reservations (list + force-expire). Stage 3 (3-repo) — dual-auth on tenant-webhook endpoints + UI.

---

### 2026-04-13 — v0.1.25.20: Create Budget + Create/Edit Policy (admin-on-behalf-of) + client-side scope validation

Closes the long-standing budget management gap reported by the user — admin operators could manage tenants end-to-end (create / update / suspend / reactivate) but could only **list / freeze / fund / update** budgets, never **create** them. Same for policies (list-only). The blocker was spec-side: createBudget / createPolicy / updatePolicy were `ApiKeyAuth`-only, and the dashboard authenticates exclusively with `X-Admin-API-Key`.

Three-PR rollout:
1. **Spec** — [cycles-protocol#36](https://github.com/runcycles/cycles-protocol/pull/36) v0.1.25.13: dual-auth + optional `tenant_id` in request bodies.
2. **Server** — [cycles-server-admin#91](https://github.com/runcycles/cycles-server-admin/pull/91) v0.1.25.14: `ADMIN_ALLOWED_ENDPOINTS` updated, controllers branch on auth context, audit log + event tag `actor_type=admin_on_behalf_of`. Defense-in-depth path-traversal guard in `AuthInterceptor`.
3. **Dashboard** — this release.

**Dashboard changes:**

| File | Change |
|------|--------|
| `src/api/client.ts` | New `createBudget(tenantId, body)`, `createPolicy(tenantId, body)`, `updatePolicy(policyId, body)`. The first two stitch `tenant_id` into the body so call sites stay tenant-agnostic; the third doesn't because policy_id pins the owning tenant server-side. |
| `src/types.ts` | Added `BudgetCreateRequest`, `PolicyCreateRequest`, `PolicyUpdateRequest`. `Capabilities` gained optional `manage_policies?: boolean` (defaults to "allow" when undefined so older admin servers keep working). |
| `src/views/TenantDetailView.vue` | "Create Budget" button on Budgets tab, "Create Policy" + per-row "Edit" buttons on Policies tab. Three new FormDialogs with field-level validation. Capability-gated via `canManageBudgets` / `canManagePolicies`. Forms pre-fill `scope`/`scope_pattern` with `tenant:<id>` to satisfy the server's tenant-prefix requirement out of the box. |

**UI placement decisions:**
- Budget creation lives under the tenant detail's Budgets tab (not on the global `BudgetsView`) because every budget is tenant-scoped — opening it from the tenant context means the tenant is unambiguous and we don't have to disambiguate which tenant the new budget belongs to.
- Edit Policy uses PATCH semantics — only fields the user changed are sent; no-op submits surface "No changes to save" inline.
- Form types use `number | string` on numeric inputs (allocated, overdraft_limit, priority) per the v0.1.25.19 hard-won lesson about Vue 3 `v-model` on `<input type="number">` auto-coercing to number after user input. All consumption sites use `Number()` + `Number.isFinite()` defensively.

**Tests** (+5 in `src/__tests__/client.test.ts` `admin-on-behalf-of write wrappers` suite):
- `createBudget` injects `tenant_id` into the POST body
- `createPolicy` injects `tenant_id` into the POST body
- `updatePolicy` does NOT inject `tenant_id` (path pins owner)
- 409 DUPLICATE_RESOURCE on createBudget surfaces as `ApiError` with code intact
- 400 INVALID_REQUEST on createPolicy surfaces cleanly

**Client-side scope validation** (folded into this PR, paired with cycles-server-admin v0.1.25.15). End-to-end testing revealed the server was silently accepting non-canonical scopes like `tenant:acme/agentic:codex` (typo for "agent") — server now enforces canonical grammar, and the dashboard mirrors the check in `validateScope()` (`src/utils/safe.ts`) so users see form-level errors instantly instead of a 400 round-trip.

- **`validateScope(scope, { allowWildcards })`** returns null on valid, or a human-readable error pointing at the offending segment. Same rules as the server:
  - First segment `tenant:<id>`
  - Canonical kinds in order: `tenant → workspace → app → workflow → agent → toolset`
  - Ids alphanumeric-bookended (rejects `.foo`, `foo-`)
  - Policy patterns allow terminal `*` and id-wildcard; budget scopes are concrete
- Wired into the `submitCreateBudget` and `submitCreatePolicy` handlers in `TenantDetailView.vue`. Server remains the source of truth — anything the client accepts must still pass server validation.
- +33 `validateScope` tests in `safe.test.ts` including the exact `agentic:codex` regression lock, every rejection path (non-canonical kind, missing tenant prefix, reversed order, duplicate kinds, empty id, disallowed chars, leading/trailing punctuation), wildcard rules (terminal-only, budget rejects all wildcards), `tenant:*/agent:foo` regression lock matching the server.

**Spec compliance.** Aligned with cycles-governance-admin v0.1.25.13. Purely additive — view-file changes don't touch existing flows.

**Structured scope builder** — replaces the raw text input on both dialogs with a row-per-segment UI (`src/components/ScopeBuilder.vue`). Previously users had to know the canonical kind set (tenant/workspace/app/workflow/agent/toolset), remember the order, and hand-type `tenant:acme/agent:reviewer`-style strings. Now:

- **First row locked** to `tenant:<tenantId from route>` — enforces the admin-on-behalf-of cross-field tenant match by construction; user can't submit a scope for a different tenant.
- **"+ Add level" dropdown** only offers canonical kinds that haven't been used yet AND come after the last-used kind in canonical order. Preserves the server's invariant without the user having to know it.
- **Per-row id chooser** — radio choice between *literal id* text input OR *any &lt;kind&gt; (\*)* for id-wildcards in policy patterns. Picking "any" drops any deeper rows and disables further additions (id-wildcards must be terminal per spec).
- **Trailing `/*` checkbox** — separate from the per-row wildcard because it's semantically not a segment, it's a "match everything deeper" suffix. Only rendered when `allowWildcards` (policies).
- **Live preview** (`Will create as: tenant:acme/agent:reviewer`) in monospace beneath the rows — sanity check for users who already know the format and want to see exactly what goes on the wire.
- **Parses existing values** on mount for edit-in-place flows; if parsing fails (legacy non-canonical scopes, tenant mismatch), surfaces a `role="alert"` warning and falls back to the tenant-locked root rather than silently corrupting.

**Tests** (+18 in `src/__tests__/ScopeBuilder.test.ts`): initial render emits locked tenant-only scope, deep scope round-trips, policy pattern round-trips (`tenant:acme/*`, `tenant:acme/agent:*`), tenant mismatch parse error + fallback, unknown-kind parse error (legacy `agentic`), add/remove rows, dropdown filtering (no duplicates, canonical-order gate), per-row wildcard radio serialization, trailing /* checkbox serialization, "any id" disables trailing checkbox (redundant), wildcard controls hidden when `allowWildcards=false`, dropdown hidden when terminal state reached.

**Gates.** typecheck clean; **267/267 tests pass** (was 211; +56); build clean.

---

### 2026-04-13 — v0.1.25.19: Fund Budget Execute regression — Vue v-model number coercion

Hotfix. v0.1.25.18 added empty-amount validation to `submitFund` via `fundForm.value.amount.trim()`, assuming the form-bound value stayed a string. **Vue 3's v-model on `<input type="number">` auto-coerces user input to a `number`** (via `looseToNumber`), so once the user typed an amount, `.trim()` threw `TypeError: trim is not a function` inside the form-submit emit handler. Vue logged the error to console but the user just saw the dialog stay open with no toast / no error banner / no network request — **"Execute does nothing"**.

Reported by user immediately after release. Browser console showed:
```
BudgetsView.vue:210 Uncaught (in promise) TypeError: fundForm.value.amount.trim is not a function
```

**Fix.**
- New `parsePositiveAmount(input: unknown): number | null` in `utils/safe.ts` — accepts both runtime types Vue can produce (string before user input, number after), returns the validated positive value or `null`. Documented edge cases: empty, zero, negative, NaN, ±Infinity, non-numeric strings, objects/arrays.
- `submitFund` calls `parsePositiveAmount(fundForm.value.amount)` and surfaces "Amount must be a positive number" on null. No more `.trim()`.
- Form ref is now typed as `{ amount: number | string; ... }` so the next person who touches this can't make the same string-only assumption without a TS error.
- +10 regression tests in `safe.test.ts` cover positive number, positive string, empty string, null/undefined, zero, negative, NaN/Infinity, non-numeric, non-primitive — and an explicit "does NOT throw" test on the inputs that crashed v0.1.25.18.

**Self-critique recorded.** The audit subagent flagged the binding type concern in v0.1.25.18 review (#4 in the report) and I dismissed it as "verified safe". It wasn't. The dismissal happened because I tested mentally with `Number(raw)` not `raw.trim()` and didn't trace which code path the new `.trim()` call would actually hit.

**Gates.** typecheck clean; **211/211 tests pass** (was 201); build clean.

**Spec compliance.** Unchanged.

---

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

**Self-validation pass.** Re-audit of the diff caught two regressions in the new code, fixed in the same branch:

- `safeJsonStringify` was using a `WeakSet` to mark visited objects — this incorrectly flagged **shared sibling references** (`{a: X, b: X}` where X is the same object) as `[Circular]` even though there's no cycle, corrupting AuditView CSV exports of any payload with shared refs. Replaced with a per-call ancestor **stack** trimmed by matching the replacer's `this` against the top — preserves true-cycle detection while matching vanilla `JSON.stringify` behavior on shared refs. +5 regression tests assert: shared refs serialized N times, deeply nested shared refs, self-cycle, deep mutual cycle, shared arrays.
- `AuditView` UI metadata panel (`<pre>{{ JSON.stringify(e.metadata, null, 2) }}</pre>`) still used bare `JSON.stringify` — same crash risk as the EventsView fix. Now uses `safeJsonStringify`.
- **Rotate Secret confirm dialog closed before the PATCH ran.** `executeRotate()` set `pendingRotate = false` at line 1, then awaited the network call. On 403 / timeout, the user clicked Confirm, watched the dialog vanish, then a disconnected toast appeared seconds later with no UI tying it to the action. **Upgraded `ConfirmAction` with optional `loading` and `error` props** (backwards compatible — both default to undefined, so the other ~12 call sites are unaffected). The Rotate flow now keeps the dialog mounted with a spinner during the PATCH, closes only on success, and surfaces failures inline so the user can retry or cancel from the same context. +10 component-level tests cover loading-disables-buttons, loading-blocks-backdrop, loading-spinner-renders, error-block-renders, retry-after-error.
- **Final cross-cutting audit found `executeDelete()` had the same close-before-await pattern.** Audited every other ConfirmAction callsite (8 destructive actions across 5 views) — only the webhook-Delete handler still had the bug. Applied the same loading + inline error pattern; user can no longer cancel mid-DELETE (network call would still complete), can no longer double-click the destructive button, and 403/timeout failures stay in the dialog instead of disappearing into a stand-alone toast. Also added two regression tests for `safeJsonStringify`: top-level array with shared element refs (exercises the synthetic `{ '': value }` wrapper that JSON.stringify uses internally) and nested-but-not-cyclic (same leaf at different depths must not be marked Circular).
- **Accessibility hardening for the loading window.** With both Cancel and Confirm `:disabled` during an in-flight request, `useFocusTrap` had no enabled focusables — Tab would escape the modal into background content (visually obscured but still in the DOM). Added a `tabindex="-1"` `sr-only` focus sink with `aria-live="polite"`; `watch(loading)` programmatically moves focus there when the request starts and back to the confirm button when it finishes (so retry-after-error is one keystroke). Dialog also gets `aria-busy="true"` while loading. SVG spinner marked `aria-hidden`. +7 component tests cover aria-busy presence/absence, live-region text/empty states, sentinel `tabindex`, focus-moves-to-sink-on-load, focus-returns-to-confirm-on-done.

**Tests.** +29 new cases in `src/__tests__/safe.test.ts`:

- `safeJsonStringify` — plain-object parity with `JSON.stringify`, circular ref → `[Circular]`, BigInt → `Ns`, indent param, undefined/null edges (6 cases).
- `csvEscape` — RFC 4180 quoting, embedded quotes, commas/newlines, null/undefined, number/boolean coercion, all 6 formula-injection prefixes (`=` / `+` / `-` / `@` / TAB / CR), no-prefix when `=` is mid-string (10 cases).
- `tenantFromScope` — bare scope, compound scope, dashes/dots/underscores in id, non-tenant scopes, null/undefined/empty, no false positive when `tenant:` is mid-string (8 cases).

**Gates.** typecheck clean; **201/201 tests pass** (was 153); build clean.

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

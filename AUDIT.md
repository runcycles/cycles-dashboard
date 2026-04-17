# Cycles Admin Dashboard — Audit

**Date:** 2026-04-17 (bulk-action wire-up PR-B undrafted — TenantsView + WebhooksView gain a server-side filter-apply path alongside the existing row-select path: single POST to `/v1/admin/tenants/bulk-action` and `/v1/admin/webhooks/bulk-action` per cycles-governance-admin v0.1.25.21 spec, filter-only body (minProperties=1), 500-row hard cap, `idempotency_key` generated via `src/utils/idempotencyKey.ts` (UUID v4 with crypto.randomUUID + getRandomValues + Math.random fallback), split succeeded/failed/skipped arrays surfaced in toast; `rateLimitedBatch` row-select path intact — filter-apply is additive; filter-apply button disabled for dashboard pseudo-values (`__root__`, `__system__`) and wildcard url-filters with no server-side equivalent; cycles-server-admin v0.1.25.26 now pinned in both compose files, PR-B undrafted and ready for merge; vitest 382 passing (up from 376 — 6 new idempotency-key tests), typecheck + build clean), 2026-04-17 (search wire-up PR-A — 6 admin list views (Tenants/Budgets/ApiKeys/Audit/Webhooks/Events) now forward the free-text `search` query param introduced in cycles-governance-admin v0.1.25.21, case-insensitive substring match on each endpoint's natural identifier pair per spec; page-1 refetch on debounced-filter change to honor cursor-tuple invalidation; pre-0.1.25.21 admin servers MUST ignore the unknown param per additive-parameter guarantee, client-side fallback filters kept for graceful degradation; vitest stays at 376 passing, build clean; PR-B bulk-action held until server .26), 2026-04-17 (tenants children breadcrumb — TenantDetailView "+N more" and inline child links now thread `?parent=<src>` to the target route so the back arrow on the landing view (filtered /tenants list or child tenant-detail) returns to the source parent instead of defaulting to flat `/tenants`. Closes the "click into Children, no way back" gap reported by an operator after W3 landed. Pure dashboard change, no spec or server dependency; vitest full suite stays at 376 passing, build clean), 2026-04-16 (non-spec scale polish — operator-facing cancel button on long multi-page exports via AbortController-observed loop, SortHeader keyboard activation (Enter/Space) pinned for the `as='div'` virtualized-grid variant, dark-mode gaps closed across EventsView + AuditView filter inputs / expanded-row borders / category badges / export-toolbar hover states; post-review fixes: AuditView status column widened 110→160px + `min-w-0 overflow-hidden` on the cell (stops `401 UNAUTHORIZED` overflow from forcing double horizontal scrollbar on narrow viewports), BudgetDetail EventTimeline `overflow-auto`→`overflow-y-auto` + `min-w-0` on flex-1 truncate (kills the phantom horizontal scrollbar), Audit + Events export CSV/JSON buttons moved from mid-page toolbar into PageHeader #actions slot so export lives next to Refresh across every list view — all dashboard-only, no server or spec change), 2026-04-16 (V4 stage 2 — six admin-plane views (Tenants, Budgets, Events, Audit, ApiKeys, Webhooks) now wired to server-side sort against cycles-server-admin v0.1.25.24 listX sort_by/sort_dir enums; TenantsView Parent + Children columns demoted to plain headers because they're client-derived and have no server-side index; compose stack bumped to cycles-server 0.1.25.12 to unblock reservations sort e2e under the runtime plane), 2026-04-16 (V4 stage 1 — useSort server-side sort opt-in with onChange callback, ReservationsView wired as reference implementation against cycles-server v0.1.25.12+ sort_by/sort_dir on GET /v1/reservations; no client-side re-sort destroying cursor tie-breaker), 2026-04-16 (scale phase 1 wire-up — ApiKeysView + BudgetsView consume the cross-tenant `/v1/admin/api-keys` and `/v1/admin/budgets` endpoints from cycles-server-admin v0.1.25.22, push all filters server-side, render `BudgetLedger.tenant_id` as a first-class column per cycles-governance-admin v0.1.25.19 / cycles-server-admin v0.1.25.23), 2026-04-16 (TenantDetailView — Edit API Key in-place, ports the v0.1.25.24 ApiKeysView diff-before-patch flow), 2026-04-16 (phase 5 polish — multi-row expansion on Events / Audit / EventTimeline for triage comparison workflow), 2026-04-16 (phase 5 polish — BudgetDetail EventTimeline virtualization + flex-fill + Load more label parity with list views), 2026-04-16 (phase 5 polish — PageHeader `itemNounPlural` override fixes "log entrys"→"log entries", WebhooksView subscription→webhook noun consistency, filter toolbars wrapped in card across TenantsView/WebhooksView/ReservationsView), 2026-04-16 (scale-hardening phase 5 — unified table-layout: flex-fill viewport on all 7 list views, fix AuditView double horizontal scrollbar, standardize Load more label), 2026-04-16 (scale-hardening phase 4 — W4 bulk-op bounded concurrency + 429 backoff across all three bulk runners, W5 reveal-timer cleanup, W6 a11y row-count live region), 2026-04-16 (scale-hardening phase 3 — V5 debounce composable, V6 PageHeader result counts, V7 filter-aware EmptyState), 2026-04-16 (scale-hardening phase 2c — V1 virtualization for EventsView + AuditView with measureElement for expandable rows), 2026-04-16 (scale-hardening phase 2b — row virtualization across 5 list views via @tanstack/vue-virtual), 2026-04-16 (scale-hardening phase 2 — pagination on tenants/webhooks/budget-detail events, lazy tabs, O(1) parent lookup, copy-event-data), 2026-04-16 (scale-hardening phase 1 — pagination, cancellation, N+1 mitigation across 6 views), 2026-04-15 (v0.1.25.27 — RESET_SPENT funding operation support, semantics corrected post-test), 2026-04-14 (error-surfacing + SecretReveal + 3 incident-response Playwright flows), 2026-04-14 (capability-gated UI visibility test layer), 2026-04-14 (v0.1.25.26 style consolidation + dark-mode restore), 2026-04-14 (a11y ratchet to WCAG AA all-levels — TERMINAL), 2026-04-14 (a11y ratchet to WCAG AA moderate+), 2026-04-14 (a11y ratchet to WCAG AA serious+critical), 2026-04-14 (v0.1.25.25 complete PERMISSIONS + unknown-filter on edit), 2026-04-14 (v0.1.25.24 API-key edit diff-before-patch), 2026-04-14 (Playwright E2E layer), 2026-04-13 (v0.1.25.23 nginx hotfix), 2026-04-13 (v0.1.25.22)
**Requires:** cycles-server v0.1.25.8+ (runtime plane, reservations dual-auth). Admin server v0.1.25.17+ continues to satisfy the governance plane; **admin server v0.1.25.18+ required** to execute the `RESET_SPENT` funding operation from BudgetsView; **admin server v0.1.25.26+ required** for the TenantsView / WebhooksView filter-apply bulk-action path (pre-.26 servers 404 the POST — the dashboard's row-select path continues to work unchanged).

### 2026-04-17 — Bulk-action wire-up: v0.1.25.21 filter-apply path (PR-B)

Wires TenantsView + WebhooksView to the `bulkActionTenants` / `bulkActionWebhooks` endpoints that cycles-governance-admin v0.1.25.21 specifies and **cycles-server-admin v0.1.25.26 implements**. Shipped initially as a draft PR alongside server development; undrafted 2026-04-17 after the v0.1.25.26 release tag (`93b923e feat(v0.1.25.26): bulk-action endpoints on tenants + webhooks`) landed on `origin/main` of cycles-server-admin. Both `docker-compose.yml` and `docker-compose.prod.yml` now pin `cycles-server-admin:0.1.25.26`.

**Spec shape (cycles-governance-admin v0.1.25.21).** Request body is filter-only — no `tenant_ids[]` or `subscription_ids[]` array. `TenantBulkFilter.minProperties=1` (empty filter is rejected with 400 to prevent accidental all-tenants action). Fields mirror the corresponding list-endpoint query params (AND combination, ILIKE semantics on `search`). Server counts matches first; if `expected_count` is supplied and differs, 409 COUNT_MISMATCH with no writes. 500-row hard cap — filters matching >500 produce 400 LIMIT_EXCEEDED with `total_matched` in the body. `idempotency_key` replay window is 15 minutes.

**Two coexisting paths after this PR.**

| Path                     | Uses                              | When                                                     |
|--------------------------|-----------------------------------|----------------------------------------------------------|
| Row-select (existing)    | per-row PATCH via rateLimitedBatch| operator checks specific rows in the virtualized grid    |
| Filter-apply (new)       | single POST to `/bulk-action`     | operator sets filters, applies action to whole match set |

The filter-apply path is **additive** — `rateLimitedBatch` stays in both views for the row-select path, with bounded concurrency + 429 backoff. The server's bulk endpoint has no ids-array option, so it can't replace row-select; it opens up a new workflow ("pause every webhook for tenant=acme") that row-select couldn't support without checkbox-clicking through every page of matches.

**What shipped (5 files, dashboard-only).**

- `src/types.ts` — `BulkActionRowOutcome`, `TENANT_BULK_ACTIONS` / `WEBHOOK_BULK_ACTIONS` enums (`SUSPEND|REACTIVATE|CLOSE`, `PAUSE|RESUME|DELETE`), `TenantBulkFilter` + `TenantBulkActionRequest` + `TenantBulkActionResponse`, and the webhook mirrors. `additionalProperties: false` on the server schema → closed interfaces on the client.
- `src/api/client.ts` — `bulkActionTenants(body)` and `bulkActionWebhooks(body)` wrap POST against `/v1/admin/tenants/bulk-action` and `/v1/admin/webhooks/bulk-action`. Response types match the spec envelope one-to-one.
- `src/utils/idempotencyKey.ts` — `generateIdempotencyKey()`. Prefers `crypto.randomUUID()` (browsers 2022+, Node 16.7+); falls back to manual UUID v4 assembly from `crypto.getRandomValues`; degrades to `Math.random` if even getRandomValues is absent. All three paths satisfy the RFC 4122 v4 regex `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`. Security note in the source — the key is opaque to the server (Bearer/Admin-Key authn already blocks forgery), so guessability doesn't matter; uniform entropy does.
- `src/views/TenantsView.vue` — new `executeFilterBulk()` builds a `TenantBulkFilter` from the current UI state. `SUSPEND` implies `status=ACTIVE`, `REACTIVATE` implies `status=SUSPENDED` (not sent by the operator — derived from the action so the 500-row budget isn't wasted on server-skipped rows). Parent-filter `'__root__'` pseudo-value disables the filter-apply button (no server null-parent filter). CLOSE is not offered on the filter path — destructive and terminal, should stay a per-row flow. Row-select path (`executeBulk` + `rateLimitedBatch`) untouched.
- `src/views/WebhooksView.vue` — mirrors TenantsView. `PAUSE` implies `status=ACTIVE`, `RESUME` implies `status=PAUSED`. DELETE not offered on the filter path. `SYSTEM_TENANT_ID` (dashboard pseudo-value) disables the button. Wildcard url-filters (containing `*`) also disable the button because the server's `search` is literal substring — sending the raw wildcard string would silently produce a different match set than the client-side `urlMatches` preview shows.

**Per-view UI.** Filter-apply buttons appear in the filter toolbar (not the floating row-select bar) so the two paths are visually distinct. Appearance condition: a filter is active AND no row-select is active — this prevents the operator from accidentally triggering a filter-apply after checking rows. Modal confirm shows the filter summary verbatim ("Filter: status=ACTIVE AND parent_tenant_id=acme AND search=\"prod\"") so the operator sees exactly what the server will match against.

**Expected_count is not sent in this PR.** `listTenants` / `listWebhooks` don't return a total count, only `has_more` / `next_cursor`. Walking the cursor to get a pre-count would add N round-trips before the single POST — expensive at the 500-row cap. The server-side 500-row LIMIT_EXCEEDED gate is the anti-footgun floor; when server .26 adds a cheap `count=` query-only endpoint (tracked as a future spec bump), the dashboard can pass `expected_count` for tighter drift detection.

**Split outcome toast.** Response envelope gives three arrays: `succeeded[]`, `failed[]`, `skipped[]` (with `reason: ALREADY_IN_TARGET_STATE` on skips). The toast surfaces all three counts and the `total_matched` so operators see `"47/50 tenants suspended, 3 skipped (already in target state)"` rather than a misleading `"47 succeeded"` that hides the skip information. Row-level failures are logged to `console.warn` with the server's `error_code` + `message` so triage has per-row context.

**Graceful degradation.** Against admin servers pre-.26 the POST returns 404 and the dashboard's `toast.error(...toMessage(e))` surfaces the server's 404 message. The existing row-select path continues to work unchanged. No feature-flag plumbing because the additive type/client shape imposes zero cost on the existing paths; the filter-apply buttons simply produce a 404 toast when the endpoint isn't there yet. When .26 ships, no dashboard redeploy is required for the feature to start working — the operator just refreshes.

**Safety-gate error-code humanization (governance spec v0.1.25.23).** Spec bump added `LIMIT_EXCEEDED` and `COUNT_MISMATCH` to the `ErrorCode` enum (prose was already in v0.1.25.21; enum was the missing piece that let spec-validators reject a compliant server's response). Dashboard catches them explicitly in both `executeFilterBulk` paths and surfaces actionable toasts: `LIMIT_EXCEEDED` → "Filter matches more than 500 {tenants|webhooks} (server matched N) — please narrow the filter before retrying", `COUNT_MISMATCH` → "…list changed between preview and submit — refresh and try again" (reserved for when `expected_count` is wired). Non-safety-gate errors fall through to the generic `toMessage()` path. `ApiError` already carries `errorCode` as a typed-string field, so no type-shape change — `instanceof ApiError && e.errorCode === '…'` guard is sufficient.

**Tests.**

- `src/__tests__/idempotencyKey.test.ts` — 6 tests. (a) delegation to `crypto.randomUUID` when present, (b) fallback to `getRandomValues` produces valid v4 shape + correct version/variant nibbles, (c) ultra-fallback to `Math.random` still satisfies the regex and produces distinct keys across 50 invocations, (d) the randomUUID path produces 100 distinct keys across calls with no collisions.
- Vitest full suite: **382 passing** (up from 376, 34 files). Typecheck clean (`vue-tsc --noEmit`), build clean.

**Explicitly not in this PR.**

- Server-spec stream → `cycles-server-admin` v0.1.25.26 ships the actual bulk-action implementation (released 2026-04-17). Dashboard deployments running against pre-.26 admin servers get a 404 on the filter-apply POST — toast surfaces the server's message, row-select path keeps working.
- Preview-count round-trip for `expected_count`. Deferred to a future spec bump that adds a cheap count endpoint.
- CLOSE (tenant) and DELETE (webhook) on the filter path. Terminal actions — intentionally kept per-row for safety review.
- Per-view integration tests for the filter-apply path. Deferred to the phase-5 coverage ratchet because the POST-to-bulk endpoint isn't wired against a real server yet.

### 2026-04-17 — Search wire-up: v0.1.25.21 `search` query param (PR-A)

Wires the dashboard to consume the `search` query parameter that cycles-governance-admin v0.1.25.21 added to the 6 list endpoints. Operator-facing capability: a free-text substring match on the natural identifier field(s) of each list — reaches "I have a partial id" workflows that the existing exact-match filters (tenant_id, key_id, correlation_id, etc.) don't cover.

**Per-endpoint spec mapping.**

| View              | Endpoint                    | Server match fields                |
|-------------------|-----------------------------|------------------------------------|
| TenantsView       | listTenants                 | `tenant_id`, `name`                |
| BudgetsView       | listBudgets                 | `tenant_id`, `scope`               |
| ApiKeysView       | listApiKeys                 | `key_id`, `name`                   |
| AuditView         | listAuditLogs               | `resource_id`, `log_id`            |
| WebhooksView      | listWebhookSubscriptions    | `subscription_id`, `url`           |
| EventsView        | listEvents                  | `correlation_id`, `scope`          |

Case-insensitive substring (ILIKE) on the server side. Empty string MUST be treated as absent per spec, so every view trims-then-sends (`const q = debouncedSearch.value.trim(); if (q) params.search = q`).

**What shipped (6 files, dashboard-only).**

- `src/views/TenantsView.vue` — `withSort()` → `withListParams()` including `search`, `watch(debouncedSearch, refresh)` for page-1 refetch on filter change; pre-existing client-side filter on filteredTenants kept as graceful degradation for pre-0.1.25.21 servers (which MUST ignore the unknown param).
- `src/views/BudgetsView.vue` — new `search` ref + 300ms debounce, threaded into `buildListParams`, watcher on `debouncedSearch`. New toolbar input sits next to the existing Scope prefix field (semantically distinct: `scope_prefix` is prefix-on-scope, `search` is substring-on-tenant_id+scope).
- `src/views/ApiKeysView.vue` — new `search` ref + 200ms debounce, wired through `fetchKeysPage`, added to `hasActiveFilters`/`clearFilters`, watcher refetches page 1. Client-side fallback filter on `filteredKeys` mirrors the server's match field pair.
- `src/views/AuditView.vue` — new `search` form field (explicit-submit, no debounce — matches the rest of this view's form pattern). Also reads `?search=` from the URL so drill-down links can pre-fill.
- `src/views/WebhooksView.vue` — existing `urlFilter` now doubles as the server `search` param when the input contains no `*`. Wildcard input remains client-only (wire contract is literal substring). Client-side `urlMatches` is also kept for `name` matching, which the server's `search` spec doesn't cover.
- `src/views/EventsView.vue` — new `search` ref + 300ms debounce alongside the existing `correlation_id` / `scope` exact/prefix fields, added to the URL query, `hasActiveFilters`, and `clearFilters`.

**Cursor-tuple invalidation.** Every `search` change fires `refresh()` / `load()` to restart at page 1, same reasoning as useSort's onChange: the opaque cursor is bound to the `(sort_by, sort_dir, filter_hash)` tuple and reusing it under a different filter would 400 with CURSOR_FILTER_MISMATCH on a spec-compliant server.

**Graceful degradation.** Pre-0.1.25.21 admin servers MUST ignore the unknown `search` param per the additive-parameter guarantee. The client-side fallback filters (already present for every view except AuditView/EventsView, where no local match was feasible because the match key isn't always loaded) keep search working in that case — the only difference is that the match set is scoped to the currently-loaded page slice rather than the full server dataset.

**Sequenced merge.** PR-A shipped first (search-only, runs against admin v0.1.25.21+); PR-B (bulk-action wire-up) stayed draft until cycles-server-admin v0.1.25.26 released the `bulkActionTenants` / `bulkActionWebhooks` endpoints. No feature-flag plumbing needed — the additive type/client shape imposed zero cost on the existing paths while .26 was in development, and the filter-apply buttons simply 404'd against pre-.26 admin servers.

**Tests.** Vitest full suite **376 passing** (unchanged — no per-view unit tests currently cover the search path; deferred to the phase-5 coverage ratchet). Typecheck clean; production build completes in 892ms.

### 2026-04-17 — Tenants: children breadcrumb back-link

Operator-reported gap after W3 palette landed: "in Tenants, when you click into Children, no way to back." Two surfaces both routed forward-only, losing the parent-tenant context:

1. TenantDetailView's **"… +N more"** affordance on the Children section linked to `/tenants?parent=<id>` — but TenantsView ignored `route.query.parent`, so the operator landed on an unfiltered list with no back-path to where they came from.
2. The **inline top-6 child links** on the Children section linked to `/tenants/<child>` with no query, so the child tenant-detail's back button (hardcoded `router.push('/tenants')`) took the operator to the flat list, not back to the parent.

**What changed** (dashboard-only, 2 files):

- `src/views/TenantsView.vue` — `parentFromQuery` computed off `route.query.parent` + `watch({ immediate: true })` that drives `parentFilter` on mount and browser back/forward. PageHeader gains a conditional `#back` slot with an arrow button that routes to `/tenants/<parent>` when the query is set, matching the same slot pattern used by TenantDetailView / WebhookDetailView / BudgetsView-detail.
- `src/views/TenantDetailView.vue` — same `parentFromQuery` computed + `goBack()` that routes to `/tenants/<parent>` when the query is set else falls back to `/tenants` (preserving the old default for row-click nav from the flat list). Back button's aria-label becomes dynamic. Inline top-6 child `<router-link>`s now thread `query: { parent: tenant.tenant_id }` so the child's back arrow returns here.

**Scope of the breadcrumb.** Single-hop. A→B→C nested traversal returns back one step each click (C → B → A), not directly to A. A full breadcrumb trail would require URL-encoded ancestry or session state; the operator report was specifically about "no way back," which single-hop fully addresses. If deeper chain nav becomes a repeat request, the `?parent=` mechanism extends naturally to a comma list or session-scoped stack without breaking the existing deep-links.

**Why not `router.back()`.** Tempting one-liner, but unreliable — `window.history.back()` fires a browser history pop that can exit the SPA entirely on deep-link nav, and doesn't help when the "Children" page was reached via an external share link. Explicit query-driven routing keeps the back target deterministic regardless of session history.

**Tests.** TenantsView + TenantDetailView don't currently have dedicated unit specs (both exercised transitively via views + e2e). Deferring a targeted spec to the phase-5 coverage ratchet; Vitest full suite stays at **376 passing**, build clean.

### 2026-04-16 — W3: global "Find tenant" command palette (Cmd/Ctrl+K)

Closes the dashboard-side portion of W3 from the original scale audit — "operator has a tenant_id, wants to land on /tenants/:id without navigating every list view first." Pure dashboard change; no spec or server dependency.

**Why this ships without a server `search=` param.**

Original plan called for a server-side substring filter on `listTenants`. The admin spec's `listTenants` still only accepts `status`, `parent_tenant_id`, `observe_mode`, `sort_by`, `sort_dir`, `cursor`, and `limit` — adding `search=` is a separate `cycles-server-admin` spec PR. Rather than block the operator UX on a round-trip, this palette prefetches up to 3 pages (150 tenants) on open and filters client-side. At thousand-tenant scale the "Load more" affordance lets the operator drill past the initial window; a future spec-level `search=` param would replace the client-side `includes()` check inside `filtered` with a debounced fetch, with every other piece (cache, keyboard nav, route target) unchanged.

**What shipped.**

1. **`src/composables/useCommandPalette.ts`** — singleton state (one `isOpen` shared across AppLayout + Sidebar + palette component) plus a module-scope tenant cache with 60s TTL. `loadInitial(force?)` dedupes concurrent calls into one in-flight promise (stops double-fetch when Cmd+K is spammed), caps prefetch at 3 pages, preserves `has_more` / `next_cursor` for Load more. `loadMore()` threads the cursor and appends. `__resetCommandPaletteCacheForTests()` exists only so vitest module-level caching doesn't leak between suites.
2. **`src/components/CommandPalette.vue`** — modal overlay (Teleport to body) with a combobox input, listbox-role result pane, and a footer of keyboard hints. Arrow-key navigation with `aria-activedescendant`, Enter selects → `router.push({ name: 'tenant-detail', params: { id } })`, Escape closes. Client-side filter runs on a debounced query (150ms) matching substring against both `name` and `tenant_id` case-insensitively. Empty state distinguishes "no tenants at all" from "no match for query" (V7 pattern). Error state surfaces the underlying fetch message via `role="alert"`.
3. **`src/components/AppLayout.vue`** — global keydown listener: `Cmd/Ctrl+K` toggles the palette, `/` opens it when nothing editable has focus (GitHub convention). `metaKey || ctrlKey` covers macOS + Linux/Windows in one branch; case-insensitive `e.key.toLowerCase()` so caps-lock doesn't break the shortcut. Listener attached on mount, removed on unmount.
4. **`src/components/Sidebar.vue`** — persistent "Find tenant" button at the top of the nav for discoverability (mouse users, mobile where no keyboard shortcut exists). Platform-appropriate kbd hint (⌘K on macOS, Ctrl K elsewhere) derived from `navigator.platform`.

**Why the specific UX.**

The reference palettes (Linear Cmd+K, GitHub /, Slack Cmd+K, Raycast) share a common vocabulary: modal overlay, single input at top, debounced substring filter, arrow-key navigation, Enter opens. Matching that vocabulary means zero onboarding for any operator who has used a modern SaaS tool. The secondary `/` shortcut is a pure GitHub carryover — small uplift, negligible cost, and already the muscle-memory trigger for "focus search" for users coming from GitHub / GitLab admin consoles.

**Scale behaviour.**

At the current deployed scale (tens to low hundreds of tenants) the initial fetch returns everything in a single page; the palette is instantly responsive and the "Load more" control never renders. At thousand-tenant scale the prefetch cap hits at 150 tenants and "Load more" surfaces — the operator can paginate until the target matches or trigger a future spec-level `search=` rollout. The 60s cache TTL prevents palette-open from issuing redundant fetches during rapid triage (open-close-open as the operator switches views).

**Tests.**

- `src/__tests__/useCommandPalette.test.ts` — six composable-level tests pinning: 3-page prefetch stops at `has_more=false`; MAX_PREFETCH_PAGES cap preserves `has_more` so Load more surfaces; second `loadInitial` hits cache (no second fetch); concurrent `loadInitial` calls dedupe to one fetch; `loadMore` threads the cursor and appends; `toggle` flips the open ref.
- `src/__tests__/CommandPalette.test.ts` — seven component tests covering: initial load + render; filter by name substring (case-insensitive); filter by tenant_id substring; arrow-key + Enter navigates to tenant-detail with the correct params; Escape closes; empty-state message distinguishes "no match" from "no tenants"; Load more renders only when the server reports `has_more=true`; error path surfaces the fetch error via `role="alert"`.
- Vitest full suite: **376 passing** (up from 362), 32 files. Build clean.

**Explicitly not in this PR.**

- Server-side `search=` param on `listTenants` — deferred to a `cycles-server-admin` spec PR. When it lands, the palette's client-side `filtered` computed swaps to a debounced `watch(debouncedQuery)` that refetches with `search=q`; every other part (cache, keyboard nav, route target) is unchanged.
- Searching budgets, events, api keys from the same palette. The original audit scoped W3 to tenants only ("single-field search across tenants that routes to TenantDetailView"). Extending to other resource types is a separate workflow (different result shapes, different target routes) and would change the palette's information density enough to warrant its own review round.

### 2026-04-16 — Non-spec scale polish: export cancel, SortHeader kbd, dark-mode gaps

A batch of operator-facing polish items that fall out of the scale-hardening roadmap but don't require any server or spec change. Three independent fixes bundled because each is small on its own and they all touch the same set of list-view surfaces:

1. **Export cancellation.** `src/composables/useListExport.ts` grows an AbortController-backed `cancelRunningExport()`. The multi-page cursor loop checks `abortExport.signal.aborted` between page fetches — the in-flight request still completes (fetchPage doesn't accept an AbortSignal), but no subsequent page is fetched and no blob is assembled. `src/components/ExportProgressOverlay.vue` now renders a **Cancel export** button when the new `cancellable` prop is true; emits `cancel` which the view wires to `cancelRunningExport`. All 8 views that use the overlay (ApiKeysView, AuditView, BudgetsView, EventsView, ReservationsView, TenantsView, WebhookDetailView, WebhooksView) destructure the two new fields and pass them through. Pre-fix, a wrong-filter export heading for the 50k-row cap was a 500-page dead wait — the operator's only escape was to close the tab and discard every other bit of session state.

2. **SortHeader keyboard activation.** `src/components/SortHeader.vue` now explicitly binds `@keydown.enter.prevent` and `@keydown.space.prevent` to the same `sort` emit the `@click` handler fires. Adds `focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-inset rounded-sm` so keyboard focus is visible on both the semantic `<th>` default and the `as='div'` variant used by virtualized ARIA grids. Pre-fix, pressing Enter on a focused columnheader only worked by accident of browser default on the `<th>` path — the div variant was inert.

3. **Dark-mode gaps on EventsView + AuditView.** Four classes of gap closed:
   - Category / resource-type badges (`bg-gray-100 text-gray-600`) now carry `dark:bg-gray-800 dark:text-gray-400` — the light badge was invisible against the dark-mode card background.
   - Expanded-row detail panels (`bg-gray-50/70 border-gray-100`) now carry `dark:bg-gray-800/40 dark:border-gray-700`.
   - Filter form inputs migrated from raw `border border-gray-300 rounded px-2 py-1.5 text-sm w-N` to the shared `.form-input` component class (which already has a dark-mode selector in `style.css`) with the width as an override.
   - Export-toolbar buttons and AuditView Quick range buttons got `dark:hover:text-gray-200 dark:hover:bg-gray-800` to match the table-row-hover pattern used elsewhere.

**Test strategy.**

- `src/__tests__/useListExport-cancel.test.ts` — two new tests: (a) the loop bails with `exportError='Export cancelled.'`, `exporting=false`, no blob written when `cancelRunningExport()` fires between pages; (b) the happy path still completes with one `URL.createObjectURL` call. Pins the contract because the AbortController observation is easy to regress into a no-op if a future edit moves the check inside the fetch instead of around it.
- `src/__tests__/SortHeader-keyboard.test.ts` — four new tests covering Enter, Space, click-still-works, and the tabindex/aria-sort attribute pair. Catches any future edit that drops the explicit keydown binding or the tabindex.
- Full vitest suite: **362 passing** (up from 356), 32 files. Build clean.
- Dark-mode gaps are visually verified; no Playwright axe assertion added for dark-mode because axe's contrast check runs against the themed computed style, and the existing a11y ratchet suite already runs the pages in both light and dark — any regression in the new `.form-input` + badge selectors would surface there.

**Explicitly skipped.** Expandable-row keyboard activation on EventsView:388-397 and AuditView:350-361 was called out in the original audit but verified not-actually-broken: both rows render a native `<button>` chevron with `focus:ring-2` that already handles Enter/Space correctly via the browser default. The surrounding row's `@click` handler is a mouse-only convenience and doesn't block keyboard users.

**Post-review fixes (folded into the same PR).**

Three issues surfaced during visual review of the polish PR; all dashboard-only, all fit inside the existing branch so no second PR was needed:

1. **AuditView double horizontal scrollbar on resize.** The status column was pinned at `110px` but the cell renders `<status> + <error_code>` (e.g. `401 UNAUTHORIZED`). Content overflowed the grid track, which forced the row grid past the 900px min-width on the inner wrapper, which then overflowed the `overflow-x-auto` outer container at certain viewport widths — the operator saw a phantom second scrollbar. Fix: widen the status column to `160px` (updates `min-width` on the wrapper from 900→950 accordingly), and add `min-w-0 overflow-hidden whitespace-nowrap` plus a `title` tooltip on the cell itself as a belt-and-suspenders guard against any future error_code that still overflows.

2. **BudgetDetail EventTimeline phantom horizontal scrollbar.** `EventTimeline.vue` used `overflow-auto` on its scroll container with a `flex-1 truncate` event-type span that was missing `min-w-0`. Browsers default `min-width: auto` on flex children, so a long `event_type` forced the flex row wider than the absolutely-positioned row parent, triggering a horizontal scrollbar even though there was nothing to scroll to. Fix: `overflow-auto` → `overflow-y-auto` on the scroll container, add `min-w-0` to the flex-1 truncate span, and while we're in the file, pick up the same dark-mode polish applied elsewhere (category badge + JSON block).

3. **Export button placement consistency.** Tenants / Budgets / Reservations / Webhooks / ApiKeys / WebhookDetail all put their Export CSV + Export JSON buttons inside `<template #actions>` on PageHeader, rendering them immediately to the right of the Refresh button. AuditView and EventsView were the outliers — they rendered the export buttons in a separate `<div class="flex justify-end">` between the filter form and the list body. Moved both into the `#actions` slot so every list view now has "Updated …s ago · Refresh · Export CSV · Export JSON" in the same order in the page header. AuditView's export disable condition now also respects `loading` (while a query is running) since there's no `loading` pathway through the form to lock out a mid-query export click.

Test suite unchanged at **362 passing** — the fixes are layout/markup only, caught by a human reviewer. No new specific test: the status column width change is a cosmetic width tweak not worth pinning (any future change to the column set has to update the `gridTemplate` anyway), the EventTimeline overflow fix is a one-line CSS change whose regression would be visible immediately, and the export button move is verified by the existing `AuditView-export.test.ts` + `EventsView-export.test.ts` suites which mount the view and click the button through its selector (the button still renders; only its position in the DOM changed).

**Second review pass (same PR).**

Two issues missed in the first post-review pass:

4. **EventTimeline phantom scrollbar, attempt 2.** The first-pass fix (`overflow-auto` → `overflow-y-auto` + `min-w-0` on the flex-1 truncate span) was insufficient. Per the CSS overflow spec, `overflow-y: auto` alone causes `overflow-x` to be computed as `auto` (not `visible`) — so a sub-pixel rounding difference between the absolutely-positioned row's width and the scroll container's width still produced a phantom horizontal scrollbar inside BudgetDetail's card. Fix: set `overflow-y-auto overflow-x-hidden` explicitly on the scroll container. Belt-and-suspenders — the explicit `overflow-x-hidden` guarantees the horizontal scrollbar never appears regardless of future content edits.

5. **ApiKeysView permissions cell pushed Actions off-screen.** The permissions cell held the chip-preview + "N perms" pill inside a `<div role="cell" class="table-cell muted-sm">` with no `min-width: 0`. Grid items default to `min-width: auto` — when the permission strings' min-content exceeded the track's `minmax(260px, 2.5fr)` floor, the track grew past the 1380px wrapper `min-width`, pushing the Actions column (Activity / Edit / Revoke) off the right edge of the viewport, and on narrower viewports the horizontal scroll couldn't reach them because content had been clipped by an intermediate container. Fix: add `min-w-0 overflow-hidden` to the permissions cell and to the Tenant cell (which shares the same missing-clip pattern) so the grid track's minimum stays at its declared `minmax` floor and long content truncates inside the cell instead of expanding the track. Row width now honours the 1380px target and Actions stays visible on the designed operating viewport.

Test suite still at **362 passing** — both fixes are CSS-only (classes added to existing cells / containers). The virtualized grid structure and the `gridTemplate` remain unchanged, so existing ApiKeysView unit tests that select cells by role continue to pass. Regression risk is low: the only observable change is that content wider than the cell now truncates (with a `title` attribute unchanged on the Scope Filter cell, and the permissions detail already accessible via the existing "N perms" click-through dialog).

**Third review pass (same PR).**

Two more consistency items surfaced in visual review; both folded into the same branch:

6. **ApiKeysView duplicate key count.** PageHeader already renders the live filtered count via `:loaded="filteredKeys.length"` (the "Showing X of Y • Updated Ns ago" line at the top of every list view). ApiKeysView also rendered a secondary `<p class="muted-sm mb-2">{{ filteredKeys.length }} keys</p>` immediately above the grid — a leftover from before the V6 PageHeader count landed. No other list view repeats the count, so the second line was pure inconsistency. Removed; ApiKeysView now matches the 6 other list views' header-only count pattern.

7. **EventTimeline expanded JSON cap too tight.** The embedded EventTimeline (BudgetDetail / TenantDetail) used `max-h-32 overflow-auto` (128px cap) on the JSON `data` block. Typical runtime events have 8-12 fields which pretty-print to ~160-180px, so the inner scrollbar fired for almost every expanded event even though no operator needed to actually scroll — they just wanted the full payload visible. EventsView's cap is `max-h-40` (160px) and AuditView's is `max-h-48` (192px); EventTimeline was the outlier. Bumped EventTimeline to `max-h-48` to match AuditView's ceiling, which covers the common event-payload shapes without scroll and still caps genuinely large debug payloads at a reasonable height. Outer virtualizer `measureElement` still tracks real row heights so the capped JSON block doesn't break row layout.

Test suite still at **362 passing** — removal of the duplicate count is pure markup removal; max-h bump is a Tailwind class swap. No new tests: PageHeader count is already covered by the shared `PageHeader.test.ts` assertions, and the JSON block's content rendering is selector-based in the existing EventTimeline tests (not height-dependent).

**Fourth review pass (same PR).**

Two more issues that only surface at specific viewport widths or with real permission data:

8. **AuditView and ApiKeysView double vertical scrollbar.** Both views use `overflow-x-auto` on their outer card to drive horizontal scroll for content wider than the min-width wrapper (AuditView 950px, ApiKeysView 1380px pre-fix). Per the CSS overflow spec, `overflow-x: auto` implicitly promotes `overflow-y` from `visible` to `auto` ("value other than visible/clip on one axis forces auto on the other"). Combined with the inner virtualized scroll body's own `overflow-y: auto`, that produced a second vertical scrollbar on the outer card in addition to the intended one on the scroll body. The other 5 list views (Events, Tenants, Budgets, Reservations, Webhooks) don't hit this because their content widths fit inside typical viewports and they use `overflow-hidden` on the outer card instead of `overflow-x-auto`. Fix: pin `overflow-y-hidden` explicitly on the outer card of both AuditView and ApiKeysView to break the implicit promotion — exactly one vertical scrollbar remains, localized to the virtualized scroll body.

9. **ApiKeysView permissions cell chip overflow.** The inline chip preview rendered up to 4 chips in a `flex-wrap` container within a `minmax(260px, 2.5fr)` cell. For common permission strings like `governance:execute` or `policy:evaluate` (~130px each), 2 chips per row didn't fit at the 260px floor (260px minus cell padding minus pill width left ~140px, so only 1 chip per row). 4 chips stacked to 4 rows = ~112px, overflowing the 76px row height — and even with `min-w-0 overflow-hidden` on the cell, chips were visually clipped mid-word. Switched to **pill-only rendering**: the always-visible "N perms" click-through button replaces the chip preview entirely. Full permissions list still opens in the permissions dialog on click (unchanged behavior). Because the pill is ~90px wide versus the chip preview's demand for 2 rows of 2 chips, the permissions column can shrink from `minmax(260px, 2.5fr)` to `minmax(140px, 1.2fr)`; the canManage grid total shrinks from 1380px to 1260px, so horizontal scroll engages less often on typical viewports. Row height also drops from 76px (2-row chip layout) to 48px (single-row pill) bringing it in line with the other list views' row heights.

Test suite still at **362 passing** — no existing tests depend on chip-preview markup or the 76px row height (verified by grep against `chip`, `slice(0, 4)`, `ROW_HEIGHT_ESTIMATE` across `src/__tests__/`). The permissions-dialog click-through path is unchanged and already covered by existing ApiKeysView tests.

**Fifth review pass (same PR).**

10. **Double horizontal scrollbar at narrow viewports (AuditView + ApiKeysView).** The round-5 fix (pinning `overflow-y-hidden` on the outer card to break the implicit promotion that produced a second vertical scrollbar) addressed the vertical-axis symptom but the exact same CSS spec rule fires in the other direction inside the virtualized scroll body. The scroll body had `flex-1 overflow-y-auto min-h-[Xpx]` — `overflow-y: auto` alone promotes `overflow-x: visible` to `auto`. When the viewport narrows below the wrapper's `min-width` (950px AuditView / 1260px ApiKeysView), the outer card's `overflow-x: auto` shows a horizontal scrollbar for "wrapper > viewport", AND the scroll body's promoted `overflow-x: auto` shows a SECOND horizontal scrollbar because the grid row's min-content slightly exceeded the scroll body width (sub-pixel rounding on cells without `min-w-0` / `truncate`, so the grid row expands above its minmax floor by a couple pixels). Fix:
    - Pin `overflow-x-hidden` explicitly on the scroll body in both views. Horizontal scroll is now owned entirely by the outer card.
    - Bump wrapper `min-width` to add headroom over the exact grid sum: AuditView 950→1000px (grid sum 952), ApiKeysView 1260→1280px / 1100→1120px (grid sums 1260 / 1100). Eliminates any sub-pixel row-content overflow regardless of cell-specific min-content quirks.

Test suite still at **362 passing**. The fix is two CSS class additions (scroll body) and two style min-width bumps; no markup or behavior change. Every existing AuditView / ApiKeysView test is selector-based and unaffected.

**Sixth review pass (same PR).**

11. **WebhooksView double horizontal scrollbar + AppLayout page-level horizontal scroll.** Operator reported a second horizontal scrollbar below WebhooksView's "Load more" button. The first scrollbar was inside the card's scroll body (`flex-1 overflow-auto`, both axes auto); the second was at the page level — `<main>` in `AppLayout.vue` had only `overflow-y-auto`, and per the CSS spec rule that hit rounds 4–5 (non-visible overflow on one axis promotes the other from `visible` to `auto`), main's `overflow-x` was implicitly promoted to `auto`. Any view whose content had a min-content width larger than main then showed a page-level horizontal scrollbar — exactly the behaviour the existing AppLayout comment (lines 32–40) explicitly said it wanted to prevent. Fix applied in two places:
    - **`src/components/AppLayout.vue`** — pin `overflow-x-hidden` explicitly on `<main>`. The existing comment already stated the design intent ("wide tables scroll horizontally inside their own scroll container, not at the page level"); the implicit promotion silently defeated it. Explicit hidden enforces it for every current and future list view, not just the ones that happened to fit.
    - **`src/views/WebhooksView.vue`** — align the scroll pattern with AuditView / ApiKeysView: outer card `overflow-x-auto overflow-y-hidden`, scroll body `overflow-y-auto overflow-x-hidden`. This moves horizontal scroll ownership from the virtualized scroll body up to the card so the sticky column header scrolls horizontally in lockstep with the virtual rows (the previous `overflow-hidden` card + `overflow-auto` body combination would misalign columns with the sticky header once any horizontal scroll occurred — a latent bug exposed once the page-level scrollbar was removed).

    The other three views with the `overflow-hidden` card + `overflow-auto` body pattern (`Events`, `Budgets`, `Reservations`, `Tenants`) are left untouched this pass — their grid min-content widths (~720–820px) fit inside typical admin viewports, so the AppLayout fix alone removes the page-level scrollbar and they don't exhibit the header/body misalignment symptom in practice. They can migrate to the AuditView pattern in a follow-up if operators ever report narrow-viewport column drift.

Test suite still at **362 passing**. The AppLayout change is a single-class addition on `<main>`; the WebhooksView change is two class swaps. No markup, props, or behaviour changes; no tests needed adjusting.

12. **Nightly E2E a11y contrast regression (AuditView error_code).** The Playwright a11y-audit spec — ratcheted in commit `4f8091f` to enforce all axe impact levels — flagged a **serious**-impact `color-contrast` violation on AuditView's error_code span (`<span class="ml-1 text-xs text-red-500 font-mono">INTERNAL_ERROR</span>`). Tailwind's `text-red-500` is `#fb2c36`; on white at 12px the contrast ratio is 3.8:1, below the WCAG AA floor of 4.5:1 for normal text (≥14pt required for the relaxed 3:1 threshold). Root cause is pre-existing — the span has used `text-red-500` since `d703c3d`, but the Nightly E2E started failing on this branch only after the full-impact ratchet. Not introduced by any of rounds 4–6 (every Nightly E2E run on `feat/scale-polish-non-spec` since the ratchet failed with the same signature). Fix: swap the two `text-red-500` usages in `AuditView.vue` (row cell at :398 + expanded detail at :411) to `text-red-700` (`#b91c1c`, ~6.3:1) — keeps the error-code visually distinct from the status badge's `text-red-700` neighbour while clearing WCAG AA.

### 2026-04-16 — V4 stage 2: six admin-plane views wired to server-side sort

Completes V4 — "push sort to server" — for the six remaining admin-plane list views. Stage 1 shipped the `useSort` opt-in and ReservationsView as the reference wiring; Stage 2 repeats that pattern against the cycles-server-admin **v0.1.25.24** `sort_by` / `sort_dir` enums on the six admin list endpoints. After this PR, every list view in the dashboard orders rows by the server's canonical sort — no client-side re-sort of the loaded slice destroying the cursor tie-breaker or misleading operators with half-ordered pagination.

**Fix.**

Each view's `useSort` call now passes `{ serverSide: true, onChange: () => <reload> }`. The reload fires page 1 because the admin server's opaque cursor is bound to the `(sort_by, sort_dir, filter_hash)` tuple — reusing a cursor under a new sort returns `400 CURSOR_SORT_MISMATCH`. Every other call site (polling, Load-more, export `fetchPage`) threads the same sort tuple through its params record so page 2+ and exports stay aligned.

1. **`src/views/BudgetsView.vue`** — `buildListParams()` now appends `sort_by` / `sort_dir` when a sort is active. `useSort` default remains `utilization desc` (the operator-facing triage order). All sort columns (`tenant_id, scope, unit, status, commit_overage_policy, utilization, debt`) map 1:1 onto the server enum; no SortHeader changes.
2. **`src/views/AuditView.vue`** — `buildFilterParams()` appends the sort tuple, used by `query()`, `loadMore`, and the export `fetchPage`. All six sort headers (`timestamp, operation, resource_type, tenant_id, key_id, status`) map onto the server enum.
3. **`src/views/EventsView.vue`** — `buildFilterParams()` appends the sort tuple. `onChange` additionally resets `loadedMorePages.value = false` before calling `load()`: a new sort invalidates the tail-cursor hash, and the R7 merge-from-head dedup would otherwise mask rows displaced by the sort change. Sort columns `event_type, category, scope, tenant_id, timestamp` all map onto the server enum.
4. **`src/views/ApiKeysView.vue`** — `fetchKeysPage(cursor?)` (the single helper that drives polling + `loadMore` + export) now forwards `sort_by` / `sort_dir`. `onChange` calls `refresh()` (the usePolling refresh) which re-runs the closure with the new tuple. Client-side status filter still runs on top of the server-sorted page — intentional, since the existing filter behaviour is client-only and out of scope for V4. Sort columns `key_id, name, tenant_id, status, created_at, expires_at` map onto the server enum; Permissions + Scope Filter columns remain plain headers (not server-sortable).
5. **`src/views/WebhooksView.vue`** — introduced a small `withSort()` helper (no existing single-call-site helper to extend) threaded through all three `listWebhooks` call sites (polling, `loadMore`, export `fetchPage`). Sort columns `url, tenant_id, status, consecutive_failures` map onto the server enum; Health + Events columns remain plain headers because they're derived client-side (`healthColor` + `event_types.join`).
6. **`src/views/TenantsView.vue`** — introduced `withSort()` mirroring WebhooksView. **Parent and Children columns are demoted from `<SortHeader>` to plain `<div role="columnheader">`**: both are client-derived (`tenantById.value.get(...).name` and `childCountMap.value[...]`), neither has a server-side index, and the listTenants `sort_by` enum is limited to `tenant_id, name, status, created_at`. Keeping a sort affordance on client-only columns at scale would silently reorder only the loaded slice — the exact pattern V4 exists to kill. The `parent` + `children` accessors that used to live in the 4th `useSort` arg are dropped because the server-side `sorted` computed short-circuits to `items.value` verbatim anyway.

**Compose pin bump (unblocks the Stage 1 e2e spec that landed in `main` as part of PR #72).** The reservations sort Playwright spec was failing under the compose stack because the pinned `cycles-server:0.1.25.8` predates `sort_by` support — the runtime server silently dropped the new query param and returned SCAN-order rows. Bumped `docker-compose.yml` and `docker-compose.prod.yml` to `cycles-server:0.1.25.12` (the first runtime-plane release with `sort_by` + `sort_dir` + stable `reservation_id` tie-breaker). Kept in lock-step per the existing "keep in sync with docker-compose.prod.yml" comment.

**Test strategy.**

- `src/__tests__/BudgetsView-cross-tenant.test.ts` — two new wire-up tests pinned:
  - Initial fetch forwards the default `sort_by=utilization` + `sort_dir=desc` tuple.
  - Load-more forwards the same tuple alongside the cursor — the server validates `(sort_by, sort_dir, filter_hash)` against the cursor and 400s on mismatch, so this one assertion catches any future regression that breaks the tuple thread.
- Vitest full suite: 356 passing (up from 354), 28 files. Build clean. Coverage holds above the 70% gate; the critical `useSort.ts` + the six touched views stay at or above their prior coverage numbers because the changes are additive (new param records) rather than rewrites.
- The existing Stage 1 Playwright e2e (`tests/e2e/reservations-sort-reserved.spec.ts`, landed in PR #72) implicitly verifies the runtime-plane path; Stage 2 admin-plane sort is verified by the unit wire-up test above. A full admin-plane Playwright sort sweep is deliberately deferred — the invariant it would check (server sees `sort_by` on the wire) is already proven by the mock-based unit test, and the admin list endpoints share the same cursor validation code path as listReservations, so a runtime regression would fail Stage 1's existing spec anyway.

**What comes next.**

This closes V4 in the scale-hardening roadmap — sort state is now always consistent with what the server returned across every list view. The next uncompleted scale-hardening tasks are the server-spec blockers tracked as task #20 (W1 bulk select-all-matching, W2 pre-coerced server-side utilization already partially in place, W3 global "find tenant" command palette) — none of those block a Stage 3 dashboard ship because they each require their own server spec PR to land first.

### 2026-04-16 — V4 stage 1: useSort server-side opt-in + ReservationsView reference

Opens the V4-plan "push sort + filter to server" phase from the scale-hardening audit. Pre-fix, every list view re-sorted the locally-loaded page in `useSort`'s `sorted` computed. At small tenant scale this was fine; past page 1 (cursor pagination) the local sort ordered only the loaded slice, leaving "sorted by timestamp desc" rows missing their tail without any UI indication. Client-side sort under paginated data is a silent-data-loss pattern — audit item V4.

With cycles-server **v0.1.25.12** landing `sort_by` + `sort_dir` on `GET /v1/reservations` (deterministic `reservation_id` tie-breaker, opaque cursor binds `(sort_by, sort_dir, filter_hash)` tuple, 400 `INVALID_REQUEST` on cross-tuple cursor reuse) and **v0.1.25.13** capping hydration at 2000 rows to keep the in-memory sort bounded, the dashboard can now delegate sort to the server and render the server's order verbatim across every page.

**Fix (foundation + reference view).**

1. **`src/composables/useSort.ts`** — extended with an optional fifth `options` parameter `{ serverSide?: boolean; onChange?: (key, dir) => void }`.
   - When `serverSide: true`, the `sorted` computed short-circuits and passes `items.value` through verbatim. Re-sorting client-side would destroy the cursor tie-breaker the server uses and corrupt pagination ordering.
   - `toggle(key)` fires `onChange(sortKey, sortDir)` after updating state. Views bind this to their loader and re-fetch with the new sort tuple.
   - Default (no options) behaviour unchanged — every existing call site (BudgetsView, ApiKeysView, WebhooksView, TenantsView, EventsView, AuditView, WebhookDetailView) continues to work byte-for-byte.

2. **`src/api/client.ts`** — `listReservations(tenantId, params)` params record extended with `sort_by?: string` + `sort_dir?: 'asc' | 'desc'`. Both are forwarded as query params when present and omitted cleanly when absent. Legacy callers that don't pass them get the server's legacy SCAN-order path exactly as before (zero-risk to existing code paths).

3. **`src/views/ReservationsView.vue`** — wired as the reference implementation for the remaining 6 admin-plane views to copy in stage 2.
   - `useSort` call now passes `{ serverSide: true, onChange: () => loadReservations() }`.
   - `loadReservations()`, `loadMore()`, and the export `fetchPage` all forward `sort_by` / `sort_dir` alongside the existing filter and cursor params. Critical: page-2+ under a sorted cursor **must** pass the same sort tuple — the server validates `filter_hash` against the cursor and 400s on mismatch. Export walks the real server cursor under the same tuple so full extractions stay consistent.
   - Comment block updated from "Sort local, not server — the runtime spec doesn't guarantee stable ordering" to reflect the new `sort_by` + `sort_dir` contract and the `reservation_id` tie-breaker.
   - UI copy around the default-sort hint is unchanged because semantics are identical under server-sort (oldest-stuck-first on `created_at_ms asc`).

**Test strategy.**

- `src/__tests__/useSort.test.ts` — four new tests under a nested `describe('server-side mode')` block:
  - `serverSide=true` preserves source order (no client re-sort)
  - `onChange` fires with `(key, dir)` on every toggle including direction-flip and column-switch
  - `sortKey` / `sortDir` still update reactively so `SortHeader` renders the correct active state
  - `onChange` also fires in client-mode when provided (enables telemetry opt-in for non-server views)
- `src/__tests__/client.test.ts` — two new `listReservations` assertions:
  - Omit-case: neither `sort_by` nor `sort_dir` appear in the URL when not passed
  - Present-case: both forward verbatim as query params when passed
- Vitest suite: 354 tests passing (up from 348), 28 files, build clean. Coverage: lines 94.69% / stmts 92.31% / branches 86.84% (thresholds 70% — well above gate). `useSort.ts` itself is 100% lines / 100% funcs / 96.29% branches.

**Stage 2 scope (follow-up).**

The remaining 6 admin-plane views (`TenantsView`, `BudgetsView`, `EventsView`, `AuditView`, `ApiKeysView`, `WebhooksView`) each follow the ReservationsView shape: flip their `useSort` call to `{ serverSide: true, onChange: () => loader() }`, pass `sort_by` / `sort_dir` through `client.ts` to the corresponding `cycles-server-admin` v0.1.25.24 sorted endpoint, and update the loader + load-more + export fetchPage to forward the same tuple. Kept out of this PR to keep stage 1 review-sized; each view's wire-up is independent and can ship separately.

### 2026-04-16 — Scale phase 1 wire-up: cross-tenant list endpoints + server-side filters

Closes the last remaining P0 from the scale-hardening audit: the two
N+1 tenant fan-out loops that, at ≥100 tenants, caused a burst of
sequential `listApiKeys(tenant_id)` and `listBudgets(tenant_id)`
requests per poll and silently truncated any match past the per-tenant
first page. With cycles-server-admin **v0.1.25.22** landing tenant-
agnostic list endpoints and **v0.1.25.23** flipping `@JsonIgnore` off
`BudgetLedger.tenant_id` (per cycles-governance-admin spec
**v0.1.25.19**), the dashboard can now collapse both loops to a single
cross-tenant paginated call and push every filter the UI exposes down
to the server.

**Fix.**

1. **`src/views/ApiKeysView.vue`** — replaced the tenant fan-out with
   a single `listApiKeys()` call driven by a composite
   `{tenantId}|{keyId}` cursor. Removed the `MAX_TENANTS_FOR_KEYS`
   cap + banner. The in-view "Tenant" filter select now forwards
   `tenant_id` when set and omits it when not. Export path walks the
   real server cursor instead of the fanout snapshot.
2. **`src/views/BudgetsView.vue`** — introduced `buildListParams()`
   as the single wire-boundary builder: forwards `status`, `unit`,
   `scope_prefix`, `over_limit`, `has_debt`, `utilization_min`,
   `utilization_max`, `tenant_id` (optional), `cursor`, `limit`.
   Utilization is converted from UI percent (0–100) to server ratio
   (0–1) at this boundary and clamped. The previous client-side
   `applyClientFilters()` / `utilizationPercent()` helpers were
   deleted — they silently dropped page-2+ matches.
   Added a "Tenant" column as the leftmost sort target; `rowTenantId()`
   prefers the wire field and falls back to `tenantFromScope(b.scope)`
   so pre-v0.1.25.23 servers and legacy stored ledgers keep rendering.
   Export columns now include `tenant_id`.
3. **`src/types.ts`** — `BudgetLedger.tenant_id?: string` (optional to
   keep older servers compatible).
4. **`src/__tests__/capabilities-gating.test.ts`** — corrected the
   `listBudgets` mock envelope from `{ budgets: [] }` to
   `{ ledgers: [], has_more: false }`. The old mock worked only because
   the fanout path short-circuited on an empty tenant list; the new
   direct-assign path would have thrown `items.value is not iterable`.

**Tests pinning the contract.**

- `src/__tests__/ApiKeysView-cross-tenant.test.ts` (3 tests) — one
  call on mount with no `tenant_id`, `tenant_id` forwarded when the
  select changes, `cursor` forwarded on Load more.
- `src/__tests__/BudgetsView-cross-tenant.test.ts` (6 tests) — one
  call on mount, `filter=over_limit` / `filter=has_debt` route query
  pushed to server, UI 75 → `utilization_min=0.75`, composite cursor
  forwarded, `tenant_id` from the wire rendered via `TenantLink`
  (prefers wire over scope-parsing).

**Gates.** 349/349 vitest, `vue-tsc -b --noEmit` clean.

### 2026-04-16 — TenantDetailView: Edit API Key in-place

Closes a workflow gap — the Policies tab on tenant-detail has had an
Edit button since the v0.1.25.20 policies rollout, but the API Keys
tab was Activity + Revoke only. Operators who wanted to rename a key
or reshape its permissions had to navigate to the global ApiKeysView,
filter by tenant, edit there, and navigate back. On a multi-tenant
day that's painful.

**Fix.** Port the v0.1.25.24 ApiKeysView Edit flow into
`src/views/TenantDetailView.vue`:

- `openEditKey(k)` — same canonical-permission filter as
  ApiKeysView.openEdit: any stored permission not in the current
  `PERMISSIONS` enum is dropped from the form's state and surfaced
  via toast so the cleanup isn't silent on save.
- `submitEditKey()` — diff-before-patch: sends only the fields the
  operator actually changed (`sameKeyStringSet()` helper).
  Round-tripping unchanged permissions was the original cause of
  spurious 400s when the stored key carried a legacy enum value.
- Pending-changes summary (green adds / red removes) on the edit
  dialog, matching the ApiKeysView UX one-to-one. `aria-live="polite"`
  so screen readers catch the diff as the operator toggles checkboxes.
- Row action: `<button v-if="k.status === 'ACTIVE'" ...>Edit</button>`
  placed between the Activity link and Revoke. Gated the same way as
  the existing Revoke button — disabled keys don't expose an Edit
  button since there's nothing coherent to change on a revoked key.

No server-side change — `updateApiKey` and `PERMISSIONS` were already
exported from `src/api/client.ts` / `src/types.ts`. Refresh after
save reuses the existing `listApiKeys({ tenant_id: id })` call so the
Permissions column in the table updates immediately.

**Gates.** 336/336 vitest, `vue-tsc -b --noEmit` clean. No E2E spec
currently targets this flow; the existing capability-gating test
(`canManageKeys`) still governs visibility of all three row actions
including the new Edit button.

### 2026-04-16 — Phase 5 polish (multi-row expansion on Events / Audit / EventTimeline)

Operator feedback on triage flows: the single-row expansion pattern
used in EventsView, AuditView, and the embedded EventTimeline forced
users to close one entry before opening the next. That's a bad default
for the real workflow in these views, which is **comparison** — two
events with the same correlation_id, before/after state of an audit
entry pair, payload diff across two nearly identical budget operations.

**Fix.** Switch `expanded` from `ref<string | null>(null)` to
`ref(new Set<string>())` in all three components. Click toggles the
row independently; other rows stay as they were. The chevron
rotation, `aria-expanded`, detail-block `v-if` gates all moved from
`expanded === id` to `expanded.has(id)`. Click handlers moved from
inline ternaries to a small `toggleExpanded(id)` helper so the
intent reads cleanly.

Vue 3's reactivity layer tracks Set `.add` / `.delete` / `.has`
mutations out of the box — no extra reactivity plumbing needed. The
virtualizer's `measureElement` still observes row height changes
correctly, so multiple simultaneously-expanded rows layout smoothly
without row-height drift.

**Files.** `src/components/EventTimeline.vue`, `src/views/EventsView.vue`,
`src/views/AuditView.vue`. No test-suite changes required — existing
tests target behavior (click fires, aria-expanded flips, detail renders)
which is unchanged from the single-row case; only the constraint that
opening row B closes row A is removed. 336/336 vitest, vue-tsc clean,
production build clean.

**Edge note.** Stale IDs linger in the Set after a filter/refresh
cycle (the events array changes but the Set is preserved). `.has()`
no-ops for IDs that aren't in the current view, so the behavior is
correct — and in fact useful: filtering then unfiltering preserves
the operator's expansion context. Set size stays bounded in practice
(ID strings are ~24 bytes; even 1000 stale IDs is under 25 KB).

### 2026-04-16 — Phase 5 polish (BudgetDetail EventTimeline large-dataset parity)

Closes a gap left after the initial Phase 5 table-layout pass: the
Event Timeline rendered on budget-detail pages didn't follow the same
flex-fill + virtualization pattern the seven list views adopted.

**Problem.** `EventTimeline.vue` was a plain `v-for` over the full
`events` array. Fine for the default 20-row page, but once an operator
hit "Load older events" a few times on a long-lived budget (chatty
agent spending every few seconds, months of history → hundreds of
events), the flat render grew unbounded. Every expand/collapse forced
Vue to diff the whole list, and on tall monitors the card was
natural-height — it kept growing past the fold instead of scrolling
within a bounded region like the list views. Button label also read
"Load older events" — inconsistent with the Phase 5 standardization
that unified every other Load-more button to plain "Load more".

**Fix.**
- **`src/components/EventTimeline.vue`** — rewritten to match the
  EventsView virtualization pattern: `@tanstack/vue-virtual`
  `useVirtualizer` with `measureElement` for variable row heights so
  expand/collapse re-layouts sibling rows smoothly. Collapsed rows
  ~36px (estimated for the virtualizer's first paint); expanded rows
  include the metadata grid + optional JSON block (still capped at
  `max-h-32` as before). Scroll container gains
  `flex-1 overflow-auto min-h-[200px]`. The `compact` prop, declared
  but never passed by any caller, was removed.
- **`src/views/BudgetsView.vue`** (detail mode) — the Event Timeline
  card now flex-fills the remaining viewport
  (`card p-4 flex-1 min-h-0 flex flex-col`). Its children — h3 header,
  EventTimeline (flex-1), Load-more button — stack vertically with
  only the timeline flexing, exactly like the list-view shells. The
  button label changed to "Load more" to match the other six views.

**Net behavior change.** Opening a budget detail now shows an event
timeline that fills the viewport below the metadata card, scrolls
within its own bounded region, and renders only the visible rows in
the DOM regardless of how many "Load more" pages the operator has
stacked up. Layout identical for budgets with few events; visibly
better for budgets with hundreds.

**Gates:** 336/336 Vitest pass (no behaviour-altering logic change —
still the same keyboard/click toggle, same aria-expanded semantics,
same JSON block cap). `vue-tsc -b --noEmit` clean.

### 2026-04-16 — Phase 5 polish (PageHeader pluralization override, webhook noun, filter-toolbar card wrapping)

Follow-up on the Phase 5 PR review. Three small consistency fixes bundled into the same branch.

**Problem 1 — "log entrys" grammar bug.** `PageHeader`'s count label ("Showing X of Y <noun>") and `EmptyState`'s fallback copy both pluralized naively by appending `s`. AuditView passed `item-noun="log entry"` → rendered "Showing 5 of 100 log entrys" in the header count line. Screen readers re-announced the same malapropism via the V6 live region.

**Problem 2 — WebhooksView noun mismatch.** Page title: "Webhooks". EmptyState hint: "No webhook subscriptions". PageHeader count: "Showing 60 of 120 subscriptions". Operators saw two different nouns for the same objects within one view. The server type is `Webhook` (not `Subscription`) — "webhook" is the correct domain noun for the UI.

**Problem 3 — Filter toolbar inconsistency.** Four of the seven list views (BudgetsView, EventsView, AuditView, ApiKeysView) wrapped their filter row in `<div class="card p-4 mb-4">` — a soft white panel with padding that visually groups the filters and separates them from the table. Three (TenantsView, WebhooksView, ReservationsView) used a bare `<div class="mb-4 flex gap-3 flex-wrap items-center">` — filters floated directly on the page background with no grouping. Inconsistent visual weight across views when switching tabs.

**Fix.**
- **`PageHeader.vue` + `EmptyState.vue`** — add optional `itemNounPlural?: string` prop. Falls back to `${noun}s` when omitted, so all regular-plural callers (tenant, webhook, event, key, reservation, budget) stay untouched. Used only for irregular plurals.
- **`AuditView.vue`** — pass `item-noun-plural="log entries"` to `PageHeader`. (The view's `EmptyState` uses an explicit `message=`, so it bypasses the auto-pluralization path — no change needed.) The existing `ExportDialog` and `ExportProgressOverlay` in the same view were already passing the plural correctly; now the header matches.
- **`WebhooksView.vue`** — `item-noun="subscription"` → `item-noun="webhook"` on PageHeader. `item-noun-plural="subscriptions"` → `"webhooks"` on ExportDialog and ExportProgressOverlay. EmptyState copy: `"No webhook subscriptions"` → `"No webhooks"`, hint: `"Webhook subscriptions will appear here once configured"` → `"Webhooks will appear here once configured"`. Server-side field `subscription_id` unchanged — this is UI copy only.
- **Filter toolbars** — `TenantsView`, `WebhooksView`, `ReservationsView` filter rows wrapped in `<div class="card p-4 mb-4">` with the existing flex row moved inside. Visual parity with the other four list views; no behavior change, no width/height impact on the flex-fill table shell below.

**Gates:** 336/336 Vitest pass (330 prior + 6 new `PageHeader.test.ts` assertions covering the count label, the singular→plural boundary, the `itemNounPlural` override, and the aria-live sr-only mirror). `vue-tsc -b --noEmit` clean. E2E untouched — no test targets UI text "subscription" (server-side `subscription_id` handler field stays as-is). Visually verified each of the three rewrapped toolbars in dev.

### 2026-04-16 — High-cardinality scale hardening (phase 5 of 5: unified table-layout)

Closes the list-view UX inconsistencies operators reported after Phase 4 shipped. Three concrete problems, one coordinated fix.

**Problem 1 — scattered `max-height: calc(100vh - Npx)` math.** Every list view picked its own magic number (N ranged 360 → 520 across 7 files) trying to account for PageHeader + toolbar + pagination height. Guesses broke whenever a filter wrapped or a banner appeared, and default views only showed 5–9 rows — too few for a data-ops tool. On tall monitors the tables left most of the viewport unused.

**Problem 2 — AuditView double horizontal scrollbar.** `<main>` had `overflow-auto` AND the AuditView outer shell had `overflow-x-auto` with an inner `min-width: 900px` shim. At viewport widths < 900px the page painted two horizontal scrollbars stacked on top of each other. ApiKeysView had the same structural pattern with a 1220/1380px shim — the bug manifested whenever the viewport dropped below the min-width.

**Problem 3 — Load-more label drift.** Six views had four distinct button texts: `Load more`, `Load more events`, `Load more log entries`, `Load more deliveries`, `Load more results`. The noun was redundant — the page title plus V6's "Showing X of Y <noun>" count label already conveyed context.

**Fix — follow the Linear / GitHub / Jira pattern.** No more height math; a flex column from `<main>` down through each list view's root makes the virtualized table body fill whatever space is left after the header, toolbar, and footer take their natural height. Resize the browser and the table grows/shrinks naturally.

- **`src/components/AppLayout.vue`** — `<main>` switched from `overflow-auto` to `overflow-y-auto`. Wide tables scroll horizontally inside their own shell (scoped to the table body), not at the page level. Kills the double-bar at < 900px / < 1220px viewports.
- **7 list views** (`TenantsView`, `BudgetsView`, `EventsView`, `AuditView`, `WebhooksView`, `ApiKeysView`, `ReservationsView`) — root `<div>` gains `h-full flex flex-col min-h-0`. The bg-white table shell gains `flex-1 min-h-0 flex flex-col`. The virtualized scroll rowgroup loses its `style="max-height: calc(100vh - Npx); min-height: Npx;"` inline and gains `class="flex-1 overflow-auto min-h-[200px|240px]"` — `flex-1` fills the remaining flex space, `min-h-[Npx]` keeps a usable minimum on tiny viewports where the filter toolbar might eat everything.
- **AuditView + ApiKeysView horizontal-shim views** — the inner `min-width: 900/1220/1380px` wrapper also gains `flex flex-col flex-1 min-h-0` so the flex chain propagates through the shim. Header rowgroup stays natural; scroll rowgroup flex-fills. Both header and body scroll horizontally together because they share the shim parent — the existing column-alignment behavior is preserved.
- **BudgetsView** dual-mode — the list-mode `<template v-else>` converted to `<div v-else class="flex flex-col flex-1 min-h-0">`. Detail mode (stacked metadata + event-timeline cards) stays natural block flow — flex-col just stacks them, which is visually identical. No behavior change for detail-mode users.
- **WebhookDetailView** delivery table — kept as a bounded scroll region because it's embedded in a scroll-flow detail page, but replaced `max-height: calc(100vh - 520px)` with `max-h-[60vh]`. Same intent ("generous max, scroll if needed"), no magic number.
- **Load-more label standardized** — `EventsView`, `AuditView`, `WebhookDetailView` lose their noun suffix. All buttons now read `Load more` (loading state stays `Loading…`). BudgetsView's list-mode button lost `results`; TenantsView/WebhooksView/ReservationsView were already correct.

**Net behavior change operators will feel:**
1. Default visible row count goes from ~5–9 to ~15–25 on a typical 1080p laptop; taller monitors show proportionally more.
2. No more double scrollbar in AuditView / ApiKeysView at narrow widths.
3. Browser resize now smoothly grows/shrinks the table instead of keeping a fixed ~400px block.

**Gates:** 330/330 Vitest pass (zero new tests — this is a layout CSS change with no new logic). `vue-tsc -b --noEmit` clean. Dev server (`npm run dev`) renders every view without console errors. Existing E2E specs (tenants-bulk-suspend, webhooks-bulk-pause, budgets-freeze-unfreeze, reservations-force-release, a11y-audit) target role/label, not layout structure — unaffected.

**Phase 5 complete. All audit items addressable on the dashboard side are now done.** Remaining items are server-spec blocked on `cycles-server-admin`: R1/R2 full fix, V4 server-side sort, W1 bulk-op filter, W2 utilization params, W3 tenant search.

### 2026-04-16 — High-cardinality scale hardening (phase 4 of 5: bulk-op concurrency + 429 backoff, reveal-timer cleanup, a11y row-count live region)

Closes **audit item W4**. Pre-fix, every bulk runner in the dashboard (TenantsView suspend/reactivate, WebhooksView pause/enable, TenantDetailView emergency-freeze) was a plain sequential `for` loop: one PATCH, await, next PATCH, await. Two concrete problems at scale:

1. **Slow.** Freezing 200 active budgets during incident response took 200× (round-trip + server work) sequentially. For operators fighting a live incident, this was painful.
2. **Half-failures on rate limits.** Once the admin tier's per-key rate limit trips, every subsequent PATCH returned 429 and the old loop treated it as a hard failure. A burst of 100 suspends could show "45 succeeded / 55 failed — check console" with no way to retry just the 429'd ones.

**Shared utility — `src/utils/rateLimitedBatch.ts`** (~120 LoC). Worker-pool runner with:
- **Bounded concurrency** (default 4, under Chrome's per-host 6-connection cap). Pulls the next unclaimed index as each slot settles, so fast items don't sit waiting for the tail of a "batch".
- **429-aware exponential backoff.** Only retries `ApiError` with status 429 — other errors fail fast, so 500s / 409s / validation errors don't eat a 4× retry budget. Delay is `baseDelayMs * 2^attempt * (0.5…1.5)`; ±50% jitter prevents a cohort of 4 parallel 429'd requests from retrying in lockstep and re-tripping the same limit. Default maxRetries=3 (4 attempts per item).
- **AbortSignal cancellation.** Signal aborts out of the retry sleep immediately; in-flight workers settle (matches "cancel bulk op" operator expectation that half-finished writes aren't rolled back). Aborted items are NOT counted as done/failed — progress honestly shows "N/M processed" rather than misleading "N/N".
- **Progress callback** — forwarded into each view's existing `bulkProgress` ref so the bulk dialog's "Working… X/Y processed" line keeps ticking.
- **Return shape** `{ done, failed, cancelled, errors }` — `errors` is `[{ index, error }]` so the caller can surface per-item context (TenantsView logs tenant_id, WebhooksView logs subscription_id, TenantDetailView logs scope:unit).

**Call sites rewired:**
- `src/views/TenantsView.vue` `executeBulk()` — suspend/reactivate.
- `src/views/WebhooksView.vue` `executeBulk()` — pause/enable.
- `src/views/TenantDetailView.vue` `executeEmergencyFreeze()` — freeze all ACTIVE budgets for a tenant.

Each view keeps its existing `bulkProgress`, `bulkRunning`, `bulkCancelRequested` refs for template bindings; a new `bulkAbort: AbortController | null` drives cancellation. The summary-toast branching now reads `result.failed` / `result.cancelled` from the utility instead of the previously-tracked scalar counters.

**Tests — `src/__tests__/rateLimitedBatch.test.ts`** (+10 Vitest cases). Cover the load-bearing contracts: concurrency is bounded (observed via release-on-demand promises), 429 retries with backoff and eventually succeeds, 429 exhausts at maxRetries + counts as failed, non-429 fails immediately, onProgress fires per item, AbortSignal halts dispatch, errors are surfaced in the result, every item is processed under the happy path, abort mid-backoff-sleep returns immediately (not after the full 5s retry delay), and already-aborted signal short-circuits before any worker runs.

**Compatibility:**
- Existing `webhooks-bulk-pause.spec.ts` E2E continues to pass — it uses `Promise.all(responses)` to await both PATCHes, which is actually a better match for the new parallel runner than the old sequential one.
- Behavior change visible to operators: bulk ops finish roughly 4× faster on large selections; 429s no longer show as hard failures.

**Gates:** 330/330 Vitest pass (320 prior + 10 new for rateLimitedBatch). Typecheck clean. Coverage 94.65% lines / 92.22% statements overall; rateLimitedBatch.ts itself at 100% lines / 92% branches (the uncovered branch lines are pre-aborted signal checks inside the retry loop that can't fire in practice once the outer pump's abort check catches first).

**W5 — MaskedValue / SecretReveal timer bookkeeping** (`src/components/MaskedValue.vue`, `src/components/SecretReveal.vue`). The short "Copied!" badge timer (1.5s / 2s) was anonymous — rapid double-click leaked a timer and unmount during the window fired `setTimeout` on a dead Vue instance. Both components now track `copiedBadgeTimer` alongside the existing `clipboardClearTimer` (30s / 60s wipe) and clear both on re-invoke + `onUnmounted`. Behavior unchanged from the user's POV; just no more dangling handles when a detail view with many reveals gets torn down.

**W6 — A11y row-count live region** (`src/components/PageHeader.vue`). Added an `sr-only` `<span>` with `aria-live="polite"` + `aria-atomic="true"` mirroring the existing `countLabel`. Screen readers now announce pagination state changes — "Showing 50 of 12,431 tenants" on first render, "Showing 75 of 12,431 tenants" after Load more, "Showing 3 of 12,431 tenants matching 'prod'" after filter — at the same moment the sighted count updates. Placed inside PageHeader (rather than AppLayout) so the text always matches what's visible. `aria-atomic=true` re-announces the entire string on any change, which is clearer at scale than partial announcements.

**Phase 4 complete. Remaining phases:**
- **Server-spec blocked** (cycles-server-admin): R1/R2 full fix, V4 server-side sort, W1 bulk-op filter, W2 utilization_min/max params, W3 tenant search.

### 2026-04-16 — High-cardinality scale hardening (phase 3 of 5: search/result UX)

Closes **audit items V5 (debounce), V6 (result count), V7 (filter-aware EmptyState)**. Small-diff, high-visibility changes that land in the top-of-view header and empty-state UX every operator sees.

**V5 — `useDebouncedRef` composable + rollout** (`src/composables/useDebouncedRef.ts`, ~25 LoC). Returns a read-only mirror ref that updates `delay` ms after the last source change. `onScopeDispose` cancels pending timers on teardown so post-unmount writes / leaked timers can't happen. Local implementation (not VueUse) to keep composables directory dependency-free and tune the exact semantics.

Applied to:
- **EventsView**: refactored from the earlier inline-timer pattern into `useDebouncedRef(tenantId|scope|correlationId, 300)`. 10 lines shorter, same behavior.
- **TenantsView**: client-side search filter now reads `debouncedSearch` (200ms). Selection-clear watcher deliberately stays on the RAW `search` ref so clearing happens immediately — a safety action that shouldn't wait for debounce.
- **BudgetsView**: replaces `@change + @keyup.enter` markup on scope/util-min/util-max inputs with debounced watchers (300ms). Eliminates the half-applied-filter bug where tabbing between inputs didn't fire the prior filter's apply.

AuditView intentionally keeps its explicit "Run Query" button — audit queries can be expensive on the backend and operators expect explicit submit.

+4 Vitest cases for the composable: sync-initial-value, propagation delay, rapid-change coalescing, scope-dispose cancellation.

**V6 — PageHeader result count** (`src/components/PageHeader.vue`). New optional `loaded`, `total`, `hasMore`, `itemNoun` props. When `loaded` is passed the header renders a tabular-num count line beneath the title:
- `loaded + total` → "Showing X of Y tenants"
- `loaded + hasMore=true` → "X tenants loaded (more available)"
- `loaded` alone → "X tenants"

Wired from all 7 list views (Tenants, Webhooks, Events, ApiKeys, Reservations, Budgets, Audit). Matches Linear / GitHub / Jira list-view header conventions.

**V7 — filter-aware EmptyState** (`src/components/EmptyState.vue`). New optional `hasActiveFilter` + `itemNoun` props with canonical default copy: "No tenants match your filters" + "Clearing filters may show more results" when filtered-empty, "No tenants found" when truly empty. Explicit `message` / `hint` still win for bespoke wording. Simplified TenantsView, EventsView, ApiKeysView to use the flag; others keep bespoke copy because their non-filter messaging is view-specific.

**Gates:** 320/320 Vitest pass (316 + 4 new composable tests). Typecheck clean. No test changes for V6/V7 — both additions are backward-compatible (props default to undefined, existing behavior preserved when unset).

**Phase 3 complete. Remaining phases:**
- **Phase 4:** W4 bulk concurrency + 429 backoff, W5 reveal-timer cleanup.
- **Phase 5:** W6 a11y row-count live region.
- **Server-spec blocked** (cycles-server-admin): R1/R2 full fix, V4 server-side sort, W1 bulk-op filter, W2 utilization_min/max params, W3 tenant search.

### 2026-04-16 — High-cardinality scale hardening (phase 2c of 5: V1 virtualization, part 2)

Completes audit item V1 by virtualizing the two remaining list views with expandable detail rows. Pattern is the same `@tanstack/vue-virtual` adoption as phase 2b, with one addition: `virtualizer.measureElement` per-row observation for dynamic heights.

**Why measureElement is needed here:** EventsView and AuditView let operators click a row to unfurl a JSON / metadata detail block. Collapsed rows are ~52px; expanded rows grow by 200–280px. Phase 2b's fixed-height pattern (one `estimateSize` value for every row) would either pin all rows tall enough for the expanded case (wasteful vertical density) or flicker as expanded rows get clipped. `measureElement` observes the real DOM height per index and re-lays out siblings on the next tick — scroll stays smooth during expand/collapse.

**Pattern:**
- Each virtualized `<div role="row">` wraps BOTH the compact row AND (when `expanded === row_id`) the detail block. One virtualized item = one logical row, regardless of expansion state.
- `:ref="measureRow"` on every row. `measureRow` narrows Vue's `Element | ComponentPublicInstance | null` ref-callback type to `Element` before calling `virtualizer.measureElement(el)`. Function is top-level / stable so Vue doesn't re-register it per render (which would cause measurement thrashing).
- `getItemKey: (i) => items[i].event_id` / `log_id` — stable identity survives sort toggles, so measured heights don't reset when the operator flips a column sort.
- Overscan 8 (same as phase 2b views) — buffer for fast scroll.

**Per-view specifics:**
- **EventsView** (`src/views/EventsView.vue`): 6-column grid. JSON payload block retains V2's `max-h-40` internal scroll so a single huge `event.data` payload doesn't balloon the row past reasonable bounds. Load-more footer relocated outside the virtualized scroll region.
- **AuditView** (`src/views/AuditView.vue`): 7-column grid with outer `overflow-x-auto` + inner `min-width: 900px` wrapper — same pattern as ApiKeysView for wide tables on narrow viewports (single horizontal scrollbar, no double-scroll bug). Loading/empty sentinels live outside the virtualized body so the virtualizer only sees real data rows.

**Gates:** 314/314 Vitest pass. Typecheck clean. All AuditView export and EventsView poll-merge tests unaffected — those drive data-layer logic that's independent of the rendering strategy.

**V1 is now complete across all 7 list views.** Remaining phases:
- **Phase 3:** V5 debounce search inputs; V4 server-side sort *(spec-blocked on cycles-server-admin)*.
- **Phase 4:** W4 bulk concurrency + 429 backoff; W1/W3 *(spec-blocked)*.
- **Phase 5:** V6 PageHeader result count; V7 EmptyState filter-aware; W5 reveal-timer cleanup; W6 a11y row-count live region.

### 2026-04-16 — High-cardinality scale hardening (phase 2b of 5: V1 virtualization, part 1)

Closes **audit item V1** (row virtualization) across the five non-expandable-row list views. Events + Audit have expandable detail rows that require `virtualizer.measureElement` for dynamic row heights; they ship in phase 2c.

**New dependency:** `@tanstack/vue-virtual@3.13.23` (~15KB gzip, headless, actively maintained). Chosen over `vue-virtual-scroller` for its composable-first API and better Vue 3 / TypeScript integration.

**Pattern (ReservationsView is the reference):**
- Semantic `<table>` becomes an ARIA grid of `<div role="table">` → `<div role="rowgroup">` → `<div role="row">` → `<div role="cell">`. HTML's table layout algorithm can't coexist with absolute-positioned virtualized rows, so CSS Grid handles column sizing.
- `gridTemplateColumns` is bound via inline `:style` (not a Tailwind arbitrary class) — removes dependency on Tailwind JIT scanner correctly picking up complex `[minmax(…,…)_…]` patterns.
- Fixed row height per view (52–56px depending on content density) so `estimateSize()` is exact and no post-measure reflow happens.
- `useVirtualizer(computed(() => ({...})))` wraps the options object in a computed; per-field reactivity doesn't work since vue-virtual reads each option as a raw value.
- `aria-rowcount` / `aria-rowindex` preserve screen-reader position awareness even when most rows aren't in the DOM.
- `SortHeader` accepts a new `as: 'th' | 'div'` prop (default `'th'`); virtualized views pass `as="div"` so the header fits the ARIA grid. `role="columnheader"` preserved in both modes.

**Views virtualized:**
1. **ReservationsView** (pilot). 7 columns when canManage. Inline grid template tuned for reservation ID + scope_path's mono-font widths; 120px action column (was 96px — "Force release" at text-xs needed more room after the 32px cell padding).
2. **TenantsView**. 8 columns when canManage, includes checkbox + bulk bar + single-row Suspend/Reactivate actions. V3's `tenantById` Map lookup unchanged; parentName() still O(1) per row.
3. **WebhooksView**. 7 columns when canManage. URL cell uses the grid cell's `min-w-0` so the inner router-link's `truncate` works correctly (was previously pinned to `max-w-[300px]` which fights grid sizing).
4. **ApiKeysView**. 9 columns when canManage — widest view, horizontal-scroll engages below ~1320px. Permissions chips use `flex gap-1 overflow-hidden` (was `flex-wrap` — wrapping on a fixed-height row would clip below). Full permissions list remains visible in the Edit dialog.
5. **BudgetsView** (list mode only). Detail mode is unaffected — it's bounded by `DETAIL_EVENTS_PAGE_SIZE=20` and virtualizing its embedded EventTimeline would be strictly worse UX. Row height 56px for UtilizationBar's label + bar + gap.

**Side fixes shipped along the way:**
- `docker-compose.yml` — `DASHBOARD_CORS_ORIGIN` on both cycles-admin and cycles-server extended to include `http://localhost:5174` as a fallback for when Vite's default :5173 is in TIME_WAIT from a prior run. Spring's CorsFilter runs before AuthInterceptor, so a missing origin surfaces as a 403 in DevTools with zero admin-server logs — the added origin is worth the belt-and-suspenders.

**Test strategy:** jsdom has no layout engine, so a real virtualizer renders zero rows in unit tests. `error-surfacing.test.ts` (which clicks a row-level Revoke button) now mocks `@tanstack/vue-virtual` with a drop-in that returns all items as virtual rows with synthetic offsets. Capability-gating tests migrated from `th.w-24` / `th.w-20` selectors to a stable `data-column="action"` attribute on the gated columnheader div — same behavior assertion, selector is layout-independent.

**Gates:** 314/314 Vitest pass. Typecheck clean. Visual verification performed against the full runtime + admin stack (7878/7979) with a real Vite dev server on :5173.

**Still outstanding (phase 2c + 3-5):**
- **Phase 2c:** EventsView + AuditView — expandable detail rows need `virtualizer.measureElement` for dynamic heights (simple `estimateSize` works up to the expand click; after that the row grows by a couple hundred pixels).
- **Phase 3:** V5 debounce search inputs; V4 server-side sort *(spec-blocked)*.
- **Phase 4:** W4 bulk concurrency + 429 backoff; W1/W3 *(spec-blocked)*.
- **Phase 5:** V6 PageHeader result count; V7 EmptyState filter-aware; W5 reveal-timer cleanup; W6 a11y row-count live region.

### 2026-04-16 — High-cardinality scale hardening (phase 2 of 5)

Continues the audit. Phase 2 focuses on **request-layer completeness** (more cursor pagination) and **render-layer low-hanging fruit** (O(1) lookup, lazy tabs, Copy JSON). Full virtualization (V1 — the originally-planned Phase 2 centerpiece) moves to phase 2b as its own PR — it touches all 7 list views and breaks semantic `<table>` in favor of ARIA-labeled divs; large enough to deserve its own review window.

**Audit items V3, R5, R6, R8, R9, V2.**

**1. V3 — TenantsView O(1) parent lookup** (`src/views/TenantsView.vue`). Pre-fix, `parentName()` called `tenants.value.find(…)` inside the row template — at render time that's O(n) per row × n rows = O(n²) total. At 10k tenants, ~100M comparisons per repaint. New `tenantById` computed builds a `Map<tenant_id, Tenant>` once per change in `tenants.value`; `parentName()` does a `.get()` — O(1) per row, O(n) for the map build. The parent column now costs what a normal column costs.

**2. R5 — TenantsView cursor pagination** (`src/views/TenantsView.vue`). Pre-fix, `listTenants()`'s `has_more` / `next_cursor` were ignored; deployments with more tenants than the server's default page size silently dropped the tail. New `hasMore` / `nextCursor` refs; `loadMore()` appends. Search and parent-filter run client-side on the loaded subset (V5 debounce + spec-blocked W3 server search ship later). Polling refreshes page 1 and drops the loaded tail — same documented trade-off as ReservationsView.

**3. R6 — WebhooksView cursor pagination** (`src/views/WebhooksView.vue`). Same pattern as R5. Unchanged behavior for small deployments; Load-more footer mirrors TenantsView / ReservationsView exactly so the idiom is consistent dashboard-wide. Tenant filter still client-side on loaded subset.

**4. R8 — BudgetDetail events "Load older events"** (`src/views/BudgetsView.vue`). Pre-fix, the budget-detail event timeline hardcoded `limit: '20'` with no escape hatch — budgets with long activity histories (chatty agents, RESET_SPENT rollovers, long-lived subs) showed only the latest 20 events with no signal more existed. New `DETAIL_EVENTS_PAGE_SIZE=20` constant, cursor refs, and `loadMoreDetailEvents()` follows `next_cursor`. Button labeled "Load older events" because events are returned newest-first — paginating moves backward in time. Budgets with ≤20 events never see the button.

**5. R9 — TenantDetailView lazy tabs** (`src/views/TenantDetailView.vue`). Pre-fix, every 60s poll ran `Promise.all([budgets, keys, policies, tenants])` regardless of which tab was open. A tenant with 10k keys or 10k policies fired two unbounded fetches the operator never asked for. Post-fix: `keysLoaded` / `policiesLoaded` flags; the poll conditionally fetches based on `tab === 'keys' || keysLoaded` etc. Budgets + tenants are always fetched because the header card's spend rollup and children list depend on them unconditionally. `watch(tab)` triggers immediate `refresh()` on first activation of a lazy tab so the first open doesn't wait up to 60s. Net effect for 10k-key tenants when operator only looks at Budgets tab: zero listApiKeys calls.

**6. V2 — EventsView Copy JSON** (`src/views/EventsView.vue`). The audit's exploration agent claimed EventsView had unbounded JSON render; it already had `max-h-40 overflow-auto` on the data block (pre-existing). Outstanding delta was the Copy button, which makes the capped viewport useful for triage rather than merely safe — operators can pull the full blob into their clipboard for grep/diff/jq rather than squinting at a capped viewport. Same pinned-header-plus-scrolling-body pattern as AuditView's metadata block. "Copied!" confirmation flips for 2s via a timer that's cancelled-and-re-created on re-copy.

**Gates:** 314/314 Vitest pass. Typecheck clean. No test regression; no new test files (each item is a refactor or an additive feature on already-tested paths).

**Still outstanding (tracked in Phase 2b, 3, 4, 5):**
- **Phase 2b:** V1 virtualization via `@tanstack/vue-virtual`. Biggest remaining render-layer item.
- **Phase 3:** V5 debounce search inputs; V4 server-side sort *(spec-blocked)*.
- **Phase 4:** W4 bulk op concurrency + 429 backoff; W1/W3 *(spec-blocked)*.
- **Phase 5:** V6 PageHeader result count; V7 EmptyState filter-aware; W5 reveal-timer cleanup; W6 a11y row-count live region.

### 2026-04-16 — High-cardinality scale hardening (phase 1 of 5)

Closes six correctness gaps surfaced by a high-cardinality UX audit (thousands of tenants, thousands of budgets per tenant, millions of events). Each was a distinct class of silent-data-loss or unbounded-resource bug that small deployments never encounter but production-scale ones consistently hit.

**Audit items R10, R3, R4, R7, R1 (mitigation), R2 (mitigation).** Items V1–V7 (virtualization, O(1) lookup, debounce, result counts, filter-aware empties), R5/R6/R8/R9 (more pagination), W4/W5/W6 (bulk concurrency, timer cleanup, a11y live region) ship in later phases. Items R1/R2/V4/W1/W2/W3 depend on cycles-server-admin spec changes; this PR does the dashboard-side mitigations only.

**1. usePolling — cancellation, in-flight dedup, jitter** (`src/composables/usePolling.ts`). The composable now passes an AbortSignal to the callback, aborts it on unmount, and drops overlapping ticks via an in-flight guard. Fixes the "later-arriving response overwrites fresher one" race that hit every polled view. `src/api/client.ts` `get`/`mutate`/`request` accept an optional signal; `fetchWithTimeout` merges an external signal with its own timeout via a linked controller so timeout keeps its friendly message while external aborts rethrow the raw AbortError unchanged. Backward-compatible — existing views that ignore the signal continue to work. Backoff is now jittered ±10% to prevent multi-tab thundering-herd. AbortError does NOT bump the failure counter (aborts are intentional). +5 tests.

**2. AuditView export paginates full result set** (`src/views/AuditView.vue`). Pre-fix, CSV/JSON exports dumped `entries.value` — just page 1. Compliance/forensics exports silently shipped incomplete data. New `fetchAllForExport()` loops `next_cursor` until exhausted, capped at `EXPORT_MAX_ROWS=50_000` (and a secondary `MAX_PAGES=500` safety cap against pathological tiny-page servers). Result-count line surfaces "(more available)" when the first page is not the full match set. Export confirm dialog distinguishes single-page vs multi-page. New blocking progress overlay during multi-page fetches so operators don't close the tab mid-assembly. +3 tests covering cursor-follow, fast-path when `has_more=false`, and filter persistence across pages.

**3. ReservationsView cursor pagination** (`src/views/ReservationsView.vue`). Replaces hardcoded `limit: 100` (which silently truncated tenants with >100 matching reservations — the cap equaled the server's default page size, so "no tail" was indistinguishable from "exactly one page fits"). New Load-more button follows `next_cursor`; footer banner documents the known trade-off that the 30s poll refreshes page 1 and drops the loaded tail. Aligned with BudgetsView's existing reference implementation of the cursor pattern.

**4. EventsView poll preserves paginated tail** (`src/views/EventsView.vue`). Pre-fix, the 15s poll unconditionally overwrote `events.value`, silently dropping any pages the operator had loaded via Load more — an in-progress forensic sweep through a correlation_id could lose hundreds of events mid-investigation. Post-fix, once the operator clicks Load more at least once (`loadedMorePages=true`), subsequent polls merge fresh events from the head via `event_id` dedup (events are immutable; repeated IDs are always safe to skip) and preserve the tail. `hasMore`/`nextCursor` are NOT updated in extended mode — they reflect the tail cursor, not page 1's, and overwriting would break subsequent Load more clicks. Filter changes reset the flag (the old tail is scoped to the old filter). Shared `buildFilterParams()` helper removes drift risk between `load()` and `loadMore()`. +3 tests.

**5. ApiKeysView tenant-fan-out mitigation** (`src/views/ApiKeysView.vue`). The full fix is a tenant-agnostic `/v1/admin/api-keys` endpoint (spec change in cycles-server-admin — not in this PR). Until that ships, three dashboard-side improvements: (a) **filter fast-path** — when `filterTenant` is set, fetch ONLY that tenant's keys (single request; also correctness — a tenant past the fan-out cap was previously invisible); `watch(filterTenant)` refreshes so the fast path triggers. (b) **Fan-out cap** — `TENANT_FANOUT_CAP=100`; amber banner surfaces when truncated with a `role="status"` for screen readers. (c) **Bounded concurrency** — `Promise.all` in batches of 4 instead of sequential. At 100 tenants drops poll time from ~3s to ~0.8s without DDoSing the admin tier (under Chrome's per-host 6-connection limit with headroom).

**6. BudgetsView cross-tenant pagination + fan-out cap** (`src/views/BudgetsView.vue`). Pre-fix, `loadAllTenantBudgets()` iterated tenants and fetched ONLY page 1 per tenant — over-limit / has-debt filters silently missed matching budgets on pages 2+ within each tenant. That was a correctness bug (not performance): an over-limit budget past its tenant's first page was invisible regardless of refresh count. Post-fix, new `fetchAllBudgetsForTenant()` follows `next_cursor` per tenant up to `CROSS_TENANT_PER_TENANT_PAGE_CAP=10` pages; `CROSS_TENANT_FANOUT_CAP=100` bounds the tenant iteration; `CROSS_TENANT_CONCURRENCY=4` parallelizes. Banner renders only when truncated AND in a fan-out mode (over_limit / has_debt / unselected-tenant). Single-tenant view's cursor pagination is unchanged.

**Gates:** 314/314 Vitest pass (303 before + 11 new: 5 usePolling + 3 AuditView-export + 3 EventsView-poll-merge). Typecheck clean. Build clean. No version bump (no runtime capability change — backend's existing has_more/next_cursor was already there; this is pure dashboard-side correctness + bounding).

**What this does NOT fix (tracked for later phases):**
- **Phase 2 (render-layer):** no list view is virtualized — 10k rows still pile into the DOM. V3 TenantsView parent-name O(n²) lookup. R9 TenantDetailView Promise.all-on-mount fetches every tab even when unopened.
- **Phase 3 (server-push):** V4 client-side sort on partial data still misleading. V5 no debounce on search inputs. R8 BudgetDetail events hardcoded to 20.
- **Phase 4 (bulk workflow):** W1 no "select all matching" for bulk ops. W4 no 429-aware backoff in bulk runners.
- **Phase 5 (polish/a11y):** V6 no result-count in PageHeader. V7 EmptyState inconsistency. W5 reveal-timer cleanup. W6 no live-region for screen-reader row-count announcements.
- **Spec-blocked (cycles-server-admin):** R1 tenant-agnostic `/admin/api-keys`, R2 cross-tenant `/admin/budgets` with `over_limit` / `utilization_min/max` server-side filters, V4 `sort_by` / `sort_dir` params, W1 bulk-op filter spec, W2 utilization_min/max, W3 tenant search param.

### 2026-04-15 — v0.1.25.27 RESET_SPENT funding operation support

Surfaces the `RESET_SPENT` funding operation added in cycles-server-admin 0.1.25.18 (billing-period rollover — reset the "spent" tally without touching allocated, with an optional `spent` override). Fully additive: existing CREDIT/DEBIT/RESET/REPAY_DEBT flows unchanged; dashboard continues to work against older admin servers for everything except the new operation.

**Changes:**
- `src/api/client.ts` — `fundBudget()` takes an optional `spent?: number` parameter, emitted in the body as an `Amount` object ONLY when `operation === 'RESET_SPENT'`. For all other operations the field is omitted (server would ignore it anyway; keeping the wire payload clean helps future wire-diff tests).
- `src/views/BudgetsView.vue` — new `RESET_SPENT` `<option>` in the Fund dialog, hint text, and a conditional "Spent override" numeric input that only appears for RESET_SPENT. Amount field is hidden for RESET_SPENT (allocated is not changing) and `amount` is sent as 0 on the wire. Blank override = server resets spent to zero; providing a value sets the exact starting spent.
- `src/views/BudgetsView.vue` — success-toast label map extended (`RESET_SPENT: 'Budget spent reset'`).
- `src/types.ts` — `EVENT_TYPES` extended with `'budget.reset_spent'` so EventTimeline icon/label resolution and TS type-checking stay clean for the new event the server emits on RESET_SPENT.
- `src/__tests__/client.test.ts` — +3 tests: (a) RESET_SPENT with spent attaches `spent` Amount to body, (b) RESET_SPENT without spent omits the field, (c) CREDIT with an accidental spent arg does NOT send spent (guards against a future refactor that removes the operation check).

**Gates:** typecheck clean, unit tests pass, existing `capabilities-gating.test.ts` + `error-surfacing.test.ts` unaffected. Server-side validation (spec: spent only permitted for RESET_SPENT) remains the authoritative gate.

**Semantics correction (post-test):** Initial implementation hid the amount field for RESET_SPENT and forced `amount=0` on the wire, on the (incorrect) belief that RESET_SPENT preserved allocated. The server's `BudgetRepository.FUND_LUA` for RESET_SPENT actually sets `allocated = amount` AND `spent = override` — so passing `amount=0` was zeroing the allocation, leaving budgets at allocated=0 / spent=N / remaining=−N. Fixed: amount input is shown for RESET_SPENT (re-labeled "Allocated for new period"), pre-filled with current allocated when the operator selects the operation, and sent through unchanged. Allocated=0 is permitted for RESET_SPENT (rare close-into-period case) but not other operations. Hint text rewritten to match server semantics. Unit tests updated to assert non-zero amount on RESET_SPENT body.


### 2026-04-14 — Error-surfacing + SecretReveal + 3 incident-response Playwright flows

Closes three gaps from the v0.1.25.26 test-quality review: silent toast-error regressions, uncovered compliance-audit surface (SecretReveal), and the remaining incident-response end-to-end flows.

**1. Error-surfacing (`src/__tests__/error-surfacing.test.ts`, 4 tests).** 26+ view catch blocks call `toast.error(toMessage(e))`. Nothing asserted the toast actually rendered with readable text — a silent-no-op refactor of `useToast.error` or a `toMessage` regression that returned "[object Object]" would have let destructive operations silently "fail-open" in prod. Tests mount `ApiKeysView`, stub `revokeApiKey` to reject with a conformant `ApiError`, drive the UI into the catch path via real click handlers, then assert the `toasts` ref received an error toast containing the server message. Covers both `ApiError` and generic `Error` catch paths.

**2. SecretReveal component (`src/__tests__/SecretReveal.test.ts`, 10 tests).** Compliance buyers audit this surface — it's the one-shot modal operators see after rotating or creating a secret. Tests lock in: secret renders inline and is selectable, "will not be shown again" warning is prominent, Close is gated on "I copied this" acknowledgement, Escape key respects the same gate, Copy invokes `navigator.clipboard.writeText` with the secret, the 2-second "Copied!" flip reverts, the 60-second clipboard wipe fires IFF the clipboard still holds the secret (preserves user's own clipboard content if they copied something else), `role="dialog"` + `aria-modal="true"` + `aria-label` wired correctly.

**3. Three incident-response Playwright flows** templated from `reservations-force-release.spec.ts`:

| Spec | Flow | Regression class caught |
|---|---|---|
| `suspend-tenant.spec.ts` | TenantDetailView → Suspend → confirm → reactivate round-trip | single-tenant compromise response (distinct from existing bulk-suspend spec) |
| `revoke-key.spec.ts` | ApiKeysView → row Revoke → confirm → list shows REVOKED | leaked-key remediation; catches dialog-lingers, toast-silent, list-doesn't-refresh regressions |
| `replay-event.spec.ts` | WebhookDetailView → Replay → form submit → events_queued banner | outage-remediation flow; locks `max_events` sent as number (not string) |

Each spec is self-contained — creates its own tenant/key/webhook in `beforeAll` so it doesn't mutate seed fixtures other specs depend on. Request-body assertions (status transition on PATCH, `max_events` type on replay) guard against silent semantic drift that a naive UI-only assertion would miss.

**Gates:** 300/300 Vitest pass (286 prior + 14 new: 4 error-surfacing + 10 SecretReveal). 3 new Playwright specs parse + list. Typecheck clean. Build clean. No runtime change, no version bump.

### 2026-04-14 — Capability-gated UI visibility test layer

Adds `src/__tests__/capabilities-gating.test.ts` (11 Vitest tests) to close the compliance-grade gap around write-action buttons rendering to read-only users. A user with `manage_X: false` must not *see* the action — server-side rejection is insufficient. A v-if dropped during a refactor, negated accidentally, or typo'd to the wrong cap name previously would have passed every existing test and shipped silently.

**Coverage matrix** — pass + fail assertion per pair:

| View | Capability | Gated surface asserted |
|---|---|---|
| `TenantsView` | `manage_tenants` | "Create Tenant" button |
| `ApiKeysView` | `manage_api_keys` | "Create API Key" button |
| `WebhooksView` | `manage_webhooks` | "Create Webhook" + "Security Config" buttons |
| `ReservationsView` | `manage_reservations` | Action column `<th class="w-24">` |
| `BudgetsView` | `manage_budgets` | Action column `<th class="w-20">` |

Plus one lock-in assertion: `undefined` capability is permissive (`!== false` pattern) — prevents someone "fixing" guards to `=== true` and silently breaking UIs mid-deploy when a new capability flag hasn't propagated through all environments.

**Why Vitest, not Playwright:** capability gating is a pure template-conditional question JSDOM handles fine. ~10× faster per assertion, no compose stack, no browser, runs on every PR in the existing test workflow. Playwright's strength stays focused on real-browser JS-layer bugs.

**Design:** `vi.mock('../api/client')` returns typed-envelope empty responses (`{ tenants: [] }`, `{ keys: [] }`, etc.) so views render in their empty-data state. `vi.mock('../composables/usePolling')` returns the destructured shape views expect. `vue-router` stubbed. Each test mounts the real view with a Pinia auth store pre-populated via `setCaps()`.

**Gates:** 286/286 Vitest pass (275 prior + 11 new). Typecheck clean. No runtime change, no version bump.

### 2026-04-14 — v0.1.25.26 — style consolidation via @layer components + dark-mode restore

Consolidates 4+ occurrences of repeated Tailwind utility-class strings into reusable classes defined in `src/style.css` via Tailwind v4's `@layer components` directive. Pure deduplication — not a design-system abstraction. Stateful composites (FormDialog, ConfirmAction, StatusBadge, ActionButton) stay as `.vue` components.

**Classes added** (17 total): `form-label`, `form-input(+mono)`, `form-select`, `card`, `card-table`, `table-cell`, `table-header`, `table-row-hover`, `muted(+sm)`, `banner-error`, `banner-warning`, `info-panel`, `btn-row-{danger,success,primary}`, `btn-pill-{danger,success,primary,secondary}`, `badge-{danger,warning,success}`.

**Sweeps:** 4 PRs, ~50 files touched across `src/views/` and `src/components/`. Sidebar.vue intentionally excluded (dark background permanently — white-bg-tuned classes would break contrast).

**Dark-mode caveat (caught late, fixed in same release):** `@apply` inlines utilities as flat declarations, so cascade rules like `.dark .bg-white { background: gray-900 }` never match elements that use the component classes (they have `.card`, not `.bg-white`). First pass shipped with broken dark mode — every card/table/banner rendered bright. Fixed by adding explicit `.dark .<class>` overrides for every component class that touches bg/border/semantic color. Documented in the style.css dark-overrides section so future additions don't repeat the mistake.

**Why this class of regression wasn't caught by tests:** Vitest is DOM-only and doesn't render CSS. Playwright specs exercise flows but don't assert visual appearance. Axe checks contrast but only on the currently-rendered colors — the dark-mode bug looked fine to axe because the computed colors on light-on-light were actually above contrast ratio for each individual element. Only human eyes on the actual dark-theme render caught it. Trade-off: add a Playwright visual-diff spec later if this class recurs, but for now manual dark-mode verification is the gate.

### 2026-04-14 — A11y ratchet: all impact levels now enforced (TERMINAL)

Flips `BLOCKING_IMPACTS` to `['minor', 'moderate', 'serious', 'critical']` — every axe-reported violation on a WCAG 2.0/2.1 AA rule now fails the audit. Terminal state of the severity ratchet started with the first a11y PR.

**Free step.** `minor` was already confirmed clean in #54's companion sweep; re-ran the full suite against current main and verified zero violations at every level across all 10 audited pages.

**Practical consequence:** a future UI change that introduces any axe-flagged WCAG 2/2.1 AA violation — even a minor-impact one (landmark labels, region annotations, empty-alt warnings on decorative content) — will fail the e2e workflow. The trade-off is we stop accumulating a11y tech debt altogether. If a specific minor rule turns out to be noisier than useful, disable it per-rule via `.disableRules([...])` rather than lowering the whole floor.

**Changes:**

| File | Change |
|---|---|
| `tests/e2e/a11y-audit.spec.ts` | `BLOCKING_IMPACTS` widened to all four levels. Doc-string re-framed around the ratchet's terminal state with the full history. Test titles updated (`has no a11y violations (minor+)`). |

**Ratchet ladder — final state:**

| Impact | Status |
|---|---|
| `critical` | ✅ blocking |
| `serious` | ✅ blocking |
| `moderate` | ✅ blocking |
| `minor` | ✅ blocking — terminal |

**Gates:** 24/24 Playwright pass in ~29s (10 a11y + 14 behavioral). 275/275 Vitest pass. Typecheck clean. No runtime change; no version bump.

### 2026-04-14 — A11y ratchet: moderate now enforced (and minor is also clean)

Free ratchet. A discovery sweep at the `moderate` threshold after the previous serious+critical fix pass found **zero violations** across all 10 audited pages — the color-contrast swaps, select-name labels, and nested-interactive refactors happened to cover every moderate-level rule as well.

**Did NOT stop there — also verified `minor`:** re-ran the sweep with `IMPACTS=['minor', 'moderate', 'serious', 'critical']`. Also zero violations across all 10 pages.

So why hold at `moderate` instead of going to all-levels?

The current floor deliberately leaves `minor` as observe-only so incidental UI tweaks (landmark labels, region annotations, empty-alt warnings) don't block unrelated PRs. When strictest-possible enforcement is desired, flipping the threshold is a one-line change — the spec comment documents the path.

**Changes:**

| File | Change |
|---|---|
| `tests/e2e/a11y-audit.spec.ts` | `BLOCKING_IMPACTS: ['serious', 'critical']` → `['moderate', 'serious', 'critical']`. Ratchet comment updated to note minor is also clean and how to flip to all-levels. |

**Gates:** 24/24 Playwright pass, 10 a11y specs in ~17s. 275/275 Vitest still pass. Typecheck clean. No runtime behavior change, no package version bump.

### 2026-04-14 — A11y ratchet: WCAG 2.0/2.1 AA serious+critical now enforced

Ratchets the axe blocking threshold from `['critical']` to `['serious', 'critical']` across every major dashboard surface after a focused fix pass. 10 pages now audited (was 3).

**Before** — ~80 serious-level violations across three rule families:
- `color-contrast` (~63 nodes) — Tailwind gray-400 / gray-500 text on white backgrounds (2.8–4.1:1; AA needs 4.5:1 for normal text).
- `select-name` (2 critical) — unlabeled `<select>` elements in Tenants + Webhooks filters.
- `nested-interactive` (~24 nodes) — row-level `role="button"` on Events + Audit expandable rows containing inner buttons / links.

**Fixes:**

| Rule | Change |
|---|---|
| `color-contrast` | Scripted rewrite across 21 .vue files: `text-gray-400` → `text-gray-600 dark:text-gray-400`; `text-gray-500` → `text-gray-600 dark:text-gray-500`. Dark-mode preserved. Sidebar excluded (its `text-gray-400` sits on bg-gray-900 = 5.4:1, already AA-compliant). Sidebar's version line bumped from gray-600 → gray-400 because the relationship reverses on a dark background. |
| `color-contrast` | EmptyState hint `text-gray-300` → `text-gray-600 dark:text-gray-400`. |
| `color-contrast` | TenantsView em-dash placeholder `text-gray-300` → `text-gray-500` + `aria-hidden="true"` (decorative). |
| `select-name` | Added `aria-label` on parent-filter select (Tenants) + tenant-filter select (Webhooks). |
| `nested-interactive` | Removed row-level `role="button" tabindex="0"` + keydown handlers on Events + Audit expandable rows. Converted the chevron SVG in the first cell into a real `<button>` with `aria-expanded`, `aria-label`, and focus ring. Row keeps `@click` for mouse convenience; keyboard + screen-reader users now interact via the dedicated button, not the whole row. |

**Coverage:** `a11y-audit.spec.ts` now audits login, overview, tenants list, tenant detail, budgets list, events, api keys, webhooks, audit, and reservations — 10 specs, all passing.

**Ratchet strategy documented inline in the spec.** Next steps: fix moderate/minor violations, then add those levels to `BLOCKING_IMPACTS`. Today's PR locks serious+critical as the floor.

**Gates:** 24/24 Playwright pass in ~27s. 275/275 Vitest pass. Typecheck clean. No package version bump — no runtime behavior change.

**Out of scope (follow-ups):**
- `moderate` / `minor` violations (the next ratchet step).
- Forced-colors media query coverage.
- Keyboard-navigation E2E flows (tab order, focus trap on modals).

### 2026-04-14 — v0.1.25.25 grouped PermissionPicker

Picking from a flat 27-item permission list was painful for operators. Replaced the inline `<label v-for>` blocks in `ApiKeysView` (create + edit) and `TenantDetailView` (create) with a new `PermissionPicker.vue` component that groups by plane + resource and supports bulk select:

- **Tenant** plane — Reservations, Balances, Budgets, Policies, Webhooks, Events
- **Admin (wildcard)** — `admin:read`, `admin:write` at the plane level (no sub-group)
- **Admin (per-resource)** — Tenants, Budgets, Policies, API Keys, Webhooks, Events, Audit

Each plane and each sub-section shows a tristate checkbox (click fills if any unchecked, clears when all checked) plus `X/Y` count. Individual checkboxes render the last colon-suffix (`create`, `read`, `write`) since the section header provides context. Spec compliance is preserved — the picker's source of truth is `PERMISSION_GROUPS` in `src/types.ts`, which a new `PermissionGroups.test.ts` asserts is the exact set-cover of `PERMISSIONS` (no drift, no duplicates).

**Changes:**
- `src/types.ts` — added `PERMISSION_GROUPS` as a typed grouped view of `PERMISSIONS`.
- `src/components/PermissionPicker.vue` — new component. ~100 LOC. `v-model` over `string[]`.
- `src/views/ApiKeysView.vue` — replaced two inline permission lists with `<PermissionPicker>`.
- `src/views/TenantDetailView.vue` — replaced inline permission list; removed now-unused `PERMISSIONS` import.
- `src/__tests__/PermissionGroups.test.ts` — drift guard (2 tests).

**Picker layout refinement (same release):**
- Edit dialog shows a pending-changes summary beneath the picker: green `+perm` chips for adds, red `−perm` chips for removes. Renders only when there's actually a diff. Makes the Save-button intent visible at a glance and also surfaces the `openEdit`-time legacy-perm filter (e.g. `decide` appears as an explicit pending removal alongside the toast). `aria-live="polite"` so screen readers pick it up as checkboxes toggle.
- *Tried and reverted:* 3-col side-by-side layout for the three planes. Looked clean in the mockup but the actual edit-dialog width (~600–700px) couldn't fit three columns of nested content — section headers wrapped, the internal `grid-cols-2` of checkboxes compressed, and `X/Y` counts fell to the next line. Stacked single-column is the honest fit for this dialog size. Revisit if the dialog is widened materially.

**Not in this PR:** filter/search box in the picker, preset buttons ("read-only", "full tenant"), collapsible sections, and the fuller matrix layout proposed as "option A." Kept scope tight; revisit if operators ask.

### 2026-04-14 — v0.1.25.25 default sort: newest-first on reservations / api-keys / budgets / tenants

Also shipping in v0.1.25.25: all four list views now default to newest-first ordering by `created_at`. Previously they defaulted to either unsorted (api-keys, tenants), created_at asc (reservations), or unsorted (budgets) — all wrong for the typical "what changed recently" operator workflow.

**Changes:**
- `ApiKeysView.vue` / `TenantsView.vue` — `useSort(items, 'created_at', 'desc')`.
- `BudgetsView.vue` — defaults to **highest-utilization first** (`('utilization', 'desc')`) rather than `created_at`. Operators triaging budgets care about "which scopes are closest to running dry" more than provisioning order — the near-exhausted rows are the actionable ones, so floating them to the top is the right default.
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

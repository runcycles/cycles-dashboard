# Cycles Admin Dashboard — Audit

**Date:** 2026-04-16 (scale-hardening phase 3 — V5 debounce composable, V6 PageHeader result counts, V7 filter-aware EmptyState), 2026-04-16 (scale-hardening phase 2c — V1 virtualization for EventsView + AuditView with measureElement for expandable rows), 2026-04-16 (scale-hardening phase 2b — row virtualization across 5 list views via @tanstack/vue-virtual), 2026-04-16 (scale-hardening phase 2 — pagination on tenants/webhooks/budget-detail events, lazy tabs, O(1) parent lookup, copy-event-data), 2026-04-16 (scale-hardening phase 1 — pagination, cancellation, N+1 mitigation across 6 views), 2026-04-15 (v0.1.25.27 — RESET_SPENT funding operation support, semantics corrected post-test), 2026-04-14 (error-surfacing + SecretReveal + 3 incident-response Playwright flows), 2026-04-14 (capability-gated UI visibility test layer), 2026-04-14 (v0.1.25.26 style consolidation + dark-mode restore), 2026-04-14 (a11y ratchet to WCAG AA all-levels — TERMINAL), 2026-04-14 (a11y ratchet to WCAG AA moderate+), 2026-04-14 (a11y ratchet to WCAG AA serious+critical), 2026-04-14 (v0.1.25.25 complete PERMISSIONS + unknown-filter on edit), 2026-04-14 (v0.1.25.24 API-key edit diff-before-patch), 2026-04-14 (Playwright E2E layer), 2026-04-13 (v0.1.25.23 nginx hotfix), 2026-04-13 (v0.1.25.22)
**Requires:** cycles-server v0.1.25.8+ (runtime plane, reservations dual-auth). Admin server v0.1.25.17+ continues to satisfy the governance plane; **admin server v0.1.25.18+ required** to execute the new `RESET_SPENT` funding operation from BudgetsView (older admin servers will reject the operation enum with 400 INVALID_REQUEST — UI degrades gracefully but the operator sees the server's error toast).

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

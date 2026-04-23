# Changelog

All notable changes to `cycles-dashboard` are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions use
[Semantic-ish Versioning](https://semver.org/) with a fourth "patch-of-patch"
segment for same-day follow-ups.

This file is for **downstream consumers** — operators pulling the Docker image
(`ghcr.io/runcycles/cycles-dashboard:<version>`) or the compose stack. For
internal engineering history (motivations, rejected alternatives, test-strategy
decisions, operator-feedback quotes) see [`AUDIT.md`](AUDIT.md). For running
the dashboard in production, see [`OPERATIONS.md`](OPERATIONS.md).

Dashboard versions track the governance spec (`cycles-governance-admin-v0.1.25.yaml`)
end-to-end support. The fourth segment bumps independently for dashboard-only
UX work that does not advance spec alignment.

## [0.1.25.58] — 2026-04-23

Mobile-responsive sweep. A focused audit turned up ~25 mobile issues
across layout shell, list/detail views, dialogs, and forms; this
release ships the highest-impact fixes. No spec advance. Bigger
refactors (virtualized-table card-mode on phones, CommandPalette
soft-keyboard handling) deferred to a follow-up.

### Fixed

- **Mobile drawer now closes on Escape and locks body scroll while
  open.** Pre-fix operators on phones could scroll the underlying
  list behind the dark overlay (reads as a bug) and had no keyboard
  escape path. Focus returns to the hamburger on close for keyboard
  coherence.
- **Hamburger button meets WCAG 44×44 touch-target minimum.** Pre-fix
  the bare icon was ~20×20 with no padding — common mis-tap target
  on phones.
- **PageHeader reflows to a column on narrow viewports.** The title
  + freshness pill + refresh + slotted actions used to overflow the
  viewport horizontally on phones < 640px. Stacks below `sm:`; title
  truncates rather than pushing content off-screen.
- **InlineErrorBanner dismiss (×) button is now 32×32** (was ~16×12)
  so operators on phones can actually tap it.
- **AuditView table `min-width` reduced from 1000px to 900px** so
  iPad portrait (768w) and most tablets hit the single-axis scroll
  path. Still enforces horizontal scroll on phones, but at a less
  aggressive width.
- **RowActionsMenu now clamps to the viewport horizontally.** The
  kebab popover can no longer open off the right edge on narrow
  screens; it flips to the opposite edge when the natural placement
  would overflow.
- **Dialog footers flex-wrap.** FormDialog + ConfirmAction footers
  previously pushed Submit off the right edge when button labels
  were long on 320w screens.
- **LoginView + NotFoundView fit on 320w phones.** Responsive padding
  (`p-6 sm:p-8`), smaller 404 text on phones (`text-5xl sm:text-6xl`),
  and `min-h-dvh` (not `min-h-screen`) so iOS Safari address-bar
  collapse doesn't leave dead strips.
- **AppLayout root uses `h-dvh`** (dynamic viewport height) so the
  layout tracks the visible viewport on mobile Safari.

### Coverage

- New test: `AppLayout-mobile-drawer.test.ts` (7 tests) — hamburger
  touch target + aria wiring, Escape closes drawer, body scroll
  locked while open, scroll restored on unmount, backdrop click,
  h-dvh root, Escape pass-through when drawer closed.
- Total: 936, was 929.

### Deferred

- Virtualized-table card-mode on phones (TenantsView, BudgetsView,
  WebhooksView, ApiKeysView). Current behaviour is horizontal scroll
  inside the table card; acceptable fallback but not ideal on 320w.
- CommandPalette soft-keyboard handling (input scrolls out of view
  when keyboard appears on mobile).
- TimeRangePicker popover horizontal overflow (structural similar
  to RowActionsMenu; didn't bundle because the component is smaller
  surface-area).
- BulkAction preview / result dialog table overflow on narrow
  screens.

## [0.1.25.57] — 2026-04-23

Correctness + debuggability sweep. Closes the remaining
medium-severity items from the v0.1.25.54 review plan
(H6 / M6 / M11 / M12 / M13 / M14 / M16) plus the deferred
Sidebar logout regression test. No spec advance.

### Fixed

- **Replay-events form: typed body + positive-number guard** (H6).
  Pre-fix used `Record<string, unknown>` + `as any` on the server call;
  an empty `max_events` field silently shoved `NaN` at the server.
  Body is now typed as `ReplayEventsRequest`; invalid `max_events`
  fails pre-flight with an inline error instead of the round-trip.
- **Tenant-list failure banner** (M6). BudgetsView's tenant-dropdown
  fetch failure used to render as tiny red text next to the disabled
  dropdown — easy to miss. Now surfaces in the dismissible top
  banner that every other error uses.
- **Auth restore() is now single-flight** (M11). Router guard +
  App.vue's mount-time session checker both called `restore()` on
  cold load, issuing two `/v1/auth/introspect` fetches in rapid
  succession. Concurrent callers now await the same in-flight
  promise; subsequent calls fire a fresh fetch.
- **Timeout error includes method + path** (M12). Pre-fix the
  timeout message was "Request timed out after 30000ms" — operators
  couldn't tell which of 8 parallel Overview fetches stalled. Now
  reads e.g. "…30000ms: GET /v1/admin/overview" for log correlation.
- **JSON parse failure surfaces in console** (M13). A non-2xx
  response with a non-JSON body (nginx HTML error page, upstream
  proxy fault) previously dissolved into the same opaque "API error:
  500" as a legit empty error body. Parse failures now log a
  `console.warn` with the underlying `SyntaxError` so devs can
  distinguish the two buckets.
- **ReservationsView respects `?tenant_id=`** (M14). Deep-links from
  Overview drill-downs or copy-pasted URLs now pre-select the URL
  tenant instead of falling through to the first-ACTIVE default.
  Stale URL tenants (tenant was deleted) drop to the default and
  clear the query param.
- **Bulk-action duration uses locale-aware formatting** (M16).
  `BulkActionAuditDetail`'s duration column used `.toFixed(2)` which
  always emits `.` decimals — mismatched the `Intl.NumberFormat`-
  based counts everywhere else in the dashboard on comma-decimal
  locales. Forced to en-US for consistency with unit suffixes.

### Tooling

- `vitest.config.ts` gains a `resolve.alias` for
  `/runcycles-logo.svg` → a test stub and a `define` for
  `__APP_VERSION__`. Lets components that reference those mount under
  jsdom without hitting Windows `file://` resolver errors. Required
  for the deferred Sidebar logout flow test.

### Coverage

- New test: `Sidebar-logout.test.ts` (3 tests) — the P1-H8 logout
  confirmation flow (deferred from .54; jsdom resource-loader
  workaround in place now).
- Extensions: `client.test.ts` (+3 M12/M13 tests),
  `auth-extended.test.ts` (+2 M11 single-flight tests),
  `BulkActionAuditDetail.test.ts` (+1 M16 locale test),
  `ReservationsView-url-deeplink.test.ts` (+2 M14 pre-select tests).
- Total (on this branch): 929 tests. Combined with the .56 tests
  (previously on main) this is the full suite.

### Review-pass additions

- **Replay form caught a real v-model coercion bug during test
  writing.** The initial H6 computed used `!raw` to short-circuit on
  the empty-string case — which also evaluates true for `0` (Vue
  auto-coerces `v-model` on `<input type="number">` to a number after
  interaction). Tests exposed the regression; fix uses explicit
  `raw === '' || raw === null` plus typed coercion. No pre-merge
  breakage on `main`.
- **Inline max-events error + `submitDisabled` wiring** now match the
  M7 TenantsView pattern (renders below the field, aria-invalid on
  the input, Submit gates on validity).
- **Sidebar-logout test isolation.** Added `afterEach` that clears
  `document.body` so Teleport fragments from a prior test can't leak
  into the next.
- **H6 + M6 regression-locks.** New test files cover the two diffs
  the first-round review flagged as untested.

## [0.1.25.56] — 2026-04-23

P2 accessibility + form-UX closeout. Last items from the v0.1.25.54
review plan; chart data becomes reachable to screen-reader users, the
tenant-create form validates as you type, and clickable chips render
a visible keyboard focus ring.

### Added

- **Screen-reader data table on `BaseChart`** (M9). Every chart now
  renders an `sr-only` data table alongside the canvas so screen-
  reader users get the same information sighted users see. Rows
  auto-derive from `option.series[0].data` for pie-shaped charts (all
  5 Overview / WebhookDetail donuts covered with zero per-view
  changes); callers with non-standard data shapes can pass an
  explicit `srData` prop.
- **`.chip:focus-visible` ring** (M10). Clickable chips (Overview
  donut legends, counter-strip chips) now render a blue focus ring on
  keyboard navigation. Ring color matches the app-wide `btn-pill-*`
  focus convention.
- **Live form validation on Create Tenant** (M7). The `tenant_id`
  input now shows inline red error text the instant an invalid
  character is typed — previously operators saw nothing wrong until
  they hit Submit. Submit button is disabled while validation fails;
  input carries `aria-invalid` for SR announcement. An empty field
  stays silent (no pre-typing scolding). `FormDialog` gains a
  `submitDisabled` prop so any form can gate Submit on its own
  validation predicate.

### Regression-locked

- **`RowActionsMenu` keyboard navigation** (M8). The review flagged
  this as missing; inspection showed it was already implemented
  (ArrowUp/Down/Home/End/Escape/Tab, lines 155-184). Added a
  regression-lock test so a future refactor can't silently strip the
  handlers.

### Changed

- `tsconfig.app.json` now includes `node` in `types` so the new
  `a11y-sweep` test can read `style.css` off disk to verify rule
  presence. Runtime build unaffected.

### Coverage

- New tests: `a11y-sweep.test.ts` (8 tests spanning M7/M8/M9/M10),
  `TenantsView-create-validation.test.ts` (6 tests — empty field,
  live error, min-length, aria-invalid, Submit gating, happy path).
- Total: 924 tests, was 896.

## [0.1.25.55] — 2026-04-23

Polish + coverage follow-up to v0.1.25.54. No spec advance; no
user-facing behaviour change from the coverage work, two minor
polish items visible to operators.

### Added

- **Shared polling-interval constants.** `POLL_FAST_MS` (30s),
  `POLL_SLOW_MS` (60s), `POLL_EVENTS_MS` (15s) in a new
  `composables/pollingConstants.ts`. Every polling view now imports
  from this single source so future tuning (e.g. back off during an
  incident) is one edit, not nine.

### Changed

- **`.form-label` is now `font-medium`.** In dense forms (TenantDetail
  tabs, BudgetsView filter strip) labels previously rendered at the
  same weight as body text, so operators missed required fields on
  scan. Medium weight is the minimum uplift that separates label from
  value without looking shouty.
- **`RefreshButton` dark hover states.** Added `dark:hover:text-gray-100`
  and `dark:hover:bg-gray-800` so the hover feedback isn't washed-out
  on the dark theme.

### Coverage

- New tests: `useChartTheme.test.ts` (5 tests — palette selection,
  reactive toggle, `statusColor` tracking, categorical length),
  `useListExport-boundaries.test.ts` (5 tests — fast-path CSV/JSON,
  maxRows abort, maxPages abort, filterFn seed-vs-page discrimination).
- `usePolling.test.ts` extended with a regression-lock: `lastSuccessAt`
  must stay `null` when a successful response lands post-unmount.
  Total: 896 tests, all passing.

## [0.1.25.54] — 2026-04-23

Dashboard-only UX & safety sweep. Triggered by a full-app review that
produced a ranked bug list (Critical / High / Medium); this release
ships the P0 (correctness / data integrity) and P1 (UX consistency)
batches together. Spec alignment unchanged.

### Added

- **Catch-all 404 route + `NotFoundView`.** Mistyped URLs and stale
  deep-links now render a "Page not found" card with the attempted
  path and an Overview / Login CTA (adapts to auth state) instead of
  a blank page. Public route so unauthenticated users aren't bounced
  to login for a bad URL — matches the Gmail / Linear / GitHub
  convention.
- **Per-route `document.title`.** Each route declares `meta.title`; an
  `afterEach` hook composes `<slug> – Cycles Admin Dashboard`. Fixes
  the "every tab reads the same thing" problem when operators stack
  tabs during incident triage.
- **"Updated Xm ago" pill on polling views.** `usePolling` now exposes
  `lastSuccessAt`; `PageHeader` renders a ticking freshness label next
  to the refresh button (Overview, Tenants, Webhooks, Events, Budgets).
  Absolute timestamp in the tooltip for exact log correlation.
- **`LoadingSkeleton` on list-view cold loads.** Tenants, Webhooks,
  Events, Audit, and Reservations previously showed `EmptyState`
  ("No X found") during the first fetch — misleading on slow links.
  Skeleton now shows until the initial poll tick resolves.
- **Dedicated not-found state on detail views.** TenantDetailView and
  WebhookDetailView differentiate "fetch in flight" (skeleton) from
  "server returned 404" (not-found card) instead of rendering an empty
  page in both cases.
- **`InlineErrorBanner` with dismiss affordance.** Shared component
  replaces nine identical inline `<p class="bg-red-50…">` banners
  across the list/detail views; adds an explicit close (×) button so
  operators can clear a one-off error without waiting for the next
  successful poll.
- **Logout confirmation dialog.** Sidebar Logout now routes through
  `ConfirmAction` ("Any unsaved form changes will be lost") — prevents
  accidental session loss mid-edit.
- **"All tenants" scope banner in `BudgetsView`.** When no tenant is
  selected and no cross-tenant filter is active, a subtle banner
  explicitly states the scope and points at the bulk-action gate.

### Fixed

- **Export abort threads the `AbortSignal` to `fetchPage`.**
  `useListExport` now forwards `abortExport.signal` into each page
  fetch AND re-checks `signal.aborted` after the fetch resolves, so a
  cancel click during an in-flight page discards the response instead
  of appending it post-cancel. AbortError mid-fetch surfaces as
  "Export cancelled" not a crash message.
- **`BudgetsView` cursor reset on `filter=` change.** The route-query
  filter watcher previously cleared selection but left `nextCursor`
  scoped to the previous filter — a subsequent Load more would mix
  rows across filters (or 400 on strict servers). Filter change now
  re-runs `loadList` which clears cursor/hasMore up-front.
- **`WebhookDetailView` polling aborts mid-tick.** The poll callback
  now accepts the `AbortSignal` from `usePolling` and checks
  `signal.aborted` between the webhook and deliveries fetches.
  Defensive against a stale response sneaking a write into a
  torn-down view.

### Changed

- **`formatDateTime` / `formatTime` include a short timezone marker.**
  The server emits UTC ISO; the browser renders in local. Prior output
  was ambiguous ("14:34" — local or UTC?). Output now includes the
  short zone abbreviation (`PDT` / `UTC` / `GMT+2`) so local vs. UTC
  is unambiguous when correlating with audit logs.
- **Named-route discipline across navigation.** Replaced every
  remaining `router.push('/path')` with `router.push({ name: '…' })`
  (Sidebar logout, TenantDetail back, WebhookDetail back, BudgetsView
  back) so a future path rename doesn't silently break navigation.
- **`auth.isAuthenticated` invariant documented.** Now requires both
  `apiKey` AND `capabilities`; the router guard awaits `restore()`
  before allowing navigation, so protected views never mount with null
  capabilities. Added comment explaining why `?.manage_X !== false`
  is safe (no null-capabilities render window).
- **`usePolling` logout-cascade invariant documented.** Logout flows
  through `isAuthenticated` → layout unmount → `usePolling.onUnmounted`
  → abort — no separate logout hook needed on the composable.

### Coverage

- New tests: `NotFoundView.test.ts`, `DetailView-not-found.test.ts`,
  `InlineErrorBanner.test.ts`, `router-document-title.test.ts`;
  `useListExport-cancel.test.ts` extended with mid-fetch cancel +
  AbortError paths; `format.test.ts` extended to assert the timezone
  marker; `PageHeader.test.ts` extended for the freshness pill;
  `usePolling.test.ts` extended for `lastSuccessAt`.
  Total: 884 tests, all passing.

### Review pass (this release)

- **`LoadingSkeleton` dark-mode palette.** Added `dark:bg-gray-700` /
  `dark:bg-gray-800` on the skeleton bars — pre-fix the light-gray
  placeholders looked washed-out against the dark-mode card surface.
- **`useListExport.executeExport` outer-catch detects AbortError.**
  Defensive: if an AbortError escapes `fetchAllForExport` via a non-
  cancel code path (e.g. upstream library tearing down), the operator
  now sees "Export cancelled." instead of raw "aborted" text.

## [0.1.25.53] — 2026-04-22

### Fixed

- **Webhooks counter-strip "active" chip drill-down now matches the
  tile number.** Operator-reported: tile showed 62 active but
  `/webhooks?status=ACTIVE` only listed 12. Root cause: the tile
  reads `webhook_counts.active` (a server-side scan across the
  whole fleet) while the list page loaded one page of 50 sorted by
  `consecutive_failures desc` and filtered `status === 'ACTIVE'`
  client-side — DISABLED/failing rows dominated page 1, leaving
  only 12 ACTIVE visible. WebhooksView now pushes `status=` to the
  server via the spec's `listWebhookSubscriptions` `status` query
  param, so polling / load-more / export all walk pages of
  matching rows. Same fix benefits `?status=PAUSED` and
  `?status=DISABLED`.
- **Webhook fleet-health donut reconciles with counter-strip
  chips.** Operator-reported: tile showed 6 paused, donut showed
  5. Root cause: the donut partitioned mutually-exclusively with
  "Failing" taking precedence over status — so a PAUSED-and-failing
  webhook was counted in "Failing", not "Paused". Tile read
  status-only; donut didn't. Donut slices are now status-pure
  (Active / Paused / Disabled) and sourced from the server's
  `webhook_counts` aggregate (same source the chip numbers use),
  so they reconcile by construction. Failing remains a separate
  counter-strip chip — that signal lives on the chip, not in the
  status mix.
- **Overview utilization donut no longer undercounts large fleets.**
  The at-or-near-cap fetch (`listBudgets?utilization_min=0.9`) is the
  same set the utilization donut buckets from. Its `limit` was 500,
  which under-sampled deployments with > 500 budgets at ≥ 90%
  utilization. Bumped to 2000 — the admin spec defines no server-side
  maximum on `limit`, so this is an order-of-magnitude headroom
  increase at negligible cost.
- **Events drill-down preserves the Overview time window.** The
  Events tile header announces the window (e.g. "Events (60m)") but
  the category chips and the "Events" link all routed to `/events`
  with no `from`/`to` — operators landed on every event ever recorded
  rather than the ones being summarized. All Events drill-downs from
  Overview (tile header, total count, category chips, and the
  fleet-chart category donut slices) now carry `from`/`to` query
  params derived from `overview.event_window_seconds`. EventsView
  already honors those params — no new spec surface.
- **Expiring API keys drill-down now filters to the 7-day window.**
  The Overview card shows "N keys expiring in 7d" and operators
  clicking "View all" landed on the full fleet with no filter
  applied. The link now carries `?expiring_within_7d=1` and
  ApiKeysView honors it as a client-side filter using the same
  `filterExpiringKeys` helper the card uses — the drill-down set is
  identical to the card set. A dismissible chip on the filter bar
  makes the active filter visible and reversible. The admin spec
  has no server-side `expires_before` param on `listApiKeys` (only
  `status=ACTIVE|REVOKED|EXPIRED`), so the filter runs client-side
  on top of the loaded page, consistent with how the card itself
  works.

## [0.1.25.52] — 2026-04-22

### Changed

- **Webhook fleet-health donut relocated to OverviewView.** The
  donut shipped in v0.1.25.51 was mounted on WebhooksView above the
  filter row, where it competed with the table for vertical space
  on the view operators use most. Moved to the Overview chart row
  (now 4-up on `lg`: budget utilization → **webhook fleet health**
  → events by category → top-10 by debt) where it lives alongside
  the other fleet-glance donuts. Same four slices, same drill-down
  contracts (`?status=ACTIVE`, `?failing=1`, `?status=PAUSED`,
  `?status=DISABLED`). Data source still the already-fetched
  webhook list on Overview — no new requests.
- **WebhooksView returns to its pre-v0.1.25.51 layout** — filter
  row directly below the error banner. Row-level health dot
  (green/amber/red) stays; that signal lives with the row it
  describes.

### Fixed

- **Overview donut legend no longer overlaps pie on the 4-up grid.**
  Going from 3-up to 4-up on `lg` shrank each card ~33% → ~25% of
  viewport width. At that width a 4-item legend wraps onto two
  lines and crashes into the pie. All four Overview donuts now use
  `legend.type: 'scroll'` with tighter item spacing, chart height
  bumped 180px → 200px for breathing room.
- **All four Overview donuts share identical pie geometry.** The
  shrink-radius fix above only caught one option because the others
  live at a deeper indent inside `series: [{...}]` arrays; the
  webhook donut ended up visibly smaller than its neighbors.
  Radius `['48%', '68%']` + center `['50%', '40%']` now applied
  uniformly.

## [0.1.25.51] — 2026-04-22

### Added

- **WebhooksView — fleet-health donut.** New card above the filter
  row, at parity with the three Overview donuts. Client-side reduce
  over the already-fetched `webhooks` list (60s poll, no new request).
  Four slices: **Healthy** (ACTIVE, no failures), **Failing**
  (`consecutive_failures ≥ 1` regardless of status — a PAUSED
  webhook with latent failures still needs attention), **Paused**
  (PAUSED, no failures), **Disabled** (terminal). Click-to-drill
  contracts:
  - Healthy → `/webhooks?status=ACTIVE`
  - Failing → `/webhooks?failing=1`
  - Paused → `/webhooks?status=PAUSED`
  - Disabled → `/webhooks?status=DISABLED`
- **WebhookDetailView — four-up per-subscription stat row.** Sits
  between the subscription card and the Delivery History table.
  All four derive from the already-loaded deliveries page (30s poll):
  - **Last successful delivery** — traffic-light chip mirroring
    PagerDuty/Grafana convention (green < 1h, amber 1h–24h, red
    ≥ 24h or no successful delivery yet).
  - **Delivery outcome donut** — SUCCESS / FAILED / RETRYING /
    PENDING over the loaded page. Clicking a slice sets the
    history-table status filter in place (no route push).
  - **Attempts per delivery histogram** — bucket counts for
    1 / 2 / 3 / 4 / 5+ attempts. A long tail in 4/5+ surfaces
    retry storms visibly before operators have to scan the table.
  - **Response time** — p50 / p95 / max over deliveries that
    carry `response_time_ms`. Text stats rather than a histogram
    because fighting over bucket widths on a variable-size cursor
    page gives p50/p95 better signal.

### Changed

- **BaseChart re-registers `BarChart` + `GridComponent`.** The
  attempts histogram needs them; tree-shaking still only bundles
  what's actively used (PieChart, BarChart, Tooltip, Legend, Grid).

## [0.1.25.50] — 2026-04-22

### Changed

- **Overview "Budget fleet utilization" — reshaped to a true-utilization
  donut (operator-reported regression).** Report: "169 budgets, several
  at 90%+ and one at 113%, all show as Healthy." Root cause: the
  previous stacked bar derived segments from `budget_counts.over_limit`
  + `budget_counts.with_debt`; per spec
  (`cycles-governance-admin-v0.1.25.yaml:1415–1417`) `is_over_limit =
  debt > overdraft_limit` is a purely financial overdraft signal, so a
  budget at 113% spent/allocated whose `overdraft_limit` absorbs the
  overage has `debt = 0` and counted as Healthy. The chart now buckets
  by actual `spent / allocated` across the `utilization_min=0.9` fetch
  that already powers the at-cap attention card:
  - Healthy (< 90%) — success
  - Near cap (90–99%) — warning
  - Over cap (≥ 100%) — danger

  Donut shape matches the two neighboring charts for visual consistency
  (three donuts rather than two donuts + a bar).
- **Utilization drill-down uses `utilization_min` / `utilization_max`
  instead of the debt-based `filter=over_limit|has_debt`.** Click
  contracts: Healthy → `/budgets` (unfiltered); Near cap →
  `/budgets?utilization_min=90&utilization_max=100`; Over cap →
  `/budgets?utilization_min=100`. `BudgetsView` now hydrates both
  params from the URL on mount — previously they were wired to the
  inline form but not to deep links, silently rendering an unfiltered
  list.
- **`/overview` attention-card fetch `utilization_min=0.9` limit bumped
  10 → 500.** The at-cap card still slices to 5 for display, but the
  new fleet-utilization donut needs a representative sample of the
  at-cap + near-cap set to produce honest bucket counts.

### Removed

- **`BarChart` + `GridComponent` ECharts registrations.** The
  utilization stacked bar was the only consumer. Only `PieChart` +
  `TooltipComponent` + `LegendComponent` remain bundled, shrinking the
  chart chunk.

### Fixed

- Overview at-cap card "View all" link — `utilization_min=0.9` →
  `utilization_min=90` to match the new percent URL convention the
  BudgetsView filter inputs already expose.

## [0.1.25.49] — 2026-04-22

### Fixed

- **Events-by-category donut color collisions.** Operator report:
  "tenant, api_key both grey, budget orange — why is the color the
  same for 2 categories?" The previous 5-tone semantic palette
  (success / warning / danger / info / neutral) forced three
  categories onto `neutral` grey. Added a 10-hue qualitative palette
  to `useChartTheme` and assigned each known category to a distinct
  slot (tenant = purple, api_key = teal, audit = pink, webhook = blue,
  etc.). `policy` keeps red and `reservation` keeps green for their
  semantic associations. Unknown categories use a deterministic
  hash → slot so two unknowns never collide either.

### Added

- **Chart drill-down.** Every slice/segment on the Overview charts is
  now clickable and navigates to the corresponding list view with the
  filter pre-applied:
  - Budget status donut → `BudgetsView?status=<ACTIVE|FROZEN|CLOSED>`
    (Over-limit → `?filter=over_limit`).
  - Budget utilization bar → `BudgetsView?filter=over_limit|has_debt`
    or unfiltered for the Healthy segment.
  - Events by category donut → `EventsView?category=<name>`.
- **BaseChart — `slice-click` emit.** Shared wrapper forwards the
  ECharts click payload (`seriesName`, `name`, `dataIndex`, `value`,
  `componentType`) so each caller can map a click to a route
  independently. Cursor switches to `pointer` on hover so the
  interaction is discoverable.

### Notes

- Each chart title carries a muted "· click a slice/segment" hint so
  operators know the charts are actionable.
- No new API surface — all drill-downs reuse existing list-view URL
  query contracts (`status`, `filter`, `category`).

## [0.1.25.48] — 2026-04-22

### Added

- **Overview — two more ancillary charts.** Expanding the trial slice
  from one chart to three, laid out as a 3-up grid beneath the counter
  strip:
  - **Budget fleet utilization** — horizontal stacked bar partitioning
    `budget_counts.total` into Healthy / With-debt / Over-limit. Answers
    "how much of the fleet is in trouble" separately from the by-status
    mix in the donut beside it.
  - **Events by category** — donut over `event_counts.by_category` with
    tone-mapped colors per category (policy = danger, reservation =
    success, webhook = info, etc.). Tells ops what class of activity
    the runtime is emitting in the recent window.
- **BaseChart — BarChart + GridComponent registered.** Tree-shaken
  additions so the new horizontal bar renders without pulling the full
  ECharts surface. No other views affected.

### Notes

- Each chart reads the same `/v1/admin/overview` payload already in
  flight on the landing page — no new fetches.
- Chart chunk grows from ~142 KB → ~165 KB gzip (BarChart +
  GridComponent). OverviewView initial chunk 6.40 → 7.11 KB gzip.

## [0.1.25.47] — 2026-04-22

### Added

- **Charting layer — trial slice.** Introduces `echarts` + `vue-echarts`
  as the dashboard's visualization library (tree-shaken, lazy-loaded).
  Adds a shared `BaseChart` wrapper (`src/components/BaseChart.vue`)
  that any view can reuse, backed by a `useChartTheme` composable
  (`src/composables/useChartTheme.ts`) that maps Tailwind status tokens
  (success / warning / danger / info / neutral) to ECharts colors and
  reactively switches palette on dark-mode toggle.
- **Overview — budget status distribution donut.** The first chart: a
  compact donut under the at-a-glance counter strip showing the share
  of budgets in each lifecycle bucket (Active / Frozen / Over-limit /
  Closed). Consumes the same `/v1/admin/overview` payload already in
  flight — no new API request. Hides automatically when every slice
  is zero (empty fleet) so an empty chart never surfaces.

### Fixed

- **BaseChart empty render.** The initial trial-slice shipped with the
  inner `<v-chart>` inheriting a redundant inline style from the outer
  wrapper. ECharts' autoresize measured zero height and the chart card
  rendered its header only. Fixed by giving the `<v-chart>` explicit
  `height: 100%; width: 100%` so it fills the sized outer container.
- **Alpine 3.23.4 HIGH/CRITICAL CVEs.** The `nginx:1.29-alpine` base
  image accumulated fixable HIGH/CRITICAL vulnerabilities overnight
  that the Trivy gate refused. Added `apk upgrade --no-cache` in the
  serve stage so each container build pulls the latest alpine patches
  regardless of when upstream refloats the nginx tag.

### Notes

- ECharts is lazy-loaded in a separate chunk (~142 KB gzip) so the
  Overview initial chunk stays at its prior ~6.4 KB gzip footprint.
  The chart bundle downloads only when a chart renders.
- No spec change. No admin change. First of a six-PR visualizations
  roadmap (see `AUDIT.md` for the full slice plan).

## [0.1.25.46] — 2026-04-21

### Changed

- **Terminal-state rows (CLOSED / DISABLED / REVOKED / EXPIRED) are
  hidden by default on every list view.** Previously a freshly-closed
  tenant or freshly-disabled webhook sorted to the top of the list
  (default `created_at desc` ordering) and visually competed with rows
  that actually needed operator attention. Operators had to apply a
  status filter to cull them — non-obvious, and the default experience
  showed terminal noise first. Matching the Gmail / GitHub / Linear
  convention, each list view now hides terminals by default and
  surfaces a **"Show &lt;verb&gt;"** toggle (with the hidden count, e.g.
  `Show closed (3)`) in the filter row to opt in.
- **Toggle state mirrors to the URL** via `?include_terminal=1` on the
  four top-level views (Tenants, Budgets, Webhooks, API Keys) so the
  operator's view preference rides browser-history and deep-links.
- **Explicit terminal-status filter auto-reveals terminal rows.**
  Picking `status=CLOSED` (Tenants / Budgets), `status=DISABLED`
  (Webhooks), or `status=REVOKED` (API Keys) from the dropdown shows
  those rows even with the toggle off — avoids the trap of filtering
  to a status and getting an empty list. Matches GitHub's
  `state:closed` behavior.
- When the toggle is on, terminal rows sink to the bottom of the list
  (stable partition that preserves column-sort order within each
  group) rather than interleaving with active rows by `created_at`.
- TenantDetail sub-lists (owned Budgets + API Keys) get the same
  hide-by-default + toggle treatment, scoped per tab (no URL mirror —
  single-URL view).

## [0.1.25.45] — 2026-04-21

### Fixed

- **Overview attention cards no longer surface children of CLOSED
  tenants.** Under spec v0.1.25.31 Rule 1 Mode B, a closed tenant's
  owned budgets, webhooks, and API keys can transiently remain
  non-terminal while the admin-side cascade converges. Those rows were
  leaking onto five attention cards — Budgets at or near cap, Budgets
  with debt, Frozen budgets, Expiring API keys, Failing webhooks —
  creating false "needs attention" work for an operator who has
  already closed the tenant.
- **Tenants filter state survives drill-in → back.** Setting a filter
  on `/tenants` (status or parent), clicking into a tenant's detail
  page, and hitting the back crumb used to reset the filter.
  `TenantsView` now mirrors filter-ref changes into the URL via
  `router.replace`, and `TenantDetailView`'s back crumb uses
  `router.back()` (with a plain `/tenants` fallback when there's no
  prior history), so the filter state rides the browser history back
  to the list. Matches the Budgets-view flow operators expected.
- **Cascade-recovery banner no longer flashes for a clean close.**
  After closing an ACTIVE tenant whose cascade converged cleanly
  server-side, the recovery banner would still render until the next
  30s poll tick — operator had to refresh the page to dismiss it.
  `executeTenantAction` now refetches budgets + webhooks + API keys
  alongside the tenant on CLOSE (same pattern as `rerunCascade`), so
  the banner-visibility computation sees post-cascade state
  immediately. Suspend / reactivate actions still do a tenant-only
  refetch — cascade doesn't run on those.

### Changed

- Overview now fetches `listTenants({status:"CLOSED"})` alongside the
  existing fanout and builds a closed-tenant id set. Every card with
  per-row data filters client-side against that set.
- Budgets-with-debt rows now come from `listBudgets({has_debt:"true"})`
  instead of `overview.debt_scopes` (which lacks `tenant_id`). Failing
  webhooks rows now come from `listWebhooks` + client-side
  `consecutive_failures>0` filter instead of `overview.failing_webhooks`
  (same reason). Card visuals and sort order unchanged.
- Axis pill counts + card badges reflect the filtered list length so
  the banner, tile, and rows stay consistent with what the operator
  sees.

### Notes

- Pure dashboard fix — no spec change, no admin version bump. Admin
  pin stays at `0.1.25.37`.
- Tenants tile, Budgets tile chips, and Webhooks tile chips continue
  to show server aggregates (closed-tenant children included) because
  those tiles are navigational counters, not actionable work surfaces —
  clicking a tile lands on a filterable list where the operator can
  drill in.
- See `AUDIT.md` for the audit of all six attention cards and why
  Recent Denials / Recent Operator Activity don't need the same
  filter.

## [0.1.25.44] — 2026-04-20

### Added

- **Cascade-recovery banner on `TenantDetailView`.** When a closed
  tenant still has non-terminal budgets, webhooks, or API keys, an
  amber banner renders at the top of the page with per-axis pending
  counts and a "Re-run cascade" button. Clicking opens a confirm
  dialog that enumerates exactly what the action will change.
- **Re-run cascade action.** Idempotently re-runs the tenant-close
  cascade. On success, the banner disappears; on failure, the server
  error surfaces inside the dialog and the button stays clickable for
  retry.

### Changed

- `TenantDetailView` now fetches webhooks alongside budgets and API
  keys on initial mount; webhook refetch on poll only happens while
  the tenant is CLOSED, so active-tenant poll cost is unchanged.

### Notes

- Admin image pin bumped `0.1.25.36` → `0.1.25.37`. Admin `.37`
  wires Rule 1(c) bounded-convergence into the close paths — a
  `PATCH {"status":"CLOSED"}` against an already-CLOSED tenant now
  re-runs the cascade idempotently over any non-terminal children.
  Pre-`.37` admin silently no-op'd the re-close, so the Re-run
  cascade button would return 200 without driving convergence. `.37`
  is therefore the minimum admin version for this feature to be
  functional, not just a cosmetic pin bump.
- No spec change.
- See `AUDIT.md` for the engineering rationale, edge cases, and the
  two operator scenarios this unblocks.

## [0.1.25.43] — 2026-04-20

### Added

- **Closed-tenant tombstone + cascade preview** — consumes governance
  spec v0.1.25.31 CASCADE SEMANTICS (Rule 1: tenant-close cascades
  owned objects into terminal states — Mode A atomic or Mode B
  flip-first-with-guarded-cascade, per spec v0.1.25.31; Rule 2:
  mutations on a closed tenant's children return 409 `TENANT_CLOSED`
  regardless of cascade mode). Requires admin image `0.1.25.36` —
  compose pins bumped in lockstep. The v0.1.25.30 spec widened Rule 2
  declarations to all mutating ops; admin v0.1.25.36 completed Rule 2
  wire-up on policies, api-keys, webhook-admin create/update/delete/
  test/replay, and per-row in bulk-action.
  - **TenantDetailView banner.** When `tenant.status === 'CLOSED'`,
    an amber read-only banner renders at the top: "Tenant closed —
    all owned objects are read-only." Makes the terminal state
    immediately obvious so operators stop asking "why won't this
    unfreeze?" on closed-tenant pages.
  - **CLOSE confirm-dialog cascade preview.** Dialog now enumerates
    what the cascade will terminate: owned budgets, webhook
    subscriptions, API keys, open reservations. Counts render from
    the tenant-detail state (already loaded). Spells out
    "This cannot be undone."
  - **`TENANT_CLOSED` 409 humanizer.** Any mutation that races the
    cascade (stale tab, deep-link, in-flight request) now surfaces
    "Tenant is closed — this object is read-only." instead of a raw
    409. Added to `src/utils/errorCodeMessages.ts` alongside the
    existing error-code map.
  - **Audit + event-timeline humanization.** `AuditView` operation
    column and `EventTimeline` rows render a small amber "tenant
    cascade" chip when the event carries `_VIA_TENANT_CASCADE` (event
    kinds `budget.closed_via_tenant_cascade`,
    `webhook.disabled_via_tenant_cascade`,
    `api_key.revoked_via_tenant_cascade`,
    `reservation.released_via_tenant_cascade`, or audit operation
    `tenant_close_cascade`). Operators can visually distinguish
    cascade-triggered state changes from user-driven ones when
    correlating by `correlation_id`.
- **Shared `isTerminalTenant()` predicate** (`src/utils/tenantStatus.ts`).
  Centralizes the "this tenant is in a sink state" check so views
  can't drift on which statuses count as terminal.

### Changed

- **Admin image pin `0.1.25.32 → 0.1.25.36`** in
  `docker-compose.prod.yml`, `docker-compose.yml`, and `README.md`.
  Operators pinning the previous dashboard bundle must re-pin to
  pick up the cascade semantics; running this dashboard against
  admin `.32` still works (tombstone + dialog preview render purely
  client-side) but the cascade itself won't fire and frozen budgets
  on closed tenants continue to inflate the Overview alert counter.
  Running against `.35` works but leaves policy / api-key /
  webhook-admin mutations un-guarded against the Rule 2 MUST —
  `.36` completes the guard coverage.
- **Spec pointer `v0.1.25.29 → v0.1.25.31`.** Spec v0.1.25.30 widened
  the `409 TENANT_CLOSED` declaration to the remaining mutating ops;
  v0.1.25.31 relaxed Rule 1 to permit Mode B cascade implementations.
  Dashboard wire surface is unchanged — both spec revisions are
  additive-documentation. Reference admin `.36` is retroactively
  conformant to Mode B.

No protocol, events-server, or runtime-server change.

## [0.1.25.42] — 2026-04-19

### Security

- **Base-image bump unblocks release pipeline.** Trivy (gate on
  `HIGH,CRITICAL` with `ignore-unfixed: true`) flagged 57 unique
  fixed-upstream CVEs against the Alpine 3.21.3 layer of
  `nginx:1.27-alpine` — blocking the push step on both v0.1.25.40
  and v0.1.25.41 (tags exist upstream; docker images were **never
  published** for those two versions). Top 3 critical: CVE-2025-15467
  (openssl RCE, CVSS 9.5), CVE-2025-49794 / CVE-2025-49796 (libxml2
  UAF / type-confusion DoS, CVSS 9.5). Remaining 54 spanned
  libpng / musl / zlib / libexpat / curl / busybox / c-ares.
- **Fix:** bump serve stage `nginx:1.27-alpine` → `nginx:1.29-alpine`
  (Alpine 3.23.4, 0 HIGH/CRITICAL via Trivy local scan) and build
  stage `node:20.19-alpine` → `node:20.20-alpine`. Operators pinning
  `0.1.25.40` or `0.1.25.41` must re-pin to `0.1.25.42` — the
  earlier tags resolve to absent image manifests.

No source / behavior change beyond the base-image bump. All dashboard
features ship unchanged from v0.1.25.41 (vue-router 5, shared icon
library, Copy JSON two-track relocation).

## [0.1.25.41] — 2026-04-19

### Updated

- **Dependency bumps** (Dependabot #106–#110):
  - `vue-router` **4.6.4 → 5.0.4** (major). No behavior change in this
    dashboard: the app uses only stable APIs (`createRouter`,
    `createWebHistory` / `createMemoryHistory`, `useRoute`,
    `useRouter`, `RouterLink`, `RouteLocationRaw`). The v5 breaking
    changes are in experimental data-loaders and auto-routes / file-
    based routing — neither in use here. Tested locally and in CI:
    typecheck clean, 742 tests green, build clean.
  - `@tanstack/vue-virtual` 3.13.23 → 3.13.24 (patch).
  - `vite` 8.0.7 → 8.0.8 (dev, patch).
  - `@vitejs/plugin-vue` 6.0.5 → 6.0.6 (dev, patch).
  - `github/codeql-action` 3 → 4 (GitHub Actions major; GitHub ships
    v3 and v4 in parallel with equivalent features — the bump is a
    track move, not a behavior change).

No protocol, admin, server, or events-server change. Pure dependency
refresh; ecosystem baseline (cycles-server-admin `.32`, cycles-server
`.15`, cycles-server-events `.8`) unchanged from v0.1.25.39.

## [0.1.25.40] — 2026-04-19

### Changed

- **Copy JSON no longer claims a dedicated row or column.** Pre-fix,
  Copy JSON consumed a full-width ~50px footer row inside every
  expanded event / audit / timeline panel and a trailing ~88px column
  on every always-visible delivery row in WebhookDetailView —
  substantial chrome for a secondary action.
  - **WebhookDetailView delivery rows** now use a row kebab (⋮)
    with three items: **Copy as JSON**, **Copy delivery ID**, **Copy
    event ID**. Trailing column shrinks from 88px to 40px. Toast
    confirms each copy (menu closes on click).
  - **EventsView**, **AuditView**, and **EventTimeline** expanded
    panels now anchor a compact clipboard icon at the top-right of
    the panel body (no new collapsed-row affordance, no footer row).
    Payload and 2-second check-mark confirmation unchanged. Same
    `aria-label="Copy full JSON for …"` selectors — screen-reader
    behavior preserved.
  - **Icon redesign.** The panel-header icon is now a combined
    copy-plus-JSON glyph (two overlapping document rectangles with
    `{ }` braces inside the front sheet) instead of a generic
    single-document clipboard. Signals "copy JSON" without relying
    on tooltip hover.
- **Copy as JSON is now available in every kebab-bearing list view.**
  Common operator workflow is "paste this object definition to a
  developer"; the kebab is the right home for it. Added to
  TenantsView, TenantDetailView (API keys, policies), WebhooksView,
  BudgetsView, ReservationsView, ApiKeysView, and WebhookDetailView's
  subscription-header kebab. Payload is the full row object serialized
  via `safeJsonStringify` (cycles- and BigInt-safe); toast confirms.
  Shared helper at `src/utils/clipboard.ts` DRYs the pattern.

### Reclaimed footprint

| Surface | Before | After |
|---|---|---|
| WebhookDetailView delivery row | 88px trailing column × every row | 40px kebab column × every row |
| EventsView expanded panel | ~50px dedicated footer row | 0 (icon overlays panel corner) |
| AuditView expanded panel | ~50px dedicated footer row | 0 |
| EventTimeline expanded item | ~35px dedicated footer row | 0 |

No protocol, admin, server, or events-server version change. Pure
dashboard UI slice.

### Removed

- **"Updated just now" indicator removed from the page header.** Every
  view polls every 15–60s, and `formatRelative` returns `"just now"`
  for anything under 60s — so the label effectively never changed and
  provided no signal. The adjacent `RefreshButton` already conveys
  freshness interactively (spinner while polling, click to force a
  tick). Removed the `lastUpdated` prop from `PageHeader` and the
  return value from `usePolling`. No test regressions.

### Refactored

- **Shared icon library at `src/components/icons/`.** 24 reusable SVG
  components — every inline glyph in the app now comes from one source
  of truth (the only exception is the data-driven Sidebar nav-icon
  whose `d` path is item-table-driven). Round 1 extracted 9 icons:
  `CopyJsonIcon`, `DownloadIcon`, `CloseIcon`, `ChevronRightIcon`,
  `BackArrowIcon`, `SearchIcon`, `CheckIcon`, `Spinner`, `WarningIcon`.
  Round 2 (full-pass polish) added 15 more: `HamburgerIcon`,
  `LogoutIcon`, `SunIcon`, `MoonIcon`, `RefreshIcon`, `SortAscIcon`,
  `SortUnsortedIcon`, `ChevronDownIcon`, `KebabIcon`, `CopyIcon`,
  `EyeIcon`, `EyeOffIcon`, `InfoCircleIcon`, `EmptyTrayIcon`,
  `CheckCircleIcon`. Side-effects of the consolidation: the three
  duplicate Copy glyphs (CorrelationIdChip, MaskedValue, inline copy
  buttons) collapse to one canonical `CopyIcon`; BulkActionResultDialog's
  hand-rolled alert triangle and info circle now reuse `WarningIcon` +
  `InfoCircleIcon`; ApiKeysView's ambiguous "view perms" arrow swaps
  to `ChevronRightIcon`. Behavior unchanged; 742 tests green.
- **Icon design-quality pass.** Stroke-width unified to `1.5` across
  every outline icon (was mixed `1.5` / `2`) — matches modern
  Heroicons v2 defaults, lighter and more balanced at 16–24px sizes.
  Four icon paths upgraded to Heroicons v2 geometry: `RefreshIcon`
  (arrow-path), `EyeIcon` / `EyeOffIcon` (refined curves + slash),
  `CopyIcon` (document-duplicate). `Spinner` (`3`), `EmptyTrayIcon`
  (`1`), and the signature `CopyJsonIcon` keep their intentional
  weights. Three dead assets deleted: `public/icons.svg` (social-icon
  sprite, never imported), `src/assets/hero.png`, `src/assets/vite.svg`
  (Vite scaffold leftovers). No behavior change; 742 tests green.

## [0.1.25.39] — 2026-04-18

### Fixed

- **Webhook delivery history rendered "HTTP -" on every row and hid
  the failure reason.** The `WebhookDelivery` TypeScript interface
  used `http_status` and `delivered_at`, but the governance spec
  (and the server) emit `response_status` and `completed_at` — so
  the HTTP Code column was always empty and the `error_message`
  field (e.g. `"Subscription not active: DISABLED"` once a webhook
  auto-disables after 10 consecutive failures) was never rendered
  at all. Fixed by renaming the type fields to match the spec,
  adding `error_message` / `response_time_ms` / `next_retry_at`,
  and adding an **Error** column to the delivery-history grid with
  tooltip + red-tint for `FAILED` rows.
- **Delivery status filter matched zero `SUCCESS` rows.** The
  dropdown offered `DELIVERED` but the server's enum is
  `PENDING | SUCCESS | FAILED | RETRYING`. Replaced the option.
- **StatusBadge lacked delivery-status colors.** `SUCCESS` /
  `FAILED` / `PENDING` / `RETRYING` all rendered gray. Mapped to
  green / red / yellow / yellow to match the rest of the badge
  vocabulary.
- CSV export now includes `response_status`, `response_time_ms`,
  `error_message`, `completed_at`, `next_retry_at`, and
  `trace_id` — previously it shipped only the empty `http_status`.

### Added

- **Cross-surface trace / request correlation.** cycles-server-admin
  **v0.1.25.31** (protocol **v0.1.25.28**) auto-populates W3C Trace
  Context `trace_id` (32-hex) on every HTTP-originated `Event` and
  `AuditLogEntry`, and captures `trace_id` + `trace_flags` +
  `traceparent_inbound_valid` on every `WebhookDelivery`. The dashboard
  surfaces and filters on the new fields:

  - **Shared chip** (`CorrelationIdChip`) renders `trace_id` /
    `request_id` / `correlation_id` with consistent truncation
    (`first8…last4`, full value in tooltip), copy-to-clipboard, and
    one-click pivot into the filtered target view.
  - **EventsView + AuditView**: new `Trace ID` and `Request ID` filter
    inputs, wired to the matching server query params with deep-link
    query-param ingest (`?trace_id=…`, `?request_id=…`) and CSV export
    column echo.
  - **Pivots**: click `trace_id` on an AuditView row → EventsView
    filtered to the same trace (audit → all events in that request).
    Click `trace_id` on an EventsView row → AuditView filtered to the
    originating entry. `request_id` refilters in place on the current
    view (primary diagnostic lookup, typically 0–1 row).
  - **EventTimeline** (BudgetsView embed) renders the full correlation
    triplet using the shared chip.

### Required

- **cycles-server-admin v0.1.25.31+** for the new `trace_id` /
  `request_id` server-side filters. Against a pre-`.31` admin the
  params are silently ignored (additive-parameter guarantee), so older
  stacks keep working — the chips render nothing when the field is
  absent on the row, and the filter inputs behave like unfiltered
  queries.

### Baseline bumps (compose + README)

- `cycles-server-admin` → **v0.1.25.32** (cross-plane read tolerance
  hardening — no wire change).
- `cycles-server` → **v0.1.25.15** (rolls up `.14` runtime-plane W3C
  Trace Context + `.15` audit-log retention TTL; both additive).
- `cycles-server-events` pinned to **v0.1.25.8** (was `:latest`);
  matches protocol v0.1.25.28 WebhookDelivery trace fields.

## [0.1.25.38] — 2026-04-18

### Added

- **Structured bulk-action audit detail** (`AuditView` expanded row).
  cycles-governance-admin **v0.1.25.30** enriches `AuditLogEntry.metadata`
  for the three bulk-action ops (`bulkActionTenants`, `bulkActionWebhooks`,
  `bulkActionBudgets`) with `succeeded_ids`, `failed_rows`, `skipped_rows`,
  `filter` (filter echo), and `duration_ms`. The dashboard now maps those
  keys to a scannable summary instead of a raw JSON `<pre>`:

  - Header strip: action verb + noun + formatted duration + three-count
    summary (succeeded / failed / skipped).
  - Filter echo: 2-column key/value grid. `tenant_id` / `parent_tenant_id`
    drill through via `TenantLink`.
  - Succeeded: collapsed, with `Copy all` for the id list.
  - Failed: open by default; each row shows `error_code` chip + humanized
    prose via `formatErrorCode()`.
  - Skipped: collapsed; each row shows `reason`.

  The raw JSON remains available as a "Raw metadata" `<details>` collapse
  so power-users can still inspect the wire payload. Non-bulk rows and
  pre-v0.1.25.30 bulk rows (no enriched keys in `metadata`) continue to
  render the existing inline `<pre>` block — no regression for older admin
  deployments.

### Version bumps

- `package.json` `0.1.25.37 → 0.1.25.38`
- Compose pins unchanged (admin `.30`, server `.13`).

### Unchanged

- Spec badge remains **v0.1.25.26**. `cycles-governance-admin-v0.1.25.yaml`
  `info.version` has not bumped — v0.1.25.27 through v0.1.25.30 are all
  additive changes that don't require an OpenAPI version bump.

## [0.1.25.37] — 2026-04-18

### Added

- **Per-row "Copy JSON" triage affordance** on every surface rendering event /
  audit / delivery rows. Closes the operator-reported gap where bulk Export
  ships hundreds of rows when one is wanted. Four surfaces:

  | Surface | Placement | Payload |
  |---|---|---|
  | EventsView | Expanded-panel header | Full `Event` object |
  | AuditView | Expanded-panel header | Full `AuditLogEntry` including `metadata` |
  | EventTimeline (BudgetDetail) | Expanded-row panel | Full `Event` object |
  | WebhookDeliveries | Inline trailing column | Full `WebhookDelivery` |

  Each uses `navigator.clipboard.writeText` with a 2s "Copied!" label flip;
  clipboard-permission errors are silently swallowed (the operator can still
  select-and-copy from the existing `<pre>` block).

- **Row-select bulk failures now open `BulkActionResultDialog`** (extension).
  TenantsView (Suspend/Reactivate), WebhooksView (Pause/Resume), BudgetsView
  (Freeze/Unfreeze), and TenantDetailView Emergency Freeze previously dropped
  per-row failures to `console.warn`. Filter-apply siblings in the same views
  already used the dialog; this closes the parity gap. New helper
  `synthesizeRowSelectBulkResult` converts `rateLimitedBatch`'s cancellation-
  aware `{done, failed, cancelled, errors}` shape into the dialog's
  `{succeeded, failed, skipped, total_matched}` shape.

- **Cross-view pivot on EventTimeline `correlation_id`** (extension). Clicking
  a correlation_id in a BudgetDetail event jumps to EventsView filtered to the
  whole correlation chain. `request_id` intentionally not wrapped — server
  filter DSLs (`listEvents`, `listAuditLogs`) don't accept it.

### Changed

- EventsView `Copy` button (data-only, inside the Data sub-box) → `Copy JSON`
  in the expanded-panel header. Widens scope from `event.data` to the full
  Event object. Label change is the signal to operators that scope widened.

### Version bumps

- `package.json` `0.1.25.36 → 0.1.25.37`
- `docker-compose.prod.yml` dashboard `.36 → .37`, cycles-admin `.29 → .30`
- `docker-compose.yml` cycles-admin `.29 → .30`
- README compose-example dashboard `.36 → .37`, cycles-admin `.28 → .30`
  (swept stale drift that had never been bumped across v0.1.25.33–.36)

### Unchanged

- Spec alignment. Still `v0.1.25.26`. No API surface exercised.
- Auth model, capability gating, CORS setup.

## [0.1.25.36] — 2026-04-18

### Added

- **BudgetsView row-select + bulk Freeze / Unfreeze.** Closes the pattern-gap
  where v0.1.25.35 shipped the filter-apply bulk path (five balance mutations)
  but left BudgetsView without the row-select checkbox + bulk toolbar that
  TenantsView + WebhooksView already exposed. Row checkboxes, select-all
  header, floating bulk toolbar, and ConfirmAction-gated bulk Freeze/Unfreeze
  mirror TenantsView's existing pattern.

### Notes

- Freeze/Unfreeze are deliberately **not** in the server-side
  `BUDGET_BULK_ACTIONS` enum per spec v0.1.25.26 — they are status transitions,
  not balance mutations. The dashboard fans them out client-side via
  `rateLimitedBatch` over the per-row `freezeBudget` / `unfreezeBudget`
  endpoints (stable since admin v0.1.25.19).

### Unchanged

- Compose pins, spec alignment (`v0.1.25.26`).

## [0.1.25.35] — 2026-04-18

### Added

- **Budget bulk-action UI.** Dashboard counterpart to the admin-server
  v0.1.25.26 / v0.1.25.29 `POST /v1/admin/budgets/bulk-action` endpoint. Five
  filter-apply actions (`CREDIT`, `DEBIT`, `RESET`, `RESET_SPENT`,
  `REPAY_DEBT`). `BudgetBulkFilter.tenant_id` is REQUIRED per spec — bulk
  toolbar button is disabled when no tenant is selected (tooltip explains).
  Cross-tenant list views (`over_limit`, `has_debt`) remain intact for
  incident scanning.

### Required

- **cycles-admin v0.1.25.29+**. Pre-.29 servers 404 the POST.

### Version bumps

- Compose admin `.28 → .29`. Spec alignment `v0.1.25.25 → v0.1.25.26`.

## [0.1.25.34] — 2026-04-18

### Added

- **`BulkActionResultDialog` component** — per-row outcome triage for bulk
  actions. Opens on any response with non-empty `failed[]` or `skipped[]`.
  Renders succeeded count, failed rows with error-code prose + Copy-ID, and
  skipped rows with reason.
- **`errorCodeMessages.ts` utility** — single source of truth for operator-
  facing prose on per-row error codes (`BUDGET_EXCEEDED`,
  `INVALID_TRANSITION`, `INTERNAL_ERROR`) and request-level gates
  (`LIMIT_EXCEEDED`, `COUNT_MISMATCH`). Forward-compat fallback renders
  unknown codes as `code: message` so new server codes surface without a
  dashboard bump.

### Changed

- TenantsView and WebhooksView filter-apply bulk paths now open the new dialog
  instead of logging failures to `console.warn`. Toast string
  `"check console for details"` → `"see details"`.

## [0.1.25.33] — 2026-04-18

### Added

- **AuditView filter DSL completeness** against cycles-governance-admin
  v0.1.25.24 (admin `.27+`):
  - `error_code_exclude` NOT-IN-list input, shares datalist with `error_code`.
  - `operation` flipped from scalar → comma-separated IN-list (explode=false,
    maxItems 25). Single-token input stays byte-compatible with pre-.24.
  - `resource_type` flipped from `<select>` → `<input list>` with datalist
    typeahead (non-whitelist — new resource types render without a dashboard
    bump).
  - `applyQueryParams` accepts `?error_code_exclude=` for deep-links.

## Older releases

Releases before v0.1.25.33 are recorded in [`AUDIT.md`](AUDIT.md). They have
not been backfilled here — the AUDIT entries contain the release notes and
engineering narrative interleaved, and splitting them retroactively would risk
introducing inaccuracies. New releases from v0.1.25.33 forward use this file
for release notes and AUDIT.md for the engineering narrative only.

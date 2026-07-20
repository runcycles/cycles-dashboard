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

## [0.1.25.79] — 2026-07-19

### Changed

- Webhook Detail subscription and delivery acquisition now run through the
  focused `useWebhookDetailData` composable. Mutation forms, charts, route
  intent, dialogs, and virtualized presentation remain in the view.
- Routine polling preserves terminal delivery pages loaded by the operator. A
  fresh page-one head is merged by delivery ID; a burst with no safe overlap or
  a mutable nonterminal row in the retained tail resets to the fresh head so
  historical delivery status cannot remain stale indefinitely.

### Fixed

- Webhook and delivery requests now receive real abort signals. Publication
  generations prevent cancelled or superseded reads from replacing newer
  subscription or filter state.
- Delivery page one, Load more, and export reuse one immutable applied status
  filter. Mid-request filter changes can no longer pair a new filter with an
  old cursor, and a filter refresh requested during a poll is replayed after
  the in-flight request settles.
- A later 404 invalidates in-flight delivery reads and clears stale detail
  content, so a late response cannot replace the not-found state. Every
  malformed page that reports more rows without a continuation cursor now
  blocks Load more and export with an actionable error instead of producing an
  incomplete file.
- The delivery toolbar reports its updating state, and export remains disabled
  until visible rows belong to the applied filter. Delivery-only filter work no
  longer advances the PageHeader timestamp reserved for a full refresh.

No endpoint, successful request shape, capability gate, server/spec minimum,
or dialog/table layout changes. Validation: 1,417 tests, 97.58% line coverage,
lint, strict typecheck, production build, and both Compose configurations pass.

## [0.1.25.78] — 2026-07-19

### Changed

- Tenant Detail's suspend/reactivate/close, cascade recovery, and Emergency
  Freeze protocols now run through the focused `useTenantLifecycle`
  composable. The view retains acquisition, tabs, forms, routing, tables, and
  dialog presentation, dropping from 1,490 to 1,276 lines.
- Emergency Freeze keeps polling excluded through its post-write refresh while
  still closing the progress dialog as soon as the cancellable batch settles.

### Fixed

- Suspend and reactivate now share permanent close's pre-mutation loading
  guard. Re-entrant confirmation can no longer send duplicate status PATCHes,
  and routine polling cannot publish through those mutation-owned refreshes.
- Direct permanent-close execution enforces the typed tenant name in the
  lifecycle owner, not only through the template's disabled button.
- Only one tenant lifecycle dialog can be armed at a time. Direct status
  requests reject transitions that are not legal from the current tenant
  state, and cascade recovery rejects a tenant that is not already CLOSED.
- Tenant status and Emergency Freeze triggers visibly disable while an
  Emergency Freeze scan or post-write refresh owns the lifecycle. Guarded
  clicks no longer appear to be accepted and then silently do nothing.

No endpoint, successful request shape, capability gate, server/spec minimum,
or dialog/table layout changes. Validation: 1,398 tests, 97.69% line coverage,
lint, strict typecheck, production build, and both Compose configurations pass.

## [0.1.25.77] — 2026-07-19

### Changed

- Tenant and webhook filter-wide suspend/pause protocols now run through
  focused `useTenantFilterBulk` and `useWebhookFilterBulk` composables. The
  views retain filters, row selection, polling, dialogs, and presentation.
- `TenantsView` drops from 1,174 to 1,048 lines and `WebhooksView` from 1,155 to
  1,053 lines without changing the existing preview or result-dialog layout.
- Build, test, lint, and CI dependencies are current through the pre-release
  Dependabot rollup, including ESLint 10 with its matching `@eslint/js` preset
  and SHA-pinned setup-node v7, CodeQL, and shared TypeScript CI workflows.

### Fixed

- Bulk Preview now captures one immutable action/filter snapshot and reuses it
  for every cursor page, the visible summary, `expected_count`, and the final
  request. Mid-preview filter or route changes can no longer mutate a tenant or
  webhook set different from the one the operator reviewed.
- Webhook filter-bulk controls refuse the derived **failing only** filter,
  matching the existing system-wide and wildcard guards. The server bulk
  schema cannot represent that predicate, so enabling it previously applied a
  broader set than the visible table implied. Each unsupported state now has a
  visible, predicate-specific explanation instead of relying on a disabled
  control's tooltip.
- Tenant and webhook status filters are now captured with the destructive
  selection. An action whose required source status falls outside the visible
  filter is disabled, so a status-only view cannot arm a global mutation
  against rows the operator is not looking at.
- Root-level tenant and unsupported webhook filters now expose visible,
  screen-reader-linked explanations instead of relying on disabled-button
  tooltips.
- A list response that reports `has_more=true` without a continuation cursor is
  now a blocking protocol error instead of a confirmable partial preview. The
  dashboard retains lower-bound confirmation only for the intentional 20-page
  safety cap; malformed pagination cannot be submitted.
- A bounded Preview that finds zero matches before exhausting the list no
  longer claims the complete filter is empty. It discloses that only the
  scanned pages are known, keeps confirmation disabled, and asks the operator
  to narrow the filter for an exact result.
- Tenant and webhook Preview now forward every natively representable mutation
  predicate to their list endpoints (`status`, parent/tenant ownership, and
  literal search) with the server's 100-row page limit. The client-side mirror
  independently reapplies literal-search semantics across tenant ID/name and
  webhook subscription ID/URL, while the 20-page walk no longer spends its
  2,000-row budget scanning rows the mutation cannot target.
- Exact and lower-bound one-row Preview copy now uses singular nouns, and the
  over-limit state says that 500+ rows match the filter instead of saying they
  “will be affected” beside a disabled confirmation.
- A preview-page failure after earlier pages found matches now disables Confirm
  and is rejected by every filter-bulk composable. A failed walk's incomplete
  count can no longer be submitted without the server's exact-count drift guard.
- Positive counts can only be confirmed after the Preview reaches either an
  exact end or the intentional page cap. The shared dialog and all three
  mutation owners independently reject unresolved state.
- Superseded or reset preview walks lose write authority immediately. A late
  response from an aborted request can no longer overwrite a newer Preview
  with a stale “Preview cancelled” error.
- Tenant and webhook Preview ownership now stores the action and filters in one
  frozen selection and exposes the action read-only. Consumers cannot change
  the mutation after the operator reviews its target set.
- Re-entrant filter-bulk confirmation is rejected before error or loading state
  can be changed; direct execution without an owned Preview snapshot is also
  refused.

No API endpoint, successful mutation shape, server/spec requirement, or polling
cadence changes. Validation: 1,371 tests; 97.47% line coverage; lint,
typecheck, production build, and both Compose configurations pass.

## [0.1.25.76] — 2026-07-18

### Changed

- Tenant Detail child acquisition now follows cursor pages through a bounded,
  abortable `useTenantDetailData` read protocol. Its initial scan seeds every
  tab; steady polls retain active-tab laziness and CLOSED-tenant cascade checks.
- Tab activation and post-mutation refreshes now have explicit ownership, so a
  late scheduled poll cannot overwrite newer state or swallow the requested
  child-axis refresh.
- Direct child refreshes now distinguish applied, superseded, and failed
  settlement. Only a successful polling round advances page-wide freshness,
  and a successful read clears errors only for the axis it actually repaired.
- Row-select batch dialogs expose an explicit **Stop remaining** action while
  work is running. Backdrop and Escape cancellation remain blocked so stopping
  a partially committed operation is always deliberate.

### Fixed

- Tenant Detail no longer treats the server's first 100-row page as the whole
  tenant. Tab/child counts, spend rollups, close-cascade previews, and recovery
  verification follow continuation cursors and disclose a lower bound if the
  1,000-row safety cap or a malformed continuation prevents completion.
- Emergency Freeze now performs a fresh cursor walk before confirmation,
  includes ACTIVE budgets found after page one, and freezes the immutable
  reviewed snapshot. Confirmation refuses to open when the complete
  client-side target set cannot be established, so the action can no longer
  promise full coverage while silently skipping later pages.
- A CLOSED tenant with partial cascade verification remains actionable, and
  the permanent tombstone no longer claims every owned object is terminal when
  only a bounded scan has been observed.
- Successful tenant, API-key, budget, and policy mutations are no longer
  described as failed solely because their follow-up refresh failed.
- A quick tab change or overlapping direct refresh no longer produces a blank
  “refresh failed” warning when the older read was intentionally superseded,
  nor can an unrelated child success hide a stale page-wide poll failure.
- Emergency Freeze and the existing tenant, webhook, and budget row-select
  batches now make their AbortSignal-backed cancellation paths reachable.
- Poll failures retain the child axis that actually failed, so a successful
  same-axis direct retry clears the repaired error while unrelated reads do
  not. A stop request made after every batch row was already claimed and
  settled now reports normal completion instead of an empty cancelled result.

## [0.1.25.75] — 2026-07-17

### Changed

- Budget tenant, list, detail, event-timeline, polling, stale-response, and
  cursor state now run through a focused `useBudgetData` read boundary.
  Filters, routing, export presentation, row selection, mutations, and all
  markup remain owned by `BudgetsView`.

### Fixed

- Budget Load more and export now reuse the immutable filter/sort tuple that
  produced the visible rows and cursor. Draft debounced edits, same-route
  navigation, and in-flight filter changes can no longer mix cursor pages or
  export data from different server filter hashes.
- Repeated watcher echoes for the same budget tuple no longer issue duplicate
  page-one requests; explicit refresh still retries an unchanged tuple.
- Export and filter-wide mutation controls stay disabled with an explicit
  "Updating filters…" state until the newly-applied page owns the visible
  rows, preventing old first-page data from being paired with the new tuple.
- Export also stays disabled during a routine page-one refresh, whose cursor is
  temporarily hidden. This prevents the fast path from silently downloading
  only the currently loaded rows; active export pages are now abortable when
  the operator enters detail mode.
- Navigating between budget list and detail modes now invalidates the abandoned
  mode's in-flight reads, preventing a late result or error from leaking into
  the other shell.
- List, detail, tenant-list, mutation, and export errors are scoped to the
  shell that owns them instead of carrying a stale banner across navigation.
- Returning from a directly-loaded budget detail now loads tenant choices with
  page one immediately, and stale visible rows cannot be selected for bulk
  Freeze/Unfreeze while a changed filter is unresolved or failed.

## [0.1.25.74] — 2026-07-17

### Changed

- Budget filter-apply balance mutations now run through a focused
  `useBudgetFilterBulk` protocol boundary. Setup validation, bounded preview,
  exact-count gating, request construction, result messaging, and refresh
  ownership are unchanged; row-select Freeze/Unfreeze remains independent.

### Fixed

- Bulk Preview now captures one immutable filter tuple and reuses it for every
  cursor page, the confirmation summary, and the final mutation. A route or
  filter change during an in-flight preview can no longer pair a new filter
  with an old cursor or submit a tuple different from the one the operator
  reviewed.

## [0.1.25.73] — 2026-07-17

### Changed

- Overview now delegates its two-phase polling, bounded cursor walks,
  signature gating, partial-result tracking, walk retry/backoff, and queued
  manual refresh to a focused `useOverviewData` composable. Cards, charts,
  filters, drill-down routes, polling cadence, and API requests are unchanged.
- The acquisition protocol now has direct deterministic coverage in addition
  to the existing Overview integration suite, making polling and pagination
  regressions fail at their owning boundary.

## [0.1.25.72] — 2026-07-16

### Fixed

- A successful single-budget funding request is now terminal even when the
  following list/detail refresh fails. The dialog closes and clears its target
  at the commit boundary, so neither the UI nor a direct/re-entrant caller can
  repeat the real mutation under a fresh idempotency key.
- Committed funding operations now announce success immediately. While the
  owning view loads authoritative data, every Fund entry point is visibly
  disabled and labeled "Funding updated — refreshing…" instead of accepting a
  click that cannot open a dialog.
- Post-commit refresh failures are reported separately as a transient warning
  that the budget was updated but the displayed data may be stale. The owning
  view still retains its detailed refresh error banner. A superseded refresh
  remains successful because the newer request owns the displayed data.

## [0.1.25.71] — 2026-07-16

### Changed

- `BudgetsView` now delegates the detail surface to `BudgetDetailPanel`, the
  funding form to `BudgetFundingDialog`, and funding-domain state to
  `useBudgetFunding`. List filters, URL ownership, polling, pagination,
  virtualization, bulk actions, visual layout, and API wire shapes are
  unchanged.
- Funding validation and request construction now have a focused typed boundary
  covering CREDIT, DEBIT, RESET, RESET_SPENT, and REPAY_DEBT. Tenant resolution,
  UUID idempotency keys, refresh-before-close behavior, and operation-specific
  success copy remain identical to the prior inline implementation.

### Fixed

- The defense-in-depth duplicate-submit guard now runs before validation or
  mutation state changes, so direct/re-entrant calls while a funding request is
  in flight cannot alter the visible error state or create another request.

## [0.1.25.70] — 2026-07-16

### Changed

- Audit and Events now share one applied-query ownership primitive for
  immutable filter snapshots, monotonic filter epochs, page-one request
  sequencing, same-signature retry/deduplication, cursor pagination, and
  exports. This is a behavior-preserving maintainability change: filters,
  URLs, polling cadence, loading states, and API wire shapes are unchanged.

### Fixed

- Multi-page Audit and Events exports now capture one immutable applied-filter
  tuple for the complete cursor walk. A filter change cancels the pending or
  running export, so no later page can be fetched or appended under a different
  server filter hash. Failed same-filter background polls still leave valid
  Load-more and export work intact.

## [0.1.25.69] — 2026-07-16

### Fixed

- **Lazy-chunk SRI is enforced under the production CSP.**
  `vite-plugin-sri-gen` emits an inline import map containing integrity hashes
  for lazy/transitive chunks, but the shipped `script-src 'self'` policy
  blocked that map on every Chromium page load. The Docker build now hashes
  the exact generated import-map content and binds that SHA-256 source into
  the served CSP. Generation fails closed if the map or placeholder drifts;
  no `'unsafe-inline'` relaxation is used.
- **Transient admin-plane outages no longer erase the operator's key.** Only
  explicit `401`/`403` responses or `authenticated: false` invalidate a key.
  Network failures, malformed/unavailable responses, and proxy/upstream 5xx
  responses retain it for retry and display a connectivity error without
  advancing the invalid-key lockout. Successful session restore also preserves
  the original absolute-session start instead of renewing the eight-hour cap
  on every refresh. Superseded login responses cannot attach stale
  capabilities to a newer key.

### Changed

- The development and production stacks, deployment-pin contract, and README
  example now pin `cycles-server-admin` `0.1.25.53`. This latest published
  admin patch reports unsupported HTTP methods as `405 Method Not Allowed`
  with the standard error shape instead of misreporting them as 500; it makes
  no dashboard wire requirement change.

## [0.1.25.68] — 2026-07-15

### Fixed

- **API-key expiry is no longer editable** — the edit dialogs offered an
  expiry picker, but `expires_at` is immutable per spec (the server silently
  ignored it, so the edit was a no-op that reported success). Expiry now
  shows read-only with a revoke-and-recreate hint. Same fix for the tenant
  edit dialog's `reservation_expiry_policy` (create-only field).
- **Bulk RESET / RESET_SPENT hints now state the real semantics**: the single
  `amount` sets every matched budget's *allocated* to that value (it is not
  preserved), and FROZEN budgets in the selection fail per-row (the preview
  now warns with a count). Bulk `amount: 0` is accepted for RESET/RESET_SPENT
  (zero-allocation rollover), matching the single-budget path.
- **Overview counts are accurate on large fleets** — at-cap budgets, closed
  tenants, failing webhooks, and expiring keys are now aggregated via cursor
  walks (the server caps every list page at 100 rows; the old single-request
  fetches silently under-counted). Cards show a "counts may be partial" note
  if a walk exceeds 1,000 rows.
- Overview → API keys expiring-key links now land pre-filtered (the old
  `?key_id=` param was never read).
- Deep budget scopes no longer 400 on Fund (idempotency key overflowed the
  server's 256-char cap).
- Stale `index.html` after deploys: the container now serves `index.html`
  with `Cache-Control: no-cache` and hashed assets as `immutable`, preventing
  the SRI-mismatch failure documented in OPERATIONS troubleshooting.
- **List refresh and pagination ownership is race-safe.** Superseded page-one
  requests no longer overwrite newer filter results or count as successful
  polling ticks. Audit pagination and multi-page exports reuse the applied
  filter tuple, so unsubmitted form edits cannot be paired with an old cursor.
- Successful Webhooks filter and sort reloads now update the page freshness
  timestamp immediately instead of waiting for the next background poll.

### Added

- Spec alignment moves `v0.1.25.35 → v0.1.25.41`: category-only webhook
  subscriptions can be saved on edit (`.39` selector clearing), and
  tenant-owned subscriptions gate out admin-only event types
  (`api_key.*`/`policy.*`/`webhook.*`/`system.*`) per the `.38`/`.40`/`.41`
  tenant-owned category boundary — matching what `.40+` servers reject.
- API-keys table shows the `key_prefix` column (the visible secret prefix;
  the key-id column is masked, so this is the correlation handle) and
  includes it in exports.
- Command palette: `/budget <query>` and `/res <tenant>` slash commands.
- Audit view: filters persist to the URL (shareable queries) and the standard
  refresh button renders in the header. URL-synced filters across list views
  now treat the URL as authoritative: navigating to a bare URL (sidebar
  click, browser Back) resets the synced filters; submitted filter state
  stays one Back-press away in history.
- gzip compression, `X-Forwarded-Proto`, JSON `502/503/504` error bodies for
  `/v1/*`, and a tightened CSP in the container nginx config; HSTS +
  `encode` in `Caddyfile.example`.

### Changed

- Docker deployments now pin the latest published server fleet as of
  2026-07-16: `cycles-server` `0.1.25.46 → 0.1.25.58`,
  `cycles-server-admin` `0.1.25.48 → 0.1.25.53`, and
  `cycles-server-events` `0.1.25.22 → 0.1.25.24` in both development and
  production Compose plus the README example. Existing evidence-enabled
  fleets must drain/recover `evidence:processing` with their older workers
  before starting events `.24`; OPERATIONS documents the ordered rollout.

- Error toasts persist until dismissed (success toasts still auto-dismiss);
  all toasts have a dismiss button and are announced to screen readers. The
  stack is capped at 5 (oldest dropped), and advisory messages use a new
  auto-dismissing amber warning style instead of red error toasts.
- Dialogs can no longer be dismissed while a mutation is in flight
  (Escape/backdrop/Cancel are gated — prevents duplicate submissions).
- `StatusBadge` renders terminal-but-not-error states (`CLOSED`, `REVOKED`,
  `EXPIRED`) in neutral gray; `FAILED` and webhook `DISABLED` (server
  auto-disable after delivery failures) stay red.
- Budgets/API-keys lists show loading skeletons instead of flashing
  "No … found" on cold load.
- Wide virtualized tables keep loading and empty states visible at viewport
  width on phones while preserving aligned, horizontally scrollable headers
  and data rows. Bulk-action toolbars wrap instead of clipping narrow screens.
- Toasts use one live-region role each (`alert` for errors, `status` for
  success/warnings), avoiding nested-live-region double announcements.
- `nginx-ssl.conf.example` rewritten as a pure TLS terminator in front of the
  container (the old example reproduced the documented `proxy_pass`
  path-stripping regression and skipped the runtime plane entirely).
- Dev compose binds all published ports to `127.0.0.1` (Redis was previously
  reachable on all interfaces without a password); prod compose pins
  `redis:7.4-alpine` / `caddy:2.11-alpine`, adds per-service memory limits
  and `no-new-privileges`.
- The Redis backup runbook now requires a short maintenance window: stop
  writers, force a snapshot, stop Redis, then archive the AOF-backed volume.
  This avoids capturing an AOF manifest during a concurrent rewrite.

### Security

- Release images are now published with SBOM + provenance attestations; the
  shared CI workflow is SHA-pinned.

### Changed

- Bumped `cycles-server-admin` `0.1.25.47 → 0.1.25.48` (compose), completing
  the fleet alignment started in `0.1.25.66`. Admin `.48` is internal-only
  (typed `EventDataTenantCascade` payload mapping — no wire change), so no
  operator action is required. No dashboard code change.

## [0.1.25.66] — 2026-07-04

### Changed

- Bumped the bundled server stack to the current fleet: `cycles-server`
  `0.1.25.44 → 0.1.25.46` and `cycles-server-events` `0.1.25.20 → 0.1.25.22`
  (compose + README; `cycles-server-admin` stays `0.1.25.47` — `.48` is
  merged but not yet released). No dashboard code change.
- **Operator note for events `0.1.25.22`:** the dispatcher now re-validates
  webhook URLs against the admin webhook-security config at DELIVERY time.
  Deployments delivering to `http://` or private-network targets (e.g.
  local receivers in dev stacks) must set `allow_http` / adjust
  `blocked_cidr_ranges` via **Settings → Webhook security**
  (`PUT /v1/admin/config/webhook-security`) or those deliveries permanently
  fail with `ssrf_blocked`. Public HTTPS targets are unaffected.
- **Operator note for server `0.1.25.46`:** default-on 429 rate limiting on
  the public evidence/JWKS endpoints (anonymous surface only, 300 req/min
  per client IP) — dashboard Evidence-view traffic is far below the limit.

## [0.1.25.65] — 2026-07-03

### Added

- **Tenant-close cascade event kinds in the pickers** (spec v0.1.25.35):
  `budget.closed_via_tenant_cascade`, `reservation.released_via_tenant_cascade`,
  `webhook.disabled_via_tenant_cascade`, `api_key.revoked_via_tenant_cascade`
  are now in `EVENT_TYPES`, so they appear in the Events view type-filter
  typeahead and — more importantly — in the webhook subscription event-type
  checkboxes. Before this, cascade events (emitted by cycles-server-admin
  since it implemented the tenant-close cascade; formalized in spec
  v0.1.25.35) rendered and free-text-filtered fine but could not be selected
  when creating or editing a webhook subscription in the UI.

### Changed

- CI coverage gate: the `lines` threshold now enforces the repo's strict
  ≥95% rule (was a 70% floor; actual line coverage is 95.98%). Spec badge
  bumped to v0.1.25.35.

## [0.1.25.64] — 2026-06-26

### Changed

- Bumped the bundled server stack to the current fleet: `cycles-server`
  `0.1.25.44`, `cycles-server-admin` `0.1.25.47`, `cycles-server-events`
  `0.1.25.20` (compose + README). All intervening server releases are
  additive/operational — no dashboard-visible wire change, no client code change.
- Added an nginx container healthcheck (Dockerfile `HEALTHCHECK` + a `healthcheck`
  block on the dashboard compose service, probing `127.0.0.1` to avoid IPv6
  localhost ambiguity) so a crashed dashboard is detected and restarted,
  matching the sibling services.
- Aligned bundled backend healthchecks with the hardened server fleet by probing
  `/actuator/health/readiness` for runtime/admin/events instead of the aggregate
  actuator health endpoint.
- Hardened production compose defaults: Redis password is required, Redis
  healthcheck authenticates, webhook-secret encryption is required for the
  admin/events pair, runtime SpringDoc is disabled, and high-cardinality tenant
  metrics are off by default.
- Tightened the Caddy production wrapper: the local `Caddyfile` is ignored by
  git while `Caddyfile.example` remains the committed template, and Caddy now
  waits for the dashboard healthcheck before starting.
- Corrected production deployment docs so generated secrets are written to
  `.env` instead of literal shell substitutions, and clarified that
  `DASHBOARD_ORIGIN` configures backend CORS in the bundled prod stack.
- Synced `package-lock.json` to the `0.1.25.64` package version.

## [0.1.25.63] — 2026-06-22

### Added

- **Link reservations to their evidence (no copy-paste).** The reservation
  detail dialog now shows one-click **View reserve / commit / release
  evidence** links straight to the Evidence viewer, and the list `include`
  toggle requests the new `evidence` projection. Consumes the runtime
  `evidence` field added in cycles-protocol v0.1.25.9 — requires
  **cycles-server v0.1.25.37+** (older servers simply omit the field and no
  links render).

## [0.1.25.62] — 2026-06-22

Gap-closure release — surfaces runtime/admin API capability that shipped in the
servers but had no dashboard UI. No governance-admin spec-badge change (the
reservation/evidence surface lives in `cycles-protocol-v0.yaml`; the policy /
webhook config was already in `cycles-governance-admin-v0.1.25.yaml`).

### Added

- **Reservations: committed & finalized surface.** The Reservations view now
  shows `committed` and `finalized_at_ms` columns and a read-only detail dialog
  with reserve-time and commit-time metadata (`include=metadata,committed_metadata`).
  Requires cycles-server v0.1.25.8+ (older servers simply omit the fields).
- **Reservations: advanced filters.** Created / expires / finalized time-range
  pickers and Subject filters (workspace / app / workflow / agent / toolset),
  under an "Advanced filters" disclosure. Additive query params — ignored by
  servers that don't support them.
- **Policy enforcement config.** Create/Edit Policy now exposes `caps`
  (token/step caps, tool allow/deny lists, cooldown), `rate_limits`,
  `reservation_ttl_override`, and the `effective_from`/`effective_until` window.
- **Webhook alerting & retry config.** Create/Edit Webhook now exposes
  `thresholds` (utilization / burn-rate / denial / expiry / auth-failure rates)
  and `retry_policy` (previously read-only JSON).
- **API key & tenant fields.** API-key edit can adjust `expires_at`; tenant
  create/edit exposes `max_reservation_extensions` and `reservation_expiry_policy`.
- **Evidence viewer.** New **Evidence** page retrieves a signed evidence
  envelope by id (`GET /v1/evidence/{id}`), renders the envelope, and resolves
  the signer key against the published JWK Set. A force-release now surfaces a
  "View evidence" deep link when the server emits one. Routed through the
  runtime upstream (`RUNTIME_UPSTREAM`) — see [`OPERATIONS.md`](OPERATIONS.md#reverse-proxy-wiring).

### UX details

- Reservation Subject text filters are debounced (one fetch after typing stops,
  not per keystroke); the Advanced-filters toggle shows an active-filter count
  and a **Clear** button.
- Policy/webhook advanced edit dialogs state in-line that clearing a field does
  not remove existing config (replacement semantics). The webhook "blank uses
  server defaults" hint now only shows in create mode.
- Evidence lookup wording for a 404 covers both "not found" and "still being
  signed" (with Retry + check-the-ID guidance), instead of implying it is always
  transiently pending.

### Deployment

- **Runtime-plane baseline moved to `cycles-server:0.1.25.36`** (both
  `docker-compose.yml` and `docker-compose.prod.yml`). `.36` surfaces reservation
  `committed`/`finalized_at_ms`/metadata + the `include=` projection and serves
  `/v1/evidence` + the signer JWKS — so the new Reservations/Evidence surface
  works against the shipped stack. Older runtime servers still work (fields
  omitted, evidence 404).
- The production compose example in `README.md` now includes the runtime plane
  (`cycles-server` + `cycles-events`) and the dashboard's `ADMIN_UPSTREAM` /
  `RUNTIME_UPSTREAM` wiring — required for `/v1/reservations`, `/v1/evidence`,
  and JWKS. `cycles-server-admin` bumped to `0.1.25.39` to match the baseline.

### Known limitation

- Policy/webhook advanced editors support setting and adjusting config; emptying
  a previously-set field leaves the server value unchanged (replacement
  semantics omit absent fields) — the edit dialogs now say so. Full Ed25519
  signature verification in the Evidence viewer is not yet performed in-browser
  (signer-key resolution against the JWK Set, validated at the envelope's
  issuance time).

## [0.1.25.61] — 2026-05-31

Deployment-only change — no spec change, no admin-API surface delta, no client behaviour change.

### Added

- **Configurable reverse-proxy upstreams via `ADMIN_UPSTREAM` / `RUNTIME_UPSTREAM`.**
  The dashboard image bundles an nginx reverse proxy that splits `/v1/*`
  traffic between the governance plane (`/v1/*`) and the runtime plane
  (`/v1/reservations/*`). Those two upstream targets are now environment
  variables instead of hardcoded hostnames, so the bundled proxy can be
  retargeted at deploy time — **no file edit and no image rebuild.** Defaults
  (`http://cycles-admin:7979` / `http://cycles-server:7878`) match the compose
  service names, so existing deployments are unaffected. Include the scheme
  when overriding, e.g. `ADMIN_UPSTREAM=https://admin.internal:7979`. See
  [`OPERATIONS.md`](OPERATIONS.md#reverse-proxy-wiring).

### Changed

- `nginx.conf` is now shipped as `default.conf.template` and rendered by the
  stock nginx entrypoint at container start. No action needed unless you
  reference the old filename in a custom build.

## [0.1.25.60] — 2026-04-26

Chart-engine bump — no spec change, no admin-API surface delta.

### Changed

- **`echarts` 5.6.0 → 6.0.0** and **`vue-echarts` 7.0.3 → 8.0.1.**
  Coordinated bump (Dependabot's standalone echarts PR was blocked by
  vue-echarts 7's `echarts@^5.5.1` peer; vue-echarts 8 declares
  `echarts@^6.0.0`). All chart construction, theme provisioning
  (`THEME_KEY` + built-in `'light'`/`'dark'` strings), and modular
  registration (`use([CanvasRenderer, PieChart, BarChart, …])`) are
  source-compatible with v6. Slice colors are explicit on every series
  in OverviewView so v6's default-theme palette change is invisible
  here. The WebhookDetailView attempts histogram has an explicit
  `grid` box (`top:16, right:16, bottom:24, left:32`) that v6's
  anti-overflow layout respects unchanged. 938 tests pass; production
  build succeeds.

## [0.1.25.59] — 2026-04-23

Spec alignment v0.1.25.31 → v0.1.25.34. Additive only — no breaking
wire changes, no new endpoints consumed. Dashboard surfaces the new
webhook lifecycle events that cycles-server-admin `.39` now emits.

### Added

- **Webhook lifecycle events are now filterable in Events view.**
  Six new `EventType` values (`webhook.created`, `webhook.updated`,
  `webhook.paused`, `webhook.resumed`, `webhook.disabled`,
  `webhook.deleted`) appear in the type datalist. Emitted by
  cycles-server-admin `.39+` on create / update / delete / bulk
  actions, and by cycles-server-events `.11+` when the dispatcher
  auto-disables a webhook after consecutive-failure thresholds.
- **New `webhook` category** in the EventsView category dropdown
  (spec v0.1.25.34 enum expansion).

### Changed

- **`docker-compose.yml` + `docker-compose.prod.yml`** bumped:
  `cycles-server-admin` `0.1.25.38` → `0.1.25.39`, 
  `cycles-server-events` `0.1.25.10` → `0.1.25.11`. Required for the
  new events to actually reach the dashboard end-to-end.
- **Spec badge** `v0.1.25.31` → `v0.1.25.34`.

### Fixed

- **EventsView category dropdown was hardcoded** — silently drifted
  from `EVENT_CATEGORIES`. Pre-fix, adding a new category to the
  const array (as this release did for `webhook`) left the dropdown
  stuck on the old list; operators couldn't filter on the new
  category even after the enum landed. Dropdown now `v-for`s over
  the const array so future additions surface automatically. Caught
  during the review cycle, not in production.
- **Budget fleet utilization donut included CLOSED budgets.**
  Operator-reported: "shows budgets in terminal CLOSED state, should
  show only budgets in non-terminal state." CLOSED is a spec-level
  terminal budget status (v0.1.25.29 cascade) — the budget is
  immutable, utilization is frozen at the close-time snapshot, and
  operators can't act on it. Pre-fix a CLOSED budget at 120%
  inflated the "Over cap" slice, and all CLOSED budgets inflated the
  "Healthy" base (via raw `budget_counts.total`). Now both the
  at-cap bucketing AND the Healthy total exclude CLOSED. FROZEN is
  NOT terminal (operators can un-freeze) so it stays in the
  utilization read per its actual spent/allocated. The at-cap
  attention card also stops surfacing CLOSED rows — previously
  operators saw them on the action queue with nothing they could do.

### Notes

- No code change to the `Event` interface — payload stays
  `Record<string, unknown>` matching the existing pattern for tenant
  lifecycle events.
- Pre-`.39` admin servers continue to work; they just don't emit
  the new events so the new filter values match zero rows. Per the
  spec's forward-compat rule, servers tolerate unknown enum values
  from newer clients.

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


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

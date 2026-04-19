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

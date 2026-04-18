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

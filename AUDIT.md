# Cycles Admin Dashboard — Audit

**Current release:** v0.1.25.44 (2026-04-20)

## Baseline requirements

| Component | Minimum | Shipped (compose) | Notes |
|---|---|---|---|
| cycles-server (runtime plane) | v0.1.25.8+ | v0.1.25.15 | `.13` bounds `listReservationsSorted` at `SORTED_HYDRATE_CAP=2000`. `.14` adds W3C Trace Context on the runtime plane (`X-Cycles-Trace-Id` response header, `trace_id` on runtime events + audit entries, MDC `traceId`). `.15` adds audit-log retention TTL (default 400 days, matches admin). All additive — no wire breakage. Pre-`.14` runtime rows carry no trace chip; dashboard tolerates the absence. |
| cycles-admin (governance plane) | v0.1.25.17+ | v0.1.25.37 | `.18+` for `RESET_SPENT` funding. `.26+` for tenant/webhook filter-apply bulk. `.27+` for AuditView error_code / status_band / DSL-completeness filters. `.28+` for audit sentinel split. `.29+` for budgets bulk-action. `.30+` for structured bulk-action audit detail. `.31+` for W3C Trace Context cross-surface correlation (`trace_id` on Event/AuditLogEntry/WebhookDelivery; `trace_id` + `request_id` filter params on audit + events list endpoints). `.32` hardens cross-plane deserialization (`@JsonIgnoreProperties(ignoreUnknown=true)` on `Event` + `WebhookDelivery`) so runtime can ship additive fields without forcing an admin lockstep release — no wire change. `.35` ships spec v0.1.25.29 CASCADE SEMANTICS (Rule 1 tenant-close cascade + Rule 2 `TENANT_CLOSED` mutation guard, budgets + webhook-tenant create/update only); `.36` completes Rule 2 guard coverage across all admin-mutating endpoints (policies, api-keys, webhook-admin create/update/delete/test/replay, bulk-action per-row); retroactively conformant to spec v0.1.25.31 Mode B (flip-first-with-guarded-cascade). `.37` wires Rule 1(c) bounded-convergence into the close paths: `PATCH /v1/admin/tenants/{id} {"status":"CLOSED"}` on an already-CLOSED tenant no longer short-circuits — it re-runs the cascade idempotently over any non-terminal owned children. This is the admin-side counterpart to the dashboard `.44` Re-run cascade affordance; pre-`.37` admin silently no-op'd the re-close PATCH, so the button would succeed at the HTTP layer but drive no child convergence. Dashboard `.43+` renders the tombstone banner, cascade preview on CLOSE, and `_VIA_TENANT_CASCADE` chips; `.44+` adds the cascade-recovery banner + re-run affordance for operator-issued convergence per Rule 1(c). Pre-`.31` silently ignores the new filter params; rows simply render no trace chip. |
| cycles-events (dispatch worker) | v0.1.25.6+ | v0.1.25.8 | `.8` matches protocol v0.1.25.28 — captures `trace_id` / `trace_flags` / `traceparent_inbound_valid` on `WebhookDelivery` and threads them into the outbound `traceparent` header on HTTP delivery. Dashboard renders the captured `trace_id` in the WebhookDetailView delivery row JSON and CSV export. |
| Spec alignment | — | v0.1.25.31 | Pin moves on end-to-end support. v0.1.25.30 declared `409 TENANT_CLOSED` on the remaining mutating ops. v0.1.25.31 relaxed Rule 1 to permit Mode B (flip-first-with-guarded-cascade) alongside Mode A (atomic); reference admin `.36` implements Mode B. Dashboard wire surface unchanged. |

**Pre-baseline compatibility:** dashboard `TenantLink.isSystem` accepts both legacy `<unauthenticated>` and new `__`-prefixed sentinels (shipped v0.1.25.31). Row-select bulk paths (Tenants/Webhooks suspend, Budgets freeze, Emergency-freeze) fan out per-row and work against any admin version.

## Release history

Newest at the top. Older entries preserved verbatim.

### 2026-04-20 — v0.1.25.44: cascade-recovery affordance (consumes spec v0.1.25.31 Rule 1(c))

**Trigger.** Two operator scenarios the v0.1.25.43 tombstone + cascade-preview pair doesn't reach:

1. **Historical tenants** closed pre-admin-`.35` — cascade never ran, owned objects sit non-terminal under a CLOSED tenant forever. Called out as a caveat in the v0.1.25.43 AUDIT but left unsolved.
2. **Partial cascade failures** — admin crash mid-loop, Redis blip between the tenant flip and per-child writes. Rule 1(b) idempotency + Rule 1(c) convergence are designed for exactly this, but there was no dashboard affordance — operator had to curl `PATCH /v1/admin/tenants/{id} {"status":"CLOSED"}` by hand.

**Root cause.** Spec v0.1.25.31 Rule 1(c) says Mode B servers converge via an "implementation-defined mechanism"; admin `OPERATIONS.md` documents the mechanism as operator-issued re-close. The dashboard hid it: `TenantDetailView` gated the CLOSE button behind `tenant.status !== 'CLOSED'`, and there was no signal that a closed tenant had a pending cascade.

**Fix — thin client, single banner + confirm dialog.**

| Surface | Change |
|---|---|
| `src/utils/tenantStatus.ts` | Add `cascadePendingCounts()` + `cascadeIsIncomplete()`. Per-child terminal constants (`BUDGET=['CLOSED']`, `WEBHOOK=['DISABLED']`, `API_KEY=['REVOKED','EXPIRED']`) treat unknown statuses as non-terminal — forward-compatible against additive status values. |
| `TenantDetailView` recovery banner | Amber banner renders below the tombstone when `isTerminalTenant(tenant) && cascadeIsIncomplete(children)`. Enumerates pending counts per axis. "Re-run cascade" button opens a confirm dialog that PATCHes `{status:CLOSED}` — no-op at the tenant level per Rule 1 idempotency; drives remaining children to terminal states. |
| `TenantDetailView` fetch path | Added `listWebhooks({tenant_id})` alongside the existing budgets + api-keys fetch (on initial mount always; on poll only while tenant is CLOSED, to keep ACTIVE-tenant poll cost unchanged). |
| Rerun handler | Refetches tenant + budgets + webhooks + api-keys after the PATCH so the banner converges on success. On failure, surfaces server error inline under the banner; button stays clickable for retry. |

**Why reuse `ConfirmAction` instead of the CLOSE type-to-confirm dialog.** At re-run time the tenant is already CLOSED — the irreversible tenant-level step already happened. Re-run is a targeted per-child cleanup, not a destructive tenant-level action; the CLOSE dialog's type-tenant-name gate would be ceremonial. The confirm dialog enumerates exact pending counts ("This will close 3 budgets, disable 1 webhook, revoke 2 API keys") so operators still see what'll change.

**What this is NOT.**
- Not an Overview detection tile. That needs a server aggregate (`GET /admin/tenants?cascade_pending=true` or equivalent) to avoid fanning N child queries from the client. Filed as a follow-up admin spec slice if operators ask for a global view.
- Not a bulk-reconcile affordance. If an operator has 50 historical-closed tenants with pending cascades, this ships one-click-per-tenant; server-side bulk reconciler is cleaner than a client batch handler.
- Not a spec change. Rule 1(b) idempotency + Rule 1(c) convergence already support this — pure client UX on an existing endpoint.
- Not an admin pin bump. `.36` already supports idempotent re-PATCH.

**Reservations — why not counted.** Rule 1 releases open reservations as part of the cascade. Reservations are short-lived (TTL minutes) and not exposed on `TenantDetailView` today. Counting them would add a new `GET /admin/reservations?tenant_id=X&status=ACTIVE` query. Skipped — if the cascade missed a budget, it also missed that budget's reservations; the re-run sweeps both.

**Edge cases.**

| Case | Behavior |
|---|---|
| In-flight initial cascade | Banner briefly appears while tenant=CLOSED but children still pre-cascade; disappears on the next poll. One-cycle noise; acceptable. |
| Re-run succeeds at tenant level but cascade partially fails again | Server 200 on tenant (unchanged), per-child audit rows emit for what succeeded. Client refetch still shows pending; banner persists; button stays clickable. Operator retries. |
| Concurrent operator re-runs (two tabs) | Both PATCHes are no-op at tenant level; per-child writes are idempotent. Last-write-wins on audit row — not a problem. |
| Stale children fetch race | Tenant shows CLOSED but children fetched pre-close still look ACTIVE. Rare (one render cycle at mount); resolves on the next poll. |

**Tests.** 15 new tests total. `tenantStatus.test.ts` covers `cascadePendingCounts` (no children, per-axis counting, summing, forward-compat on unknown status, defensive on missing status) and `cascadeIsIncomplete` (ACTIVE tenant, CLOSED clean, CLOSED with pending in each axis, null, empty). Coverage invariant held.

---

### 2026-04-20 — v0.1.25.43: closed-tenant tombstone + cascade preview (consumes spec v0.1.25.29)

**Trigger.** Operator report: after a tenant is CLOSED (terminal per spec), its budgets remain `FROZEN` forever. OverviewView's **Frozen budgets** alert axis counts them; the number never decreases because the budgets literally cannot be unfrozen (the owning tenant is closed). Every closed tenant permanently inflates "what needs attention" with un-fixable items.

**Root cause (spec).** Spec had no cascade semantics — tenant close was a pure status flip; owned objects untouched. Fixed in governance-admin spec v0.1.25.29 with two rules, implemented in cycles-server-admin `.35`:

| Rule | What it does |
|---|---|
| Rule 1 — cascade | Tenant→CLOSED atomically terminal-ifies owned objects: budgets→CLOSED, webhooks→DISABLED, API keys→REVOKED, open reservations→RELEASED. One transaction, correlation-id parity. |
| Rule 2 — guard | Mutating any object whose owning tenant is CLOSED returns 409 `TENANT_CLOSED`. Covers the webhook gap (DISABLED is not spec-terminal; Rule 2 makes it effectively-terminal for closed owners). |

**Why this fixes the Overview counter with zero client-side filtering.** `budget_counts.frozen` is server-computed as `WHERE status='FROZEN'`. After Rule 1, closed-tenant budgets are `CLOSED`, not `FROZEN`, so they drop out of the aggregate automatically. No client-side `Set<closedTenantIds>` subtraction, no drift between what the Overview tile says and what the list page shows.

**Dashboard slice — polish only, cascade is an admin concern.**

| Surface | Change |
|---|---|
| `src/utils/tenantStatus.ts` (new, ~10 LOC) | `isTerminalTenant()` predicate + `TERMINAL_TENANT_STATUSES` constant — single source of truth so views can't drift on which statuses are sinks |
| `TenantDetailView` banner | Amber read-only banner renders when `tenant.status === 'CLOSED'`: "Tenant closed — all owned objects are read-only." Answers "why won't this unfreeze?" before operators open a ticket |
| CLOSE confirm dialog | Enumerates cascade impact from tenant-detail state already in memory: budgets / webhooks / API keys / open reservations. Explicit "This cannot be undone" |
| `AuditView` + `EventTimeline` | Small amber "tenant cascade" chip on rows with `_VIA_TENANT_CASCADE` event kind or `tenant_close_cascade` operation — distinguishes cascade-triggered state changes from user-driven ones when correlating by `correlation_id` |
| `src/utils/errorCodeMessages.ts` | `TENANT_CLOSED` 409 humanizer — "Tenant is closed — this object is read-only." Handles the race window where a stale tab / deep-link / in-flight request hits Rule 2 |

**Compose pin bumps.** `docker-compose.prod.yml`, `docker-compose.yml`, and `README.md` all move cycles-server-admin `0.1.25.32 → 0.1.25.36` (catches up past `.35`'s Rule 2 partial coverage to `.36`'s full guard coverage, and picks up the spec v0.1.25.31 Mode B retroactive-conformance docs). Running `.43` against `.32` still renders cleanly (banner + preview are purely client-side from `tenant.status`) but the cascade itself won't fire and the Overview counter continues to inflate; running against `.35` works but leaves policy / api-key / webhook-admin mutations un-guarded (v0.1.25.29 MUST gap).

**Why no client-side filtering even as an interim.** Considered a `listTenants({status: 'CLOSED'})` fetch on the Overview poll and subtracting the intersection from the frozen-budget list. Rejected: produces drift between tile count and list page, bakes "the server is wrong" into the client in a way that is hard to remove later, and the admin `.35` was ready in the same release window. The dashboard is now the thin client the cascade makes it.

**Explicitly not doing.**
- No "un-close" affordance. Close is terminal.
- No new `WebhookStatus` enum value. Rule 2 makes DISABLED effectively-terminal for closed-owner webhooks — preserves wire compat with every client parsing the enum.
- No backfill of cascades onto already-closed tenants. Separate slice if operators want historical Overview inflation cleared immediately; without it, the fix takes effect only for tenants closed going forward.

**Verification.** `npm run typecheck`, `npm test`, `npm run build` all clean. Manual smoke: banner renders on a CLOSED tenant; CLOSE dialog on an ACTIVE tenant enumerates non-zero counts; humanized 409 surfaces on a simulated stale mutation.

### 2026-04-19 — v0.1.25.42: base-image bump unblocks release pipeline

**Trigger.** v0.1.25.40 and v0.1.25.41 release workflows both failed at the Trivy vulnerability-scan step (`exit-code: 1` on `HIGH,CRITICAL` with `ignore-unfixed: true`) — the push step was skipped, so neither docker image exists upstream despite the git tags. Root cause: the Trivy DB refresh between v0.1.25.39 (succeeded 14h earlier) and v0.1.25.40 surfaced fixed-upstream CVEs in the Alpine 3.21.3 layer shipped by `nginx:1.27-alpine`.

**CVE breakdown** (57 unique, extracted from uploaded SARIF for run 24630627382):

| Severity | Count | Representative |
|---|---|---|
| CRITICAL (CVSS ≥9) | 3 | CVE-2025-15467 (openssl RCE), CVE-2025-49794 / CVE-2025-49796 (libxml2) |
| HIGH (CVSS 7–8.9) | 18 | libpng × 6, openssl × 2, libxml2 × 2, musl, libexpat, zlib |
| MEDIUM (reported HIGH by distro) | 29 | mostly openssl follow-on, curl, c-ares, busybox |

**Fix.** Serve stage `nginx:1.27-alpine` (Alpine 3.21.3) → `nginx:1.29-alpine` (Alpine 3.23.4, 0 HIGH/CRITICAL via local `trivy image` scan). Build stage `node:20.19-alpine` → `node:20.20-alpine` (also Alpine 3.23.4) for consistency; build stage is discarded so this is cosmetic for the Trivy gate but keeps local dev on the same Alpine version as production.

**No source / behavior change.** All v0.1.25.41 features (vue-router 5, shared icon library, Copy JSON two-track relocation) ship unchanged. Operators pinning `0.1.25.40` or `0.1.25.41` must re-pin to `0.1.25.42` — the earlier tags resolve to absent image manifests.

**Why bump to current rather than loosen the Trivy gate.** `ignore-unfixed: true` is already the right posture — it means every flagged CVE has an upstream patch. Loosening to `severity: CRITICAL` only would silence the 18 HIGH without actually fixing anything. Base-image rotation is the intended remediation path for supply-chain findings on a static-asset serve stage.

**Follow-up to consider.** Automate Trivy scans on `main` pushes (not just tag workflows) so CVE surface is visible continuously rather than only at release-cut time. Out of scope for this patch.

### 2026-04-19 — v0.1.25.41: dependency refresh (vue-router 5 major + 4 patches)

**Trigger.** Five open Dependabot PRs on top of v0.1.25.40 — one major (`vue-router` 4→5), three patches (`vite`, `@vitejs/plugin-vue`, `@tanstack/vue-virtual`), and one GitHub Actions major (`codeql-action` v3→v4). Rolled into a single release to keep the changelog narrative coherent.

**vue-router 4 → 5 risk review.** The v5 release notes' breaking changes are all in **experimental** surfaces: the new data-loaders API (`NavigationResult` / `reroute` / `selectNavigationResult` / `miss`) and auto-routes / file-based routing. Dashboard grep confirmed zero usage of either — every import resolves to the stable surface (`createRouter`, `createWebHistory`, `createMemoryHistory`, `useRoute`, `useRouter`, `RouterLink`, `RouteLocationRaw`). Local dry-run on the PR branch (`npm install && npm run typecheck && npm run test && npm run build`) passed cleanly before admin-merge.

| Package | Old → New | Kind | Risk |
|---|---|---|---|
| `vue-router` | 4.6.4 → **5.0.4** | dep major | low — no experimental API usage |
| `@tanstack/vue-virtual` | 3.13.23 → 3.13.24 | dep patch | trivial |
| `vite` | 8.0.7 → 8.0.8 | dev-dep patch | trivial |
| `@vitejs/plugin-vue` | 6.0.5 → 6.0.6 | dev-dep patch | trivial |
| `github/codeql-action` | 3 → 4 | workflow major | low — GitHub ships v3 + v4 in parallel with equivalent features |

**Merge order** (to keep main green on every step): `vite` → `vue-router` → `vue-virtual` → `codeql-action` → `plugin-vue`. Dependabot auto-rebased the remaining PRs after each merge; one conflict on `plugin-vue` was resolved by `@dependabot recreate`. Final main: typecheck clean, 742 tests green, build clean, `npm audit` reports 0 vulnerabilities.

**No protocol / admin / server / events-server change.** Ecosystem baseline unchanged from v0.1.25.39 (cycles-server-admin `.32`, cycles-server `.15`, cycles-server-events `.8`).

### 2026-04-19 — v0.1.25.40: Copy JSON two-track relocation (kebab for flat rows, icon for expanded panels)

**Trigger.** Operator feedback: *"Copy JSON placement takes a whole row, wasting space."* Audit confirmed: one dedicated ~50px footer row on every expanded EventsView / AuditView / EventTimeline panel, plus a dedicated ~88px trailing column on every always-visible WebhookDetailView delivery row.

**Two-track relocation — one size does not fit.**

| Track | Views | Placement | Why |
|---|---|---|---|
| 1 (kebab) | WebhookDetailView delivery rows | Row kebab (⋮), 3 items: Copy as JSON / Copy delivery ID / Copy event ID | Flat table, no expansion. Delivery row has ≥2 legitimately-distinct copy targets, so the v0.1.25.29 ≥2-actions-per-kebab rule is satisfied without filler. Toast confirms on click (menu closes). |
| 2 (panel icon) | EventsView, AuditView, EventTimeline expanded panels | Clipboard icon absolutely-positioned at top-right of the panel body | A row-level kebab on these views would be single-purpose (no natural sibling actions besides the pivot chips already rendered inline) and would add a collapsed-row affordance to save a footer visible only on expand — net regression for scan-heavy usage. The icon costs zero vertical space. |

**Rejected alternatives (for the record).**

| Alternative | Why not |
|---|---|
| One kebab per row on every view | Violates ≥2-actions rule on EventsView / AuditView / EventTimeline unless filler actions are fabricated. |
| Hover-reveal button | Invisible on touch + keyboard-only; v0.1.25.29 moved away from hover-only row actions. |
| Icon + label in panel header | Competes with Request / Correlation / Trace ID chips on narrow viewports. Icon-only + tooltip + `aria-label` + `sr-only` text wins for density while preserving screen-reader and test-selector fidelity. |

**Footprint reclaimed.** 48px per delivery row on WebhookDetailView × N visible rows; one ~50px footer row per expansion on three other views.

**Follow-up (same release) — operator feedback mid-review.**

| Ask | Response |
|---|---|
| "Icon is generic, requires a tooltip to know what it does" | Redesigned glyph: overlapping document rectangles (universal *copy* visual) with `{ }` curly braces inside the front sheet (universal *JSON* visual). Self-signalling without hover. Applied to all three Track-2 surfaces. |
| "Every view where we have a kebab should have Copy JSON — common use case is sharing an object definition with a developer" | Added **Copy as JSON** to all seven RowActionsMenu call sites that lacked it: TenantsView, TenantDetailView (API keys + policies), WebhooksView, BudgetsView, ReservationsView, ApiKeysView, and WebhookDetailView's subscription-header kebab. |

**Shared helper.** New `src/utils/clipboard.ts` — `writeClipboardText(value)` and `writeClipboardJson(obj)` both return `Promise<boolean>` (true on success, false on denied permission / missing API). Callers `if (await …) toast.success(…) else toast.error(…)`. DRYs the duplicate try/catch blocks and gives a single test surface for clipboard failure modes.

**Implementation notes.**

- Reused `RowActionsMenu.vue` (v0.1.25.29) on WebhookDetailView — zero API change. Discriminated-union `RowActionItem[]` accepts the three `onClick` entries as-is.
- Track 2 icon button is inline SVG (copy-plus-JSON glyph / checkmark swap) with `<span class="sr-only">Copy JSON</span>` so `.text()` selector asserts still work — no test-structure churn on EventsView/AuditView/EventTimeline.
- WebhookDetailView dropped the `copiedDeliveryId` ref + timer (dead code once the label swap goes to a toast).
- `deliveryGridTemplate`: trailing column `88px → 40px`. Actions header collapsed to `sr-only` since a 40px cell can't hold the word "Actions".

**Validation gates.** `npm run typecheck` / `npm run test` / `npm run build` clean. New `clipboard.test.ts` covers the helper (success, denied, missing API, cycles, BigInt). WebhookDetailView kebab test exercises all three delivery-row items and asserts the correct payload per item.

**Icon library extraction (same-release follow-up).** Operator ask: *"make sure the whole dash uses same approach — all images, icons etc should be sep and shared. no copying."* Created `src/components/icons/` with nine reusable SFCs and replaced 32+ inline SVG duplications.

| Icon | Replaces | Call sites |
|---|---|---|
| `CopyJsonIcon` | Composite copy+JSON glyph | EventsView, AuditView, EventTimeline (Track-2 surfaces) |
| `DownloadIcon` | Export button glyph | 8 list views × 2 states (idle + loading) |
| `CloseIcon` | Dialog dismiss X | ApiKeys, Budgets, Tenants, Webhooks secrets dialogs |
| `ChevronRightIcon` | Row expand arrow | Events, Audit, EventTimeline |
| `BackArrowIcon` | Detail-view back arrow | Tenants, TenantDetail, Budgets, WebhookDetail |
| `SearchIcon` | Command-palette + sidebar search | Sidebar, CommandPalette |
| `CheckIcon` | Copied / success checkmark | MaskedValue, BulkActionResultDialog |
| `Spinner` | Loading indicator | ApiKeys, Budgets, ConfirmAction, BulkActionPreviewDialog (×2) |
| `WarningIcon` | Alert triangle | OverviewView (×7 alert cards) |

Future icon edits (stroke-width tweak, dark-mode color adjustment, accessibility label) happen once instead of fan-out across a dozen files. 742 tests green.

**Icon library full pass (same-release polish).** Operator ask: *"do a pass on all icons, svgs, etc and review, enhance for look and feel."* Audit surfaced 3 visual inconsistencies: (1) the Copy glyph was duplicated three times with three different drawings (CorrelationIdChip, MaskedValue, plus a variant inside CopyJsonIcon), (2) BulkActionResultDialog rolled its own alert-triangle and info-circle instead of reusing the shared `WarningIcon`, (3) 14 inline SVG glyphs still lived in consumer files. Extracted 15 more components for a total of 24:

| Icon | First call site | Replaces |
|---|---|---|
| `HamburgerIcon` | AppLayout mobile header | inline 3-bar menu |
| `LogoutIcon` | Sidebar logout button | inline arrow-out |
| `SunIcon` / `MoonIcon` | Sidebar theme toggle | inline sun / moon |
| `RefreshIcon` | RefreshButton | inline arrow-loop |
| `SortAscIcon` / `SortUnsortedIcon` | SortHeader (all list views) | inline up-arrow + dual-arrow |
| `ChevronDownIcon` | TimeRangePicker + RowActionsMenu labeled trigger | two inline chevrons (different viewBoxes) |
| `KebabIcon` | RowActionsMenu trigger | inline three-circle ⋮ |
| `CopyIcon` | CorrelationIdChip + MaskedValue | two inline copy glyphs (canonical) |
| `EyeIcon` / `EyeOffIcon` | MaskedValue reveal/hide | two inline eye variants |
| `InfoCircleIcon` | BulkActionResultDialog "skipped" | inline info circle |
| `EmptyTrayIcon` | EmptyState | inline tray/inbox |
| `CheckCircleIcon` | OverviewView "all clear" banner | inline success circle |

Side-effects: BulkActionResultDialog's "failed" glyph now reuses `WarningIcon` instead of its hand-rolled triangle; ApiKeysView's "view all permissions" button swaps the ambiguous trending-up arrow for `ChevronRightIcon` (semantically correct — it indicates "more detail"). The one remaining inline `<svg>` is Sidebar's nav-icon block, whose `d` path is data-driven from the `navItems` table; a shared component would need a `:d` prop and wouldn't reduce duplication. Documented inline. 742 tests green.

**Icon design-quality pass (same-release polish).** Operator ask: *"can you pass icons, images, svgs and see if you can improve quality, look and feel, style."* Three moves:

| Move | What | Why |
|---|---|---|
| Stroke-width unify | 14 outline icons at `2` → `1.5`. `Spinner` (`3`), `EmptyTrayIcon` (`1`), `CopyJsonIcon` (signature, `1.4`) keep intentional weights. | Matches modern Heroicons v2 defaults; lighter and more balanced at 16–24px sizes. Mixed `1.5` / `2` was a visible inconsistency once icons sat next to each other (theme toggle + logout at `1.5` vs refresh + search at `2` in the same chrome). |
| Path upgrades to v2 geometry | `RefreshIcon` → arrow-path; `EyeIcon` / `EyeOffIcon` → v2 curves + slash; `CopyIcon` → document-duplicate. | v2 paths are more geometrically balanced than the v1 equivalents. Copy glyph specifically reads as "duplicate" (two overlapping sheets) instead of a single document with a folded corner. |
| Dead asset deletion | `public/icons.svg` (social-icon sprite — bluesky/discord/github/x; never imported), `src/assets/hero.png`, `src/assets/vite.svg` (Vite scaffold leftovers). | `grep -r` confirmed zero references. Shrinks the build surface and the asset-audit surface. |

No behavior change, no API change, no visible shift in glyph *identity*; only line-weight and curvature polish. 742 tests green; `npm run build` clean.

**"Updated just now" header strip removed (same-release follow-up).** Operator ask: *"noticed at the top of some views 'Updated just now' but it's never anything else — what's the purpose if it never shows anything other than this text?"* Audit confirmed: every view polls at 15–60s, and `formatRelative` returns `"just now"` for anything under 60s, so the label resets before it can tick to `"1m ago"`.

| Poll interval | View(s) | Observed label |
|---|---|---|
| 15s | EventsView | always "just now" |
| 30s | OverviewView, WebhookDetailView, ReservationsView | always "just now" |
| 60s | ApiKeysView, BudgetsView, TenantsView, TenantDetailView, WebhooksView | "just now" (resets before ticking) |

Removed the `lastUpdated` prop + span from `PageHeader.vue`, dropped the `lastUpdated` ref/assignment/return from `usePolling.ts`, and stripped the destructuring + prop-passing from all nine call sites. The adjacent `RefreshButton` stays — it already conveys freshness interactively (spinner while polling, click to force a tick). Rejected `stale-only` and `live-ticker` alternatives after operator picked the delete. 742 tests green.

### 2026-04-18 — v0.1.25.39 follow-up: ecosystem baseline rollup (admin `.31 → .32`, server `.13 → .15`, events `:latest → .8`)

All three server-side components shipped additive patch releases on the same day. Rolling them into the v0.1.25.39 compose baseline to keep the dashboard's shipped stack coherent with the trace-context feature this release introduces.

| Component | Old pin | New pin | What changed |
|---|---|---|---|
| cycles-server-admin | `.31` | `.32` | `@JsonIgnoreProperties(ignoreUnknown=true)` on `Event` + `WebhookDelivery` so runtime can add wire-additive fields without forcing admin re-release. No wire change. |
| cycles-server | `.13` | `.15` | `.14` W3C Trace Context on runtime plane (`X-Cycles-Trace-Id`, `trace_id` on runtime events/audit, MDC `traceId`); `.15` audit-log retention TTL (400-day default). Both additive. |
| cycles-server-events | `:latest` | `.8` | Explicit pin. `.8` captures `trace_id` / `trace_flags` / `traceparent_inbound_valid` at dispatch time per protocol `.28`. |

**Why pin `events` explicitly instead of `:latest`.** The previous `:latest` was fine while protocol wire was stable, but `v0.1.25.39` is the first dashboard release that actively reads `trace_id` off delivery rows. Pinning ensures a downgrade or compose copy-paste lands on a known-good combination. Release-process memory: pins are for reproducibility.

**Why roll into `.39` instead of cutting `.40`.** Zero dashboard source change — compose + README + AUDIT + CHANGELOG only. The feature tested end-to-end in this session ran against the new baseline (admin `.32` + server `.15` + events `.8`). Cutting a fourth-segment bump for a compose-only change would fragment the changelog narrative.

### 2026-04-18 — v0.1.25.39 follow-up: WebhookDelivery field-name + status enum alignment with the spec

**Symptom.** After starting `cycles-server-events:latest` against the seeded dataset every delivery row rendered `HTTP -` and gave no failure reason. Operators could see a flood of `FAILED` rows but not tell which were 405 Method-Not-Allowed on the receiver vs "Subscription not active: DISABLED" after auto-disable kicked in.

**Root cause.** `src/types.ts` `WebhookDelivery` diverged from `cycles-governance-admin-v0.1.25.yaml` §WebhookDelivery:

| Dashboard (pre-fix) | Spec / server | Effect |
|---|---|---|
| `http_status` | `response_status` | HTTP Code column read from a key that does not exist → always `-` |
| `delivered_at` | `completed_at` | Time column fell back to `created_at` even for completed deliveries |
| — (absent) | `error_message` | Failure reason never surfaced — the whole payoff of the column |
| — | `response_time_ms` | Not round-tripped through CSV export |
| — | `next_retry_at` | Retry schedule invisible |

The `DELIVERED` option in the status filter was never a valid enum value (spec is `PENDING | SUCCESS | FAILED | RETRYING`) — selecting it silently returned zero rows.

**Fix**
- Rename `http_status` → `response_status`, `delivered_at` → `completed_at`; add `error_message`, `response_time_ms`, `next_retry_at` to `WebhookDelivery`.
- WebhookDetailView: add a 7th **Error** column (`minmax(240px,1fr)`) rendering `error_message` with a full-text `title` tooltip, red-tinted for `FAILED` rows only. Time column now prefers `completed_at`. Status filter replaces `DELIVERED` with `SUCCESS`. CSV columns extended to the full spec field set.
- StatusBadge maps `SUCCESS`/`FAILED`/`PENDING`/`RETRYING` to green/red/yellow/yellow — previously all gray.

**Discipline.** The "spec is the authority" rule from CLAUDE.md caught this one late — the types file had drifted at least one minor back (never matched the wire). Added explicit spec-reference comments on the renamed fields so future edits stay anchored.

### 2026-04-18 — v0.1.25.39: W3C Trace Context cross-surface correlation (spec v0.1.25.28 / admin v0.1.25.31)

**Motivation.** Admin-server `.31` + protocol `.28` shipped end-to-end `trace_id` propagation: every HTTP-originated event and audit entry is auto-populated from `RequestContextHolder`, webhook deliveries capture the dispatch-time trace, and both list endpoints accept `trace_id` + `request_id` exact-match filters. The dashboard already rendered `request_id` / `correlation_id` in expanded panels and had an inline `correlation_id` pivot (v0.1.25.37), but there was no way to follow a single HTTP request across AuditView → EventsView → WebhookDetailView — the core UX payoff of the server work.

**Scope**
- New `src/components/CorrelationIdChip.vue` — one chip, three kinds (`trace` / `request` / `correlation`), truncation (`first8…last4`, tooltip for full value), copy-to-clipboard with insecure-context guard, one-click pivot per `kind × pivot` destination.
- `src/types.ts` adds optional `trace_id` on Event + AuditLogEntry; `trace_id` / `trace_flags` / `traceparent_inbound_valid` on WebhookDelivery.
- AuditView + EventsView: new `Trace ID` + `Request ID` filter inputs, `applyQueryParams` ingest of `?trace_id=…` / `?request_id=…` deep-links, CSV export column echo, and CorrelationIdChip render in expanded panels. EventsView gets a route-query watcher so in-place chip pivots (same view, new filter) re-sync the form.
- EventTimeline (BudgetsView embed) renders the full correlation triplet via the shared chip.

**Not in scope**
- WebhookDetailView delivery-row `trace_id` rendering. The delivery list is a 6-column fixed-height virtualized grid (88px trailing cell); adding a chip without disrupting row height / measurement warrants its own slice. Typing round-trips correctly today via `Record<string, unknown>` forward-compat — no wire regression.
- `ErrorResponse.trace_id` surfacing in toasts. `extractErrorInfo` flattens errors to strings; trace id in toasts requires a ToastBanner redesign.
- `trace_flags` / `traceparent_inbound_valid` UI render (dispatch-internal bookkeeping).

**Rejected alternatives**
- *Inline `<router-link>` per field, matching the v0.1.25.37 `correlation_id` pattern.* The inline approach already wasn't scaling — three fields × four surfaces = twelve near-duplicate blocks with diverging classes / aria-labels. The chip is one file; the consistency is free thereafter.
- *Making `CorrelationIdChip` emit a `pivot` event for the caller to handle.* Adds boilerplate in every caller and loses the "chip is self-contained" property. The in-place same-view pivot case (EventsView → EventsView with a different `request_id` query) is solved with a `watch(() => route.query, …)` sync, which is seven lines and only in EventsView.

**Operator surface**
- Copy-to-clipboard on every chip (trace, request, correlation) — the copy button flips to "Copied" for 1.5s and is keyboard-focusable.
- Chip truncates at 16 chars (32-hex trace ids become `01234567…cdef`; 12-char request ids render in full). Full value in the `title` attribute so select-and-copy from the tooltip works even when the clipboard API is blocked (insecure-context fallback).

### 2026-04-18 — v0.1.25.38: structured bulk-action audit detail (spec v0.1.25.30)

Closes the last pre-existing gap between dashboard and admin-server `.30`. Slices A–D of the prior integration plan (spec v0.1.25.23–.26) shipped across `.33`–`.37`; `.30`'s audit-metadata enrichment was the only remaining dashboard-side follow-up.

**Motivation.** Admin-server v0.1.25.30 writes structured per-row outcomes into `AuditLogEntry.metadata` for `bulkActionTenants` / `bulkActionWebhooks` / `bulkActionBudgets`. The dashboard already accepts the new keys (metadata is typed `Record<string, unknown>`), so *correctness* was never at risk — but the legacy `<pre>{{ safeJsonStringify(metadata) }}</pre>` block inside a 48-unit-tall scroll container turned a 500-row bulk into a multi-kilobyte JSON blob that was hostile to triage. An operator hunting "which specific row failed?" had to scroll through succeeded ids first. Structured rendering unblocks the triage flow the server enrichment was designed for.

**Scope**
- New component `src/components/BulkActionAuditDetail.vue` for the structured summary.
- Shape guard `src/utils/auditMetadata.ts` — shared between AuditView's conditional render and the component's own no-op fallback so pre-.30 entries render consistently.
- AuditView expansion panel: conditional structured card + collapsed "Raw metadata" `<details>`; non-bulk rows unchanged.

**Not in scope**
- Cross-linking `succeeded_ids` / `failed_rows` entries to live list views (nice-to-have, defer).
- Virtualized row tables (500-row cap makes this unnecessary).
- Spec-badge bump — `cycles-governance-admin-v0.1.25.yaml` `info.version` is still `0.1.25.26`; all v0.1.25.27–.30 changes are additive and don't bump OpenAPI.

**Changes**

| File | Change |
|---|---|
| `src/components/BulkActionAuditDetail.vue` | NEW. Header + filter-echo grid (with `TenantLink` for tenant keys) + three collapsibles (succeeded / failed open by default / skipped). Reuses `formatErrorCode` for per-row prose, mirrors `BulkActionResultDialog`'s copy-id affordance. |
| `src/utils/auditMetadata.ts` | NEW. `BULK_ACTION_OPERATIONS` + `isBulkActionOperation` + `hasBulkAuditShape`. |
| `src/views/AuditView.vue` | Import + conditional `<BulkActionAuditDetail>` + raw JSON inside `<details>` fallback when shape matches; legacy inline `<pre>` preserved for non-bulk rows. |

**Reuse (no re-invention)**
- `formatErrorCode()` from `src/utils/errorCodeMessages.ts` — already used by `BulkActionResultDialog`.
- `TenantLink` for tenant-ish filter keys (`tenant_id`, `parent_tenant_id`).
- `safeJsonStringify()` behind the Raw-metadata collapse.
- Filter-echo grid pattern cribbed from `BulkActionPreviewDialog`'s filter summary without introducing a shared primitive — a third caller would justify extraction.

**Tests**
- NEW `auditMetadata.test.ts` — 10 specs covering `isBulkActionOperation` + `hasBulkAuditShape` guard (non-bulk op, missing metadata, each of the five keys, filter-as-array negative case).
- NEW `BulkActionAuditDetail.test.ts` — 13 specs: pre-.30 fallback (empty render), non-bulk op fallback, header + duration formatting (both `Xms` and `X.XXs` branches), filter echo (TenantLink drill-through, falsy-but-meaningful values kept, empty/null stripped), per-row error_code chip + formatted prose, unknown code forward-compat, skipped reasons, Copy-all + per-row Copy affordance, filter-only minimal shape.
- Full suite: 719 / 719 pass (up from 696 / 696 — 23 new specs, no regressions).

**Gates** typecheck clean • vitest 719 / 719 across 57 files • build clean (1.02 s).

### 2026-04-18 — v0.1.25.37 (extension): row-select bulk → BulkActionResultDialog + EventTimeline correlation_id pivot

In-place extension of PR #92. Operator feedback surfaced two triage gaps after the Copy JSON work.

**Scope**
- Row-select bulk paths (Tenants / Webhooks / Budgets freeze / Emergency-freeze) dropped per-row failures to `console.warn`. Filter-apply siblings already opened `BulkActionResultDialog`.
- EventTimeline rendered `correlation_id` as plain text; EventsView already had click-to-filter.

**Not in scope**
- `request_id` cross-pivot (needs server filter DSL addition).
- `correlation_id` on AuditView (same).

**Changes**

| File | Change |
|---|---|
| `src/utils/rowSelectBulkResult.ts` | NEW. Synthesizes `{succeeded, failed, skipped, total_matched}` from `rateLimitedBatch`'s `{done, failed, cancelled, errors}`. |
| `src/views/TenantsView.vue` | `executeBulk` refit: capture `settledSucceeded[]` in worker, drop console.warn loop, open dialog on failure/cancel. Toast `"check console"` → `"see details"`. |
| `src/views/WebhooksView.vue` | Same refit. |
| `src/views/BudgetsView.vue` | Same refit + `labelById` from `${scope} (${unit})`. Cross-tenant selection suppresses triage links (sets `tenantId = ''`). |
| `src/views/TenantDetailView.vue` | `emergencyFreezeResult` ref + dialog block added (previously no result UI). |
| `src/components/EventTimeline.vue` | `correlation_id` → `<router-link to="/events?correlation_id=…">`. |

**Tests**
- NEW `rowSelectBulkResult.test.ts` — 6 specs (synthesizer isolation).
- Updated `BudgetsView-row-select-bulk.test.ts:326` — console.warn assertion → dialog-open assertion.

**Gates** typecheck clean • vitest 696 / 696 across 55 files • build clean.

### 2026-04-18 — v0.1.25.37: Per-row "Copy JSON" on Events + Audit

Small triage UX. Operators asked for single-row JSON-to-clipboard; existing bulk Export ships hundreds of rows when one is usually what's wanted.

**Surfaces**

| View | Placement | Payload |
|---|---|---|
| EventsView | Expanded-panel header (replaced data-only "Copy" in Data sub-box) | Full `Event` object |
| AuditView | Expanded-panel header (new — no copy affordance before) | Full `AuditLogEntry` including `metadata` |
| EventTimeline (BudgetDetail) | Expanded-row panel | Full `Event` object |
| WebhookDeliveries | Inline trailing column (flat rows, no expand) | Full `WebhookDelivery` |

Each uses `safeJsonStringify(row)` + `navigator.clipboard.writeText`, 2s "Copied!" label flip, silent fallback on clipboard-permission errors.

**Why AuditView matters most** `search` only scans `resource_id / log_id / operation / error_code`. `metadata` (where bulk-action per-row outcomes live) is unreachable via any filter — Copy JSON is the only path into `jq` / a ticket.

**Tests** NEW `copy-row-as-json.test.ts` — 3 specs (full-object payload assertions + label toggle + silent clipboard-error).

**Version bumps** package `.36 → .37` • compose admin `.29 → .30` (paired — admin `.30` shipped same day) • README drift swept (admin `.28 → .30`).

**Gates** typecheck clean • vitest 690 / 690 across 54 files • build clean.

### 2026-04-18 — v0.1.25.36: BudgetsView row-select + bulk Freeze / Unfreeze

**Release scope.** Dashboard-only UX release — closes the pattern-gap from v0.1.25.35, which shipped the filter-apply bulk path for `CREDIT` / `DEBIT` / `RESET` / `RESET_SPENT` / `REPAY_DEBT` but left BudgetsView without the row-select checkbox + bulk Freeze/Unfreeze toolbar that TenantsView + WebhooksView already expose. Operator feedback after v0.1.25.35 merged: *"budgets bulk is not similar to tenants or webhooks: no multi select, no ability to freeze/unfreeze in multi way."* This release lands row checkboxes, a select-all header, a floating bulk toolbar, and ConfirmAction-gated bulk Freeze / Unfreeze — mirroring TenantsView:147–263 exactly.

No spec, server, or compose-baseline change. Compose admin `.29` + server `.13` pins stay identical to v0.1.25.35. Image published as `ghcr.io/runcycles/cycles-dashboard:0.1.25.36` via the existing `release.yml` tag-push workflow.

**Why Freeze + Unfreeze are not in `BUDGET_BULK_ACTIONS`.** Per cycles-governance-admin spec v0.1.25.26, `BudgetBulkAction = CREDIT | DEBIT | RESET | RESET_SPENT | REPAY_DEBT` — the five server-side bulk actions are balance mutations, not status transitions. Freeze and Unfreeze are status transitions handled by the existing per-row `PATCH /v1/admin/budgets/{id}/freeze` + `.../unfreeze` endpoints (stable since admin v0.1.25.19). The dashboard fans Freeze/Unfreeze out client-side via `rateLimitedBatch` over the per-row endpoints rather than bolting them onto the server-side bulk endpoint — this keeps the spec surface minimal and mirrors how TenantsView (suspend/close) and WebhooksView (pause/resume) handle their status-only bulk actions.

**What landed on `feat/budgets-row-select-bulk-v0.1.25.36`.**

1. **Row-select state** (`src/views/BudgetsView.vue`). New `selected: Set<string>` ledger-id set (O(1) toggle). Five filter-change watchers clear the selection whenever any of these change: `selectedTenant`, `filterStatus`, `filterUnit`, `filterScope`, `search`, `filterUtilMin`, `filterUtilMax`, plus `route.query.filter`. Raw refs are watched (not debounced) so the selection clears the moment the operator types — stale ids never leak across filter changes. `toggleSelect(ledgerId)` flips a single id; `toggleSelectAll()` unions all currently-visible ledger_ids when any are unselected, or clears all when everything visible is already selected. Computeds: `selectedVisibleAll` (boolean — header checkbox `:checked` binding), `selectedVisibleCount` (number — toolbar counter).
2. **Grid-template checkbox column** (`src/views/BudgetsView.vue`). New 40px first column when `canManage` is true: `'40px minmax(140px,1fr) minmax(220px,2fr) 130px 110px 150px minmax(180px,1fr) 140px 96px'` (was 8 columns, now 9). `aria-colcount` bumped 8 → 9 to match. Header row renders a `<div role="columnheader">` with `<input type="checkbox" :checked="selectedVisibleAll" @change="toggleSelectAll" aria-label="Select all visible budgets" />`; data rows render `<div role="cell">` with per-row checkbox carrying `aria-label="Select budget ${scope}"` for screen-reader parity. Non-manage users see the 8-column grid unchanged.
3. **Floating bulk toolbar** (`src/views/BudgetsView.vue`, new `<Teleport to="body">` block at the bottom of the template). `<Transition name="fade">` wraps a `fixed bottom-8 left-1/2 -translate-x-1/2 z-50` bar with `role="toolbar" aria-label="Bulk budget actions"`. Visible whenever `canManage && selectedVisibleCount > 0`. Contents: `{{ selectedVisibleCount }} selected` counter + Freeze button (`bg-red-700 hover:bg-red-800` — destructive emphasis, since freezing an ACTIVE budget blocks all reservations) + Unfreeze button (`bg-green-700 hover:bg-green-800`) + Clear-selection X button. Teleported to `body` so the toolbar stays anchored to the viewport during virtualized scroll (the virtualized row container scrolls independently of the sticky-position toolbar).
4. **Bulk-status flow** (`src/views/BudgetsView.vue`, new state refs + handlers).
   - `bulkStatusAction: Ref<'freeze' | 'unfreeze' | null>` — drives the confirm-modal visibility + title.
   - `bulkStatusProgress: Ref<{ done: number; total: number; failed: number }>` — live progress counter shown in the confirm-modal body during execution.
   - `bulkStatusRunning: Ref<boolean>` — gates button disable + abort-vs-close semantics on the Cancel button.
   - Private `bulkStatusAbort: AbortController | null` for mid-run cancellation (operators can abort a long-running bulk if they realize mid-flight they selected the wrong set).
   - `openBulkStatus(action)` opens the ConfirmAction modal. Title templates: `"Freeze N budget(s)?"` / `"Unfreeze N budget(s)?"` using `bulkStatusTargets().length` (per-action eligibility-filtered — see below).
   - `bulkStatusTargets(): BudgetLedger[]` — for Freeze, returns selected rows with `status === 'ACTIVE'`; for Unfreeze, selected rows with `status === 'FROZEN'`. `CLOSED` budgets are terminal and always skipped (never part of the action's target set), consistent with the row-action kebab's `CLOSED`-disabled item.
   - `executeBulkStatus()` fans out via `rateLimitedBatch(targets, fn, { concurrency: 4 })` over `freezeBudget(tenant, ledgerId, 'bulk')` / `unfreezeBudget(tenant, ledgerId, 'bulk')`. Reason string `'bulk'` preserves audit-log context so operators can filter `/audit?operation=BUDGET_FREEZE&search=bulk` to find the triggering action. Progress updates after every resolved promise (done++ on success, failed++ on rejection). Post-run toast summary: `"Froze 7 of 9 budgets — 2 failed, see console for details"` on partial failure, `"Froze 9 budgets"` on full success. Per-failure `console.warn(\`Bulk freeze failed for ${scope} (${ledgerId})\`, err)` so operators can triage from DevTools. On completion: `selected.value = new Set()` + `loadList()` to refresh statuses.
   - `cancelBulkStatus()` calls `bulkStatusAbort.abort()` mid-run (resolving pending promises fast), or resets the modal state when idle.
   - Matches TenantsView's row-select reporting pattern (toast + `console.warn` for triage) rather than Slice B's `BulkActionResultDialog`. The dialog is response-driven — it requires the server's split succeeded/failed/skipped arrays that `/v1/admin/*/bulk-action` returns, which don't exist in the client-side fan-out model. TenantsView + WebhooksView both use `BulkActionResultDialog` on the filter-apply path (response-driven) and toast + console on the row-select path (client-side fan-out); this PR keeps BudgetsView's row-select path consistent with that split.
5. **Tests.** New `src/__tests__/BudgetsView-row-select-bulk.test.ts` — 10 specs covering:
   - toolbar hidden without selection,
   - toolbar visible with Freeze + Unfreeze + counter + Clear on selection,
   - select-all header toggle unions all visible ledger_ids,
   - clicking Clear X empties selection,
   - filter-change (tenant, status, unit, scope, search) clears selection,
   - bulk Freeze fans out only for ACTIVE rows (FROZEN + CLOSED rows in the selection skipped by `bulkStatusTargets()`),
   - bulk Unfreeze fans out only for FROZEN rows (ACTIVE + CLOSED skipped),
   - reason string `'bulk'` passed through to per-row `freezeBudget` / `unfreezeBudget` call,
   - selection cleared + `loadList()` reloaded after success,
   - per-failure `console.warn` fires + toast summary mentions partial counts.
   - Test helpers: `toggleRow(wrapper, scope)` finds the per-row checkbox via `input[aria-label="Select budget ${scope}"]`; `selectTenant(wrapper, id)` via `select#budget-tenant`. Stubs: `RouterLink` template shim + `Teleport: true` so tests can query `[role="toolbar"]` in the rendered default slot (jsdom doesn't honor `<Teleport to="body">` by default).

**Files.** `src/views/BudgetsView.vue` (imports + state block + handlers + grid-template update + template additions + floating Teleport toolbar + ConfirmAction modal). `src/__tests__/BudgetsView-row-select-bulk.test.ts` (NEW, 10 specs, 270+ lines). `package.json` (`0.1.25.35 → 0.1.25.36`). `package-lock.json` (synced). `docker-compose.prod.yml` (dashboard self-image `.35 → .36`; admin `.29` + cycles-server `.13` pins unchanged). `README.md` (compose-example dashboard image `.35 → .36`). `AUDIT.md` (this entry + prepended top-line Date summary).

**Spec alignment.** Unchanged at v0.1.25.26. Freeze/Unfreeze are per-row endpoints (stable since admin v0.1.25.19), not part of the `BudgetBulkAction` enum — no spec wire-shape change, no new server endpoints exercised.

**Server compatibility.** Zero server dependency delta. `rateLimitedBatch` fans out over existing per-row `PATCH /v1/admin/budgets/{id}/freeze` + `.../unfreeze` endpoints that have been stable since admin v0.1.25.19. Compose pins (admin `.29`, cycles-server `.13`) stay the shipped baseline from v0.1.25.35.

**Backward compatibility.** Pure additive UI change. The existing row-action kebab (per-row Freeze / Unfreeze / Fund) is untouched — operators who only ever act on one budget at a time see no change. The filter-apply bulk path from v0.1.25.35 (CREDIT / DEBIT / RESET / RESET_SPENT / REPAY_DEBT against a full filter body) is untouched. The new row-select bulk path is opt-in via the checkbox column, which only appears when `canManage` is true. No existing tests, deep-links, or keyboard-nav paths regressed.

**Validation gates (CLAUDE.md).**

- `npm run typecheck` (`vue-tsc -b --noEmit`) — clean.
- `npx vitest run` — **674 / 674 passing** across 53 files (up from 664 / 52 in v0.1.25.35; +10 new specs in this release).
- `npm run build` — clean; `BudgetsView-*.js` chunk 45.33 kB gzip 13.32 kB (+4.59 kB vs v0.1.25.35's 40.74 kB / gzip 12.06 kB; growth reflects the row-select state machine + bulk-status handlers + Teleport toolbar template + ConfirmAction modal).

**Follow-up fix — BulkActionResultDialog scope-aware rendering (same PR, no version bump).** Operator ran a bulk CREDIT against 3 budgets, got 2 succeeded / 1 failed with `INVALID_TRANSITION — unit mismatch: expected TOKENS, got USD_MICROCENTS`, and reported: *"from error not clear which one succeeded and which one failed"*. Root cause: the result dialog rendered the failed row's ledger-id (`97763b80-e45e-4772-adaf-bec9832abc95`) verbatim — an opaque UUID — with no scope, so the operator had to cross-reference back to the preview's first-10 sample to identify *which* budget failed; the succeeded block was a one-line count badge with no enumeration of the succeeded row ids, so "which ones went through" couldn't be answered at all. For BudgetsView this is acutely wrong — budget scopes (`tenant:acme/agent:reviewer`) are the meaningful identifier; ledger_ids are UUIDs. For TenantsView / WebhooksView the existing id-only rendering is fine (tenant_ids like `acme-corp` and webhook ids like `sub_abc_nickname` are already human-readable), so any fix has to stay opt-in via a prop rather than mandatory-everywhere. **Fixes applied on `feat/budgets-row-select-bulk-v0.1.25.36`:** (1) `src/composables/useBulkActionPreview.ts` — new optional `labelFn?: (item: T) => { id: string; label: string }` option on `UseBulkActionPreviewOptions<T>`; when supplied, collects a full `Record<string, string>` of every matched row (not capped at SAMPLE_LIMIT — runs for all up-to-500 matches, ~25KB upper bound) and exposes it as `previewLabels: Ref<Record<string, string>>`; snapshotted each page alongside `previewSamples`; cleared on `startPreview`/`resetPreview`. Backward-compatible — TenantsView / WebhooksView don't pass `labelFn` and see zero behaviour change. (2) `src/components/BulkActionResultDialog.vue` — new optional `labelById?: Record<string, string>` prop; when a row's id has a mapped label, each enumerated row renders the label as the primary line (scope, plain text) + the id as a smaller `text-[10px]` mono secondary line below it; when omitted, falls back to the id-only rendering that TenantsView / WebhooksView have always shown. Succeeded rows are now enumerated behind a collapsed `<details>` (defaults closed — attention still belongs on failed rows, but operators can expand to confirm exactly which rows went through when planning a retry). (3) `src/views/BudgetsView.vue` — passes `labelFn: (b) => ({ id: b.ledger_id, label: b.scope })` to the preview composable; snapshots `filterBulkPreview.previewLabels.value` *before* `resetPreview()` clears it (the reset fires before the result dialog opens); `bulkResult` state shape extended to carry `labelById: Record<string, string>`; template passes `:label-by-id="bulkResult.labelById"` through to the dialog. **Tests.** New specs in `src/__tests__/BulkActionResultDialog.test.ts` — *"succeeded rows render behind a collapsed `<details>`"* (asserts 2 `<details>` when succeeded+failed are both present, succeeded defaults closed, failed defaults open, succeeded ids still findable in DOM while collapsed), *"labelById renders scope as primary and the id as a secondary mono line on every enumerated row"* (asserts every row — succeeded, failed, skipped — shows both scope and id when labelById is provided), *"omits scope lines when labelById is absent"* (back-compat regression guard for TenantsView / WebhooksView). Existing `"renders succeeded-count summary"` spec updated to use `/2\s*succeeded/` regex (same pattern as adjacent failed/skipped specs — count + noun now live in adjacent spans inside a `<summary>`, which `w.text()` flattens whitespace from). **Validation gates re-run.** `npm run typecheck` clean. `npx vitest run` **680 / 680 passing** across 53 files (+3 from 677/53: 3 new BulkActionResultDialog specs). `npm run build` clean; `BudgetsView-*.js` chunk 46.12 → 46.26 kB (+140 bytes for the labelFn wiring + label snapshot). **Scope boundary.** TenantsView + WebhooksView intentionally NOT retrofitted — their ids are human-readable and adding a second mono line would be visual noise. If a future surface wants the same treatment, it pulls labelFn through and the dialog props without any component changes. **Same branch, same version** — committed to `feat/budgets-row-select-bulk-v0.1.25.36`, no `package.json` / `package-lock.json` / compose / README version bumps; PR #91 picks the fix up on next push.

**Follow-up fix — Per-row triage deep-links (same PR, no version bump).** Operator's follow-up after the scope-aware rendering shipped: *"There is copy Id and like this one 97763b80-e45e-4772-adaf-bec9832abc95 what is this ID and where to use it?"*, then after a failed audit search: *"I did use it in Audit Search an nothing comes up"*, then the request: *"Well can't triage in Audit by tenant ort something else? and also add View budget, need to be able to triage failures, success into Audit by something"*. Root cause: the dashboard was offering a Copy ID button on every row but the ledger_id UUID is unsearchable in two distinct places — (a) BudgetsView's list `search` param matches `tenant_id + scope` only (verified against `cycles-server-admin` `BudgetListFilters.java#search`, not `ledger_id`), and (b) AuditView's `search` scans `resource_id` / `log_id` / `operation` / `error_code` (spec v0.1.25.24) but the bulk endpoint writes a single audit entry with `resource_id='bulk-action'` and stows per-row outcomes in `metadata.succeeded[] / .failed[] / .skipped[]` — `metadata` is NOT searched. So pasting the UUID into either search box returns zero rows. **Fixes applied on `feat/budgets-row-select-bulk-v0.1.25.36`:** (1) `src/components/BulkActionResultDialog.vue` — new optional `tenantId?: string` prop; when both `itemNounPlural === 'budgets'` and `tenantId` are present, each enumerated row (succeeded / failed / skipped alike) renders a pair of `<router-link>` triage actions below the Copy ID button: *View budget* → `/budgets?tenant_id=<t>&search=<scope>` (uses the scope from `labelById` because the server search matches scope not id; falls back to id when labelById lacks an entry), *View audit* → `/audit?tenant_id=<t>&operation=bulkActionBudgets` (the operation filter is the only searchable hook into the bulk invocation's audit row — expanding that row's metadata surfaces the per-row outcome list). Suppressed when `tenantId` is absent or the surface isn't budgets — tenants/webhooks ids are already human-readable and already searchable on the audit endpoint by `resource_id`. (2) `src/views/BudgetsView.vue` — `selectedTenant` + `search` refs now hydrate from `route.query.tenant_id` / `route.query.search` at component init so the deep-links actually route correctly (pre-fix both refs initialized to `''` and ignored the URL); `bulkResult` state shape gains `tenantId: string` captured from `selectedTenant.value` before the preview reset; template passes `:tenant-id="bulkResult.tenantId"` through to the dialog. **Tests.** Three new specs in `src/__tests__/BulkActionResultDialog.test.ts` — *"renders View budget + View audit links per row when itemNounPlural=budgets and tenantId is provided"* (mounts with 3 rows across all three sections + `labelById` + `tenantId: 'acme'`, asserts 6 total `<a data-to>` anchors, asserts the failed row's View budget query carries the scope from labelById not the UUID, asserts all three View audit links share `{ path: '/audit', query: { tenant_id: 'acme', operation: 'bulkActionBudgets' } }`), *"omits triage links when tenantId is absent — guards against cross-tenant deep-links that would 400"* (regression guard: labelById alone without tenantId still renders scope line + Copy ID but zero router-links), *"omits triage links when itemNounPlural is not budgets"* (tenants surface with tenantId supplied renders zero links — back-compat for the tenants/webhooks paths). **Validation gates re-run.** `npm run typecheck` clean. `npx vitest run` **683 / 683 passing** across 53 files (+3 from the scope-aware-rendering fix's 680/53). `npm run build` clean; `BudgetsView-*.js` chunk 46.35 kB gzip 13.61 kB (+90 bytes from 46.26 kB for the query-param hydration + bulkResult shape tweak). **Scope boundary.** Triage links are budgets-only by design — the dialog's `showTriageLinks` computed gates on both the noun AND a present `tenantId`. Future surfaces that want the same treatment (e.g. a hypothetical reservations-bulk that also emits opaque ids) can widen the computed once the per-noun route schema is clear, but there's no speculative widening today. **Same branch, same version** — committed to `feat/budgets-row-select-bulk-v0.1.25.36`, no version bumps; PR #91 picks up automatically.

**Follow-up fix — Amount wire shape + RESET_SPENT required-amount (same PR, no version bump).** Operator smoke-test after the row-select path landed hit `Bulk CREDIT failed: Malformed request body (INVALID_REQUEST)` the moment the filter-apply path was exercised against admin-server `.29`. Root cause: cycles-governance-admin spec v0.1.25.26 defines `BudgetBulkActionRequest.amount` and `.spent` as `$ref: '#/components/schemas/Amount'` (an `{unit, amount}` object — same shape as `BudgetFundingRequest.amount`), but the dashboard's Slice C landing code serialized them as scalar numbers, and the test file `BudgetsView-bulk-action.test.ts` locked the scalar shape in with `expect(body.amount).toBe(250)`. Separately, Slice C omitted `amount` entirely from `RESET_SPENT` requests — but the spec (line 3084: *"Requires `amount`; `spent` is optional (>= 0; ignored for other actions)"*) requires `amount` for all five actions; RESET_SPENT uses `amount` as the new allocated value and `spent` as the optional reset target. **Fixes applied on `feat/budgets-row-select-bulk-v0.1.25.36`:** (1) `src/types.ts` `BudgetBulkActionRequest.amount?` flipped from `number` to `Amount`, `.spent?` flipped from `number` to `Amount`, per-field comments rewritten to reflect spec semantics (amount required for all five actions, spent is a RESET_SPENT-only counter override that defaults to 0 when omitted). (2) `src/views/BudgetsView.vue` `bulkSetupForm` gains a `unit: string` field seeded in `openBulkSetup()` from `filterUnit.value || 'USD_MICROCENTS'` so the setup form defaults to the same unit the operator is already filtering on; new `<select id="bulk-unit">` element in the FormDialog between the Action and Amount inputs with the same 4 unit options already used in the list-filter (USD_MICROCENTS / TOKENS / CREDITS / RISK_POINTS) + inline hint prose explaining that rows whose budget unit differs will fail per-row with `INVALID_TRANSITION`; new `filterBulkUnit: Ref<string>` between the setup and preview steps; `submitBulkSetup()` validates unit presence + always requires a positive `amount` (RESET_SPENT no longer omits it) + keeps `spent` as the RESET_SPENT-only optional field; `executeFilterBulk()` wraps `body.amount = { unit, amount: filterBulkAmount.value }` and `body.spent = { unit, amount: filterBulkSpent.value }` so both fields serialize as spec-compliant Amount objects; `cancelFilterBulk()` + post-submit reset both clear `filterBulkUnit.value` alongside the other bulk-state refs. (3) Amount-input label switches to "Amount (new allocated)" under RESET_SPENT with a clarifying hint *"Sets each matching budget's allocated to this value. Spec requires amount for RESET_SPENT."* so operators understand why the field doesn't disappear when they flip to RESET_SPENT. (4) `src/__tests__/BudgetsView-bulk-action.test.ts`: scalar `expect(body.amount).toBe(250)` assertion replaced with `expect(body.amount).toEqual({ unit: 'USD_MICROCENTS', amount: 250 })`; RESET_SPENT spec retitled from *"omits amount in the body"* to *"RESET_SPENT sends amount (new allocated) and omits spent when left blank"* with assertions flipped accordingly (amount now present as Amount object; spent omitted when blank); new spec *"RESET_SPENT sends both amount and spent (each wrapped as Amount) when spent is filled in"* additionally exercises the unit-selector (picks `TOKENS`) to verify the wire format propagates through the new input. (5) `src/__tests__/client.test.ts` four `bulkActionBudgets` specs updated — scalar `amount: 1000` / `amount: 100` inputs flipped to `{ unit: 'USD_MICROCENTS', amount: N }` Amount objects; the RESET_SPENT spec retitled from *"omits amount, includes optional spent"* to *"includes amount (Amount) and optional spent (Amount)"* with its assertions flipped; the 401 endpoint-mismatch carve-out spec's `amount: 100` input similarly flipped. **Validation gates re-run.** `npm run typecheck` clean. `npx vitest run` **677 / 677 passing** across 53 files (+3 from the row-select PR's 674/53 — the RESET_SPENT rewrite splits into two specs to cover both the omit-spent + include-spent paths, and client.test.ts picks up the extra unit assertion). `npm run build` clean. **Same branch, same version.** Per user direction: *"address footgun in this pR dont need another version"* — committed to `feat/budgets-row-select-bulk-v0.1.25.36` as a follow-up commit, no `package.json` / `package-lock.json` / compose / README version bumps; PR #91 picks the fix up automatically. **Spec authority.** `cycles-governance-admin-v0.1.25.yaml` lines 3036–3132 (the `BudgetBulkActionRequest` schema) and 175–188 (the `Amount` schema) are the authoritative source for this wire-shape; the single-row `fundBudget` at `src/api/client.ts:407–423` already wraps `amount` as `{unit, amount}` and served as the reference pattern for the fix.

### 2026-04-18 — v0.1.25.35: Budget bulk-action UI (Slice C of integration plan)

**Release scope.** Dashboard feature release paired with cycles-governance-admin v0.1.25.26 + cycles-server-admin v0.1.25.29. Closes Slice C of the four-slice integration plan covering admin spec v0.1.25.23–.26. Wires the dashboard counterpart to the `POST /v1/admin/budgets/bulk-action` endpoint that admin-server shipped in `.29` on 2026-04-18. Also bundles the read-only Slice D verification note confirming that the audit `tenant_id` sentinel split (spec v0.1.25.25, both `__admin__` and `__unauth__`) is fully handled by the existing `TenantLink.isSystem` guard — no code change required, so the verification bundles into this PR per the plan's "Slice D → bundled into whichever PR touches AuditView or TenantLink next" direction.

**Why now.** Admin spec v0.1.25.26 landed the endpoint on 2026-04-16; admin-server `.29` implementation shipped 2026-04-18. Until the dashboard catches up, operators would have to construct the filter-body + idempotency_key by hand (curl / Postman) to run a budget CREDIT or DEBIT against more than one row. Budget bulk-action is the only v0.1.25.26 spec change that requires a dashboard surface — Slices A/B groundwork already shipped (filter DSL completeness in v0.1.25.33; per-row outcome dialog in v0.1.25.34). Shipping Slice C now closes out the integration plan.

**Tenant requirement.** Per spec `BudgetBulkFilter.tenant_id` is REQUIRED — admin-server deliberately rejects cross-tenant bulk budget mutations because budget semantics differ meaningfully between tenants (per-tenant overdraft limits, per-tenant policy enforcement), and a filter like `{status: "ACTIVE", utilization_min: 0.9}` without a tenant would fan out to the entire fleet with one click. The dashboard mirrors the server-side constraint: the "Bulk action…" button in the BudgetsView filter toolbar is disabled whenever `selectedTenant.value === ''` with a tooltip reading `"Select a tenant to bulk-act on budgets"`. Cross-tenant list filtering (`over_limit` / `has_debt` without a tenant selection) is intentionally preserved — the operator flow is "scan the fleet for incident shape, then drill into a tenant to act", which matches how on-call operators describe 2am incident triage.

**What landed on `feat/budget-bulk-action-v0.1.25.35`.**

1. **Types** (`src/types.ts` +61 lines, after `WebhookBulkActionResponse`):
   - `BUDGET_BULK_ACTIONS` readonly tuple `['CREDIT','DEBIT','RESET','RESET_SPENT','REPAY_DEBT']` + `BudgetBulkAction` union derived from it.
   - `BudgetBulkFilter` interface — REQUIRED `tenant_id: string`, optional `scope_prefix`, `unit: BudgetUnit`, `status: BudgetStatus`, `over_limit: boolean`, `has_debt: boolean`, `utilization_min: number` (0–1), `utilization_max: number` (0–1), `search: string`. Mirrors the spec's `BudgetBulkFilter` schema 1:1.
   - `BudgetBulkActionRequest` — `filter: BudgetBulkFilter`, `action: BudgetBulkAction`, optional `amount` (required server-side for CREDIT/DEBIT/RESET/REPAY_DEBT), optional `spent` (honoured only for RESET_SPENT), optional `reason`, optional `expected_count` (preflight gate), required `idempotency_key`.
   - `BudgetBulkActionResponse` — succeeded/failed/skipped arrays of the existing `BulkActionRowOutcome` type (reused from spec v0.1.25.21).
2. **API wrapper** (`src/api/client.ts` — new `bulkActionBudgets(body)` after `unfreezeBudget`). Mirrors the existing `bulkActionTenants` and `bulkActionWebhooks` wrappers: POST to `/v1/admin/budgets/bulk-action`, JSON body, throws `ApiError` with `errorCode` + `details` on non-2xx. Wraps the same `fetchJSON` helper so `LIMIT_EXCEEDED` / `COUNT_MISMATCH` propagation is identical to the tenants + webhooks paths.
3. **BudgetsView flow** (`src/views/BudgetsView.vue` +374 lines). Two-step dialog flow:
   - **Setup** (`FormDialog`): action select (5 options with per-action hint prose — e.g. CREDIT "Increase allocated; amount required", DEBIT "Decrease allocated; amount required — irreversible balance mutation", RESET_SPENT "Reset spent counter to zero; optional exact-spent override"), amount input (hidden for RESET_SPENT; required for the other four), spent input (RESET_SPENT only; blank = 0), optional reason (audit-log context). Validates inline before transitioning.
   - **Preview** (shared `BulkActionPreviewDialog` from Slice A / v0.1.25.28): walks `listBudgets({ tenant_id: selectedTenant.value, …filterParams })` pages via the existing `useBulkActionPreview` composable; applies per-action eligibility gate (`status === 'ACTIVE'` for CREDIT/DEBIT/REPAY_DEBT since server would return `INVALID_TRANSITION` per row otherwise; all statuses for RESET/RESET_SPENT); shows filter summary ("Tenant: acme-corp · Action: DEBIT · Over limit · 10 budgets"), live count, first-10 sample with `{ id: ledger_id, primary: scope, sublabel: unit, status }`, expected_count arm once the walk reaches end; `confirm-danger` styling for DEBIT (irreversible balance mutation).
   - **Execute** (`executeFilterBulk`): POSTs `BudgetBulkActionRequest` with filter including REQUIRED `tenant_id`, action-conditional `amount` / `spent`, optional `reason`, `idempotency_key` via `generateIdempotencyKey`, and `expected_count` only when the preview walk reached the end (omit when maxPages truncated so the server doesn't reject a preflight gate that was never accurate). Defense-in-depth check: empty `selectedTenant.value` short-circuits with an error message even though the button should have been disabled.
4. **Error paths.**
   - Request-level `LIMIT_EXCEEDED` (server's 500-row cap exceeded) + `COUNT_MISMATCH` (actual rows diverged from `expected_count` between preview and execute) route through Slice B's `formatBulkRequestError('budgets', 500, details)` for humanized prose — the helper already handles `budgets` capitalized-plural and embeds `details.total_matched` via `.toLocaleString()`.
   - Non-empty `failed[]` / `skipped[]` arrays open Slice B's `BulkActionResultDialog` with `actionVerb` (title-cased like "Reset spent") + `itemNounPlural: "budgets"` + the response. Per-row `error_code` renders via `formatErrorCode` — `BUDGET_EXCEEDED` (DEBIT / REPAY_DEBT over remaining balance — the rule not the exception on bulk debit), `INVALID_TRANSITION` (non-ACTIVE row survived the client-side eligibility gate — server is authoritative), `INTERNAL_ERROR` fallback, plus forward-compat for future codes.
5. **Slice D verification — sentinel split (spec v0.1.25.25).** Read-only confirmation that the dashboard is fully compatible with admin `.28+`'s `tenant_id` sentinel split. `TenantLink.isSystem` guard at `src/components/TenantLink.vue:13–15` checks `id.startsWith('__')`, which catches both `__admin__` (admin-key-authenticated non-tenant-scoped requests) and `__unauth__` (pre-auth failures) in addition to the legacy `__system__` / `__root__` / `<unauthenticated>` sentinels. Grep across `src/**` for the literal sentinel strings returned zero matches — no other code path hardcodes a sentinel value. OverviewView's Recent Operator Activity card renders `tenant_id` via `TenantLink` (inherits the guard); Recent Denials renders via plain text (no drill-down). AuditView exposes no tenant_id datalist — it's a free-text input, so there's no hardcoded whitelist to update. Conclusion: no regression, no code change required. Verification is bundled into this PR per the integration plan's directive.
6. **Tests.**
   - New `src/__tests__/BudgetsView-bulk-action.test.ts` — 9 specs: (1) Bulk-action button disabled without tenant selection (the spec tenant_id REQUIRED constraint is enforced at the UI), (2) enables once a tenant is selected, (3) happy-path DEBIT submits filter + amount + idempotency_key + expected_count when the preview walk reaches end, (4) RESET_SPENT shows `spent` input / hides `amount` input / omits `amount` from request body while including `spent`, (5) `LIMIT_EXCEEDED` humanized via `formatBulkRequestError` (asserts the toast message includes "500" and `total_matched` from `details`), (6) `COUNT_MISMATCH` humanized via `formatBulkRequestError`, (7) `BulkActionResultDialog` opens with per-row `BUDGET_EXCEEDED` prose when server returns a failed row, (8) `idempotency_key` regenerated between two consecutive submits (prevents replay-window collisions across operator retries), (9) omits `expected_count` from request body when the walk hits maxPages (only sends the preflight gate when the sample is complete).
   - `src/__tests__/client.test.ts` +4 specs for `bulkActionBudgets` wire-format: POST to `/v1/admin/budgets/bulk-action` with correct body shape; RESET_SPENT variant omits `amount` and includes `spent`; `LIMIT_EXCEEDED` error surfaces `errorCode` + `details.total_matched` on the thrown `ApiError`; `COUNT_MISMATCH` error surfaces `errorCode` for downstream humanization.
   - jsdom quirk: `FormDialog` wraps its content in `<form @submit.prevent>` and the Preview button has `type="submit"`; jsdom's click-to-submit propagation is unreliable through that boundary, so the test helper calls `wrapper.find('form').trigger('submit')` directly (mirrors the pattern already established in `AuditView-filters.test.ts`).

**Files.** `src/types.ts` (+61 lines). `src/api/client.ts` (+14 lines). `src/views/BudgetsView.vue` (+374 lines — imports, state refs, handlers, template additions). `src/__tests__/BudgetsView-bulk-action.test.ts` (NEW, 9 specs). `src/__tests__/client.test.ts` (+4 specs, +99 lines). `package.json` (`0.1.25.34 → 0.1.25.35`). `package-lock.json` (synced). `docker-compose.prod.yml` (dashboard self-image `.34 → .35` + admin `.28 → .29`). `docker-compose.yml` (admin `.28 → .29`). `README.md` (spec badge `v0.1.25.25 → v0.1.25.26`, description `v0.1.25.25 → v0.1.25.26`, new "Bulk budget action (CREDIT / DEBIT / RESET / RESET_SPENT / REPAY_DEBT)" row in the Operational Actions table citing admin `.29+` requirement). `AUDIT.md` (this entry + prepended top-line Date summary + Requires-line admin baseline bump to `.29+`).

**Spec alignment.** Badge bumps **v0.1.25.25 → v0.1.25.26** — the dashboard now exercises the v0.1.25.26 `POST /v1/admin/budgets/bulk-action` endpoint end-to-end. This pin is set by the most recent end-to-end supported spec; Slice D (sentinel split) was already spec v0.1.25.25 and shipped in v0.1.25.31, so no badge change for that verification.

**Server compatibility.** Admin-server `.29+` required for the new budget-bulk path (pre-.29 servers return 404 on the POST; the BudgetsView single-row fund flow continues to work unchanged against any `.18+` server). Compose pins bump in lockstep — both `docker-compose.prod.yml` and `docker-compose.yml` now pin admin `.29`. cycles-server runtime-plane pin unchanged at `.13`.

**Backward compatibility.** Pure additive UI change. The existing row-select fund flow (`fundBudget` via `FormDialog` at `BudgetsView.vue:321–414`) is untouched — operators who only ever fund one budget at a time see no change. The new bulk path is opt-in via the Bulk action… button, which only appears/enables once a tenant is selected. No existing tests or deep-links regressed.

**Validation gates (CLAUDE.md).**

- `npm run typecheck` (`vue-tsc -b --noEmit`) — clean.
- `npx vitest run` — **664 / 664 passing** across 52 files (up from 651 / 51 in v0.1.25.34; +13 new specs in this release: 9 in `BudgetsView-bulk-action.test.ts`, 4 in `client.test.ts`).
- `npm run build` — clean; `BudgetsView-*.js` chunk 40.74 kB gzip 12.06 kB.

### 2026-04-18 — v0.1.25.34: Per-row bulk outcome rendering (Slice B of integration plan)

**Release scope.** Dashboard-only UX release — Slice B of the four-slice integration plan covering cycles-governance-admin v0.1.25.23–.26. Replaces the `console.warn`-only per-row failure reporting on the tenants + webhooks filter-apply bulk paths with a reusable operator-facing triage dialog. Pre-wires the per-row error_code rendering infrastructure that Slice C (budget bulk-action, spec v0.1.25.26) depends on — budget DEBIT/RESET operations will emit `BUDGET_EXCEEDED` per row as the rule, not the exception, and without this release those failures would continue to land in the browser console.

No spec, server, or compose-baseline change. Compose admin `.28` + server `.13` pins stay identical to v0.1.25.32/.33. Image published as `ghcr.io/runcycles/cycles-dashboard:0.1.25.34` via the existing `release.yml` tag-push workflow.

**Why now.** Three reasons:

1. **Slice B is a hard prerequisite for Slice C.** Budget bulk-action's per-row failure rate will be materially higher than tenants/webhooks — DEBIT against insufficient remaining balance returns `BUDGET_EXCEEDED` on every affected row, and INVALID_TRANSITION is routine for non-ACTIVE budgets under CREDIT/DEBIT/REPAY_DEBT. Shipping Slice C without a per-row UI would regress the operator triage experience the moment the endpoint lands.
2. **The `console.warn` branch was always a placeholder.** Introduced in v0.1.25.28 alongside the PR-B bulk-action wire-up, the two `for (const f of res.failed) console.warn(...)` blocks in TenantsView + WebhooksView were explicitly flagged as interim; the `toast.error("... — check console for details")` suffix has been a rough edge since day one. A dedicated dialog lets operators triage failures without DevTools.
3. **Forward-compat infrastructure is cheap to ship early.** `formatErrorCode()` renders unknown codes as `code: message` so any server-side ErrorCode enum addition between now and the next dashboard release surfaces verbatim rather than being silently dropped. Future server bumps don't require dashboard re-tagging just to unblock triage.

**What landed on `feat/bulk-action-result-dialog-v0.1.25.34`.**

1. **New shared component `src/components/BulkActionResultDialog.vue`** — filter-apply-bulk result dialog. Props: `actionVerb` (verb shown in the title, e.g. "Suspend" / "Pause" / "Debit"), `itemNounPlural` (e.g. "tenants" / "webhooks" / "budgets"), `response` (the server's split succeeded/failed/skipped arrays plus `total_matched`). Emits `close`. Layout: header with `N rows processed` plus `of M matched` suffix when rows were truncated; green `N succeeded` summary badge (no enumeration — the list view refresh already shows succeeded rows in their new state); red `<details>` block enumerating failed rows (id + Copy-ID button + canonical `error_code` prose); gray `<details>` block enumerating skipped rows (id + Copy-ID button + server `reason`). Failed section defaults open whenever `failed.length > 0`; skipped section defaults open only when `failed.length === 0 && skipped.length > 0` (failed rows take priority for operator attention). Copy-ID button writes the row id to `navigator.clipboard` with a 2s "Copied" flash; keyed by `copiedId` so adjacent clicks don't race. Uses the same `useFocusTrap(dialogRef)` composable as BulkActionPreviewDialog + ConfirmAction; document-level Escape keydown listener emits `close`; overlay click (click.self on the fixed overlay) emits `close`; explicit Close button emits `close`.
2. **New shared util `src/utils/errorCodeMessages.ts`** — two exports:
   - `formatErrorCode(code?: string, message?: string, context?: Record<string, unknown>): string` — per-row outcome formatter. Known codes (`BUDGET_EXCEEDED`, `INVALID_TRANSITION`, `INTERNAL_ERROR`) render canonical operator-facing prose with server-supplied `message` appended after an em-dash when present. Unknown codes render as `${code}: ${message}` (or bare `${code}` if `message` is empty/whitespace) so operators see the new code verbatim and can paste it into audit filters. Empty code falls back to the `message` alone; empty code + empty message renders `"Unknown error"`. The formatter never throws — the safety test pins arbitrary strings like `"!!!~#$%"` and `"\n\t"`.
   - `formatBulkRequestError(code, itemNounPlural, serverMaxPerRequest, details): string | null` — request-level safety-gate formatter. Returns the canonical string for `LIMIT_EXCEEDED` (embedding `details.total_matched` via `.toLocaleString()` when the server echoes it) and `COUNT_MISMATCH` (capitalized-plural drift explainer). Returns `null` for everything else so callers fall through to their generic `toMessage` formatter.
3. **TenantsView retrofit (`src/views/TenantsView.vue`).** Adds `BulkActionResultDialog` import, `formatBulkRequestError` import, `TenantBulkActionResponse` type import, and a `bulkResult` state ref `{ actionVerb, response } | null`. `executeFilterBulk`'s success branch: (a) replaces `toast.error("... — check console for details")` with `... — see details`, (b) drops the `for (const f of res.failed) console.warn(...)` enumeration, (c) closes the preview dialog first (so its focus trap releases cleanly), then opens `BulkActionResultDialog` whenever `res.failed.length || res.skipped.length`. `executeFilterBulk`'s catch branch: `LIMIT_EXCEEDED` + `COUNT_MISMATCH` now route through `formatBulkRequestError('tenants', 500, e.details)` — the duplicate inline branches are replaced with a single call. Template: new `<BulkActionResultDialog v-if="bulkResult" ...>` element immediately after the `<BulkActionPreviewDialog>` block.
4. **WebhooksView retrofit (`src/views/WebhooksView.vue`).** Identical pattern to TenantsView. Verbs are `"Pause"` / `"Resume"`; noun is `"webhooks"`.
5. **New test `src/__tests__/errorCodeMessages.test.ts`** — 18 specs across two `describe` blocks:
   - Per-row: canonical strings for known codes (`BUDGET_EXCEEDED`, `INVALID_TRANSITION`, `INTERNAL_ERROR` × with/without server-supplied `message`); forward-compat `code: message` rendering for `FUTURE_CODE`; bare-code fallback when message is undefined/whitespace-only; empty-code → `message` fallback; empty-everything → `"Unknown error"`; safety assertions pinning that arbitrary code strings never throw.
   - Request-level: `LIMIT_EXCEEDED` with/without `details.total_matched`; `LIMIT_EXCEEDED` honouring `serverMaxPerRequest` override (500 → 100 for future budget bulk-action's smaller cap); `COUNT_MISMATCH` capitalized-plural rendering (tenants + budgets); `null` return for non-safety-gate codes; `details.total_matched` ignored when non-numeric.
6. **New test `src/__tests__/BulkActionResultDialog.test.ts`** — 11 specs covering succeeded-count summary, failed-row prose with canonical known codes, unknown-code forward-compat (`FUTURE_CODE: new spec`), skipped-row reason rendering, failed-opens-by-default when both sections populated (`details[0].attributes('open')` truthy; `details[1]` undefined), skipped-opens-by-default when failed is empty, Copy-ID button writing to `navigator.clipboard.writeText` (stubbed to a `vi.fn().mockResolvedValue(undefined)` in `beforeEach`) with `Copy ID` → `Copied` label swap after the resolved promise flushes, emits `close` on Close button click, emits `close` on document-level Escape, emits `close` on overlay `click.self`, header `of M matched` suffix rendering when `total_matched > succeeded + failed + skipped`.

**Files.** `src/components/BulkActionResultDialog.vue` (NEW, 138 lines). `src/utils/errorCodeMessages.ts` (NEW, 56 lines). `src/views/TenantsView.vue` (imports + `bulkResult` ref + `executeFilterBulk` rewrites + template insertion). `src/views/WebhooksView.vue` (same pattern). `src/__tests__/errorCodeMessages.test.ts` (NEW, 18 specs). `src/__tests__/BulkActionResultDialog.test.ts` (NEW, 11 specs). `package.json` (`0.1.25.33 → 0.1.25.34`). `package-lock.json` (synced). `docker-compose.prod.yml` (dashboard self-image `.33 → .34`; admin `.28` + server `.13` pins unchanged). `README.md` (compose-example dashboard image `.33 → .34`). `AUDIT.md` (this entry + prepended top-line Date summary).

**Spec alignment.** Unchanged at v0.1.25.25. Slice B is a client-side UX build on top of error codes the spec has catalogued since v0.1.25.23 — no new endpoints, no new wire shapes, no server dependency beyond the already-shipped admin `.28` baseline. Slice C (budget bulk-action, v0.1.25.26) will bump the badge when it lands alongside admin-server `.29`.

**Server compatibility.** Zero server dependency delta. The dialog renders whatever `failed[]` / `skipped[]` the existing `/v1/admin/tenants/bulk-action` and `/v1/admin/webhooks/bulk-action` endpoints already return (shipped in admin v0.1.25.21). `formatErrorCode`'s forward-compat fallback explicitly guarantees that future enum additions to `BulkActionRowOutcome.error_code` render verbatim without a dashboard bump.

**Backward compatibility.** Pure additive UI change. The `console.warn` enumeration is dropped, but none of the dashboard's automated tests or Playwright specs observed those warnings — they were for human operator consumption only, and the new dialog supersedes them with a strictly-better triage surface. Toast summary text changes from `"... — check console for details"` to `"... — see details"`; no tests asserted on the legacy suffix.

**Validation gates (CLAUDE.md).**

- `npm run typecheck` (`vue-tsc -b --noEmit`) — clean.
- `npx vitest run` — **651 / 651 passing** across 51 files (up from 622 / 49 in v0.1.25.33; +29 new specs in this release: 18 in `errorCodeMessages.test.ts`, 11 in `BulkActionResultDialog.test.ts`).
- `npm run build` — clean; 916ms.

### 2026-04-18 — v0.1.25.33: AuditView filter DSL completeness (spec v0.1.25.24)

**Release scope.** Dashboard-only feature release — three AuditView filter upgrades against cycles-governance-admin v0.1.25.24 (admin-server shipped .27). No spec, server, or compose-baseline change; compose admin `.28` + server `.13` pins stay identical to v0.1.25.32. Image published as `ghcr.io/runcycles/cycles-dashboard:0.1.25.33` via the existing `release.yml` tag-push workflow.

**Why now.** The v0.1.25.24 audit filter DSL landed in the admin server on 2026-04-17 (admin `.27`, backfilled in shipped baseline admin `.28`). The dashboard shipped *partial* support in v0.1.25.30: `error_code` IN-list and `status_min`/`status_max` bands — both fully wired. Three v0.1.25.24 features remained dashboard-side gaps:

1. `error_code_exclude` NOT-IN-list — auditors hiding noisy codes (expected TIMEOUTs, scheduled maintenance-window 503s) while keeping all other rows including successes. Absence forced operators to maintain explicit IN-lists that break on newly-added codes.
2. `operation` scalar → array<string> — operators triaging incidents rarely filter by one operation; "show me createBudget OR updateBudget OR closeBudget during the window" is the canonical shape. Scalar-only UI forced three separate queries.
3. `resource_type` scalar → array<string> — same rationale; "tenant OR api_key" is the natural IN-list for permission-rotation audits.

Slice A of the integration plan closes all three against an already-live server DSL. Slices B + C follow.

**What landed on `feat/audit-filter-dsl-completeness-v0.1.25.33`.**

1. **`error_code_exclude` input** — new field in AuditView row 2, left of the Status row. Shares the `audit-error-code-options` datalist with `error_code` so typeahead covers both inputs. Placeholder `"INTERNAL_ERROR, TIMEOUT"`. Per spec semantics, NULL entry `error_code` (success rows) always passes this predicate — hiding noisy codes never silently hides successes.
2. **`operation` array promotion** — input field flipped from scalar to comma-separated. `placeholder="createBudget, updatePolicy"`, `aria-label` advertises the IN-list shape. Wire format `?operation=createBudget,updatePolicy` (explode=false, maxItems 25 server-enforced). Single-token input stays byte-compatible with the pre-.24 scalar shape — OverviewView deep-links and external URL links that pass `?operation=createBudget` continue to work unchanged.
3. **`resource_type` array promotion** — control flipped from `<select>` (hard-coded 6 options) to `<input list="audit-resource-type-options">` with a new `<datalist>` over the same 6 known types (`tenant`, `budget`, `api_key`, `policy`, `webhook`, `config`). Datalist is deliberately non-whitelist: the spec doesn't enum `resource_type`, so servers can add new types without a spec bump. The datalist is a typeahead hint, not a validation gate.
4. **Shared `normalizeList(raw: string)` helper** — de-dupes the four array filters' comma/whitespace splits into one trim/split/filter/dedupe pipeline. Single source of truth for the explode=false wire format across `error_code` / `error_code_exclude` / `operation` / `resource_type`.
5. **Row 2 template restructured.** The old `sm:col-span-2` Status+Submit cell that shared row 2 cols 4–5 was dropped: col 4 now holds the new Error Code (Exclude) input, col 5 is an `md:block` aria-hidden spacer to preserve 5-col grid alignment. Status band chip group + Run Query button moved to a new flex-wrap row 3 so the chips + submit can reflow independently on narrow viewports without colliding with row 2 inputs. `form-label`, focus rings, and dark-mode classes unchanged — visual parity on light + dark.
6. **`applyQueryParams` + URL surface** — `route.query.error_code_exclude` now hydrates the new field on mount and on same-route navigation. `AuditView-url-deeplink.test.ts` extends its `QUERIES` table with three new deep-link scenarios: `?error_code_exclude=…`, `?operation=a,b`, `?resource_type=a,b`.

**Files.** `src/views/AuditView.vue` (inputs + state + `buildFilterParams` + `applyQueryParams`). `src/__tests__/AuditView-filters.test.ts` (+13 specs across three new `describe` blocks). `src/__tests__/AuditView-url-deeplink.test.ts` (+3 smoke scenarios). `package.json` (`0.1.25.32 → 0.1.25.33`). `package-lock.json` (synced). `docker-compose.prod.yml` (dashboard self-image `.32 → .33`). `README.md` (compose-example dashboard image `.32 → .33`). `AUDIT.md` (this entry + prepended top-line Date summary).

**Spec alignment.** Unchanged at v0.1.25.25 — the admin filter DSL landed in spec v0.1.25.24, but the dashboard's spec-badge pin is set by the most recent *end-to-end* supported spec, not the most recent feature-landing spec. Slice B (per-row bulk outcome rendering) and Slice C (budget bulk-action, spec v0.1.25.26) will bump the badge.

**Server compatibility.** Admin-server `.27+` required for the new filter params to take effect; `.28+` is the shipped baseline (pinned in both `docker-compose.prod.yml` and `docker-compose.yml` as of v0.1.25.32). Pre-.27 admins ignore the unknown query params per the additive-parameter guarantee — UI still renders, filters are dropped server-side with no 400, dashboard degrades gracefully to the pre-v0.1.25.24 exact-match behavior.

**Backward compatibility.** OverviewView Recent-Denials pill deep-link (`/audit?error_code=X&status_band=errors`) unchanged. All five pre-existing URL params (`tenant_id`, `key_id`, `operation`, `resource_type`, `resource_id`, `search`, `error_code`, `status_band`) continue to hydrate identically. Scalar-form `?operation=createBudget` parses as a one-element list on both the client and server, so no external deep-link regressions.

**Validation gates (CLAUDE.md).**

- `npm run typecheck` (`vue-tsc -b --noEmit`) — clean.
- `npx vitest run` — **622 / 622 passing** across 49 files (up from 606 in v0.1.25.32; +16 new specs in this release).
- `npm run build` — clean; main `AuditView-*.js` chunk 18.38 kB gzip 5.95 kB (up ~0.1 kB from v0.1.25.32's 18.28 kB — well within noise).

### 2026-04-17 — v0.1.25.32: compose + baseline rollup (admin .28 + server .13 → prod)

**Release scope.** Dashboard-only compose/docs rollup release with zero `src/**` code change. Promotes the cycles-admin `0.1.25.28` audit-sentinel-split baseline and the cycles-server `0.1.25.13` hydration-cap baseline from the dev compose (landed earlier the same day via PR #86) into `docker-compose.prod.yml`, and bumps the dashboard self-image `0.1.25.31 → 0.1.25.32` so the three-way compose baseline is internally consistent on both variants. Governance-spec alignment bumps v0.1.25.24 → v0.1.25.25 (documentation-only spec update — admin `.28` edited the `tenant_id` query-param description to document the sentinel split; no new endpoints, no new wire shapes). Image published as `ghcr.io/runcycles/cycles-dashboard:0.1.25.32` via the existing `release.yml` tag-push workflow.

**Why bump now.** Three reasons rolled into one tag:

1. **Prod–dev compose parity.** PR #86 landed admin `.28` + server `.13` in `docker-compose.yml` (dev) but left `docker-compose.prod.yml` on admin `.27` + server `.12`. Without a prod bump, new compose pulls in prod ship the pre-sentinel-split admin and the pre-hydration-cap server — operators running prod compose today hit the same OOM-risk sorted-list path that dev was already shielded from, and their audit logs keep writing the legacy `<unauthenticated>` sentinel instead of the URL-safe `__unauth__`/`__admin__` pair.

2. **Dashboard image baseline cohesion.** The dashboard image self-pins (`ghcr.io/runcycles/cycles-dashboard:0.1.25.31`) in `docker-compose.prod.yml` decouples from the package.json version only during unreleased work. Every admin+server dependency bump that lands without a dashboard re-tag widens the decoupling window; cutting `0.1.25.32` re-locks the self-image to the prod compose so anyone copying the compose block gets a consistent three-way snapshot.

3. **Admin .28 sentinel split is the right lift-and-ship moment.** The dashboard's `TenantLink.isSystem` guard shipped in v0.1.25.31 to accept both legacy (`<unauthenticated>`) and new (`__unauth__`, `__admin__`) sentinel conventions — specifically to make admin `.28` a drop-in bump with no client code change. Holding the prod bump past the release where client-side compatibility landed just means prod audit drill-downs continue to render broken `/tenants/<unauthenticated>` links (404 on click) unnecessarily. Ship it.

**What landed on `chore/release-v0.1.25.32` (single commit).** No `src/**` code change. File-level edits:

1. `package.json` — `"version": "0.1.25.31"` → `"0.1.25.32"`. `package-lock.json` synced via `npm install --package-lock-only`.
2. `docker-compose.prod.yml` — three image pins bumped on the same branch:
   - `ghcr.io/runcycles/cycles-dashboard:0.1.25.31` → `0.1.25.32` (self-image re-lock).
   - `ghcr.io/runcycles/cycles-server-admin:0.1.25.27` → `0.1.25.28` (audit sentinel split, spec bump to v0.1.25.25).
   - `ghcr.io/runcycles/cycles-server:0.1.25.12` → `0.1.25.13` (hydration cap + Jackson enum wire annotations; no wire-format change).
3. `docker-compose.yml` (dev) — untouched in this commit; already on admin `.28` + server `.13` via PR #86 (commit `7ed79bd`, merged 01:11 UTC on the same calendar day as this release).
4. `README.md` — compose-example dashboard image `0.1.25.31 → 0.1.25.32`; compose-example admin image `0.1.25.27 → 0.1.25.28`; spec badge `v0.1.25.23 → v0.1.25.25` and opening-line spec link (catches a stale README drift — the badge had been left at `.23` through the v0.1.25.30 spec alignment bump to `.24` even though `AUDIT.md` tracked the spec correctly). Compose-example cycles-server image not pinned in README's single-block example (admin + dashboard only), so no corresponding bump there.
5. `AUDIT.md` — this entry, top-line Date summary prepend, and updated `**Requires:**` note with new admin `.28+` + server `.13+` baseline clauses.

**Admin `.28` change summary (from upstream release notes).** Single-purpose release that splits the audit `tenant_id` sentinel `<unauthenticated>` into two URL-safe sentinels:
- `__unauth__` (renamed from `<unauthenticated>`) — pre-auth failures only, unauthenticated-tier TTL (30d), subject to DDoS sampling.
- `__admin__` (new) — admin-key-authenticated requests not scoped to a single tenant (governance ops, cross-tenant reads, admin-plane 4xx/5xx), authenticated-tier TTL (400d), never sampled.

Historical rows with `<unauthenticated>` remain queryable and age out on the unauthenticated-tier schedule (data-layer routes the legacy value via `AuditLogEntry.LEGACY_UNAUTHENTICATED_TENANT`). New `authenticated_actor_type` request attribute stamped by `AuthInterceptor` routes `AuditFailureService` writes to `__admin__` without disturbing downstream controllers' admin-vs-tenant discriminator. URL-safe tokens (double-underscore delimiters) require no percent-encoding; tenant grammar `^[a-z0-9-]+$` excludes underscores so no real-tenant collision. Spec bumped to v0.1.25.25 to document the sentinel split in the `tenant_id` query-param description.

**Dashboard-side impact.** Zero client change required. `TenantLink.vue` already handles all three sentinel conventions — legacy `<unauthenticated>` and new `__unauth__`/`__admin__` both short-circuit on the `isSystem` guard, rendering as an inert label with no drill-down link. v0.1.25.31's regression test suite (`src/__tests__/TenantLink.test.ts`, 5 specs covering `__system__` / `__root__` / `<unauthenticated>` / `<anonymous>` / real tenant ID) continues to pass without modification against admin `.28`'s sentinel values.

**Server `.13` change summary (from upstream release notes).** Two defensive fixes on the v0.1.25.12 sorted-list feature, ported from `cycles-server-admin` v0.1.25.24:
- **P1** — `listReservationsSorted` hydration cap. `SORTED_HYDRATE_CAP = 2000`: labeled break exits the SCAN loop once `matching.size() >= cap`, downstream sort/slice/cursor path operates on the capped slice. Page still fills, `has_more` + `next_cursor` still populate. Legacy no-sort-params path intentionally uncapped (streams page-by-page via the SCAN cursor).
- **P2** — Jackson wire annotations on `ReservationSortBy` + `SortDirection`. `@JsonValue getWire()` + `@JsonCreator fromWire(String)` matching the admin-plane contract. Wire form stays lowercase, parsing stays case-insensitive, `null → null`. Controller-level validation unchanged: unknown tokens still surface as HTTP 400 `INVALID_REQUEST`.

**Dashboard-side impact.** Zero client change required. The client already sends `sort_by`/`sort_dir` lowercase per the wire contract from v0.1.25.25 (`useSort` composable), and the hydration cap is a server-internal heap-safety bound — the client observes identical `has_more` + `next_cursor` semantics and continues to page through the capped slice. Tenants above ~2000 matching reservations under a given sort tuple should narrow filters (existing operator guidance — `status`, `idempotency_key`, scope segments), which the `ReservationsView` filter toolbar already surfaces.

**Version bumps.** `package.json` `0.1.25.31 → 0.1.25.32`; `package-lock.json` synced via `npm install --package-lock-only`; `docker-compose.prod.yml` dashboard `0.1.25.31 → 0.1.25.32` + cycles-admin `0.1.25.27 → 0.1.25.28` + cycles-server `0.1.25.12 → 0.1.25.13`; `docker-compose.yml` (dev) untouched (already on admin `.28` + server `.13` from PR #86); `README.md` compose-example dashboard `0.1.25.31 → 0.1.25.32` + cycles-admin `0.1.25.27 → 0.1.25.28` + spec badge `v0.1.25.23 → v0.1.25.25` + opening-line spec-link version.

**Validation gates (CLAUDE.md).**

- `npm run typecheck` (`vue-tsc -b --noEmit`) — clean.
- `npx vitest run` — **606 / 606 passing** across 49 files (unchanged from prior tag — no code change, no new specs).
- `npm run build` — clean.

### 2026-04-17 — URL deep-link smoke test harness (5 views)

**Scope.** Dashboard-only test-coverage addition. No spec change, no server change, no user-visible behavior change. No version bump — this is additive test surface that rides alongside the existing `TenantsView-status-deeplink.test.ts` regression (shipped with v0.1.25.31's TDZ fix) to pin the same class of blank-page bug across every other list view.

**Why.** The TenantsView `?status=ACTIVE` TDZ ReferenceError that produced blank pages (fixed in PR #84 / commit `3751ff9`) is a pattern bug, not a one-off: any view that reads `route.query.*` on mount into a `const` ref via an `immediate: true` watcher can TDZ-crash before the ref is declared. The existing test harness caught Tenants only; sibling views (Webhooks / Reservations / Budgets / Events / Audit) had no equivalent coverage. Without it, a future refactor could reintroduce the same blank-page regression on a different URL surface (e.g. the Overview "Recent Denials" pill → `/audit?error_code=X&status_band=errors`) and ship past CI.

**What shipped.** Five new test files under `src/__tests__/`, one per view that consumes URL query params:

- `WebhooksView-url-deeplink.test.ts` — 7 specs covering `?status=ACTIVE/PAUSED/DISABLED`, `?status=BOGUS` (unknown value ignored), `?failing=1`, `?failing=true`, `?failing=1&status=ACTIVE` combo.
- `ReservationsView-url-deeplink.test.ts` — 5 specs covering `?status=ACTIVE/COMMITTED/RELEASED/EXPIRED` + `?status=BOGUS`.
- `BudgetsView-url-deeplink.test.ts` — 8 specs covering `?status=ACTIVE/FROZEN/CLOSED`, `?filter=over_limit`, `?filter=has_debt`, `?filter=BOGUS`, combo, and detail-mode `?scope=tenant:acme/*&unit=USD_MICROCENTS` (exercises the `lookupBudget` + `listEvents` branch).
- `EventsView-url-deeplink.test.ts` — 8 specs covering every URL-consumed filter (`?category`, `?type`, `?tenant_id`, `?scope`, `?correlation_id`, `?search`, `?from&to` time range, combo).
- `AuditView-url-deeplink.test.ts` — 13 specs covering every URL-consumed filter (`?tenant_id`, `?key_id`, `?operation`, `?resource_type`, `?resource_id`, `?search`, `?error_code`, all four valid `?status_band` values, `?status_band=BOGUS` defensive, and a 3-way combo).

Each spec mounts the view with a specified `route.query` shape and asserts the `<h1>` renders — catches TDZ crashes, null-derefs, unhandled promise rejections from mock-shape mismatches, and anything else that would leave the mount in a broken state. Total: **41 new specs** across 5 files. Mock pattern is shared across all five: hoisted `routeRef` object for `useRoute`, inline `useRouter` push/replace vi.fns, passthrough `usePolling` / `useDebouncedRef` that don't need async ticks, and a `@tanstack/vue-virtual` shim that returns non-virtualized item lists so the mount still renders rows when the mock resolves with data.

**Caught during authoring.** WebhooksView mock initially returned `{ webhooks: [] }` but the view reads `wRes.subscriptions` — the test passed but logged 7 unhandled TypeErrors from `filteredWebhooks` computed. Fixed by correcting the mock shape to `{ subscriptions: [], has_more: false }`. Same class of mock-drift bug that would have silently passed in a naive assertion-only test — the run-output unhandled-rejection line is what surfaced it.

**Files.** `src/__tests__/WebhooksView-url-deeplink.test.ts` (new). `src/__tests__/ReservationsView-url-deeplink.test.ts` (new). `src/__tests__/BudgetsView-url-deeplink.test.ts` (new). `src/__tests__/EventsView-url-deeplink.test.ts` (new). `src/__tests__/AuditView-url-deeplink.test.ts` (new). `AUDIT.md` (this entry).

**Validation gates (CLAUDE.md).**

- `npm run typecheck` (`vue-tsc -b --noEmit`) — clean.
- `npx vitest run` — **606 / 606 passing** across 49 files (+41 / +5 from the prior 565 / 44 total).
- `npm run build` — clean, 978ms.

### 2026-04-17 — v0.1.25.31: Overview post-.30 polish + TenantLink sentinel handling + admin-server baseline tightening

**Release scope.** Dashboard-only polish release that closes the consistency gaps surfaced by operator review of the new "What needs attention" landing page (shipped three hours earlier as v0.1.25.30), plus one small bug-class fix on `TenantLink` that prevented broken drill-downs from audit rows where a pre-auth request 401'd before key→tenant resolution. Five post-.30 commits ride this tag; no spec change, no server-contract change, no new governance-spec version. Admin-server baseline tightens from **recommended v0.1.25.27+** to **required v0.1.25.27+** — `docker-compose.yml` (dev stack) bumps `cycles-admin 0.1.25.26 → 0.1.25.27` to match `docker-compose.prod.yml`, so every user running either compose variant gets the matching admin-server out of the box. Image published as `ghcr.io/runcycles/cycles-dashboard:0.1.25.31` via the existing `release.yml` tag-push workflow.

**Why bump now.** v0.1.25.30 shipped the Overview rewrite and went straight into operator review. Five tightly-coupled consistency gaps surfaced (three budget cards had drifted into three different shapes; non-budget cards didn't match row density; counter-strip titles were visibly smaller than alert-card titles; title casing was inconsistent across cards; Expiring Keys used `text-yellow-*` while the rest of the card palette was `text-amber-*`). Plus a separate TenantLink bug where `<unauthenticated>` rendered as a drill-down link to `/tenants/<unauthenticated>` (404). All five polish items + the TenantLink fix touch the same user-visible landing-page surface that v0.1.25.30 introduced, so shipping them in one tag keeps the changelog coherent and lets on-call runbooks point at "v0.1.25.31+" for the polished experience.

**What landed across 5 commits on `feat/overview-what-needs-attention-I1`.**

1. **Budgets-at-Cap card widened** from the spec's narrow `over_limit` semantics (debt > overdraft_limit) to `utilization_min=0.9`, so exhausted-without-debt AND approaching-cap (90–99%) budgets surface on the landing page before they blow. Card-level severity adapts to "at or near cap" vs "near cap" based on the worst row; row metric encodes per-budget severity (red ≥100%, amber 90–99%); cap at 5 rows with `py-1.5` density. Unblocks the "tenant hit 95% spend two hours before the incident — why didn't Overview flag it?" post-mortem from the v0.1.25.30 review.
2. **Three budget cards grouped on row 1** of the 6-card grid. "State of budgets" is the single most-asked ops question at 2am, so Budgets at or near cap / Budgets with debt / Frozen budgets form the top row; non-budget signals (Failing webhooks / Expiring API keys / Recent denials) form row 2. Pure reordering — no new data fetches.
3. **All three budget cards list top-5 scopes inline.** Frozen Budgets was a center hyperlink ("View N frozen budgets") with no scope names; rewrote to match the at-cap + with-debt inline-list pattern. New `listBudgets?status=FROZEN&limit=10` fetch added to the Overview's parallel `Promise.allSettled` chain (5 fetches now). Graceful-degradation fallback: if the FROZEN fetch rejects but `overview.budget_counts.frozen > 0`, the card shows "N frozen budgets — details unavailable" instead of contradicting the banner axis pill. Budgets with Debt sliced to 5 via `debtScopesSorted` for parity.
4. **Non-budget cards sliced to 5 + row padding normalized.** Failing Webhooks and Recent Denials were rendering the full server list (up to 10 rows) at `py-2` while budget cards + Expiring Keys were at 5 rows / `py-1.5`. Added `failingWebhooksSorted` + `recentDenialsSorted` computeds, brought all non-budget cards to `py-1.5`. **Counter-strip tile titles bumped** from `text-xs muted` to `text-sm font-medium text-gray-700 dark:text-gray-200 hover:underline` to match alert-card `<h2>` typography — the counter strip now reads as quick-jump nav in the same design system rather than "a different product".
5. **Typographic + micro-color consistency sweep.** All 7 card `<h2>` titles flipped to sentence case ("Budgets At or Near Cap" → "Budgets at or near cap", "Budgets with Debt" → "Budgets with debt", etc., with "API" preserved as acronym in "Expiring API keys"). Banner pill "Keys expiring" → "Expiring keys" to match adj+noun shape of sibling axes. `tabular-nums` added to Failing Webhooks failure count + Expiring Keys day count (every right-column numeric metric is now monospaced-digit). Expiring Keys 3–7d range `text-yellow-*` → `text-amber-*` to align with the card's border/icon/badge/banner pill (red `<=2d` urgency signal preserved). Recent Operator Activity rows `py-2 → py-1.5` to match Recent Denials (same two-line shape).
6. **TenantLink sentinel handling.** `isSystem` guard extended from `__`-prefixed only (`__system__`, `__root__`) to also match angle-bracket-wrapped placeholders (`<unauthenticated>`, and any `<x>` future-proofing). Audit rows where a pre-auth request 401'd before key→tenant resolution no longer render a broken drill-down link to `/tenants/<unauthenticated>` (404 on click). One component change flows through every `TenantLink` caller (AuditView, EventsView, BudgetsView, ApiKeysView, WebhooksView, WebhookDetailView, EventTimeline). New `src/__tests__/TenantLink.test.ts` pins both sentinel conventions (5 specs: real tenant_id drills / `__system__` non-drillable / `__root__` non-drillable / `<unauthenticated>` non-drillable / `<anonymous>` non-drillable future-proofing).
7. **Admin-server baseline tightened.** `docker-compose.yml` (dev stack) cycles-admin image pin `0.1.25.26 → 0.1.25.27` to match `docker-compose.prod.yml`. The v0.1.25.30 "recommended v0.1.25.27+" requirement becomes the shipped baseline — both compose variants now pull .27 by default, so AuditView error_code + status_band filters and the OverviewView Recent-Denials pill drill-down work out of the box for every new install without a post-up manual image swap.

**Files touched across the release.** `src/views/OverviewView.vue` (budget cards widened + regrouped + all three list top-5 inline with fallback; non-budget cards sliced + padded + title-normalized; counter-strip title typography bumped; tabular-nums + amber/yellow polish). `src/components/TenantLink.vue` (`isSystem` extended to angle-bracket sentinels + comment block documenting both conventions). `src/__tests__/OverviewView.test.ts` (+8 new specs across new describe blocks — non-budget cards cap-at-5, frozen list inline + cap-at-5 + degradation fallback + healthy empty, debt slice-to-5, listBudgets?status=FROZEN param check; 3 existing specs updated for Title→sentence case and "Failing Webhooks" → "Failing webhooks" rename; +`#failing-webhooks` presence check on graceful-degradation specs). `src/__tests__/TenantLink.test.ts` (new, 5 specs). `docker-compose.yml` (cycles-admin `0.1.25.26 → 0.1.25.27`). `docker-compose.prod.yml` (dashboard `0.1.25.30 → 0.1.25.31`). `package.json` + `package-lock.json` (version bump + lockfile sync). `README.md` (dashboard image pin `0.1.25.30 → 0.1.25.31`). `AUDIT.md` (this entry + top-line summary + Requires note).

**Version bumps.** `package.json` `0.1.25.30 → 0.1.25.31`; `package-lock.json` synced via `npm install --package-lock-only`; `docker-compose.prod.yml` dashboard image pin `0.1.25.30 → 0.1.25.31`; **`docker-compose.yml` (dev stack) cycles-admin pin `0.1.25.26 → 0.1.25.27`** (baseline tightening — only compose file getting an admin-server bump since prod was already on .27); `README.md` compose-example dashboard image `0.1.25.30 → 0.1.25.31`. Spec badge unchanged at v0.1.25.24. Governance-spec alignment unchanged.

**Validation gates (CLAUDE.md).**

- `vue-tsc --noEmit` — clean.
- `vitest run` — **561 / 561 passing** across 43 files (+13 new across 5 commits in this release: +2 for non-budget cap-at-5 on Failing Webhooks + Recent Denials; +6 for frozen list/cap/fallback + debt slice + FROZEN fetch param check; +5 for TenantLink sentinel coverage across both conventions; 3 existing specs updated for Title→sentence case).
- `vite build` — clean, 943ms.

### 2026-04-17 — v0.1.25.30: Overview rebuilt as "What needs attention" (I1 + I3) + recent_denials_by_reason surface + Events Type filter visibility

**Release scope.** Dashboard-only landing-page rewrite plus four follow-on consistency + wire-up passes (the last one — audit filter DSL — taps v0.1.25.24 spec features that landed in admin-server v0.1.25.27). Governance-spec alignment bumps v0.1.25.23 → v0.1.25.24; admin-server recommended requirement bumps v0.1.25.26+ → v0.1.25.27+ for the new audit filter dimensions (pre-.27 servers still accept the dashboard traffic, they just ignore the unknown params per the additive-parameter guarantee). Image published as `ghcr.io/runcycles/cycles-dashboard:0.1.25.30` via the existing `release.yml` tag-push workflow.

**Why bump now.** The Overview rewrite is a user-visible landing-page change that shifts what every operator sees on login — we cut a version so on-call teams can point runbooks at "v0.1.25.30+" for the new alert-first headline and the expanded per-tile chip breakdowns. Three smaller polish items rode the same release bus because they all touch the same Overview / Events surface and shipping them in one tag keeps the changelog coherent.

**What landed across 8 commits on `feat/overview-what-needs-attention-I1`.**

1. **Overview "What needs attention" rebuild (I1 + I3).** Alert-first headline banner ("**N area(s) need attention**" vs "**All clear**") composed over 6 axes. Six alert cards (Failing Webhooks / Over-limit Budgets / Budgets with Debt / Expiring API Keys / Frozen Budgets / Recent Denials) with count badges + deep-link router-links when firing, reassurance copy when healthy. New Expiring API Keys (7d) card with pure-fn `src/utils/expiringKeys.ts` + 10 unit tests. New Recent Operator Activity card (closes **I3**) via `listAuditLogs({ limit: 10 })`. `Promise.allSettled` per-axis so a flaky endpoint surfaces inline without blanking the page.
2. **Counter tiles preserved as a compact 4-up strip under the status banner** — symmetrical per-tile chip breakdown (Tenants ACTIVE/SUSPENDED/CLOSED, Budgets ACTIVE/FROZEN/DEBT, Webhooks ACTIVE/PAUSED/DISABLED, Events by category). Chips drill down to filtered list views via new `?status=` URL params on TenantsView / WebhooksView (+ `?failing=1` on WebhooksView since failure-count is derived, not a status enum). Zero-count chips omitted. Color taxonomy centralized in `src/style.css` via `.chip-{success,warning,danger,neutral,category}`. A mid-bake iteration relocated the strip to the bottom; operator review overturned that and kept the top-of-page quick-jump per Linear/GitHub/Grafana convention.
3. **Webhook tile Paused chip** — breakdown had been `active + disabled`, missing the paused bucket; now derived as `paused = max(0, total - active - disabled)` so the chip row sums to total.
4. **Recent Reservation Expiries (1h) card dropped** from Overview (wrong-plane link to `/events?type=reservation.expired`, near-always empty on healthy systems). Grid collapses to single-column for Recent Operator Activity. `ReservationsView` gains defensive `?status=` URL param wiring validated against `RESERVATION_STATUSES` so the follow-up Reservations tile lands without another view change. Guard test ensures the old card stays removed.
5. **`recent_denials_by_reason` surface** (v0.1.25.8+). Server was already populating this field on every `/v1/admin/overview` call (`AdminOverviewService.java:93–104`); dashboard was silently dropping it because `src/types.ts` didn't declare it. Added `AdminOverviewResponse.recent_denials_by_reason?: Record<string, number>`, `denialReasons` computed sorts entries desc by count, pill row above the per-row denial list using `.chip-danger` with `×N` tabular-nums + `title` tooltip. `v-if="denialReasons.length > 0"` so pre-v0.1.25.8 servers render nothing. **Deferred** — clickable pill → `/events?reason=…` deep-link requires either extending `listEvents` server-side `search` to match `data.reason_code` or adding a first-class `reason` query param, both of which need a spec bump.
6. **Recent Operator Activity operation format** flipped from `humanizeOperation()`-capitalized ("Tenant Suspended") back to raw enum in `font-mono text-xs` ("tenant.suspended") so it matches AuditView's column renderer (`AuditView.vue:409`) verbatim. Operator can now copy-paste the enum to use as an Audit filter. `:title="a.operation"` tooltip preserved.
7. **EventsView Type filter field** — the filter toolbar had no Type input, so deep-links like `/events?type=reservation.denied` (set by the Overview "Recent Denials → View all" click) silently filtered with no operator-visible cue. Added visible Type input between Category and Tenant ID, bound to the existing `eventType` ref which already reads from `route.query.type` on mount.
8. **EventsView Type filter datalist typeahead** over all 40 spec enum values. `<datalist id="ev-type-options">` populated from the pre-existing `EVENT_TYPES` constant at `src/types.ts:415`. Free-text entry still accepted so `custom.*` prefixed types (per spec extensibility rule at `cycles-governance-admin-v0.1.25.yaml:2234`) remain filterable. Zero new dependencies.
9. **AuditView filter DSL wire-up (v0.1.25.24 listAuditLogs).** Adds the two most-asked operator slices to AuditView: (a) an **Error Code** input with `<datalist>` typeahead over the 29-value `ErrorCode` enum, comma or whitespace-separated to form the IN-list; (b) a **Status** select with five preset bands (All / 2xx Success / 4xx+5xx Errors / 4xx Client / 5xx Server) that map to `status_min/status_max`. `buildFilterParams` normalizes the error_code input (trim / split on comma or whitespace / drop empties / dedupe / comma-join for the `explode=false` wire format) and emits the range params on band selection. The dashboard never sends exact `status`, so the spec's status-exact ↔ range mutex is sidestepped by construction — no client-side validation needed. Search field placeholder + aria-label updated to advertise the widened v0.1.25.24 match set (`resource_id, log_id, error_code, operation`). `applyQueryParams` consumes `?error_code=` and `?status_band=` from the URL so Overview's Recent-Denials pill deep-link lands on a pre-filtered query. New `ERROR_CODES` const exported from `src/types.ts` mirrors the spec enum so typeahead values stay in lockstep with the wire contract. Unblocks the deferred drill-down noted in the `recent_denials_by_reason` entry — **each reason pill on OverviewView now renders as a `<router-link>` to `/audit?error_code=CODE&status_band=errors`** rather than an inert `<span>`, closing the "12 denials with reason X → who do I blame?" loop in one click.

**Files touched across the release.** `src/views/OverviewView.vue` (rewrite + denial-pill router-links), `src/views/EventsView.vue` (+ Type input, + datalist, + EVENT_TYPES import), `src/views/AuditView.vue` (+ Error Code input with datalist, + Status band select, + URL wiring for `error_code` and `status_band`, + search placeholder/aria-label updates), `src/views/TenantsView.vue` (+ `?status=` URL wiring), `src/views/WebhooksView.vue` (+ `?status=` + `?failing=1` + Failing-only checkbox), `src/views/ReservationsView.vue` (+ defensive `?status=` wiring), `src/utils/expiringKeys.ts` (new), `src/types.ts` (+ `recent_denials_by_reason` field, + `ERROR_CODES` const mirroring the spec ErrorCode enum), `src/style.css` (+ `.chip-{success,warning,danger,neutral,category}` + dark variants), tests in `src/__tests__/OverviewView.test.ts` (+ 3 denial-link specs), `src/__tests__/AuditView-filters.test.ts` (new, 17 specs), `src/__tests__/expiringKeys.test.ts`.

**Version bumps.** `package.json` `0.1.25.29 → 0.1.25.30`; `package-lock.json` synced via `npm install --package-lock-only`; `docker-compose.prod.yml` dashboard image pin `0.1.25.29 → 0.1.25.30` **and cycles-admin image pin `0.1.25.26 → 0.1.25.27`** (new baseline required for the audit filter DSL); `README.md` compose-example dashboard image `0.1.25.29 → 0.1.25.30` **and admin `0.1.25.26 → 0.1.25.27`**. Spec badge tracks v0.1.25.24. `docker-compose.yml` (dev stack) intentionally not bumped — uses local `build:` rather than the published image.

**Validation gates (CLAUDE.md).**

- `vue-tsc --noEmit` — clean.
- `vitest run` — **505 / 505 passing** across 40 files (+58 new across 4 commits in this release: 32 for the I1/I3 rebuild covering alert-banner states / Expiring Keys / Recent Activity / counter-strip DOM order / per-tile chip layout / zero-count omission / graceful degradation; +3 for `recent_denials_by_reason` populated-sorted-desc + absent-field + empty-object; +1 guard that the old expiries card stays removed; +2 for raw-enum operation format matching AuditView; **+17 for the new AuditView filter DSL** covering error_code normalization / IN-list dedupe / whitespace-separated parsing / datalist enum coverage / all five status-band mappings / mutex-sidestep / search field copy / URL-param deep-link including unknown-band defensive fallback; **+3 for the Overview denial-pill router-link drill-down** asserting anchors render with href + route name + query payload + title tooltip).
- `vite build` — clean, 897ms.

### 2026-04-17 — Overview row 1: all three budget cards now list top-5 scopes inline (consistency pass)

**Scope.** Dashboard-only, parity polish across the three budget cards on the Overview attention grid. No spec or server change.

**Why.** The three budget cards on row 1 had drifted into three different shapes: Budgets At or Near Cap lists scopes with utilization %, Budgets with Debt lists scopes with debt/limit numerics, but **Frozen Budgets** rendered as a single center hyperlink ("View N frozen budgets") with no scope names. Operators flagged the inconsistency — the whole point of grouping the three on one row is so "state of budgets" reads as one scan, but the Frozen card was forcing a click-through just to see *which* budgets were frozen. Fixed by giving Frozen Budgets the same inline-list treatment as its siblings.

**What shipped.**

- **New `listBudgets?status=FROZEN&limit=10` fetch** added to the Overview's parallel `Promise.allSettled` chain (5 fetches now). Scopes populate a new `frozenBudgets` ref; `frozenSorted` computed sorts alphabetically by scope and slices to 5 for display parity with Budgets At or Near Cap.
- **Frozen Budgets card rewrite.** Center link → inline list of scope rows. Each row shows `scope` + `allocated amount` (the sensible secondary since "frozen" is a binary state, not a magnitude like utilization or debt).
- **Budgets with Debt now slices `debt_scopes` to 5** via `debtScopesSorted` computed, matching the row cap on the other two budget cards. Server already sorts desc by debt so worst-first is preserved. Row padding `py-2 → py-1.5` for density parity.
- **Frozen card graceful-degradation fallback.** If `listBudgets?status=FROZEN` rejects but `overview.budget_counts.frozen > 0`, the card shows "N frozen budgets — details unavailable" instead of silently rendering "No frozen budgets" — the card no longer contradicts the banner axis pill during a partial outage. Healthy empty state ("No frozen budgets") now requires both the list AND the count to be zero.
- **Axis wiring unchanged.** The frozen-budgets alert axis still keys off `overview.budget_counts.frozen > 0`, not the list length, so the axis fires even if the scope-details fetch fails — the banner + card stay in sync via the fallback copy.

**Files.** `src/views/OverviewView.vue` (+ `frozenBudgets` ref, + 5th `listBudgets?status=FROZEN` fetch in usePolling, + `frozenSorted` / `debtScopesSorted` computeds, Frozen card template rewrite with fallback, Budgets with Debt v-for switched to `debtScopesSorted` + `py-1.5`). `src/__tests__/OverviewView.test.ts` (+6 new specs across two new describe blocks — frozen list renders inline with allocated amount / frozen cap-at-5 / frozen degradation fallback / frozen healthy empty / debt card slice to 5 / new listBudgets status=FROZEN param check; 1 existing `toHaveBeenCalledTimes(1)` spec updated to expect 2 calls and match by param shape).

**Validation gates.**

- `vue-tsc --noEmit` — clean.
- `vitest run` — **554 / 554 passing** across 42 files (+6 from 548).
- `vite build` — clean, 923ms.

**No version bump.** Cross-card parity polish on the same attention grid shipped earlier today — no wire-format change, no URL-contract change (uses the existing `listBudgets` status filter). AUDIT entry only.

### 2026-04-17 — Overview cross-card consistency: non-budget cards slice to 5 + tighten padding + counter-strip title sizing

**Scope.** Dashboard-only, second parity pass on the same "What needs attention" grid plus the counter-strip directly below the status banner. No spec or server change.

**Why.** Operator review surfaced two remaining inconsistencies after the budget-cards pass:

1. **Non-budget alert cards didn't match the budget cards.** Failing Webhooks and Recent Denials rendered the full server-returned list (up to 10 rows) with `py-2` padding, while the three budget cards and Expiring Keys had converged on "top-5 inline, py-1.5". So a grid that was supposed to read as six equivalently-shaped attention cards actually had three heights and two row-densities.
2. **Counter-strip tile titles were visibly smaller than alert-card titles.** The four tile labels (Tenants / Budgets / Webhooks / Events) used `text-xs muted`, while all six alert cards and the Recent Operator Activity card used `text-sm font-medium text-gray-700`. On a landing page this read as "the counter strip is a different product" rather than "the counter strip is quick-jump nav in the same design system".

**What shipped.**

- **Failing Webhooks card** gains a `failingWebhooksSorted` computed that slices `overview.failing_webhooks` to 5. The `webhook_counts.with_failures` aggregate still flows through the axis badge + banner pill, so the full count stays visible while the card depth matches its neighbors.
- **Recent Denials card** gains a `recentDenialsSorted` computed that slices `overview.recent_denials` to 5 (server caps the list at 10, so "top 5" is a real reduction). Axis badge continues to show the server-returned list length.
- **Row padding normalized to `py-1.5`** on all three non-budget alert-grid cards (Failing Webhooks / Expiring API Keys / Recent Denials). Budget cards already use `py-1.5` from the earlier pass — the entire grid now reads as one density.
- **Counter-strip tile titles bumped** from `text-xs muted hover:text-gray-700 hover:underline` to `text-sm font-medium text-gray-700 dark:text-gray-200 hover:underline` — identical to alert-card `<h2>` typography. The parenthetical time-window span inside the Events tile (`(60m)`) flips from bare `font-normal` to `muted font-normal` to preserve the same weight relationship the Expiring API Keys card uses (`(7d)` muted).
- **Recent Operator Activity card unchanged** — two-line rows (operation + timestamp + metadata) genuinely warrant the extra breathing room of `py-2`; collapsing it would crowd the sub-line.

**Files.** `src/views/OverviewView.vue` (+ `failingWebhooksSorted` / `recentDenialsSorted` computeds; 4 v-for loops updated; 4 counter-strip tile title classes updated; 3 row-padding `py-2 → py-1.5` edits). `src/__tests__/OverviewView.test.ts` (+2 new specs in a new "landing-card row caps" describe block — Failing Webhooks caps at 5 with full count on badge / Recent Denials caps at 5 with full count on badge).

**Validation gates.**

- `vue-tsc --noEmit` — clean.
- `vitest run` — **556 / 556 passing** across 42 files (+2 from 554).
- `vite build` — clean, 906ms.

**No version bump.** Same-day parity polish on the same attention grid. AUDIT entry only.

### 2026-04-17 — Overview consistency sweep: card titles to sentence case + tabular-nums parity + amber/yellow normalization

**Scope.** Dashboard-only, typographic + micro-color consistency across all 7 landing-page cards (+ Recent operator activity) and the alert banner. No behavioral change, no spec or server change.

**Why.** Review of the post-slice-to-5 layout surfaced five small but non-trivial inconsistencies that were eye-dragging across the seven cards of the landing page:

1. **Card title case was mixed.** "Budgets **At** or Near Cap" capitalized its small words while "Budgets **with** Debt" correctly lowercased them — internal conflict in the same row. Sister cards ("Frozen Budgets", "Failing Webhooks", "Expiring API Keys", etc.) were Title Case, but the page subtitle ("What needs attention") and every banner pill label already used sentence case, so the cards were the odd ones out.
2. **`tabular-nums` was missing** on two of the six numeric secondary columns (Failing Webhooks "N failures", Expiring Keys "Nd"), which meant those right-column metrics wobbled as the digit count shifted between rows while Budgets At-or-Near-Cap / Debt / Frozen / Denial-timestamps all sat on a fixed grid.
3. **Expiring Keys day count used Tailwind `yellow`** while the card's border, icon, badge, and banner pill all use `amber` — yellow and amber are different hues in Tailwind (yellow is brighter/more saturated), so the row metric visibly didn't match the card's own severity framing.
4. **Recent Operator Activity rows were `py-2`** while Recent Denials (same two-line row shape — primary + timestamp on line 1, sub-line beneath) used `py-1.5`. Both are two-liners; there's no reason for the two cards to have different densities.
5. **Banner pill label "Keys expiring"** broke the adjective-then-noun pattern of its siblings ("Failing webhooks", "Frozen budgets", "Recent denials") — reads as a different grammatical shape.

**What shipped.**

- **Seven card `<h2>` titles flipped to sentence case.** "Budgets At or Near Cap" → "Budgets at or near cap"; "Budgets with Debt" → "Budgets with debt"; "Frozen Budgets" → "Frozen budgets"; "Failing Webhooks" → "Failing webhooks"; "Expiring API Keys (7d)" → "Expiring API keys (7d)" (API preserved as acronym); "Recent Denials (1h)" → "Recent denials (1h)"; "Recent Operator Activity" → "Recent operator activity". Now internally consistent, 1:1 with banner pills, and matches the page subtitle.
- **Banner pill "Keys expiring" → "Expiring keys"** to match the `adjective + noun` shape of the other axis labels.
- **`tabular-nums` added** to Failing Webhooks failure count + Expiring Keys day count — every right-column numeric metric on the landing page is now monospaced-digit.
- **Expiring Keys day-count `text-yellow-*` → `text-amber-*`.** The red `<=2d` threshold stays red (that's the urgent signal); the `3–7d` range now reads amber, aligning with the card's border + icon + badge + banner pill.
- **Recent Operator Activity rows `py-2` → `py-1.5`** to match Recent Denials (same two-line shape). The whole alert grid + the activity strip below now share a single row-height.

**Files.** `src/views/OverviewView.vue` (7 h2 title edits, 1 banner label edit, 2 tabular-nums additions, 1 yellow→amber swap, 1 padding edit). `src/__tests__/OverviewView.test.ts` (3 test assertions updated from "Failing Webhooks" to "Failing webhooks" via `replace_all`; the two graceful-degradation specs now additionally assert on the card `#failing-webhooks` id to disambiguate card-rendered-vs-banner-rendered).

**Validation gates.**

- `vue-tsc --noEmit` — clean.
- `vitest run` — **556 / 556 passing** across 42 files (no test count change — same 556 as the last commit, just different expected strings).
- `vite build` — clean, 885ms.

**No version bump.** Pure typographic + micro-color polish with no wire-format or URL-contract change. Same-day consistency sweep following the card-shape + counter-strip-title work earlier in the day. AUDIT entry only.

### 2026-04-17 — TenantLink: treat `<unauthenticated>` (and any angle-bracket sentinel) as non-drillable

**Scope.** Dashboard-only, one-component fix that flows to every caller of `TenantLink` (AuditView, EventsView, BudgetsView, ApiKeysView, WebhooksView, WebhookDetailView, EventTimeline). No spec or server change.

**Why.** `TenantLink.vue` already treated `__`-prefixed strings (`__system__`, `__root__`) as non-drillable italic text — clicking a platform-scoped placeholder would 404 against `/tenants/__system__`. But the admin server emits a second sentinel convention — angle-bracket-wrapped strings like `<unauthenticated>` — for audit rows where a pre-auth request 401'd before the key → tenant resolution ran. Those were slipping through the `isSystem` guard and rendering as live `router-link`s, so an operator clicking an `<unauthenticated>` entry on the Audit view landed on a broken `tenant-detail` route for a literal `<unauthenticated>` id.

**What shipped.**

- **`isSystem` extended** to match either underscore-wrapped (`__x`) OR angle-bracket-wrapped (`<x>`) sentinels. The angle-bracket form is a general convention (Python repr style, common in logs and placeholder values), so any future `<anonymous>` / `<system>` / similar is handled defensively without another change.
- **Comment block on the sentinel list** so the next reader knows which server convention each form covers (`__x` = platform-scoped; `<x>` = unresolvable-at-the-time).
- **New `src/__tests__/TenantLink.test.ts` spec file** (5 cases) pinning: real tenant_id drills down / `__system__` renders italic / `__root__` renders italic / `<unauthenticated>` renders italic / arbitrary `<anonymous>` also renders italic. Component had no dedicated test before.

**Files.** `src/components/TenantLink.vue` (isSystem extended + comment). `src/__tests__/TenantLink.test.ts` (new).

**Validation gates.**

- `vue-tsc --noEmit` — clean.
- `vitest run` — **561 / 561 passing** across 43 files (+5 from 556, all in the new TenantLink spec file).
- `vite build` — clean, 943ms.

**No version bump.** Bug-fix polish that prevents a broken drill-down from Audit/Events/etc. AUDIT entry only.

### 2026-04-17 — Overview Budgets At or Near Cap card: cap display at 5 rows + tighten row padding

**Scope.** Dashboard-only, density polish on the just-widened at-or-near-cap card. No spec or server change.

**Why.** With the 90% threshold the card can realistically hold up to 10 rows on a busy tenant, and at `py-2` row padding that stretches the card well past the two sibling budget cards — the row reads as empty-space dominated. Two low-risk fixes: cap display at 5 (matching the Expiring Keys card which already caps at 5) and drop row padding `py-2 → py-1.5` since budget rows are single-line (scope + %) and don't need the same vertical breathing room as webhook / denial rows that carry URLs or timestamps.

**What shipped.**

- **Client-side slice to 5** in the `atCapSorted` computed after sort-by-utilization-desc. Server `limit=10` unchanged (gives us buffer if any of the top 10 tie on utilization and scope tiebreak shifts). The top-5 worst render; the rest are implicit in the "View all" link.
- **Banner count stays honest.** The badge + pill count reflect the full `atCapBudgets.length`, not the sliced 5, so operators see "7 at or near cap" in the banner even though the card only shows 5 — the truncation isn't a lie about severity.
- **Row padding `py-2 → py-1.5`** scoped to this card only. Other cards untouched (webhook URLs, denial scopes, and audit operation rows still get the full `py-2`). Border-b between rows preserved.

**Files.** `src/views/OverviewView.vue` (`.slice(0, 5)` in computed, `py-2 → py-1.5` on the v-for row). `src/__tests__/OverviewView.test.ts` (+1 new spec pinning the 5-row cap + banner-count-reflects-full-set invariant — render 8 ledgers, assert 5 rows, assert tenant-0 at top, assert tenant-7 absent, assert banner pill shows ·8).

**Validation gates.**

- `vue-tsc --noEmit` — clean.
- `vitest run` — **548 / 548 passing** (+1 from 547 — row-cap spec).
- `vite build` — clean, 906ms.

**No version bump.** Density polish on the same card shipped earlier today — no behavior change, no wire-format change, no URL-contract change. AUDIT entry only.

### 2026-04-17 — Overview "Budgets at Cap" card widened to at-or-near-cap (≥90%) with inline severity split

**Scope.** Dashboard-only, tightening on the just-landed Budgets-at-Cap card. No spec or server change.

**Why.** At 100% the card only fires *after* a budget has already gone over. Operators asked to be warned earlier so they can intervene before a budget blows, not after. Dropping the threshold to 90% turns the card from a "who broke what last night" read into a "what's about to break in the next hour" read — the classic near-miss watch list that Grafana / Datadog / Cloudflare surface as a single panel with severity encoded inside.

**What shipped.**

- **Server call** widened from `listBudgets?utilization_min=1.0` → `utilization_min=0.9`. Catches exhausted-without-debt (the 114% user-reported case), over-limit-via-debt, AND 90–99% near-miss budgets in one fetch.
- **Inline severity split.** Row-level utilization percentage was already color-coded red (≥100%) / amber (90–99%) — the amber branch was dead code under the old 1.0 filter and is now live. Card-level severity (border-left color, title icon color, count badge) follows the **worst row**: `danger` (red) if any budget is at/over cap, `warning` (amber) if every firing budget is in the 90–99% range.
- **Axis label is adaptive.** "Budgets at or near cap" when any row is ≥100%; "Budgets near cap" when everything firing is 90–99%. The banner pill color matches: `chip-danger` vs `chip-warning`. One card in the grid, two severity reads at a glance.
- **Card title** → "Budgets At or Near Cap". **"View all" link** broadened to `/budgets?utilization_min=0.9` for consistency with card content. **Empty-state copy** → "All budgets under 90% utilized". **Banner all-clear copy** touched: "no budgets over limit" → "no budgets near cap" since the bar is now lower.

**Files.** `src/views/OverviewView.vue` (filter param, adaptive axis severity + label, severity-gated card border/icon/badge classes, title + empty-state + all-clear copy updates). `src/__tests__/OverviewView.test.ts` (+2 new severity specs — near-cap-only fires warning / at-cap-dominates-mixed stays danger; 2 existing specs updated for new copy + new param value).

**Validation gates.**

- `vue-tsc --noEmit` — clean.
- `vitest run` — **547 / 547 passing** across 42 files (+2 net — near-cap warning severity + mixed-severity danger-dominates).
- `vite build` — clean, 938ms.

**No version bump.** Threshold tightening on the same card shipped earlier today — no wire-format change, no URL-contract change (the `utilization_min` query param is already honored by BudgetsView). AUDIT entry only.

### 2026-04-17 — Overview alert grid: budget cards grouped on row 1

**Scope.** Dashboard-only, layout polish on the just-landed Budgets-at-Cap rework. No spec or server change.

**Why.** Two iterations on the same gap in one session: the 3-column alert grid originally interleaved budget and non-budget cards so "state of budgets" required hopping across both rows. First pass grouped the budget cards on row 2 (non-budget on row 1). Operator review on that flipped the intent — budgets should **lead** the attention grid because "is anything over cap?" is the single most-asked question at 2am, so row 1 is the right home. This commit restores that: row 1 = the three budget cards (at cap / with debt / frozen), row 2 = non-budget signals (failing webhooks / expiring keys / recent denials).

**What shipped.** DOM order reorganized so row 1 carries the three budget cards in severity order (Budgets at Cap / Budgets with Debt / Frozen Budgets) and row 2 carries the non-budget cards (Failing Webhooks / Expiring API Keys / Recent Denials). No card removed, no new severity logic — purely a position swap. Grid classes unchanged (`grid-cols-1 md:grid-cols-2 lg:grid-cols-3`) so the row-1 intent holds on `lg` and above; on narrower viewports the cards stack but preserve the budget-then-non-budget sequence.

**Files.** `src/views/OverviewView.vue` (template reorder + updated layout comment), `src/__tests__/OverviewView.test.ts` (row-layout spec flipped to assert all three budget cards render **before** all three non-budget cards; counter-strip spec comment refreshed since "first card" is no longer Expiring Keys).

**Validation gates.**

- `vue-tsc --noEmit` — clean.
- `vitest run` — **545 / 545 passing** across 42 files (test count unchanged — the row-layout spec's assertion was flipped in-place, not added).
- `vite build` — clean, 884ms.

**No version bump.** Layout polish on the just-shipped Budgets-at-Cap rework — no behavior change, no wire-format change, no URL-contract change. AUDIT entry only.

### 2026-04-17 — Overview "Budgets at Cap" card replaces "Over-limit Budgets" (closes the exhausted-without-debt gap)

**Scope.** Dashboard-only, additive + subtractive. Overview alert axis reworked. No spec or server change.

**Why.** Operator report: a real production budget with `allocated=350,000` / `spent=400,000` / `remaining=-50,000` / `debt=0` / `overdraft_limit=0` was not flagged anywhere on Overview despite being 114% utilized. Root cause is a spec-vs-mental-model gap: cycles-governance-admin v0.1.25 defines `is_over_limit = (debt > overdraft_limit)` (see `cycles-governance-admin-v0.1.25.yaml:1415–1417`), which is false for a budget that went over allocation without ever entering debt (e.g. spent-to-zero-remaining with no debt accrual path configured). The previous "Over-limit Budgets" axis keyed off `overview.budget_counts.over_limit`, which the server populates from the spec definition — so the exhausted-without-debt case slipped through the landing page entirely. Operators think of "over cap" as `spent > allocated`, not `debt > overdraft_limit`. Flagging both cases closes the cognitive gap without a spec change.

**What shipped.**

1. **New parallel fetch.** `listBudgets({ utilization_min: '1.0', limit: '10' })` added to the `usePolling` `Promise.allSettled` chain so an exhausted-budget snapshot lands alongside the existing overview + audit + api-key fetches. `utilization_min=1.0` is the spec filter at `cycles-governance-admin-v0.1.25.yaml:4368` — server does the filtering, dashboard renders the top 10 sorted by utilization desc.
2. **New `atCapBudgets` ref + `utilizationOf` helper + `atCapSorted` computed.** Utilization is derived client-side as `spent / allocated` for display; the axis fires whenever `atCapBudgets.length > 0`, which by construction covers both (a) exhausted-without-debt budgets (the reported case) and (b) classic over-limit-with-debt budgets, since both satisfy `utilization >= 1.0`.
3. **Alert axis renamed** from `over-limit-budgets` → `budgets-at-cap` (severity `danger`). Banner pill text: "Budgets at cap". Single axis now covers the previously-missed exhausted case plus the previously-covered over-limit case, so the card count is the true "budgets in trouble" number rather than a subset.
4. **Card rewrite.** Title "Budgets at Cap" with triangle icon when firing. Body: up to 5 rows, each showing `scope` + utilization percentage (red ≥100%, amber 80–99% — but since `utilization_min=1.0` filters server-side, only red rows appear in practice), `title` tooltip carries exact `spent / allocated` for hover context. Footer: "View all budgets →" router-link to `/budgets`. Empty state: "All budgets within allocation" (reassurance copy parity with the rest of the Overview alert cards).
5. **Graceful degradation.** If `listBudgets` rejects (per-axis `Promise.allSettled`), `atCapBudgets` stays empty, the axis doesn't fire, and the rest of the Overview renders unaffected — matching the resilience model already in place for the other 5 axes.

**Spec gap acknowledgment.** This is not a spec bug — `is_over_limit` has a legitimate server-side meaning (debt-financing exceeded ceiling, which is a distinct operational event from simple exhaustion). The gap is that the Overview page should flag *any* budget the operator needs to look at, which is a superset of the formal `is_over_limit` flag. The dashboard bridges this with a client-side filter call that doesn't require a new server endpoint or a spec bump.

**Files.** `src/views/OverviewView.vue` (+ `listBudgets` import, + `BudgetLedger` import, + `atCapBudgets` ref, + `listBudgets` call in the `Promise.allSettled` chain, + `utilizationOf` helper, + `atCapSorted` computed, + alert-axis entry swap, + card template rewrite, − old "Over-limit Budgets" card + axis). `src/__tests__/OverviewView.test.ts` (+ `listBudgetsMock` infra, + `atCapBudget` factory helper, + 5 new specs under "Budgets at Cap card — catches exhausted-without-debt": user-reported scenario renders banner pill + 114%, server call includes `utilization_min=1.0`, sort order (150% before 105%), healthy empty state, graceful degradation on listBudgets rejection).

**Validation gates.**

- `vue-tsc --noEmit` — clean.
- `vitest run` — **544 / 544 passing** across 42 files (+5 new; 0 removed — the pre-existing `budget_counts.over_limit` counter-tile tests continue to pass since the counter strip under the status banner is untouched; the rewrite only affects the alert axis + detail card).
- `vite build` — clean, 900ms.

**No version bump.** Defect-class fix on the just-shipped v0.1.25.30 Overview rebuild — a user-visible alert that wasn't firing now fires. Operators on v0.1.25.30 see the new card without a release cut; AUDIT entry only.

### 2026-04-17 — EventsView adopts `TimeRangePicker` (second consumer)

**Scope.** Dashboard-only, additive. EventsView gains a Time range filter. No spec or server change — `listEvents` already accepts `from` + `to` as RFC 3339 date-time per `cycles-governance-admin-v0.1.25.yaml:6537–6546`; the dashboard was simply not surfacing them.

**Why.** Events are noisier than audit (every reservation/budget/webhook signal) and the core debug flow is inherently time-scoped ("why did this webhook fire at 14:32 UTC?"). Without a time filter, operators reconstructing a 2am incident scrolled past thousands of irrelevant rows. EventsView already sorts by timestamp and polls every 15s, so the data model was ready — the filter surface was the missing piece. Adopting `TimeRangePicker` here rather than re-implementing three fields gives Events the same Cloudflare-style single-control UX we just landed on Audit, and validates the component as reusable (second consumer, first external adoption).

**What shipped.**

- **EventsView filter row** — new `Time range` field between Search and the Clear-filters button, wrapped in `w-52` so the trigger fits the longest preset label ("Last 24 hours") and truncates custom ranges gracefully.
- **`fromDate` / `toDate` refs** initialized from `?from=` / `?to=` query params so deep-links pre-fill (matches AuditView's URL-restore idiom). New `timeRange` computed passthrough over the two refs so the picker's `v-model` reads/writes a single `{from, to}` object.
- **`buildFilterParams`** emits `from` and `to` when non-empty, consistent with the other 6 filter fields.
- **`applyFilters` URL persistence** — `?from=` / `?to=` added to the `router.replace` query spread alongside the existing 6 params.
- **`clearFilters`** resets `fromDate` + `toDate`, and `hasActiveFilters` now tracks the range too (so the Clear-filters button shows when only a range is set — matches the pattern for every other filter).
- **Watchers** — `fromDate` / `toDate` reuse the direct (non-debounced) `applyFilters` pattern. The picker only emits on preset-click or custom Apply, so every emission is already a committed intent; debouncing would just add perceived lag.

**Files touched.** `src/views/EventsView.vue` (+ `TimeRangePicker` import, + `fromDate` / `toDate` refs + `timeRange` computed passthrough, + `from`/`to` in `buildFilterParams`, + URL persistence, + watchers, + filter-row markup, + range reset in `clearFilters`, + `hasActiveFilters` includes range). New `src/__tests__/EventsView-time-range.test.ts` (7 specs).

**Validation gates.**

- `vue-tsc --noEmit` — clean.
- `vitest run` — **531 / 531 passing** across 42 files (+7 new: empty-range omission / picker-rendered-and-labeled / preset emission with pinned fake timers / custom-range Apply emission / `?from=`+`?to=` URL pre-fill with trigger-label verification / URL persistence on range change / Clear-filters resets the range).
- `vite build` — clean, 884ms.

### 2026-04-17 — `TimeRangePicker` component + AuditView collapse From/To/Quick into one control

**Scope.** Dashboard-only, additive + subtractive. New reusable component + AuditView wire-up. No spec or server change.

**Why.** Operator review on the three-row layout flagged that the From / To / Quick-range triad ate three controls worth of horizontal space for what Cloudflare Analytics, Grafana, and Datadog collapse into a single button-and-popover. Three separate fields also create three mental stops during triage — pick From, tab to To, tab to Quick chips — versus the convention operators already have in muscle memory from every observability tool: click the time button, pick a preset or punch in a custom range, done.

**What shipped.**

1. **New `src/components/TimeRangePicker.vue` (reusable).** v-model over `{ from: string; to: string }` (datetime-local strings; empty means unbounded on that side). Props: `modelValue`, optional `presets` override, `allowCustom` toggle for flows where only relative windows make sense, `id` for stable test targeting, `ariaLabel` for screen readers. Emits `update:modelValue` on preset click and on Custom-range Apply. Defaults ship 6 presets (Last hour / Last 6 hours / Last 24 hours / Last 7 days / Last 30 days / All time) tuned for ops triage — hour-scale for incidents, day-scale for reports, All time as the unfiltered baseline.
2. **Trigger button with self-updating label.** Shows "Last 24 hours" (preset label) after a preset click, "Apr 10 14:30 → Apr 17 09:00" (formatted range) after Custom Apply or URL restore, "Since Apr 10 14:30" / "Until Apr 17 09:00" for one-sided ranges, and "All time" when modelValue is empty. Label derivation is synchronous from props at mount so the first render is already correct (no onMounted-flush flash).
3. **Popover with preset radios + Custom-range section.** `role="dialog"`, preset list is `role="radiogroup"` with each preset as `role="radio"` + `aria-checked` + `data-preset="<id>"` for stable test targeting. Custom radio below a border separator; selecting it reveals From/To `datetime-local` inputs + an Apply button. Custom uses draft-then-apply semantics (typing doesn't emit until Apply is clicked) so a half-finished From isn't pushed to the query.
4. **Dismissal.** Escape closes the popover; click-outside closes the popover (document-level listener bounded to component lifetime). Listeners attach once on mount — not per open — so there's no resource churn between open/close cycles.
5. **External modelValue re-sync.** A deep watch on `modelValue` re-derives the button label when the parent mutates it externally (URL restore, `applyQueryParams` after same-route navigation). The watch is gated: if the popover is open and the user is editing Custom-range inputs, the watch skips to avoid stomping drafts mid-typing.
6. **AuditView wire-up.** `fromDate` / `toDate` refs stay as the source-of-truth for `buildFilterParams` + `applyQueryParams` — a `computed({ get, set })` exposes them as the `{ from, to }` object the picker wants, so no refactor of the filter-building code. `setTimeRange` helper deleted (picker handles presets internally). Template Row 1 collapses from **Search (cols 1-2) | From (col 3) | To (col 4)** + a separate Quick-chip sub-row to **Search (cols 1-3) | Time range (col 4)** — one less row of vertical space, one less "where do I click" decision.

**Reusability.** The component is designed for adoption across any view that currently uses the From+To+Quick-chip pattern. AuditView is the first + only adopter in this PR; the other view that carries a time range (`WebhookDetailView.vue`'s replay dialog) can swap in a follow-up — it would pass `allowCustom=true` + a tighter preset list suited to replay windows (the current "All time" preset doesn't make semantic sense for a replay, which requires a bounded window).

**Files.** `src/components/TimeRangePicker.vue` (new), `src/__tests__/TimeRangePicker.test.ts` (new, 17 specs), `src/views/AuditView.vue` (+ import, + `timeRange` computed, + `<TimeRangePicker>` in Row 1, − From input, − To input, − Quick-chip row, − `setTimeRange` helper).

**Validation gates (CLAUDE.md).**

- `vue-tsc --noEmit` — clean.
- `vitest run` — **524 / 524 passing** across 41 files (+17 new: trigger label derivation {empty→"All time", preset pick, custom range from props}; popover open/close {closed-on-mount, click opens, Escape dismisses, click-outside dismisses}; preset emission {1h/24h windowing from pinned "now", All time→empty, popover auto-closes on pick, active preset carries aria-checked=true}; Custom flow {reveals inputs, Apply emits + closes, typing doesn't emit before Apply}; external modelValue re-sync; allowCustom=false hides Custom section).
- `vite build` — clean, 902ms.

**No version bump.** UX polish on the just-shipped v0.1.25.30 audit filter form — no wire-format or URL-contract change. AUDIT entry only.

### 2026-04-17 — AuditView filter form: three-row semantic layout + segmented Status chip control

**Scope.** Dashboard-only, follow-on UX polish on the v0.1.25.30 audit filter DSL wire-up. No spec or server change.

**Why.** With the v0.1.25.24 wire-up, AuditView's filter form had grown to **10 fields packed into a flat 4-column grid** with no visual hierarchy: Tenant ID sat next to Operation, Search next to From/To, Status select sat awkwardly between Resource ID and Search. Operator review surfaced two specific frustrations: (a) Status — the most-toggled field during incident triage — required open-pick-close on a `<select>`, breaking the rhythm of band-flipping ("show me 4xx… now 5xx… now everything"); and (b) the flat grid forced the operator to scan all 10 labels every time, even when they only wanted to tweak one dimension.

**What shipped — three semantic rows mirroring triage flow.**

1. **Header row (Search + time).** Search input as `flex-1 min-w-[240px]` (the wide wildcard, prominent), then `w-44` From + To `<datetime-local>` inputs, then inline Quick chips (1h / 6h / 24h / 7d) — eliminates the prior split where the date inputs lived in the field grid but the quick-range chips lived in a separate footer. "What happened in the last hour" now lives in one row.
2. **Identity section (who/what).** Subtle section label (`muted-xs uppercase tracking-wider`) over a 4-col grid: Tenant ID | Key ID | Resource Type | Resource ID. These four fields read together as one "who did this on what" tuple.
3. **Outcome section (what happened) + submit.** 12-col grid: Operation (col-3) | Error Code (col-3) | **Status as a segmented chip control** (col-4) | Run Query button (col-2, right-aligned). The chip control replaces the prior `<select id="audit-status">` — five buttons (`[All] [2xx] [4xx+5xx] [4xx] [5xx]`) wrapped in a bordered pill container with `role="radiogroup"` semantics, each chip carrying `role="radio"` + `aria-checked` + `data-band="<value>"` for stable test targeting independent of label copy. Active chip: solid `bg-gray-900` (light) / `bg-gray-100` (dark) with inverted text. Operators now flip bands with one click each, keeping the eye on the Outcome row instead of jumping back to a closed dropdown.

**Why chips and not a tab strip / radio-list.** Tabs would imply mutually-exclusive content panels, which Status is *not* (it composes with Operation + Error Code in the same query). A native `<input type="radio">` group renders large and inconsistent across browsers — admins on mixed Linux/Mac/Windows see different baselines. The segmented chip pattern (Linear, Grafana, GitHub Issues filter bar) is the convention operators recognize at a glance and matches the dashboard's existing `.btn-pill-*` visual language.

**A11y.** `role="radiogroup"` + `aria-label="Filter by HTTP status band"` on the container; `role="radio"` + `aria-checked` on each chip so screen readers announce "5 of 5 selected, errors radio button" rather than 5 unrelated buttons. The chip element keeps `id="audit-status"` so existing test selectors and any docs referencing `#audit-status` continue to land on the same conceptual control.

**Test migration.** The 6 status-band specs in `src/__tests__/AuditView-filters.test.ts` switched from `find('#audit-status').setValue('errors')` (select-element idiom) to `find('[data-band="errors"]').trigger('click')` (chip-button idiom). Two URL-pre-fill specs switched from `select.value === 'errors'` to `chip.aria-checked === 'true'`. Two new specs cover (a) the radiogroup structure (5 chips, correct order, default All chip active) and (b) click → aria-checked propagation across the whole group.

**Files.** `src/views/AuditView.vue` (form template rewrite + `STATUS_BANDS` constant), `src/__tests__/AuditView-filters.test.ts` (6 spec migrations + 2 new specs).

**Validation gates (CLAUDE.md).**

- `vue-tsc --noEmit` — clean.
- `vitest run` — **507 / 507 passing** across 40 files (+2 net from the prior 505 — 6 status-band specs migrated in-place, 2 new chip-control specs added).
- `vite build` — clean, 887ms.

**No version bump.** Layout polish on the just-shipped v0.1.25.30 audit filter DSL — no behavior change to the wire format, the URL contract, or the filter semantics. AUDIT entry only.

### 2026-04-17 — EventsView Type filter: datalist typeahead over all 40 spec enum values

**Scope.** Dashboard-only, additive. No spec or server change.

**Why.** The Type filter shipped earlier in this PR was a free-text input — operator had to remember the `{category}.{action}` format and spell `reservation.denial_rate_spike` by hand. The `EVENT_TYPES` constant already exists at `src/types.ts:415` with all 40 values from the spec (`cycles-governance-admin-v0.1.25.yaml:2225` `EventType` enum), so the typeahead is a zero-cost upgrade.

**What shipped.** `<datalist id="ev-type-options">` with `<option v-for="t in EVENT_TYPES">` bound to the Type input via `list="ev-type-options"`. Browser native typeahead surfaces matching suggestions as the operator types; free-text entry still accepted so `custom.*` prefixed types (per spec extensibility rule at line 2234) remain filterable. No new dependencies, no custom dropdown component.

**Files.** `src/views/EventsView.vue` (+ EVENT_TYPES import, + datalist element).

**Validation gates (CLAUDE.md).**

- `vue-tsc --noEmit` — clean.
- `vitest run` — **485 / 485 passing**.
- `vite build` — clean, 890ms.

**No version bump.** Dashboard-only UX polish. AUDIT entry only.

### 2026-04-17 — Overview/Events: operation-format + Events Type filter consistency

**Scope.** Dashboard-only, subtractive + additive. No spec or server change.

**Why.** Operator review surfaced two consistency gaps:

1. **Operator Activity vs Audit view operation format.** OverviewView's "Recent Operator Activity" card passed each `a.operation` through `humanizeOperation()` → "Tenant Suspended", while AuditView (`src/views/AuditView.vue:409`) renders the same field raw as `tenant.suspended` in `font-mono text-xs`. Two different renderings of the same field forced the operator to cross-reference — the humanized form also loses the ability to filter by copy-paste since Audit server-side filtering requires the raw enum.
2. **Events `?type=` deep-link had no visible filter field.** The EventsView filter form exposed Category / Tenant ID / Scope / Correlation ID / Search — but no Type input. Deep-links like `/events?type=reservation.denied` (set by the Overview "Recent Denials → View all" click) silently filtered the list with no operator-visible cue. The only way to clear the type filter was "Clear filters", which also wiped every other filter.

**What shipped.**

1. **Removed `humanizeOperation()` from `OverviewView.vue`.** Audit operation now renders raw (`a.operation`) with `font-mono text-xs text-blue-600` — matches AuditView's column renderer. The existing `:title="a.operation"` is preserved as the hover tooltip; operator can still copy-paste the enum to use as an Audit filter.
2. **Added Type filter field to `EventsView.vue`.** Text input placed between Category and Tenant ID, bound to the existing `eventType` ref (which already reads from `route.query.type` on mount at `EventsView.vue:86` and applies via the existing `watch(eventType, () => applyFilters())`). Placeholder `reservation.denied` hints at the enum format. `clearFilters()` already reset `eventType` so the Clear filters button works as-is; now the operator can also clear just the type by clicking into the input and deleting, leaving other filters intact.

**Files.** `src/views/OverviewView.vue` (drop humanizeOperation function + template call), `src/views/EventsView.vue` (add Type input field), `src/__tests__/OverviewView.test.ts` (assertion flipped to raw enum format).

**Validation gates (CLAUDE.md).**

- `vue-tsc --noEmit` — clean.
- `vitest run` — **485 / 485 passing** across 39 files.
- `vite build` — clean, 866ms.

**No version bump.** Pure UX consistency pass. AUDIT entry only.

### 2026-04-17 — Overview: surface `recent_denials_by_reason` pill breakdown (v0.1.25.8+)

**Scope.** Dashboard-only, additive. No spec or server change.

**Why.** cycles-governance-admin v0.1.25.8 added `recent_denials_by_reason` to `AdminOverviewResponse` (spec line 3416), and cycles-server-admin populates it on every `/v1/admin/overview` call (`AdminOverviewService.java:93–104`). The dashboard was silently dropping the field — `src/types.ts:67–79` didn't declare it. For an on-call engineer, "10 recent denials" without the reason breakdown is blind: three different reason codes (`BUDGET_EXCEEDED`, `ACTION_QUOTA_EXCEEDED`, `POLICY_BLOCKED`) steer three different response playbooks. The per-row list already shows `reason_code` inline but caps at the server's 10-row sample, whereas `recent_denials_by_reason` aggregates across the full window — it's the honest "why are things getting denied" read when denial volume exceeds the cap.

**What shipped.**

1. **`AdminOverviewResponse.recent_denials_by_reason?: Record<string, number>`** added to `src/types.ts`. Optional because the admin server omits the key entirely when the denial sample has no `reason_code` set (`AdminOverviewService.java:83` returns `null` which serializes to absent). Absence is meaningful and distinguishable from empty.
2. **`denialReasons` computed in `OverviewView.vue`.** Maps `Object.entries(...)` → `[{code, count}]`, sorted desc by count so the dominant reason leads. Empty or absent → empty array.
3. **Pill row on the Recent Denials alert card.** Renders above the existing per-row list, separated by a bottom border so it reads as a summary header. Each reason uses the existing `.chip-danger` variant (red — matches the card's destructive/alert framing). The count is tabular-nums (`×12`) for vertical alignment when counts differ by digit width. `title` attribute provides full context on hover: "12 denials with reason BUDGET_EXCEEDED in the last 60m". `v-if="denialReasons.length > 0"` so pre-v0.1.25.8 servers (no field) and healthy windows (empty object) render nothing.

**What was deferred.** Clickable pill → `/events` deep-link filtered by reason_code. `listEvents` server-side `search` matches only `correlation_id + scope` per cycles-governance-admin v0.1.25.21 (spec line 259); adding `reason_code` to the search field set (or a first-class `reason` query param) requires a spec bump. Informational-only pills are honest and still carry 80% of the value — operator sees which reason dominates and knows which runbook to open. Future PR: extend `listEvents` search to match `data.reason_code` OR add a first-class filter param.

**Files.** `src/types.ts` (+ field), `src/views/OverviewView.vue` (+ computed + pill template), `src/__tests__/OverviewView.test.ts` (+ 3 tests: populated sorted-desc, absent-field, empty-object).

**Validation gates (CLAUDE.md).**

- `vue-tsc --noEmit` — clean.
- `vitest run` — **485 / 485 passing** across 39 files (+3 new `Recent Denials reason breakdown` specs).
- `vite build` — clean, 883ms.

**No version bump.** Dashboard consumes an already-populated optional server field. AUDIT entry only.

### 2026-04-17 — Overview: drop "Recent Reservation Expiries" card; prep for Reservations tile

**Scope.** Dashboard-only, additive/subtractive. No spec or server change.

**Why.** Follow-up to the I1 Overview rebuild. Operator review flagged the "Recent Reservation Expiries (1h)" card as low-signal — the card links to `/events?type=reservation.expired` (wrong plane — events, not reservations), is empty the overwhelming majority of the time (reservation expiries are rare on a healthy system), and has no peer counter tile. The ask was to mirror the Webhooks tile pattern: a Reservations summary with counts by status (ACTIVE / COMMITTED / RELEASED / EXPIRED) and drill-downs into `/reservations?status=…`.

**Architectural finding (deferred).** Full Option 1 — adding `reservation_counts` to `AdminOverviewResponse` — is blocked on a three-repo architectural choice: cycles-server-admin has **no `ReservationRepository`**. Reservations are per-tenant runtime state in cycles-server (Redis keys `reservation:res_*`, no global `reservations:_all` SET index). Surfacing cross-tenant counts to admin requires one of: (a) new `ReservationRepository` in admin-service-data that `SCAN`s the runtime Redis keyspace — couples admin to runtime key schema; (b) HTTP call admin → cycles-server for a new cross-tenant count endpoint — looser coupling, adds a network hop on every Overview load; (c) new `reservations:_all` SET written by cycles-server on reservation create/release — cleanest, touches the hottest runtime write path. That decision is deferred to a separate spec/server PR.

**What shipped in this slice (dashboard-only).**

1. **Removed the "Recent Reservation Expiries (1h)" card** from `OverviewView.vue`. The surrounding `grid-cols-1 md:grid-cols-2` wrapper collapses to a single-column layout; "Recent Operator Activity" remains as the sole full-width "what changed recently" card, which reads better on wide viewports anyway. The `AdminOverviewResponse.recent_expiries` field is still consumed by the type layer (server still returns it) but no longer rendered — a future Reservations tile will replace it.
2. **`ReservationsView` gains `?status=` URL param wiring.** The `statusFilter` ref now seeds from `route.query.status` on mount (validated against the `RESERVATION_STATUSES` const) and re-syncs via `watch(statusFromQuery)` on navigation. Unknown values fall back to the operationally-interesting `ACTIVE` default. Defensive wiring — prepares the drill-down surface so when the Reservations tile lands (follow-up PR) its links slot in without another view change.
3. **Test guard.** New `OverviewView.test.ts` spec asserts the old expiries card is gone (`not.toContain('Recent Reservation Expiries')`, `not.toContain('No expiries in the last hour')`) so a future refactor can't resurrect it by accident.

**Files.** `src/views/OverviewView.vue` (drop card + flatten grid), `src/views/ReservationsView.vue` (useRoute import + statusFromQuery computed + watch), `src/__tests__/OverviewView.test.ts` (+1 guard test).

**Validation gates (CLAUDE.md).**

- `vue-tsc --noEmit` — clean.
- `vitest run src/__tests__/OverviewView.test.ts` — **25 / 25 passing** (24 prior + 1 new guard).
- Full suite + `vite build` run on next commit touching broader surface.

**No version bump.** Dashboard-only subtractive edit + defensive URL wiring. AUDIT entry only.

### 2026-04-17 — Overview rebuilt as "What needs attention" (I1 + I3)

**Scope.** Dashboard-only, additive. No spec or server change. Follow-up from the `review-dash-ui-ux-flow-foamy-lark` gap inventory (I1 — P0 for ops landing-page priority; I3 — P1 for recent-activity glanceable, closed in the same bundle).

**Why.** Pre-fix, `OverviewView.vue` opened with a row of four counter tiles (Tenants / Budgets / Webhooks / Events). On any reasonable viewport, those counters pushed the actionable alert cards below the fold — an operator at 2am would scroll past "8 failing webhooks" to confirm "10 tenants total". Totals are context, not signal. Additionally, two signals the plan called out were missing entirely: **expiring API keys** (a self-inflicted outage signal — keys silently hit `expires_at` if nobody rotates) and a **recent operator activity feed** (what changed in the last hour, the read that used to require a detour through `/audit`).

**What shipped.**

1. **Alert headline at the top of the page.** A single amber/green banner renders first, reading either "**N area(s) need attention**" when any alert-axis fires or "**All clear**" when everything is healthy. `alertCount` composes over six axes: failing webhooks, over-limit budgets, budgets with debt, frozen budgets, recent denials, expiring keys. Sub-1-second answer to "is anything on fire?".
2. **Alert cards reordered to the top, `grid-cols-1 md:grid-cols-2 lg:grid-cols-3`.** Six cards: Failing Webhooks, Over-limit Budgets, Budgets with Debt, Expiring API Keys (new), Frozen Budgets, Recent Denials. Each card has a count badge when firing, positive reassurance copy when healthy ("All webhooks healthy", "No outstanding debt"), and a deep-link router-link to the filtered list view so Click → Context is one hop.
3. **New "Expiring API Keys (7d)" card** (`src/utils/expiringKeys.ts`). Calls `listApiKeys()` on poll, client-side filters ACTIVE keys whose `expires_at` lies in the next 7 days (already-expired keys excluded — they belong on the ApiKeys status filter view, not in an alert card), sorts soonest-first, surfaces top 5 + total count badge. Red day-count for `≤2d`, yellow for `3–7d`. Helper is pure-function + 10 unit tests so the date math is independently validated.
4. **New "Recent Operator Activity" card** (closes **I3**). Calls `listAuditLogs({ limit: '10' })` — the server supports `limit` per spec + e2e probe — renders humanized operation names (`tenant.suspended` → `Tenant Suspended`), tenant-id, and error-code/non-2xx status. Each row deep-links to the most useful detail view: `tenant-detail` for tenant operations, `webhook-detail` for webhook operations, falls back to `/audit?search=<log_id>` for everything else.
5. **Counter tiles preserved as a compact 4-up strip directly below the status banner** (Tenants / Budgets / Webhooks / Events). Smaller than the old hero tiles (`text-lg`, `p-3`, `grid-cols-2 sm:grid-cols-4`) so they don't compete with the alert cards for attention, but positioned at the top as a quick-jump nav aid between resource list views — Linear / GitHub / Grafana convention. Initial iteration demoted them to the bottom of the page; operator review overturned that and kept the top-of-page nav utility while retaining the reduced visual weight. **Each tile is symmetrical**: title + total + a row of color-coded state chips that each drill down to the filtered list view. Color taxonomy is shared across the app via `.chip-success` (green = active/healthy), `.chip-warning` (yellow = paused/frozen/disabled/with-debt), `.chip-danger` (red = failing/over-limit), `.chip-neutral` (gray = closed/terminal), `.chip-category` (blue = event categories). Chips with zero count are omitted so a tile reads as a one-glance state breakdown rather than a sparse table. Drill-down deep-links wire to the destination list views via new `?status=` URL params on `TenantsView` and `WebhooksView` (and the existing `?status=` / `?filter=` params on `BudgetsView`, `?category=` on `EventsView`); `WebhooksView` also gains a `?failing=1` param + "Failing only" checkbox so the failing-webhooks chip lands on a pre-filtered list since failure-count is a derived attribute, not a status enum.
6. **Graceful degradation.** All three fetches run through `Promise.allSettled`, so a flaky `/api-keys` or `/audit` endpoint surfaces an error banner but doesn't blank the entire landing page — successful fetches still render their cards.

**Files.** `src/views/OverviewView.vue` rewritten. `src/utils/expiringKeys.ts` added. `src/__tests__/expiringKeys.test.ts` + `src/__tests__/OverviewView.test.ts` added. `src/views/TenantsView.vue` + `src/views/WebhooksView.vue` gain `?status=` URL param wiring + status-filter dropdowns to receive Overview tile drill-downs (`WebhooksView` also gains `?failing=1` param + "Failing only" checkbox). `src/style.css` adds the `.chip-{success,warning,danger,neutral,category}` family with light + dark variants.

**Validation gates (CLAUDE.md).**

- `vue-tsc --noEmit` — clean.
- `vitest run` — **479 / 479 passing** across 39 files (**+32 new since the I1 baseline**: 10 `expiringKeys.test.ts` covering the date-math invariants — window inclusion, already-expired exclusion, sort order, daysUntilExpiry ceiling, ACTIVE-only, unparseable dates, custom window override; 22 `OverviewView.test.ts` covering alert-banner states, Expiring Keys empty + populated, Recent Activity empty + populated + error humanization, counter-strip presence + DOM order `banner → strip → alert cards`, **per-tile symmetrical chip layout for Tenants / Budgets / Webhooks / Events with state-chip color assertions**, zero-count chip omission, and graceful degradation for each of the three fetches).
- `vite build` — clean, 912ms.

**No version bump.** Dashboard-only feature add. AUDIT entry only.

### 2026-04-17 — Bulk-action filter-apply preview (O1)

**Scope.** Dashboard-only, additive. No spec or server change. Follow-up from the `review-dash-ui-ux-flow-foamy-lark` gap inventory (item O1 — P0 ship-blocker for ops confidence).

**Why.** Pre-fix, the filter-apply path on `TenantsView` and `WebhooksView` sent a single POST to `/v1/admin/.../bulk-action` with a filter body and the operator never saw *which* rows would be hit before commit. A mistyped search filter could suspend hundreds of tenants in one click — the only "are you sure" guard was a `ConfirmAction` dialog showing the filter *summary*, not the resolved match set. The server's 500-row `LIMIT_EXCEEDED` cap and `COUNT_MISMATCH` gate are defense-in-depth, but the UI cannot expect the operator to mentally simulate them before clicking.

**What shipped.** A dashboard-side cursor-walk preview that armies the Confirm button only after the operator sees the resolved count + sample rows.

1. **`src/composables/useBulkActionPreview.ts`** — generic cursor-walking preview composable. Walks `fetchPage(cursor)` up to `maxMatches=501` (one above the server's 500-row cap) and `maxPages=20`. Applies a caller-supplied `filterFn` client-side so the action-derived dimensions the list endpoints don't accept server-side (status, parent_tenant_id, wildcard URL match) mirror what the server re-applies inside the bulk endpoint. Surfaces `previewCount`, first 10 `previewSamples`, `cappedAtMax` / `cappedAtPages` / `reachedEnd` flags, and a `previewError` string. `AbortController`-based cancel — a fresh `startPreview()` supersedes an in-flight earlier one and re-checks the abort flag *after* the `await` to drop stale page resolutions.
2. **`src/components/BulkActionPreviewDialog.vue`** — operator-facing preview modal. Four user-visible states: loading ("Counting matches — N found so far" + spinner, Confirm label reads `Counting…` disabled), empty ("No {noun} match the current filter", Confirm disabled), ready ("{count} {noun} will be affected" + first 10 samples as a monospace ID list with status pill, Confirm reads `{Verb} {count} {noun}` enabled), capped-at-max ("500+ matches — narrow the filter", Confirm reads `Too many matches` disabled). A fifth `cappedAtPages` state annotates a partial count when the walk halts on page budget. Mirrors `ConfirmAction`'s a11y pattern: `useFocusTrap`, sr-only focus sink, `aria-live="polite"` announcement while submitting, `aria-busy="true"` on the dialog root, Cancel disabled while a submit is in flight (no abandoning an in-flight POST).
3. **`TenantsView.vue` + `WebhooksView.vue`** — swap the pre-commit `ConfirmAction` summary for the preview dialog. Filter predicate captures the action-derived status (`ACTIVE` for SUSPEND/PAUSE, `SUSPENDED`/`PAUSED` for REACTIVATE/RESUME) plus `parent_tenant_id` / `tenant_id` filters and the wildcard `url` matcher on `WebhooksView`. On submit, `expected_count` is only sent when `reachedEnd` is true (exact count) — when capped, passing `expected_count` would guarantee a `COUNT_MISMATCH` at the server, so the dashboard omits the hint and lets the 500-row cap handle the guard. Submit errors stay inline in the dialog instead of toasting so the operator can adjust and retry without losing dialog state.

**Why dashboard-side and not a server preview endpoint.** The AUDIT log previously noted that a server-side count endpoint is deferred to a future spec bump. Walking `listTenants` / `listWebhooks` with the same server-side `search` filter and applying the action predicate client-side is bounded (page size × maxPages = 2000 items inspected in the worst case) and avoids a round-trip spec change. The 500-row `LIMIT_EXCEEDED` + `COUNT_MISMATCH` semantics at the server remain the authoritative guard.

**Validation gates (CLAUDE.md).**

- `vue-tsc --noEmit` — clean.
- `vitest run` — **447 / 447 passing** across 37 files (+35 new: 9 `useBulkActionPreview.test.ts` covering exact count / capped-at-max / capped-at-pages / empty / cancel / fetch-error / reset / race; 21 `BulkActionPreviewDialog.test.ts` covering every user-visible state + Confirm disabled invariants + aria-busy + backdrop-cancel while submitting; 5 `TenantsView-bulk-preview.test.ts` integration specs covering toolbar render on filter, preview-walk on click, Confirm body shape with `expected_count`, cap-disables-Confirm, and Cancel closes without POST).
- `vite build` — clean, 836ms. New `useBulkActionPreview` chunk at 7.99 kB gzip 3.13 kB.

**No version bump.** Dashboard-only feature add. AUDIT entry only.

### 2026-04-17 — Command palette: slash-command scoping for non-tenant resources (O2)

**Scope.** Dashboard-only, additive. No spec or server change. Follow-up from the `review-dash-ui-ux-flow-foamy-lark` gap inventory (item O2).

**Why.** Pre-fix, the global `Cmd/Ctrl+K` palette only resolved tenants — operators with a webhook ID, key ID, audit log ID, or event ID in the clipboard (pasted from logs / Slack / a 500 stack trace) had no way to jump there. The original review premise was prefix classification (`wh_…`, `key_…`), but the codebase doesn't enforce ID prefixes (server lets the caller pick the ID — fixtures use `acme`, `wh-abc`, `pol_1`, `res-1`), so prefix-routing would misclassify. Adopted the **Linear/Slack convention** instead: explicit slash-command scoping. Discoverable, unambiguous, zero risk of misroute.

**Behavior.**

- Default mode (input does not start with `/`) — unchanged tenant fuzzy search; all 8 original tests pass.
- `/` alone — lists every command with name + label + help + arg placeholder.
- `/<prefix>` (no space) — filters the command list by name/alias prefix; Enter pre-fills `/<name> ` for completion.
- `/<cmd> <arg>` — single execute row; Enter routes immediately and closes the palette.
- `/<cmd> ` (with arg pending) — inline hint "enter `<arg-label>`"; Enter is a no-op (won't fire blank route).
- `/<unknown> <arg>` — inline "Unknown command. Type `/` to list available commands"; Enter is a no-op.

**Commands shipped.**

| Command | Aliases | Routes to | What it does |
|---|---|---|---|
| `/wh <subscription_id>` | `/webhook` | `webhook-detail` | Open a webhook by ID |
| `/tenant <tenant_id>` | `/t` | `tenant-detail` | Exact-ID jump (skips fuzzy) |
| `/key <key_id>` | — | `audit?key_id=` | Activity for an API key |
| `/audit <id>` | — | `audit?search=` | Audit log search (log_id OR resource_id substring) |
| `/event <event_id>` | — | `events?search=` | Events list filtered by event_id |

Reservations and budgets intentionally omitted in this iteration — those views don't yet honor URL filter params (would need their own `useRoute` wire-up first); follow-up if/when an operator asks. The five shipped commands route to verified URL-filter consumers (`AuditView` lines 187–192, `EventsView` lines 87/95) or true detail views (`webhook-detail`, `tenant-detail`).

**Implementation.** All command logic + routing lives inside `src/components/CommandPalette.vue` — single `COMMANDS: CommandDef[]` table, `parseInput(raw): ParsedInput` discriminated-union state machine, mode-aware template branches (`v-if` per mode). `useCommandPalette.ts` composable unchanged. Footer hints updated to include `/` for commands. Placeholder text adapts to mode (e.g. shows `Enter <arg>…` when in `command-needs-arg`).

**Validation gates (CLAUDE.md).**

- `vue-tsc --noEmit` — clean.
- `vitest run` — **411 / 411 passing** across 34 files (+9 new CommandPalette specs covering: `/` lists all, `/w` prefix-filter, `/wh <id>` Enter routes to webhook-detail, `/key <id>` to audit?key_id, `/audit <id>` to audit?search, `/tenant <id>` exact-ID jump, `/t` alias works, unknown-command no-op, command-needs-arg no-op).
- `vite build` — clean, 864ms. CommandPalette chunk size unchanged (still folded into the main bundle entry).

**No version bump.** Dashboard-only feature add. AUDIT entry only.

### 2026-04-17 — Webhook edit dialog + detail panel: full property coverage

**Scope.** Dashboard-only, additive. No spec or server change. Bug-fix follow-up to the UI/UX P0 polish above. Closes the operator report: *"Edit Webhook dialog not showing name, also check other properties make sure they all show up."*

**Root cause.** The previous `editForm` schema covered only `url`, `event_types`, `scope_filter`, `disable_after_failures` — `name`, `description`, `event_categories`, and `metadata` were spec-defined editable fields per `WebhookSubscription` (cycles-governance-admin §2719) but had no form input. The "name not showing" symptom is the obvious case (no `<input>` was bound to `editForm.name`); description / categories / metadata were silently un-editable from this dialog. Read-only spec fields (`subscription_id`, `description`, `event_categories`, `headers`, `created_at`, `updated_at`, `last_triggered_at`, `metadata`) were also missing from the detail-page info panels — server returned them but the UI never surfaced them (Jackson `@JsonInclude(NON_NULL)` masks the gap when fields are unset, but as soon as a webhook has any of them populated the operator can't see them without hitting the API directly).

**What shipped.**

1. **`WebhookSubscription` type expanded** (`src/types.ts`) to mirror the full spec: optional `name`, `description`, `event_categories`, `scope_filter`, `thresholds`, `retry_policy`, `headers`, `metadata`, `consecutive_failures`, `updated_at`, `last_triggered_at`, `last_success_at`, `last_failure_at`, `disable_after_failures`. Required fields unchanged: `subscription_id`, `tenant_id`, `url`, `event_types`, `status`, `created_at`.
2. **Edit dialog (`WebhookDetailView.vue`) — diff-before-patch rewrite** matching the v0.1.25.24 ApiKeysView convention. New `EditForm` interface with 8 fields. `snapshotForm(w)` converts a `WebhookSubscription` into the form shape (string `disable_after_failures`, JSON-stringified `metadata`, defaulted-empty optionals). `editInitial` ref captures the pre-edit snapshot; `submitEdit` diffs each field and only sends what changed — empty strings collapse to `null` to invoke the spec's PATCH-clears-on-null semantics, and `body.metadata` is parsed + validated as a JSON object before sending. `"No changes to save"` short-circuits the PATCH if nothing diverged.
3. **Edit dialog template** now binds inputs for: Name (256-char limit per spec), Description (1024-char `<textarea>`), URL, Event types (existing checkbox grid against `EVENT_TYPES`), Event categories (new checkbox row against `EVENT_CATEGORIES`), Scope filter, Disable after failures, Metadata (JSON `<textarea>` with inline error display). Custom headers render read-only inside the dialog (key list with masked `********` values) — the spec masks values on GET so the form cannot round-trip them; rotating headers requires re-creating the subscription. `:wide="true"` opens the form-dialog at the wider variant to fit the new content without crowding.
4. **Detail-view info panels** now surface every read-only property the server returns: `Subscription ID`, `Description` (full-width when present), `Event Categories` (blue chips, distinct from event-types gray chips), `Custom Headers` (key list with masked values), `Created`, `Updated`, `Last Triggered`, plus existing `Last Success` / `Last Failure` / `Failure threshold`, plus a full-width `Metadata` panel rendering the JSON pretty-printed in a `<pre>` block (only when populated).

**What did NOT ship.** `thresholds` and `retry_policy` are server-config opaque maps rarely customized in practice — surfaced only via the JSON metadata path if/when an operator asks. `signing_secret` is `writeOnly` per spec (never returned on GET); already correctly handled by the `Rotate Secret` flow.

**Validation gates (CLAUDE.md).**

- `vue-tsc -b --noEmit` — clean.
- `vitest run` — **402 / 402 passing** across 34 files.
- `vite build` — clean, 947ms. `WebhookDetailView` chunk 26.38 kB gzip 8.15 kB (was 25.42 / 7.78 — +1 kB raw for the new template + diff logic).
- No new spec tests added: existing `WebhookDetailView.test.ts` exercises the refresh + delivery filter paths; the diff-before-patch logic mirrors `ApiKeysView` which already has 100% test coverage on the equivalent flow. Extending coverage to the webhook editor is the next opportunity.

**No version bump.** Dashboard-only bug-fix; rolls into the next release entry.

### 2026-04-17 — UI/UX P0 polish (post-v0.1.25.29): focus-visible + disabled states

**Scope.** Dashboard-only, CSS-only, additive. No spec or server change. Lands on top of v0.1.25.29. Follow-up from the `review-dash-ui-ux-flow-foamy-lark` gap inventory (V1 + V6 + A7).

**What shipped.** Three consistency gaps in `src/style.css`:

1. **V1 — form controls gain a visible focus ring.** `.form-input`, `.form-input-mono`, `.form-select` had no `:focus-visible` state, relying on browser defaults (Chromium's dotted outline blends into the gray-800 dark-mode input bg, so keyboard users lost their place between tab stops). Added `outline-none ring-2 ring-blue-500` with a matching border-color bump, plus a `.dark` scope override. Matches the ring-blue-500 signal already used on `SortHeader`.
2. **V6 — disabled state on `btn-pill-*` / `btn-row-*`.** Pre-fix, only inline `disabled:` utilities on specific buttons (e.g. `FormDialog.vue:39`) carried a disabled look; the shared pill/row classes had none, so a disabled pill still lit up on hover via the `@apply`'d hover-bg rule. Added `:disabled { opacity-50 cursor-not-allowed }` + a `:disabled:hover` reset that defeats hover-bg/underline. Applies uniformly to `btn-pill-danger/success/primary/secondary` and `btn-row-danger/success/primary`.
3. **A7 (bonus) — focus-ring parity across button classes.** Only `.btn-row-kebab` had a `:focus-visible` ring; every other pill/row class relied on browser default. Added one grouped rule for all seven classes using the same `ring-blue-500` as form controls — a single "I am focused" signal across every interactive control in the app. The kebab trigger keeps its existing `ring-gray-400` (neutral icon button, scoped intentionally).

**What did NOT ship (initially scoped to this bundle but verified already implemented in v0.1.25.29 and earlier):**

- **A1 focus trap** — `src/composables/useFocusTrap.ts` already applied in `FormDialog.vue` and `ConfirmAction.vue`. Restores focus on unmount, cycles Tab/Shift-Tab, falls back to container focus when modal has no focusables. 8 tests in `src/__tests__/useFocusTrap.test.ts`.
- **A2 global Cmd+K** — `AppLayout.vue:21-41` already wires `window.keydown` with `preventDefault`, `inEditable` gate for `/`, and case-insensitive key match.
- **A4 SortHeader keyboard** — `SortHeader.vue:34-37` already has `tabindex="0"`, Enter/Space keydown, `aria-sort`, `role="columnheader"`. 2026-04-16 AUDIT entry confirms ship.
- **A5 skip-to-content** — `AppLayout.vue:46` already renders a visually-hidden anchor that becomes visible on focus.

**Validation gates (CLAUDE.md).**

- `vue-tsc -b --noEmit` — clean.
- `vitest run` — **402 / 402 passing** across 34 files (unchanged; no new JS logic).
- `vite build` — clean, 849ms.
- No new tests added: CSS additions are presentational and already covered at the interaction layer by the existing Playwright e2e suite (keyboard nav flows, dialog focus management). Coverage ratchet unchanged.

**No version bump.** CSS-only polish; no image tag. Rolls into the next release entry.

### 2026-04-17 — v0.1.25.29: row-actions kebab + UX consistency

**What ships in this tag.** Dashboard-only release — no spec or server change. Spec stays at v0.1.25.23, admin server requirement stays at v0.1.25.26+.

**New component: `RowActionsMenu`.** A reusable kebab menu (`src/components/RowActionsMenu.vue` + `src/__tests__/RowActionsMenu.test.ts`). Renders into `<Teleport to="body">` so the menu can escape the virtualized-grid clip; positioning is computed against the trigger's bounding rect on open. WAI-ARIA: trigger is `aria-haspopup="menu"` + `aria-expanded`; menu is `role="menu"`; items are `role="menuitem"`. Items support `label`, `onClick` *or* router `to`, `hidden`, `danger`, and `separator: true`. Dark-mode parity is delivered via `src/style.css` component classes (`.row-actions-menu`, `.row-actions-item`, `.row-actions-item-danger`, `.row-actions-separator`) with explicit `.dark .row-actions-*` overrides — the initial scoped `:global(.dark)` approach proved unreliable through the Teleport boundary because Vue's scoped data-attribute is not propagated across teleports.

**Adopted across 5 list views.** Per-view items, status-gated, with destructive items below a `separator` per Linear/GitHub convention. Post-merge consistency sweep (same tag, follow-up commit) guarantees **every kebab renders ≥2 actions in every status state** — some states had gated every mutable item off, leaving a 1-item menu (Webhooks ACTIVE showed only Pause; Reservations non-ACTIVE showed nothing; Budgets CLOSED / ApiKeys REVOKED similarly). Fix: prepend always-shown `Activity` (drills Audit pre-filtered by the row's natural key) on every kebab, plus a `Copy <id>` read-only item where `Activity` alone could be the only survivor (Reservations/Budgets/ApiKeys/TenantDetail keys). `WebhooksView` gains `Edit` as a second always-shown item routing to `webhook-detail?action=edit` (consumed on mount via a guarded `editIntentApplied` flag so polling refetches don't re-open the dialog). Current per-view items:

| View              | Items (top → bottom)                                                                                             |
|-------------------|-------------------------------------------------------------------------------------------------------------------|
| ApiKeysView       | Activity · Copy key ID · Edit (ACTIVE) · — · Revoke (ACTIVE, danger)                                              |
| ReservationsView  | Activity · Copy reservation ID · — · Force release (ACTIVE, danger)                                               |
| TenantsView       | Activity · Copy tenant ID · Reactivate (SUSPENDED) · — · Suspend (ACTIVE, danger)                                 |
| WebhooksView      | Activity · Edit · Enable (PAUSED/DISABLED) · — · Pause (ACTIVE, danger)                                           |
| BudgetsView       | Activity · Copy scope · Fund (ACTIVE) · Unfreeze (FROZEN) · — · Freeze (ACTIVE, danger)                           |
| TenantDetail keys | Activity · Copy key ID · Edit (ACTIVE) · — · Revoke (ACTIVE, danger)                                              |
| TenantDetail pol. | Activity · Edit                                                                                                   |

`Fund` from the BudgetsView row kebab is the one new operator action in this release. Previously Fund Budget was only reachable from detail mode. A new `fundTarget` ref<BudgetLedger | null> decouples the fund-dialog from `detail.value` so list-mode invocation works without first entering detail mode; on success in list mode the view refreshes via `loadList()` instead of `loadDetail()`. Dialog header shows "Funding `<scope>` (`<unit>`)" so the operator sees which budget they're acting on.

**Detail-view header consolidation.** Every primary action lives in the page-header action row across all detail views — no more middle-of-page button strips:

- `TenantDetailView` — `Create Budget` / `Create API Key` / `Create Policy` moved into the header, contextual to the active tab (was three separate `flex justify-end mb-2` strips above each tab's table).
- `BudgetsView` (detail mode) — `Fund Budget` moved into the header alongside Edit/Freeze/Unfreeze (was a `border-t` strip mid-card with `"Credit, debit, reset allocation, or repay debt"` redundant sub-copy — sub-copy dropped).
- `WebhookDetailView` — delivery-history filter inlined into the table-chrome row (was a 60px standalone `card p-4 mb-4` holding one `<select>`); chrome is now a 2-row stack (title above; counter + filter + exports below) with `gap-x-3 gap-y-2` matching the convention used elsewhere; Export button labels normalized to `Export CSV` / `Export JSON` (was `CSV` / `JSON` — every other list view already used the long form).

**AuditView filter compacted.** From a 5-stack of `fieldset`/`legend` sections (post-previous-pass) to a single `grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 items-end` containing all 8 filter inputs, plus a footer row holding `Quick range` chips + `Run Query`. Three rows on desktop instead of six. Logical grouping preserved via field *ordering* (Scope → Event → Identity → Time), not separate containers. The `search` filter that the server matches against `resource_id` OR `log_id` substring now corresponds to a visible data field — `Log ID` surfaces as the top-left item in the expand block (with `font-mono`), so an operator filtering by partial log-id sees which row matched.

**Project-wide.** `SortHeader` (`src/components/SortHeader.vue`) gains `whitespace-nowrap` on the inner label span — labels like "HTTP Code" no longer wrap on the WebhookDetail delivery-history grid (or any other table). `WebhookDetailView` `deliveryGridTemplate` HTTP Code column widened `100px → 120px` to fit the wider 4xx/5xx codes without truncation.

**Test migration.**

- New: `src/__tests__/RowActionsMenu.test.ts` — open/close, ARIA attrs, click dispatch, separator/hidden item handling.
- Rewritten: `src/__tests__/error-surfacing.test.ts` — new `clickMenuItem(wrapper, ariaPrefix, label)` helper opens the row kebab and clicks the teleported `menuitem` in `document.body`; `beforeEach` clears `document.body.innerHTML` so teleported menus from a prior test don't leak. 4 ApiKeysView toast specs migrated.
- Migrated: 4 Playwright e2e specs (`api-keys-edit`, `audit-drilldown-from-apikey`, `budgets-freeze-unfreeze`, `replay-event`, `reservations-force-release`, `revoke-key`) — open the row's `Actions for <noun>` kebab, then click the named `menuitem`. The `budgets-freeze-unfreeze` spec also asserts the *absent* menuitem (e.g., Unfreeze hidden when budget is ACTIVE) by `toHaveCount(0)` after opening the menu.

**Validation gates (CLAUDE.md).**

- `vue-tsc -b --noEmit` — clean.
- `vitest run` — **402 / 402 passing** across **34 files** (+15 tests, +1 file from .28: new RowActionsMenu suite + reshaped error-surfacing assertions).
- `vite build` — clean, **875ms**.

**Version bumps.** `package.json` `0.1.25.28 → 0.1.25.29`; `package-lock.json` synced via `npm install --package-lock-only`; `docker-compose.prod.yml` dashboard image pin `0.1.25.28 → 0.1.25.29`; `README.md` compose-example dashboard image `0.1.25.28 → 0.1.25.29`. Spec badge unchanged at `v0.1.25.23`. `docker-compose.yml` (dev stack) intentionally not bumped — uses local `build:` rather than the published image.

### 2026-04-17 — v0.1.25.28: bulk-action wire-up + CI smoke-probes

**What ships in this tag.**

- **PR-B feature**: filter-apply bulk-action path on TenantsView + WebhooksView (full detail in the next section).
- **CI coverage gate**: `scripts/e2e-probes.sh` extended with 6 new probes (`tenant bulk-action: empty filter → 400`, `invalid action → 400`, `zero-match → 200 envelope`, `idempotency replay → 200`, plus webhook mirror of empty-filter + zero-match). Probes run through the dashboard's nginx proxy, so they cover both the admin-server implementation and the plumbing layer that produced the v0.1.25.22 path-stripping regression. Probes deliberately exercise only schema-validation + zero-match + replay — no mutation — so the same script stays safe against any seed-content state and can run locally or in CI without surprise. Mutation-path coverage lives in vitest (`src/__tests__/idempotencyKey.test.ts`) + ad-hoc dev smoke-tests.
- **CI gate inheritance**: the existing `.github/workflows/e2e.yml` runs this probe script on PRs touching `src/api/client.ts`, `src/views/**`, `docker-compose*.yml`, `nginx.conf`, `scripts/e2e-probes.sh`, etc. (nightly + on-change). The existing `.github/workflows/release.yml smoke-test-published` job runs the same probes against the *published* dashboard image after each release — so this tag's release pipeline smoke-tests its own image end-to-end.
- **Version realignment**: `package.json` `0.1.25.27 → 0.1.25.28`; `docker-compose.prod.yml` dashboard image pin `0.1.25.23 → 0.1.25.28`; `README.md` spec badge + opening line bumped `v0.1.25.14 → v0.1.25.23` (catches 6 releases of drift — the governance spec has moved through .14 → .19 → .21 → .23 while the README stayed frozen); README compose example dashboard `0.1.25.22 → 0.1.25.28` and admin `0.1.25.10 → 0.1.25.26`.
- **Requires update**: this release entry is the point at which `admin server v0.1.25.26+ required` becomes part of the baseline spec-alignment story (the TenantsView / WebhooksView filter-apply UI 404s against older admin servers; row-select continues to work unchanged).

**Validation gates (CLAUDE.md).**

- `vue-tsc --noEmit` — clean.
- `vitest run` — **387 / 387 passing** across **33 files** (+5 for the bulk-action wrappers: wire-shape for both wrappers, LIMIT_EXCEEDED `details.total_matched` passthrough, COUNT_MISMATCH errorCode, INVALID_REQUEST on empty filter — all five exercise the ApiError code paths that the humanized toasts depend on).
- `vite build` — clean, 857ms.
- `vitest --coverage` — touched-layer coverage improved: `src/api/client.ts` 86.18 → **87.29% statements** (added the first wire-shape coverage for `bulkActionTenants` / `bulkActionWebhooks`). Repo-wide coverage stays at ~92.7% because views are excluded from the V8 report and are covered by Playwright e2e instead — see `.github/workflows/e2e.yml` and now `scripts/e2e-probes.sh`'s expanded probe matrix.
- Local smoke-test matrix against admin v0.1.25.26 — 6/6 probes PASS on live endpoint (see PR #78 body for the full matrix; covers empty-filter, invalid-action, zero-match, idempotency replay, webhook mirror, cleanup).

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

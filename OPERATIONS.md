# Operations guide

Operator-facing runbook for running `cycles-dashboard` in production. Covers
deployment, reverse-proxy wiring, CORS, auth, capability gating, admin-server
version compatibility, and the common troubleshooting paths.

Assumes you are deploying via the published Docker image
(`ghcr.io/runcycles/cycles-dashboard:<version>`) or the compose stack. If you
haven't set that up yet, see the Deployment section of
[`README.md`](README.md) first.

The dashboard is a **static SPA** served by nginx. It has no server-side
state, no metrics endpoint, and no persistence. All data comes from the two
backend planes:

- **Governance plane** (`cycles-admin-server`) on port 7979 — owns tenants,
  budgets, policies, API keys, webhooks, events, audit. Operational runbook:
  [cycles-server-admin/OPERATIONS.md](https://github.com/runcycles/cycles-server-admin/blob/main/OPERATIONS.md).
- **Runtime plane** (`cycles-server`) on port 7878 — owns reservations and
  commits. Used only by the Reservations view for admin-on-behalf-of force-
  release during incident response.
  [cycles-server/OPERATIONS.md](https://github.com/runcycles/cycles-server/blob/main/OPERATIONS.md).

## Table of contents

1. [Deployment](#deployment)
2. [Reverse-proxy wiring](#reverse-proxy-wiring)
3. [CORS](#cors)
4. [Admin-server version compatibility](#admin-server-version-compatibility)
5. [Auth and session](#auth-and-session)
6. [Capability gating](#capability-gating)
7. [Cross-surface correlation](#cross-surface-correlation-trace--request--correlation)
8. [Troubleshooting](#troubleshooting)

---

## Deployment

Two supported modes.

**Compose stack (recommended for single-host deployments).** The published
`docker-compose.prod.yml` brings up cycles-admin + cycles-server + Redis +
dashboard on one network. Dashboard talks to both planes via nginx reverse
proxy in the same container. The baseline pinned in the current compose file
is authoritative; see the badge in README.md or the release entry in
[`CHANGELOG.md`](CHANGELOG.md) for the current version.

**Behind a reverse proxy (Caddy / cloud load balancer).** The dashboard
container exposes port 80 and serves static assets + internal nginx reverse
proxy for `/v1/*`. For TLS, terminate at the edge proxy and forward to the
container. `nginx-ssl.conf.example` ships as a reference; `Caddyfile.example`
covers the Caddy path. Health-check path: `GET /` (returns the SPA shell).

The container is stateless — scale horizontally for availability. There is no
session-affinity requirement; the API key lives in the operator's browser
(`sessionStorage`), not the dashboard.

## Reverse-proxy wiring

`nginx.conf` inside the container routes `/v1/*` to the two backend planes:

- `/v1/reservations/*` → `cycles-server:7878` (runtime plane)
- `/v1/*` (everything else) → `cycles-admin:7979` (governance plane)

Service names resolve via Docker's internal DNS resolver (127.0.0.11). If you
deploy the dashboard outside Docker, rewrite the `proxy_pass` targets to your
admin and server hostnames. Both planes must be reachable from the dashboard
container — the browser never calls them directly.

`proxy_pass` uses `$request_uri` (not a literal `/v1/` suffix) so the full
original path + query string is preserved. Do not edit this. A prior regression
(`v0.1.25.22 → v0.1.25.23` hotfix) stripped the path for non-reservations
endpoints; the variable form is the fix.

## CORS

**Production (same-origin):** with the reverse-proxy wiring above, the browser
calls the dashboard's own origin for `/v1/*`. No CORS preflight happens. Nothing
to configure.

**Development (cross-origin):** `npm run dev` serves on `:5173` and calls the
admin plane on `:8080`. The admin plane must allow both `:8080` and `:5173` in
`DASHBOARD_CORS_ORIGIN` — comma-separated. Setting only `:8080` will 403 the
preflight for Vite dev.

Example compose override:

```yaml
cycles-admin:
  environment:
    - DASHBOARD_CORS_ORIGIN=http://localhost:8080,http://localhost:5173
```

**CORS failure signature:** preflight OPTIONS returns 403 (not 200) in the
browser Network tab. The JavaScript sees a generic TypeError but the real
diagnosis is the 403 on the preflight. Always check Network before assuming
the dashboard code is at fault.

## Admin-server version compatibility

The governance spec pin (e.g. `v0.1.25.26`) names the spec version the
dashboard exercises end-to-end. The admin-server minimum is higher — it
reflects the oldest admin version that ships every endpoint the dashboard
calls.

See [`AUDIT.md`](AUDIT.md) "Baseline requirements" table for the authoritative
current matrix. High-level rules:

- **Pre-`.27` admins** silently ignore unknown filter params per the
  additive-parameter guarantee. The dashboard's filter UI stays visible but
  filters apply client-side only — slower on large datasets, but functional.
- **Pre-`.28` admins** emit the legacy `<unauthenticated>` sentinel instead
  of `__unauth__` / `__admin__`. The dashboard's `TenantLink.isSystem` guard
  accepts both conventions — no regression.
- **Pre-`.29` admins** 404 `POST /v1/admin/budgets/bulk-action`. The
  BudgetsView row-select fund flow continues to work. The filter-apply
  bulk button will surface a 404 toast on submit.

**Upgrade path:** bump the admin pin in `docker-compose.prod.yml` and recycle.
The dashboard image does not need to change for an admin-only version bump.

## Auth and session

The dashboard uses `X-Admin-API-Key` header authentication. No cookies, no
server-side session.

- Key is stored in **`sessionStorage`** — survives page refresh, cleared on
  tab close. Not `localStorage`.
- **Idle timeout**: 30 minutes of no `mousedown` / `keydown` / `scroll` /
  `touchstart`. Check runs every 60s.
- **Absolute timeout**: 8 hours from login. Enforced regardless of activity.
- On 401 from the admin plane, the dashboard redirects to `/login` with
  `?redirect=<current-path>` so the operator lands back where they were.
- The `/v1/auth/introspect` endpoint on the admin plane returns the
  capability set for the supplied key. The dashboard uses this to drive
  capability gating (see next section).

The login screen displays a "session expired" banner when redirected from an
expired idle/absolute timeout. Manual logout clears `sessionStorage` and
redirects to `/login` without the banner.

## Capability gating

`/v1/auth/introspect` returns a `capabilities: string[]` array. The dashboard
hides / disables operator actions that the current key cannot perform:

| Capability | What it gates |
|---|---|
| `admin:tenant:manage` | TenantsView create / edit / suspend / reactivate / close, Emergency Freeze |
| `admin:budget:manage` | Create budget, Freeze/Unfreeze, Fund, bulk budget-action |
| `admin:apikey:manage` | Create / edit / revoke API keys |
| `admin:policy:manage` | Create / edit policies |
| `admin:webhook:manage` | Create / edit / pause / resume / delete webhooks |
| `admin:audit:read` | AuditView (hidden entirely when absent) |
| `runtime:reservation:admin` | ReservationsView force-release |

A read-only operator key (only the `:read` caps) sees every list view but no
write actions — kebabs are empty or disabled with a tooltip. This is the
intended shape; do not "open up" actions client-side if the server will 403
them anyway.

## Cross-surface correlation (trace / request / correlation)

Every HTTP-originated event and audit entry on admin **v0.1.25.31+**
carries a W3C Trace Context `trace_id` (32 hex chars). The admin plane
also emits an `X-Cycles-Trace-Id` response header on every response
(2xx / 4xx / 5xx), and honors inbound `traceparent` → `X-Cycles-Trace-Id`
→ server-generated (in that precedence order) so callers can stitch an
existing distributed trace through the governance plane.

**Operator pivots in the dashboard:**

- AuditView expanded row → **Trace ID** chip → pivots to EventsView
  filtered by `trace_id` (all events emitted by that single HTTP
  request). Use when you have an audit entry and want the events it
  produced.
- EventsView expanded row → **Trace ID** chip → pivots to AuditView
  filtered by `trace_id` (the originating audit entry). Use when you
  have an event and want the operation that caused it.
- **Request ID** chip on either view refilters the same view by
  `request_id` (typically 0–1 row — primary diagnostic lookup).
- All three chips (`trace_id` / `request_id` / `correlation_id`) carry
  a copy-to-clipboard button; tooltip shows the full untruncated value.

Filter inputs on both views accept a pasted `trace_id` (32 hex chars)
or `request_id` directly. `?trace_id=…` and `?request_id=…` URL
deep-links work too — useful for cross-referencing from ticket links.

Against a pre-`v0.1.25.31` admin, the new filter params are silently
ignored per the additive-parameter guarantee, and rows simply render
no trace chip (the field is absent). No regression.

## Troubleshooting

**Login loops back to `/login` on every action.** Idle timeout fired, or the
admin plane 401'd a request. Check admin-plane logs for the 401 reason —
usually a key revoke or a clock skew issue on the admin side. The dashboard
cannot help you diagnose this.

**"Session expired" banner on every login.** `sessionStorage` is being
cleared between page loads. Usually an incognito/private-window artifact, or
a browser extension clearing storage. Use a normal window.

**Read-only operator sees blank pages.** Some views require a specific
capability to even render the table (AuditView, ReservationsView). This is
intentional. Check the key's capabilities via `/v1/auth/introspect` and
compare against the table above.

**All list views empty, no error.** Usually the admin plane is up but
returning `total=0`. Check the admin plane directly
(`curl -H "X-Admin-API-Key: ..." http://admin:7979/v1/admin/tenants`). If
that's empty too, the seed data never loaded.

**"A row I know exists isn't showing up in the list."** As of **v0.1.25.46**
terminal-state rows (tenants/budgets `CLOSED`, webhooks `DISABLED`, api-keys
`REVOKED` / `EXPIRED`) are hidden by default on every list view. Check the
**"Show &lt;verb&gt;"** toggle in the filter row — the count next to it
(`Show closed (3)`) tells you how many are currently hidden. Flip it on, or
pick the terminal value in the status dropdown (auto-reveals those rows
even with the toggle off). Toggle state mirrors to `?include_terminal=1` so
a deep-linked list URL carries the operator's preference.

**"Exported CSV is missing some rows."** Same cause. Export follows the
visible list — if terminals are hidden, they are not in the export. This
is deliberate ("export what I see"). Flip the toggle on before exporting
if you need the terminals included.

**One list view empty, inline error banner.** The dashboard uses
`Promise.allSettled` on OverviewView so one failing endpoint does not blank
the landing page. Expand the banner to see the failing endpoint. Usually a
version-skew issue — admin plane below the minimum version for a new filter
param or endpoint.

**CORS preflight 403 in dev.** `DASHBOARD_CORS_ORIGIN` on the admin plane
does not include `http://localhost:5173`. See [CORS](#cors).

**Bulk action "N failed" with no dialog.** Older bulk paths (pre-v0.1.25.37
extension) dropped failures to browser console. Open DevTools Console for the
per-row failure reasons. As of v0.1.25.37 extension every bulk surface opens
`BulkActionResultDialog` on any failure.

**Row-select bulk mix-state selection shows all-success toast.** By design —
Tenants/Webhooks/Budgets pre-filter the selection to only rows whose state
would actually change (drops already-in-target-state rows silently to avoid
noisy 409s). If you need to exercise the dialog during testing, use DevTools
Network → Block request URL for the PATCH endpoint.

**Triaging a failing webhook delivery.** Open WebhookDetailView for the
subscription. The delivery-history grid shows the last delivery attempts
with Status / HTTP / Tries / Event ID / **Error** / Time columns. The
`Error` column carries the server's `error_message` — the two most common
values are the receiver's response body (e.g. `HTTP 405` when the endpoint
rejects POST) and `Subscription not active: DISABLED` (emitted after 10
consecutive failures trigger auto-disable). `RETRYING` is yellow, `FAILED`
is red; a `FAILED` row with `HTTP -` typically means the receiver never
responded (timeout / DNS / connection refused) rather than a 2xx. Click
**Copy JSON** on any row to grab `response_status` + `response_time_ms` +
`next_retry_at` + `trace_id` for cross-referencing into EventsView.

**Triaging a bulk action from the audit trail.** Open AuditView, filter by
`operation=bulkActionTenants` (or `…Webhooks` / `…Budgets`), and expand the
row. With admin-server **v0.1.25.30+** the entry renders a structured summary
(header + filter echo + succeeded/failed/skipped sections with per-row error
codes). The raw metadata JSON is available under the "Raw metadata" collapse
for wire-level inspection. Earlier admin versions fall back to the legacy
inline JSON block — upgrade admin to `.30` for the scannable view.

**Triaging a cascade-incomplete tenant.** A CLOSED tenant with non-terminal
owned objects renders an amber **"Cascade incomplete"** banner at the top
of TenantDetailView, above the tombstone. The banner enumerates per-axis
pending counts ("N budgets, N webhooks, N API keys are still non-terminal").
Two populations produce this state: tenants closed on admin **pre-v0.1.25.35**
(cascade semantics did not yet exist) and partial-failure cascades on
`.35+` (admin crash mid-loop, Redis blip between the tenant-status flip
and the per-child writes). Click **Re-run cascade** → confirm in the
dialog. The dashboard re-PATCHes `{"status":"CLOSED"}` on the already-CLOSED
tenant, which is a tenant-level no-op per spec v0.1.25.31 Rule 1(b)
idempotency and drives remaining non-terminal children to their terminal
states per Rule 1(c) convergence. On success the banner disappears. On
failure the dialog surfaces the server error and stays open for retry; if
a specific child repeatedly fails to transition, check the admin plane
logs for the per-child write error (usually a Redis connection issue or a
stale DISABLED-but-not-closed webhook). Operators without
`manage_tenants` see the banner (so they can escalate) but not the
button.

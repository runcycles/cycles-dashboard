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
5. [Upgrades and rollback](#upgrades-and-rollback)
6. [Backup and restore](#backup-and-restore)
7. [Auth and session](#auth-and-session)
8. [Capability gating](#capability-gating)
9. [Cross-surface correlation](#cross-surface-correlation-trace--request--correlation)
10. [Troubleshooting](#troubleshooting)

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

**Dev stack ports are loopback-only.** `docker-compose.yml` (the dev stack)
binds every published port to `127.0.0.1` — it runs a passwordless Redis and
a default admin key, so nothing in it may be reachable from other hosts. Use
a local override file if you knowingly need wider exposure.

**Memory limits (prod).** `docker-compose.prod.yml` caps each service via
`deploy.resources.limits.memory`. The caps are env-parameterized:
`CYCLES_SERVER_MEM_LIMIT` / `CYCLES_ADMIN_MEM_LIMIT` /
`CYCLES_EVENTS_MEM_LIMIT` (default 2g each), `REDIS_MEM_LIMIT` (default
768m); dashboard and caddy stay fixed at 256m. *Memory sizing:* the
defaults suit small/mid fleets. The JVMs size their heap as 75% of the
container limit (`-XX:MaxRAMPercentage=75`), so a 2g cap ≈ 1.5g heap —
raise the three JVM knobs together with tenant/key/webhook volume. Redis
additionally runs with `--maxmemory` (`REDIS_MAXMEMORY`, default 512mb)
and `--maxmemory-policy noeviction`: governance data must never be
silently evicted, so hitting the cap surfaces as visible Redis write
errors instead of a kernel OOM-kill → AOF-replay crash loop that takes
down all three planes. Always keep `REDIS_MAXMEMORY` comfortably below
`REDIS_MEM_LIMIT` (the defaults leave 256m headroom) — AOF rewrites and
persistence forks need memory beyond the dataset; raise the two together.
Requires Docker Compose v2 (the `docker compose` plugin), which applies
`deploy.resources.limits` outside swarm mode.

**Further hardening (deliberate non-defaults).** The stock nginx and caddy
images need root at startup (port bind, config render, privilege drop), so
the compose files stop at `no-new-privileges` + memory limits. `read_only`
rootfs with tmpfs mounts and `cap_drop` are the next steps if your platform
needs them — they require image-specific tuning and are intentionally not
shipped as defaults.

## Reverse-proxy wiring

The container bundles its own nginx reverse proxy — there is **no separate
proxy to deploy**. `default.conf.template` inside the image routes `/v1/*` to
the two backend planes:

- `/v1/reservations/*` → runtime plane (default `http://cycles-server:7878`)
- `/v1/evidence/*` and `/v1/.well-known/cycles-jwks.json` → runtime plane
  (added v0.1.25.62 — the Evidence viewer fetches signed envelopes + signer
  keys from the runtime server, same origin so the CSP `connect-src 'self'`
  allows it)
- `/v1/*` (everything else) → governance plane (default `http://cycles-admin:7979`)

The two upstreams are configurable at deploy time via environment variables —
**no file edit and no image rebuild required:**

| Variable | Default | Purpose |
|----------|---------|---------|
| `ADMIN_UPSTREAM` | `http://cycles-admin:7979` | Governance-plane base (`/v1/*` except the runtime routes below) |
| `RUNTIME_UPSTREAM` | `http://cycles-server:7878` | Runtime-plane base (`/v1/reservations/*`, `/v1/evidence/*`, `/v1/.well-known/cycles-jwks.json`) |

The stock nginx entrypoint renders `default.conf.template` through `envsubst`
at container start, filling these two placeholders while leaving nginx's own
runtime variables (`$host`, `$request_uri`, `$upstream`, …) intact. Defaults
match the bundled compose service names, so the image works out of the box;
override them when the admin / runtime servers live on different hosts or
ports (split deployments, external endpoints). Include the scheme — e.g.
`ADMIN_UPSTREAM=https://admin.internal:7979`.

Service names resolve via Docker's internal DNS resolver (127.0.0.11). Both
planes must be reachable from the dashboard container — the browser never
calls them directly, so no CORS or CSP changes are needed when retargeting.

`proxy_pass` uses `$request_uri` (not a literal `/v1/` suffix) so the full
original path + query string is preserved. Do not edit this. A prior regression
(`v0.1.25.22 → v0.1.25.23` hotfix) stripped the path for non-reservations
endpoints; the variable form is the fix.

**Cache headers.** The bundled nginx serves `index.html` with
`Cache-Control: no-cache` (revalidate on every load) and `/assets/*` with
`public, max-age=31536000, immutable`. The build embeds SRI hashes
(vite-plugin-sri-gen), so a stale cached `index.html` referencing purged
hashed assets would both 404 and hard-fail integrity after a deploy — the
`no-cache` header prevents that failure class. An edge proxy or CDN in
front should pass these headers through (it may cache `/assets/*`
aggressively; it must not cache `index.html` beyond revalidation).

**X-Forwarded-Proto trust.** The bundled nginx passes an incoming
`X-Forwarded-Proto` through to the backends verbatim (falling back to its
own scheme only when the header is absent). That is trustworthy only behind
a TLS terminator that overwrites forwarded headers from untrusted clients —
the shipped topologies do (Caddy replaces incoming `X-Forwarded-*` by
default; `nginx-ssl.conf.example` sets the header explicitly). Exposing the
dashboard container directly makes the header client-controlled — a
plain-HTTP caller can spoof `https` — so direct exposure is dev-only (the
dev compose binds to loopback).

**Security headers** live in `/etc/nginx/snippets/security-headers.conf`
inside the image. `security-headers.conf` in this repo is a build template:
after Vite emits `dist/index.html`, the Docker build computes the SHA-256 of
the exact inline SRI import map and replaces `__CSP_IMPORTMAP_HASH__` in the
served snippet. This permits only that generated inline script; it does not
enable `'unsafe-inline'`. The build fails closed if either the import map or
placeholder is missing or duplicated. The generated headers
are re-`include`d in every location that sets its own header because
nginx's `add_header` does not merge across levels — a location-level
`add_header` silently drops all inherited headers. Keep that invariant
when editing the template.

**JSON errors on proxy failure.** When an upstream plane is down or
unreachable, the proxy answers 502/503/504 with a JSON body
(`{"error": "UPSTREAM_UNAVAILABLE", "message": …}`, served from
`/50x.json` with the original status code) instead of nginx's HTML error
page, so `/v1/*` callers can always parse the error. Error bodies produced
by the upstreams themselves pass through unmodified
(`proxy_intercept_errors` stays off).

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

**Upgrade path:** see [Upgrades and rollback](#upgrades-and-rollback). The
dashboard image does not need to change for an admin-only version bump.

## Upgrades and rollback

**Pinned server fleet (dashboard v0.1.25.72):** runtime `0.1.25.58`, admin
`0.1.25.53`, events `0.1.25.24`. These are exact tags, not floating aliases.

**Upgrading an existing fleet to the pinned versions.** Upgrade events before
admin: admin `.51+` assumes the ownership boundary enforced by events `.23+`.
Events `.24` also changes the internal members of `evidence:processing` from
raw source JSON to claim IDs. If evidence signing is enabled, stop every older
events replica and use the older workers to drain or recover
`evidence:processing` before starting `.24`; records in `evidence:pending` may
remain queued. Then deploy events `.24`, admin `.53`, and runtime `.58`:

```bash
docker compose -f docker-compose.prod.yml pull \
  cycles-events cycles-admin cycles-server
docker compose -f docker-compose.prod.yml up -d cycles-events
docker compose -f docker-compose.prod.yml up -d cycles-admin cycles-server
```

Fresh deployments and fleets with evidence signing disabled have no
`evidence:processing` migration and may bring up the pinned stack normally.

**Admin-only bump.** Edit the `cycles-server-admin` image pin in
`docker-compose.prod.yml`, then recycle just that service:

```bash
docker compose -f docker-compose.prod.yml pull cycles-admin
docker compose -f docker-compose.prod.yml up -d cycles-admin
```

**Dashboard bump.** Same pattern with the `dashboard` service pin
(`ghcr.io/runcycles/cycles-dashboard:<version>`). Check the release entry in
[`CHANGELOG.md`](CHANGELOG.md) for an admin-server minimum bump first — if
the minimum moved, bump admin in the same maintenance window:

```bash
docker compose -f docker-compose.prod.yml pull dashboard
docker compose -f docker-compose.prod.yml up -d dashboard
```

Operators with an open tab pick up the new build on their next page load —
`index.html` is served `Cache-Control: no-cache`, so no hard refresh is
needed.

**Rollback.** Every image in the stack is pinned by tag, so rollback is
editing the pin back to the previous version and re-running `up -d` — compose
recreates only the changed service. Previous dashboard versions are listed in
[`CHANGELOG.md`](CHANGELOG.md); published tags are never reused. Roll back
the dashboard alone unless the release notes say the admin minimum moved.
An image rollback does not touch Redis data — but take a backup (below)
before rolling the admin plane back across a release that changed data
shapes.

## Backup and restore

**All governance state lives in the `redis-data` volume** — tenants, budgets,
policies, API keys, webhooks, events, audit; both planes share the one Redis.
Dashboard and caddy containers are stateless. The compose volumes are the
only persistence on the host.

Take a short maintenance window for backups. Redis is configured with AOF
enabled, and Redis 7 stores AOF data as a manifest plus multiple files. Tarring
the volume while Redis is running can race an AOF rewrite and capture a file set
that does not match the manifest. Stop the writers first, force an RDB snapshot,
then stop Redis before a throwaway container reads the volume:

```bash
docker compose -f docker-compose.prod.yml stop \
  cycles-admin cycles-server cycles-events
docker compose -f docker-compose.prod.yml exec redis \
  sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli SAVE'
docker compose -f docker-compose.prod.yml stop redis
docker run --rm -v <project>_redis-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/redis-data-$(date +%F).tar.gz -C /data .
docker compose -f docker-compose.prod.yml up -d
```

`REDISCLI_AUTH` is set inside the Redis container, so the command uses the
password Compose supplied from `.env` even when the host shell did not export
`REDIS_PASSWORD`. If any backup step fails after services are stopped, run the
final `up -d` command to restore the stack before investigating.

Restore into a stopped stack:

```bash
docker compose -f docker-compose.prod.yml down
docker run --rm -v <project>_redis-data:/data -v "$PWD":/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/redis-data-<date>.tar.gz -C /data"
docker compose -f docker-compose.prod.yml up -d
```

`<project>` is the compose project name — `docker volume ls` shows the exact
volume name.

**`caddy-data` persists the Let's Encrypt certificates.** Deleting it forces
re-issuance on next start, which can trip Let's Encrypt rate limits (5
duplicate certificates per week). Leave it in place across redeploys; include
it in backups if you rebuild hosts often.

## Auth and session

The dashboard uses `X-Admin-API-Key` header authentication. No cookies, no
server-side session.

- Key is stored in **`sessionStorage`** — survives page refresh, cleared on
  tab close. Not `localStorage`.
- **Idle timeout**: 30 minutes of no `mousedown` / `keydown` / `touchstart`.
  Check runs every 15s. Passive scrolling intentionally does not extend a
  session.
- **Absolute timeout**: 8 hours from login. Enforced regardless of activity.
- On 401 from the admin plane, the dashboard redirects to `/login` with
  `?redirect=<current-path>` so the operator lands back where they were.
- The `/v1/auth/introspect` endpoint on the admin plane returns the
  capability set for the supplied key. The dashboard uses this to drive
  capability gating (see next section).
- Introspection clears a stored key only on explicit credential rejection
  (`401`/`403` or `authenticated: false`). A fetch failure, malformed response,
  or proxy/upstream 5xx keeps the key for retry and shows a service-unavailable
  message. Those failures do not advance the invalid-key login lockout.

The login screen displays a "session expired" banner when redirected from an
expired idle/absolute timeout. Manual logout clears `sessionStorage` and
redirects to `/login` without the banner.

## Capability gating

`/v1/auth/introspect` returns a `capabilities` object of boolean flags. The dashboard
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

**"Unable to reach the admin server" on login or restore.** The dashboard
retains the submitted/saved key because a network or 5xx failure does not prove
the credential is invalid. Restore admin-plane connectivity, then retry; an
explicit authentication rejection will still clear the key.

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

**"The budget-status donut on Overview isn't drawing."** Two cases. (1) The
fleet is empty — if `budget_counts.{active,frozen,closed,over_limit}` are
all zero, the donut block is intentionally hidden (no empty-chart
placeholder). Create or fund a budget and refresh. (2) The ECharts chunk
failed to load — the chart is lazy-split (`BaseChart-*.js`, ~142 KB gz).
DevTools → Network → look for a failed JS fetch; the Overview shell still
renders its counter strip and attention cards regardless. The container
itself serves `/assets/*` with correct immutable cache headers — a failed
chunk fetch points at an edge proxy / CDN in front rewriting `/assets/*.js`
paths or caching a stale `index.html` in violation of its
`Cache-Control: no-cache` header.

**"Dark-mode palette on a chart looks wrong after a theme toggle."** The
chart theme reactively rebinds when `isDark` flips. If colors look frozen
on the old palette, the browser's service worker may be serving a stale
`BaseChart-*.js` from before a deployment. Hard-refresh (Ctrl+Shift+R)
clears it. (`index.html` is served `no-cache`, so a normal reload picks up
the new asset manifest — persistent staleness means an extension/service
worker or an edge cache ignoring the container's cache headers.)

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

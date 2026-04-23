[![CI](https://github.com/runcycles/cycles-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/runcycles/cycles-dashboard/actions)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![Spec](https://img.shields.io/badge/spec-v0.1.25.31-blue)](https://github.com/runcycles/cycles-protocol/blob/main/cycles-governance-admin-v0.1.25.yaml)
[![Vue](https://img.shields.io/badge/vue-3-brightgreen)](https://vuejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-strict-blue)](https://www.typescriptlang.org)

# Runcycles Admin Dashboard

Operational admin dashboard for the [Cycles Budget Governance System](https://github.com/runcycles/cycles-server-admin), aligned with [governance spec v0.1.25.31](https://github.com/runcycles/cycles-protocol/blob/main/cycles-governance-admin-v0.1.25.yaml).

**Documentation:** [CHANGELOG](CHANGELOG.md) (downstream release notes) · [OPERATIONS](OPERATIONS.md) (production runbook) · [AUDIT](AUDIT.md) (engineering narrative).

<p align="center">
  <img src="docs/runcycles-demo.gif" alt="Dashboard walkthrough — tenants, budgets, reservations, webhooks" width="800"/><br/>
  <em>End-to-end walkthrough of the main operator flows</em>
</p>

## Overview

Operations-first dashboard for monitoring and managing the Cycles budget enforcement platform. Designed around operator workflows, not CRUD entity lists.

| Page | Purpose |
|------|---------|
| **Overview** | Operational health at a glance — single-request aggregated dashboard |
| **Tenants** | Tenant list + detail with budgets, API keys, and policies tabs |
| **Budgets** | Tenant-scoped budget list with utilization/debt bars + exact scope detail |
| **Events** | Correlation-first investigation tool with expandable detail rows |
| **API Keys** | Cross-tenant key list with masked IDs, permissions, status filters |
| **Webhooks** | Subscription health (green/yellow/red) + delivery history |
| **Reservations** | Hung-reservation force-release during incident response (runtime-plane admin-on-behalf-of) |
| **Audit** | Compliance query tool with CSV/JSON export (manual-only, no auto-refresh) |

### Operational Actions

Tier 1 incident-response actions available directly from the dashboard (capability-gated, confirmation required):

| Action | Where | Effect |
|--------|-------|--------|
| **Freeze budget** | Budget detail | Blocks all reservations, commits, and fund operations |
| **Unfreeze budget** | Budget detail | Re-enables normal operations |
| **Create budget** | Budgets list, Tenant detail | Admin-on-behalf-of (dual-auth) — modal with ScopeBuilder + tenant selector |
| **Adjust budget allocation** | Budget detail | Inline form — uses fund endpoint with RESET operation |
| **Rollover billing period (RESET_SPENT)** | Budget detail → Fund → RESET_SPENT | Resets `spent` tally without touching `allocated`; optional exact-spent override (blank = zero). Requires cycles-server-admin v0.1.25.18+ |
| **Bulk budget action (CREDIT / DEBIT / RESET / RESET_SPENT / REPAY_DEBT)** | Budgets list | Filter-apply — single tenant required (spec constraint); preview walk + expected_count gate + per-row result dialog for failed/skipped rows. Requires cycles-server-admin v0.1.25.29+ |
| **Emergency Freeze (tenant-wide)** | Tenant detail | Sequential freeze across all ACTIVE budgets — one-click lockdown with confirm + blast-radius summary |
| **Create policy** | Policies tab (Tenant detail) | Admin-on-behalf-of — modal form, tenant-scoped |
| **Edit policy** | Policies tab | Admin-on-behalf-of — patch policy_id, server resolves owning tenant |
| **Suspend tenant** | Tenant detail | Blocks all API access for the tenant |
| **Reactivate tenant** | Tenant detail | Restores API access |
| **Bulk suspend / reactivate tenants** | Tenants list | Multi-select + bulk action bar with sequential per-tenant calls, live progress, cancel-between-requests |
| **Create tenant** | Tenants list | Modal form, navigates to new tenant on success |
| **Edit tenant** | Tenant detail | Edit display name |
| **Revoke API key** | API Keys list, Tenant detail | Immediately invalidates the key (irreversible) |
| **Create API key** | API Keys list, Tenant detail | Modal form with permissions, shows secret once |
| **Edit API key** | API Keys list | Edit name, permissions, scope filter |
| **Pause webhook** | Webhook detail | Stops event deliveries; events silently dropped |
| **Enable webhook** | Webhook detail | Resumes deliveries (resets failure counter) |
| **Reset & re-enable webhook** | Webhook detail | Re-enables disabled/failing webhook, clears failures |
| **Bulk pause / enable webhooks** | Webhooks list | Multi-select + tenant filter; sequential per-sub with cancel. Auto-disabled webhooks excluded from bulk Enable (per-row verification required) |
| **Create webhook** | Webhooks list | Modal form, shows signing secret once |
| **Delete webhook** | Webhook detail | Permanent deletion with confirmation |
| **Test webhook** | Webhook detail | Sends synthetic test event, shows result inline |
| **Replay events** | Webhook detail | Re-deliver events for a time range |
| **Force release reservation** | Reservations | Runtime-plane admin-on-behalf-of — pre-filled `[INCIDENT_FORCE_RELEASE]` reason for audit grep-ability |

## Architecture

```
src/
├── api/           # API client (X-Admin-API-Key only)
├── components/    # Reusable UI: Sidebar, PageHeader, StatusBadge, SortHeader, EmptyState, etc.
├── composables/   # usePolling, useSort, useDarkMode, useTerminalAwareList, useChartTheme
├── stores/        # Pinia: auth (introspect + capabilities)
├── views/         # 10 route views (login, overview, budgets, events, api-keys, webhooks, audit, tenants + detail views)
└── types.ts       # TypeScript types matching governance spec schemas
```

- **Framework:** Vue 3 + TypeScript + Vite
- **State:** Pinia
- **Styling:** Tailwind CSS v4 with dark mode support
- **Testing:** Vitest + @vue/test-utils (unit); Playwright (E2E against live compose stack)
- **Router:** Vue Router 4 with auth guard
- **Security:** SRI hashes (`vite-plugin-sri-gen`), CSP + HSTS headers, login rate limiting

## Quick Start

### Development (with Vite proxy)

Requires **both** backends running locally:
- **cycles-server-admin** at `localhost:7979` — governance plane (tenants, budgets, policies, webhooks, audit, introspect).
- **cycles-server** at `localhost:7878` — runtime plane (reservations; force-release uses admin-on-behalf-of dual-auth).

```bash
npm install
npm run dev
```

Dashboard starts at `http://localhost:5173`. The Vite dev server splits the proxy:
- `/v1/reservations*` → `localhost:7878` (cycles-server)
- `/v1/*` (all others) → `localhost:7979` (cycles-server-admin)

The same routing split is mirrored in `nginx.conf` for the production container.

### Development (full stack via Docker)

```bash
# Start admin server + Redis
cd ../cycles-server-admin
ADMIN_API_KEY=your-key docker compose up -d

# Start dashboard
cd ../cycles-dashboard
npm install
npm run dev
```

### Production (Docker)

See [Production Deployment](#production-deployment) below. The recommended setup uses Caddy for automatic HTTPS:

```bash
cp Caddyfile.example Caddyfile   # edit domain
# create .env with ADMIN_API_KEY, REDIS_PASSWORD, etc.
docker compose -f docker-compose.prod.yml up -d
```

Only ports 443 and 80 are exposed. All internal services (dashboard, admin server, Redis) communicate over the Docker network.

## Authentication

The dashboard uses `AdminKeyAuth` exclusively (`X-Admin-API-Key` header). No tenant API keys are used.

1. User enters admin API key on the login page
2. Dashboard calls `GET /v1/auth/introspect` to validate and retrieve capabilities
3. Sidebar navigation is gated by capability booleans (`view_overview`, `view_budgets`, etc.)
4. On 401/403 from any API call, the session is cleared and user is redirected to login
5. API key is stored in `sessionStorage` — survives page refresh, cleared on tab/browser close
6. Session idle timeout (30 min) and absolute timeout (8 h) enforced client-side (checked every 15s)
7. Login rate limiting — exponential backoff after 3 failed attempts (5s → 60s cap)

## API Endpoints Used

| Endpoint | Page | Notes |
|----------|------|-------|
| `GET /v1/auth/introspect` | Login | Auth validation + capability discovery |
| `GET /v1/admin/overview` | Overview | Single-request aggregated dashboard payload |
| `GET /v1/admin/tenants` | Tenants | Tenant list |
| `GET /v1/admin/tenants/{id}` | Tenant Detail | Single tenant |
| `GET /v1/admin/budgets` | Budgets | Tenant-scoped list (requires `tenant_id` param) |
| `GET /v1/admin/budgets/lookup` | Budget Detail | Exact (scope, unit) lookup |
| `GET /v1/admin/events` | Events | Filtered event stream |
| `GET /v1/admin/webhooks` | Webhooks | Subscription list |
| `GET /v1/admin/webhooks/{id}` | Webhook Detail | Single subscription |
| `GET /v1/admin/webhooks/{id}/deliveries` | Webhook Detail | Delivery history |
| `GET /v1/admin/audit/logs` | Audit | Manual query with export |
| `GET /v1/admin/api-keys` | Tenant Detail | API keys per tenant |
| `GET /v1/admin/policies` | Tenant Detail | Policies per tenant (requires `tenant_id`) |
| `POST /v1/admin/budgets/freeze` | Budget Detail | Freeze budget (ACTIVE → FROZEN) |
| `POST /v1/admin/budgets/unfreeze` | Budget Detail | Unfreeze budget (FROZEN → ACTIVE) |
| `PATCH /v1/admin/tenants/{id}` | Tenant Detail | Suspend / reactivate tenant |
| `DELETE /v1/admin/api-keys/{key_id}` | API Keys, Tenant Detail | Revoke API key |
| `PATCH /v1/admin/webhooks/{subscription_id}` | Webhook Detail | Pause/enable, reset failures |
| `DELETE /v1/admin/webhooks/{subscription_id}` | Webhook Detail | Delete webhook subscription |
| `POST /v1/admin/webhooks/{subscription_id}/test` | Webhook Detail | Send test event |
| `POST /v1/admin/webhooks/{subscription_id}/replay` | Webhook Detail | Replay historical events |
| `POST /v1/admin/budgets/fund` | Budget Detail | Adjust allocation (RESET operation) |

## List conventions

Every top-level list view (Tenants, Budgets, Webhooks, API Keys) and the TenantDetail sub-lists share a **hide-terminal-by-default** pattern (v0.1.25.46+). Terminal-state rows are hidden at mount and surfaced via a **"Show &lt;verb&gt;"** toggle in the filter row:

| Entity | Terminal states | Toggle label | URL param |
|---|---|---|---|
| Tenant | `CLOSED` | Show closed (N) | `?include_terminal=1` |
| Budget | `CLOSED` | Show closed (N) | `?include_terminal=1` |
| Webhook | `DISABLED` | Show disabled (N) | `?include_terminal=1` |
| API Key | `REVOKED`, `EXPIRED` | Show revoked (N) | `?include_terminal=1` |

- **Why:** under default `created_at desc` sort, freshly-terminal rows pin to the top and visually compete with rows that still need operator action. Matches the Gmail / GitHub / Linear "hide done / archived" convention.
- **Auto-engage:** picking a terminal value from the status dropdown (e.g. `status=CLOSED`) auto-reveals those rows so the operator doesn't see an empty list (same pattern as GitHub's `state:closed`).
- **Sink order:** when toggled on, terminal rows appear at the bottom of the visible list via stable partition (column-sort order preserved within each group).
- **Export / select-all / counter:** all read from the post-terminal-filter visible list. CSV/JSON export never includes hidden terminals; bulk actions never silently touch a hidden row.

Shared implementation: `src/composables/useTerminalAwareList.ts`.

## Visualizations

The dashboard renders inline charts alongside the data tables via Apache
ECharts (`vue-echarts`). The charting layer landed as a trial slice in
v0.1.25.47 (single donut) and expanded through v0.1.25.48 – v0.1.25.50
to three Overview donuts: **Budget status distribution** (lifecycle
mix), **Budget fleet utilization** (true-utilization buckets —
Healthy < 90% / Near cap 90–99% / Over cap ≥ 100%, computed from
`spent/allocated` rather than the debt-based `is_over_limit` server
signal), and **Events by category** (recent-window activity mix).
v0.1.25.51 added a **webhook fleet-health donut**
(Healthy / Failing / Paused / Disabled) and a four-up
**per-subscription stat row** on `WebhookDetailView` (last-success
band, delivery-outcome donut, attempts histogram, response-time
p50/p95/max) — all derived from the data polls already in flight.
v0.1.25.52 **relocated** the webhook fleet-health donut from
`WebhooksView` to the Overview chart row (now 4-up on `lg`:
budget utilization → webhook fleet health → events by category
→ top-10 by debt) so `WebhooksView` keeps the table above the
fold for row-level triage; `WebhookDetailView` stat row stays on
the detail view (per-subscription detail belongs with the
subscription). Subsequent slices extend the pattern to API Keys /
Events views.

Shared building blocks:

| File | Role |
|---|---|
| `src/components/BaseChart.vue` | Shared wrapper. Props: `option`, `label` (accessibility), `height`. Tree-shaken ECharts registrations — only chart types in use are bundled. |
| `src/composables/useChartTheme.ts` | Reactive palette mapping the Tailwind status tokens (success / warning / danger / info / neutral) plus axis / grid / tooltip colors to ECharts values. Re-derives on dark-mode toggle. |

ECharts is lazy-loaded per-view via `defineAsyncComponent` so the chart
bundle downloads only when a chart actually renders. No view's initial
chunk pays the chart-library cost. v0.1.25.51 re-registered BarChart +
GridComponent (removed in v0.1.25.50 when all three Overview charts
became donuts) because `WebhookDetailView` introduces an attempts-
per-delivery bar chart. Active registrations: PieChart, BarChart,
TooltipComponent, LegendComponent, GridComponent.

Every chart reads data the view already fetched — no chart adds a
network request beyond what the attention cards above already drive.
Charts are also **clickable**: slices emit `slice-click` which the
parent view maps to `router.push` with the corresponding list-view
filter pre-applied. Current drill-down contracts:

- Budget status donut → Budgets filtered by `status=ACTIVE|FROZEN|CLOSED` or `filter=over_limit`.
- Budget fleet utilization donut → Budgets filtered by `utilization_min` / `utilization_max` (integer percent, 0–100). `BudgetsView` hydrates both params from the URL on mount.
- Events by category donut → Events filtered by `category=<name>`.
- Webhook fleet-health donut → Webhooks filtered by `status=ACTIVE|PAUSED|DISABLED` or `failing=1` (the Failing slice is orthogonal to status — a `PAUSED` webhook with `consecutive_failures ≥ 1` still counts as Failing so the chart and the `failing=1` filter match). As of v0.1.25.53 `status=…` is pushed to the server (`listWebhookSubscriptions` `status` param) so drill-down counts reconcile with the Overview counter-strip tiles.
- Delivery-outcome donut (WebhookDetailView) → local status filter on the history table, no route push.

For the full six-slice roadmap and what each view is expected to
visualize, see `AUDIT.md` → *v0.1.25.47 charting layer*.

## Polling Strategy

Each page manages its own polling lifecycle via the `usePolling` composable:

| Page | Interval | Behavior |
|------|----------|----------|
| Overview | 30s | Pause on tab hidden, 2x backoff on error (max 5min) |
| Budgets | 60s | Same |
| Events | 15s | Same |
| Webhooks | 60s | Same |
| Tenants | 60s | Same |
| Audit | Manual only | Explicit "Run Query" button |

## Building

```bash
npm run build      # Type-check + production build → dist/
npm run test       # Run Vitest unit tests
npm run dev        # Development server with HMR
npm run preview    # Preview production build locally
```

## E2E tests

Two layers run against the live docker-compose stack:

1. **HTTP probes** (`scripts/e2e-probes.sh`) — curl through the dashboard nginx, verify routing + response shape.
2. **Playwright** (`tests/e2e/`) — drive a real Chromium through critical user flows (login, reservation force-release, sort accessor).

Run locally:

```bash
# One-time: install Playwright's Chromium + OS deps
npm run test:e2e:install

# Bring up the full stack (admin + runtime + redis + dashboard on :8080)
ADMIN_API_KEY=admin-bootstrap-key docker compose -f docker-compose.yml up -d --wait

# Run both layers:
bash scripts/e2e-probes.sh
npm run test:e2e

# Interactive UI (pick tests, see traces inline):
npm run test:e2e:ui

# Tear down
docker compose -f docker-compose.yml down -v
```

Both layers are wired into `.github/workflows/e2e.yml` — runs nightly and on PRs that touch nginx, Dockerfile, compose, the API client, `tests/e2e/`, or the workflow/probe files.

## Docker

Multi-stage build: Node 20 for `npm run build`, then nginx:alpine to serve.

```dockerfile
# Build
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Serve
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
```

The nginx config handles SPA routing (`try_files $uri /index.html`) and reverse-proxies `/v1/` to the admin server.

## Production Deployment

### Architecture

```
                     ┌─────────────┐
  Browser ──HTTPS──▶ │  TLS Proxy  │──HTTP──▶ Dashboard (nginx:80)
                     │ (Caddy/ALB) │                  │
                     └─────────────┘           /v1/ proxy
                                                      │
                                               Admin Server (:7979)
                                                      │
                                                   Redis (:6379)
```

The dashboard is a static SPA served by nginx. API calls are reverse-proxied through the same nginx to the admin server. In production, a TLS-terminating proxy sits in front.

### docker-compose (production)

```yaml
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "443:443"
      - "80:80"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy-data:/data
    depends_on:
      - dashboard
    networks:
      - cycles

  dashboard:
    image: ghcr.io/runcycles/cycles-dashboard:0.1.25.53
    restart: unless-stopped
    # No exposed ports — only accessible through Caddy
    depends_on:
      cycles-admin:
        condition: service_healthy
    networks:
      - cycles

  cycles-admin:
    image: ghcr.io/runcycles/cycles-server-admin:0.1.25.37
    restart: unless-stopped
    environment:
      REDIS_HOST: redis
      REDIS_PORT: 6379
      REDIS_PASSWORD: ${REDIS_PASSWORD:-}
      ADMIN_API_KEY: ${ADMIN_API_KEY:?ADMIN_API_KEY must be set}
      WEBHOOK_SECRET_ENCRYPTION_KEY: ${WEBHOOK_SECRET_ENCRYPTION_KEY:-}
      DASHBOARD_CORS_ORIGIN: ${DASHBOARD_ORIGIN:-https://admin.example.com}
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:7979/actuator/health"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 30s
    depends_on:
      redis:
        condition: service_healthy
    networks:
      - cycles

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: redis-server --appendonly yes --requirepass ${REDIS_PASSWORD:-}
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    networks:
      - cycles

volumes:
  redis-data:
  caddy-data:

networks:
  cycles:
```

**Caddyfile** (automatic HTTPS via Let's Encrypt):
```
admin.example.com {
    reverse_proxy dashboard:80
}
```

**Deploy:**
```bash
# Create .env with secrets (never commit this file)
cat > .env << 'EOF'
ADMIN_API_KEY=your-strong-admin-key-here
REDIS_PASSWORD=your-redis-password
WEBHOOK_SECRET_ENCRYPTION_KEY=$(openssl rand -base64 32)
DASHBOARD_ORIGIN=https://admin.example.com
EOF

docker compose -f docker-compose.prod.yml up -d
```

### Development vs Production

| Concern | Development | Production |
|---------|------------|------------|
| **Dashboard URL** | `http://localhost:5173` | `https://admin.example.com` |
| **API proxy** | Vite dev proxy → `localhost:7979` | nginx → `cycles-admin:7979` |
| **TLS** | None (local only) | Required — admin key in headers |
| **Admin key** | Any test value | Strong random key, rotated periodically |
| **Redis password** | Empty (default) | Set via `REDIS_PASSWORD` |
| **CORS origin** | `http://localhost:5173` | Not needed (same-origin via nginx proxy) |
| **Docker images** | Built from source | Pre-built from GHCR |
| **Health checks** | Not needed | Redis + admin server health gates |
| **Restart policy** | None | `unless-stopped` |
| **Ports exposed** | All (5173, 7979, 6379) | Only 443/80 via TLS proxy |

## Hardening

### Network

- **Do not expose ports 7979 or 6379** to the public internet. Only the TLS proxy (443/80) should be reachable.
- Place the admin server and Redis on an internal Docker network with no published ports.
- Use firewall rules or security groups to restrict access to the dashboard's public port by IP range if possible.

### Authentication

- **Rotate the admin API key** periodically. The key is the only credential for full system access.
- Use a strong, random key (at minimum 32 characters): `openssl rand -base64 32`
- The key is stored in `sessionStorage` — survives page refresh but cleared when the tab or browser is closed. Never written to `localStorage` or cookies.
- Consider placing the dashboard behind SSO or VPN in addition to the API key for defense in depth.

### CORS

In production, the dashboard's nginx reverse-proxies `/v1/` to the admin server, so all API calls are same-origin from the browser's perspective. **CORS is not involved in a standard production deployment.**

CORS only matters when the browser talks directly to the admin server (e.g., during development with Vite's proxy, or non-standard deployments where the dashboard and API are on different origins). In that case:
- Set `DASHBOARD_CORS_ORIGIN` to the exact dashboard URL (e.g., `https://admin.example.com`).
- Do **not** use `*` — the admin server only allows the configured origin.
- The admin server only permits `X-Admin-API-Key` and `Content-Type` headers through CORS.

### TLS

- Always use HTTPS in production — the admin API key is transmitted as an HTTP header on every request.
- Use TLS 1.2+ with modern cipher suites. Caddy handles this automatically.
- For nginx, add:
  ```nginx
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_prefer_server_ciphers on;
  ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
  ```

### nginx hardening

The default `nginx.conf` already includes these security headers:

```nginx
# Security headers (included by default)
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
server_tokens off;
```

The TLS config (`nginx-ssl.conf.example`) additionally includes HSTS:

```nginx
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
```

All production assets include Subresource Integrity (SRI) hashes via `vite-plugin-sri-gen`.

### Redis

- Set a password via `REDIS_PASSWORD` — the default has no authentication.
- Use `appendonly yes` for durability (enabled in the docker-compose above).
- Do not expose Redis port (6379) outside the Docker network.
- For production, consider Redis Sentinel or Redis Cluster for high availability.

### Secrets management

- Store `ADMIN_API_KEY`, `REDIS_PASSWORD`, and `WEBHOOK_SECRET_ENCRYPTION_KEY` in a secrets manager (Vault, AWS Secrets Manager, etc.) — not in git.
- Use Docker secrets or environment variable injection from your orchestrator.
- The `.env` file should be in `.gitignore` and never committed.

### Monitoring

- The admin server exposes `/actuator/health` for health checks.
- The dashboard's `GET /v1/admin/overview` endpoint is a good target for synthetic monitoring — if it returns 200, the entire stack (Redis + admin server + auth) is working.
- Set up alerts on the overview endpoint's `failing_webhooks` and `over_limit_scopes` arrays.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ADMIN_API_KEY` | Yes | — | Admin API key for `X-Admin-API-Key` header |
| `REDIS_PASSWORD` | Recommended | (empty) | Redis authentication password |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | Recommended | (empty) | AES-256-GCM key for webhook signing secrets at rest |
| `DASHBOARD_CORS_ORIGIN` | Dev only | `http://localhost:5173` | CORS origin — only needed when browser calls admin server directly (not via nginx proxy) |

The dashboard itself has no server-side configuration — it's a static SPA. The admin server URL is configured via:
- **Development:** Vite proxy in `vite.config.ts` (default: `localhost:7979`)
- **Production:** nginx reverse proxy in `nginx.conf` (default: `cycles-admin:7979`)

## Documentation

- [Cycles Documentation](https://runcycles.io)
- [Admin Server](https://github.com/runcycles/cycles-server-admin)
- [Governance Spec](https://github.com/runcycles/cycles-protocol/blob/main/cycles-governance-admin-v0.1.25.yaml)

## License

[Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0)

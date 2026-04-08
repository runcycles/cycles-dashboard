[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

# Cycles Admin Dashboard

Operational admin dashboard for the [Cycles Budget Governance System](https://github.com/runcycles/cycles-server-admin), aligned with [governance spec v0.1.25.5](https://github.com/runcycles/cycles-server-admin/blob/main/complete-budget-governance-v0.1.25.yaml).

## Overview

Operations-first dashboard for monitoring and managing the Cycles budget enforcement platform. Designed around operator workflows, not CRUD entity lists.

| Page | Purpose |
|------|---------|
| **Overview** | Operational health at a glance — single-request aggregated dashboard |
| **Tenants** | Tenant list + detail with budgets, API keys, and policies tabs |
| **Budgets** | Tenant-scoped budget list with utilization/debt bars + exact scope detail |
| **Events** | Correlation-first investigation tool with expandable detail rows |
| **Webhooks** | Subscription health (green/yellow/red) + delivery history |
| **Audit** | Compliance query tool with CSV/JSON export (manual-only, no auto-refresh) |

## Architecture

```
src/
├── api/           # API client (X-Admin-API-Key only)
├── components/    # Reusable UI: Sidebar, PageHeader, StatusBadge, UtilizationBar, etc.
├── composables/   # usePolling (visibility API pause + exponential backoff)
├── stores/        # Pinia: auth (introspect + capabilities)
├── views/         # 9 route views (login, overview, budgets, events, webhooks, audit, tenants + detail views)
└── types.ts       # TypeScript types matching governance spec schemas
```

- **Framework:** Vue 3 + TypeScript + Vite
- **State:** Pinia
- **Styling:** Tailwind CSS v4
- **Testing:** Vitest + @vue/test-utils
- **Router:** Vue Router 4 with auth guard

## Quick Start

### Development (with Vite proxy)

Requires the admin server running at `localhost:7979`.

```bash
npm install
npm run dev
```

Dashboard starts at `http://localhost:5173`. The Vite dev server proxies `/v1/*` to the admin server.

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

```bash
docker compose up -d
```

| Service | Port | Purpose |
|---------|------|---------|
| Dashboard | 8080 | nginx serving SPA + reverse proxy to admin |
| Admin Server | 7979 | Budget governance API |
| Redis | 6379 | Shared state store |

## Authentication

The dashboard uses `AdminKeyAuth` exclusively (`X-Admin-API-Key` header). No tenant API keys are used.

1. User enters admin API key on the login page
2. Dashboard calls `GET /v1/auth/introspect` to validate and retrieve capabilities
3. Sidebar navigation is gated by capability booleans (`view_overview`, `view_budgets`, etc.)
4. On 401/403 from any API call, the session is cleared and user is redirected to login
5. API key is stored in memory only (Pinia store) — cleared on tab close

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
npm run test       # Run Vitest tests
npm run dev        # Development server with HMR
npm run preview    # Preview production build locally
```

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

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ADMIN_API_KEY` | Yes | — | Admin API key (docker-compose only) |

The dashboard itself has no server-side configuration — it's a static SPA. The admin server URL is configured via:
- **Development:** Vite proxy in `vite.config.ts` (default: `localhost:7979`)
- **Production:** nginx reverse proxy in `nginx.conf` (default: `cycles-admin:7979`)

## HTTPS / TLS

The dashboard transmits the admin API key on every request, so HTTPS is strongly recommended in production.

### Option 1: Reverse proxy (recommended)

Place the dashboard behind a TLS-terminating reverse proxy (e.g., Caddy, Traefik, or a cloud load balancer):

```
Client ──HTTPS──▶ Reverse Proxy ──HTTP──▶ Dashboard (port 80) ──HTTP──▶ Admin Server (port 7979)
```

**Caddy example** (automatic HTTPS with Let's Encrypt):
```
admin.example.com {
    reverse_proxy dashboard:80
}
```

**docker-compose with Caddy:**
```yaml
services:
  caddy:
    image: caddy:2-alpine
    ports:
      - "443:443"
      - "80:80"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy-data:/data
    networks:
      - cycles

  dashboard:
    build: .
    # No exposed ports — only accessible through Caddy
    networks:
      - cycles

  # ... cycles-admin and redis as before

volumes:
  caddy-data:
```

### Option 2: TLS directly in nginx

Mount your certificate and key into the dashboard container and use an HTTPS nginx config:

```nginx
server {
    listen 443 ssl;
    server_name admin.example.com;

    ssl_certificate     /etc/ssl/certs/dashboard.crt;
    ssl_certificate_key /etc/ssl/private/dashboard.key;

    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /v1/ {
        resolver 127.0.0.11 valid=30s ipv6=off;
        set $upstream http://cycles-admin:7979;
        proxy_pass $upstream/v1/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}

server {
    listen 80;
    return 301 https://$host$request_uri;
}
```

Mount the certs in docker-compose:
```yaml
dashboard:
  build: .
  ports:
    - "443:443"
    - "80:80"
  volumes:
    - ./nginx-ssl.conf:/etc/nginx/conf.d/default.conf
    - ./certs/dashboard.crt:/etc/ssl/certs/dashboard.crt:ro
    - ./certs/dashboard.key:/etc/ssl/private/dashboard.key:ro
```

### Security notes

- The admin API key is sent as an HTTP header (`X-Admin-API-Key`) on every request. Without TLS, it is visible to anyone on the network.
- The key is stored in browser memory only (Pinia store) and cleared on tab close — it is never written to localStorage or cookies.
- The admin server's `dashboard.cors.origin` should match your production URL (e.g., `https://admin.example.com`).

## Documentation

- [Cycles Documentation](https://runcycles.io)
- [Admin Server](https://github.com/runcycles/cycles-server-admin)
- [Governance Spec](https://github.com/runcycles/cycles-server-admin/blob/main/complete-budget-governance-v0.1.25.yaml)

## License

[Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0)

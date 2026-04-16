#!/usr/bin/env node
/**
 * Seed a local admin server with realistic volume of tenants, budgets,
 * and webhooks so the virtualized dashboard views have something to
 * exercise scroll, Load-more, and column-width behavior against.
 *
 * Usage (local dev):
 *   node scripts/seed-scale-data.mjs
 *
 * Env knobs:
 *   ADMIN_URL         — default http://localhost:7979
 *   RUNTIME_URL       — default http://localhost:7878 (unused here, for future reservation seeding)
 *   ADMIN_API_KEY     — default admin-key (matches docker-compose.yml default)
 *   TENANT_COUNT      — default 60
 *   BUDGETS_PER_TENANT — default 3
 *   WEBHOOK_COUNT     — default 40
 *   PREFIX            — default seed- (prefix for generated ids; lets you find + clean them up)
 *
 * Conventions:
 *   - All generated tenant_ids and subscription prefixes start with `PREFIX`
 *     so `grep seed-` in any listing disambiguates them from manually-created
 *     data.
 *   - Idempotent-ish: re-running will create duplicates (the server assigns
 *     fresh UUIDs for subscriptions, but tenant_ids are stable). If tenant
 *     already exists, POST /v1/admin/tenants returns 409; we just log and
 *     continue so partial re-runs work.
 *   - Sequential-with-concurrency-cap rather than Promise.all for the whole
 *     set — cycles-admin is happy with 4-8 concurrent writes but not 60+
 *     stacked at once.
 */

const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:7979'
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'admin-key'
const TENANT_COUNT = parseInt(process.env.TENANT_COUNT || '60', 10)
const BUDGETS_PER_TENANT = parseInt(process.env.BUDGETS_PER_TENANT || '3', 10)
const WEBHOOK_COUNT = parseInt(process.env.WEBHOOK_COUNT || '40', 10)
const PREFIX = process.env.PREFIX || 'seed-'
const CONCURRENCY = 4

// Server's registered unit codes (probed empirically — REQUESTS / any
// ad-hoc string gets 400 "Malformed request body"). Stick to these two
// until the spec exposes an endpoint to enumerate registered units.
const UNITS = ['TOKENS', 'USD_MICROCENTS']
const OVERAGE = ['REJECT', 'ALLOW_IF_AVAILABLE', 'ALLOW_WITH_OVERDRAFT']
// Probed set the server accepts. `reservation.*` types return 400
// on this server version (not yet wired into the webhook event enum
// even though they're emitted via other channels) so they're excluded.
// Dashboard's EVENT_TYPES in types.ts is broader — some of those are
// admin-server only too. If you see 400 on re-run, probe with
// `curl ... -d '{"event_types":["x.y"]}'` to find the culprit.
const EVENT_TYPES = ['budget.created', 'budget.updated', 'budget.funded', 'budget.frozen', 'budget.unfrozen', 'budget.closed', 'tenant.created', 'tenant.suspended']

async function adminFetch(path, init = {}) {
  const res = await fetch(`${ADMIN_URL}${path}`, {
    ...init,
    headers: {
      'X-Admin-API-Key': ADMIN_API_KEY,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  const bodyText = await res.text()
  if (!res.ok) {
    // 409 = already exists. Treat as soft-success so re-runs are idempotent.
    if (res.status === 409) return { ok: false, status: 409, body: bodyText }
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${bodyText.slice(0, 200)}`)
  }
  return { ok: true, status: res.status, body: bodyText ? JSON.parse(bodyText) : null }
}

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)] }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }

async function runWithConcurrency(items, worker, label) {
  let done = 0, failed = 0
  // Simple bounded-concurrency loop: chunk into CONCURRENCY-sized batches,
  // Promise.all each batch. Tracks progress so long runs don't feel dead.
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(batch.map(worker))
    for (const r of results) {
      done++
      if (r.status === 'rejected') { failed++; console.warn(`  ✗ ${r.reason?.message ?? r.reason}`) }
    }
    process.stdout.write(`  ${label}: ${done}/${items.length} (${failed} failed)\r`)
  }
  process.stdout.write('\n')
}

// ─── Tenants ──────────────────────────────────────────────────────────────

async function createTenant(i) {
  const tenant_id = `${PREFIX}tenant-${String(i).padStart(3, '0')}`
  const name = `Seed Tenant ${i}`
  // First 10 are root; tenants 11-25 attach as children of tenants 1-10
  // to exercise the parent-child column + childCountMap logic.
  const body = { tenant_id, name }
  if (i > 10 && i <= 25) {
    const parentIdx = ((i - 11) % 10) + 1
    body.parent_tenant_id = `${PREFIX}tenant-${String(parentIdx).padStart(3, '0')}`
  }
  const res = await adminFetch('/v1/admin/tenants', { method: 'POST', body: JSON.stringify(body) })
  // Suspend every 10th so the status column has non-ACTIVE rows to render
  if (res.ok && i % 10 === 0) {
    await adminFetch(`/v1/admin/tenants/${tenant_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'SUSPENDED' }),
    }).catch(() => {})
  }
  return tenant_id
}

// ─── Budgets ──────────────────────────────────────────────────────────────

async function createBudgetsForTenant(tenant_id, idx) {
  // Generate BUDGETS_PER_TENANT budgets per tenant. Server enforces each
  // scope segment be of the form `<kind>:<id>` (canonical protocol spec),
  // so use `tenant:<id>/project:<name>` etc. Varied units + allocation
  // so the utilization column renders across the color range
  // (green/yellow/red).
  // Canonical kinds per cycles-protocol: [tenant, workspace, app,
  // workflow, agent, toolset]. Other kinds trigger 400 INVALID_REQUEST.
  const segments = [
    { kind: 'workspace', ids: ['prod', 'staging', 'dev'] },
    { kind: 'app', ids: ['api', 'batch', 'worker'] },
    { kind: 'agent', ids: ['planner', 'coder', 'reviewer'] },
  ]
  for (let i = 0; i < BUDGETS_PER_TENANT; i++) {
    const unit = rand(UNITS)
    const allocated = unit === 'USD_MICROCENTS' ? randInt(1_000_000, 100_000_000) : randInt(1000, 1_000_000)
    const seg = segments[(idx + i) % segments.length]
    const segId = seg.ids[(idx + i) % seg.ids.length]
    const scope = `tenant:${tenant_id}/${seg.kind}:${segId}`
    const body = {
      scope,
      unit,
      allocated: { unit, amount: allocated },
      commit_overage_policy: rand(OVERAGE),
    }
    await adminFetch('/v1/admin/budgets', {
      method: 'POST',
      body: JSON.stringify({ ...body, tenant_id }),
    }).catch((e) => console.warn(`  ✗ budget ${scope}: ${e.message}`))
  }
}

// ─── Webhooks ─────────────────────────────────────────────────────────────

async function createWebhook(i, tenantIds) {
  // Half system-wide (no tenant), half tenant-scoped. Names give the
  // webhooks view a scannable label; URLs use example.com so the tests
  // never accidentally deliver to a real endpoint.
  const isSystemWide = i % 2 === 0
  const tenant_id = isSystemWide ? undefined : tenantIds[i % tenantIds.length]
  const body = {
    url: `https://example.com/webhooks/${PREFIX}hook-${i}`,
    name: `${isSystemWide ? 'System' : 'Tenant'} webhook ${i}`,
    event_types: [
      rand(EVENT_TYPES),
      ...(Math.random() > 0.5 ? [rand(EVENT_TYPES)] : []),
    ],
  }
  const qs = tenant_id ? `?tenant_id=${encodeURIComponent(tenant_id)}` : ''
  await adminFetch(`/v1/admin/webhooks${qs}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Seeding ${ADMIN_URL}`)
  console.log(`  Tenants: ${TENANT_COUNT}`)
  console.log(`  Budgets per tenant: ${BUDGETS_PER_TENANT} (target ~${TENANT_COUNT * BUDGETS_PER_TENANT})`)
  console.log(`  Webhooks: ${WEBHOOK_COUNT}`)
  console.log(`  Prefix: ${PREFIX}`)
  console.log()

  // Sanity check the admin API + key before queuing anything
  await adminFetch('/v1/auth/introspect').catch((e) => {
    console.error(`Admin API unreachable or key rejected: ${e.message}`)
    process.exit(1)
  })

  console.log('Creating tenants…')
  const tenantIds = []
  const tenantIndices = Array.from({ length: TENANT_COUNT }, (_, i) => i + 1)
  await runWithConcurrency(tenantIndices, async (i) => {
    const id = await createTenant(i)
    if (id) tenantIds.push(id)
  }, 'tenants')

  console.log('Creating budgets…')
  const budgetTargets = tenantIds.map((id, idx) => ({ id, idx }))
  await runWithConcurrency(budgetTargets, (t) => createBudgetsForTenant(t.id, t.idx), 'budget groups')

  console.log('Creating webhooks…')
  const webhookIndices = Array.from({ length: WEBHOOK_COUNT }, (_, i) => i + 1)
  await runWithConcurrency(webhookIndices, (i) => createWebhook(i, tenantIds), 'webhooks')

  console.log()
  console.log('Done. Open the dashboard and try:')
  console.log(`  - Tenants: ${tenantIds.length} new (~15 with parents, ~6 suspended)`)
  console.log(`  - Budgets: ~${tenantIds.length * BUDGETS_PER_TENANT} across all tenants, mixed units/statuses`)
  console.log(`  - Webhooks: ${WEBHOOK_COUNT} (half system-wide, half tenant-scoped)`)
}

main().catch((e) => { console.error(e); process.exit(1) })

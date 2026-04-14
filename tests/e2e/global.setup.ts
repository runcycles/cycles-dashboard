/**
 * Playwright global setup — seeds a tenant, API key, budget, and
 * reservation before the spec suite runs. Writes fixture IDs to
 * test-results/fixtures.json for specs to read via ./fixtures.ts.
 *
 * The seed is idempotent only in the "fresh stack" sense: each run
 * creates a new tenant with a timestamp-suffixed ID, so repeated
 * local runs without `docker compose down -v` just accumulate test
 * tenants rather than colliding. CI runs against a fresh stack.
 *
 * All HTTP calls go through the dashboard nginx proxy on :8080 — this
 * means the seed exercises the same routing the browser tests will use
 * (admin-plane paths → cycles-admin, runtime-plane paths → cycles-server).
 * Seed failures caused by proxy misconfiguration fail loudly at setup
 * time rather than producing cryptic spec failures later.
 */
import { request, type FullConfig } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

export interface Fixtures {
  tenantId: string
  tenantName: string
  tenantApiKey: string
  budgetId: string
  budgetScope: string
  /** The reservation the force-release spec will target. 50,000 amount. */
  reservationIdForRelease: string
  /** Smaller-amount reservation used by the sort spec. 30,000 amount. */
  reservationIdSmall: string
  /** Larger-amount reservation used by the sort spec. 75,000 amount. */
  reservationIdLarge: string
}

const ADMIN_KEY = process.env.ADMIN_API_KEY || 'admin-bootstrap-key'
const BASE_URL = process.env.DASHBOARD_URL || 'http://localhost:8080'
const FIXTURES_PATH = path.resolve('test-results', 'fixtures.json')

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const ctx = await request.newContext({ baseURL: BASE_URL })

  // Stamp every fixture with this run's timestamp so reruns don't collide.
  const stamp = Date.now()
  const tenantId = `e2e-tenant-${stamp}`
  const tenantName = `E2E Test Tenant (${stamp})`

  // 1. Create the tenant. Admin plane.
  const tenantRes = await ctx.post('/v1/admin/tenants', {
    headers: { 'X-Admin-API-Key': ADMIN_KEY },
    data: { tenant_id: tenantId, name: tenantName },
  })
  if (!tenantRes.ok()) {
    throw new Error(`seed: create tenant failed: ${tenantRes.status()} ${await tenantRes.text()}`)
  }

  // 2. Create a tenant API key with the permissions the reservation
  //    flow needs. Admin plane.
  const keyRes = await ctx.post('/v1/admin/api-keys', {
    headers: { 'X-Admin-API-Key': ADMIN_KEY },
    data: {
      tenant_id: tenantId,
      name: 'e2e-seed-key',
      permissions: [
        'budgets:read',
        'budgets:write',
        'balances:read',
        'reservations:create',
        'reservations:list',
        'reservations:release',
        'reservations:extend',
      ],
    },
  })
  if (!keyRes.ok()) {
    throw new Error(`seed: create API key failed: ${keyRes.status()} ${await keyRes.text()}`)
  }
  const keyBody = await keyRes.json()
  const tenantApiKey: string = keyBody.key_secret
  if (!tenantApiKey) {
    throw new Error(`seed: API key response missing key_secret: ${JSON.stringify(keyBody)}`)
  }

  // 3. Create a budget for the tenant. Admin-on-behalf-of (tenant_id in body).
  const budgetScope = `tenant:${tenantId}`
  const budgetRes = await ctx.post('/v1/admin/budgets', {
    headers: { 'X-Admin-API-Key': ADMIN_KEY },
    data: {
      tenant_id: tenantId,
      scope: budgetScope,
      unit: 'USD_MICROCENTS',
      allocated: { unit: 'USD_MICROCENTS', amount: 10_000_000 }, // $100
    },
  })
  if (!budgetRes.ok()) {
    throw new Error(`seed: create budget failed: ${budgetRes.status()} ${await budgetRes.text()}`)
  }
  const budgetBody = await budgetRes.json()
  const budgetId: string = budgetBody.ledger_id

  // 4. Create three ACTIVE reservations with 1h TTLs. Runtime plane;
  //    must use the tenant API key (X-Cycles-API-Key). The 1h TTL is
  //    well beyond any reasonable suite runtime so ACTIVE preconditions
  //    don't race with expiry.
  //
  //    Role split:
  //      - "for-release" — the force-release spec targets this one by ID.
  //      - "small" (30k) + "large" (75k) — the sort spec observes rows
  //        reorder when the Reserved column header is clicked. Distinct
  //        amounts are required; the sort-accessor bug class manifests
  //        as "click does nothing" which is only observable when there's
  //        a visible reorder to either occur or not.
  const reserve = async (
    role: string,
    amount: number,
  ): Promise<string> => {
    const res = await ctx.post('/v1/reservations', {
      headers: { 'X-Cycles-API-Key': tenantApiKey },
      data: {
        idempotency_key: `e2e-seed-${stamp}-${role}`,
        subject: { tenant: tenantId, workspace: 'e2e', agent: `seed-${role}` },
        action: { kind: 'llm.completion', name: `e2e-fixture-${role}` },
        estimate: { unit: 'USD_MICROCENTS', amount },
        ttl_ms: 3_600_000, // 1 hour
      },
    })
    if (!res.ok()) {
      throw new Error(`seed: create reservation (${role}) failed: ${res.status()} ${await res.text()}`)
    }
    const body = await res.json()
    if (!body.reservation_id) {
      throw new Error(`seed: reservation (${role}) response missing reservation_id: ${JSON.stringify(body)}`)
    }
    return body.reservation_id
  }

  const reservationIdForRelease = await reserve('for-release', 50_000)
  const reservationIdSmall = await reserve('small', 30_000)
  const reservationIdLarge = await reserve('large', 75_000)

  const fixtures: Fixtures = {
    tenantId,
    tenantName,
    tenantApiKey,
    budgetId,
    budgetScope,
    reservationIdForRelease,
    reservationIdSmall,
    reservationIdLarge,
  }

  fs.mkdirSync(path.dirname(FIXTURES_PATH), { recursive: true })
  fs.writeFileSync(FIXTURES_PATH, JSON.stringify(fixtures, null, 2))

  await ctx.dispose()

  console.log(
    `[e2e seed] tenant=${tenantId} budget=${budgetId} ` +
      `reservations: forRelease=${reservationIdForRelease} ` +
      `small=${reservationIdSmall} large=${reservationIdLarge}`,
  )
}

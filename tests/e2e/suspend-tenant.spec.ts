import { test, expect, request as pwRequest } from '@playwright/test'
import { ADMIN_KEY, loginAsAdmin } from './fixtures'

/**
 * Suspend-tenant — single-tenant incident-response flow via
 * TenantDetailView. Distinct from tenants-bulk-suspend.spec.ts which
 * covers the bulk-select pattern; this one exercises the row-detail
 * button + ConfirmAction dialog that a security/compliance operator
 * uses when a single tenant has been compromised.
 *
 * Regression class: TenantDetailView pendingTenantAction → confirm →
 * updateTenantStatus(id, 'SUSPENDED') → toast + refresh. Spec asserts
 * the request fires, status flips to SUSPENDED, and the Reactivate
 * round-trip restores ACTIVE (keeps test-stack state clean).
 *
 * Self-contained: creates its own tenant in beforeAll so the seed
 * tenant used by other specs stays ACTIVE.
 */

let targetTenantId = ''

test.beforeAll(async () => {
  targetTenantId = `e2e-suspend-target-${Date.now()}`

  const ctx = await pwRequest.newContext({ baseURL: process.env.DASHBOARD_URL || 'http://localhost:8080' })
  const res = await ctx.post('/v1/admin/tenants', {
    headers: { 'X-Admin-API-Key': ADMIN_KEY },
    data: { tenant_id: targetTenantId, name: `E2E Suspend Target ${Date.now()}` },
  })
  if (!res.ok()) {
    throw new Error(`suspend-tenant setup: create tenant failed: ${res.status()} ${await res.text()}`)
  }
  await ctx.dispose()
})

test('operator suspends a compromised tenant from the detail view and reactivates it', async ({ page }) => {
  await loginAsAdmin(page)
  await page.goto(`/tenants/${targetTenantId}`)

  // Wait for the tenant GET to populate the view.
  await page.waitForResponse(
    (r) => r.url().includes(`/v1/admin/tenants/${targetTenantId}`) && r.request().method() === 'GET',
    { timeout: 10_000 },
  )

  // The detail view shows status ACTIVE + a Suspend button in the
  // actions cluster. Clicking populates pendingTenantAction='SUSPENDED'
  // and opens the ConfirmAction dialog.
  await page.getByRole('button', { name: /^suspend$/i }).click()
  const suspendDialog = page.getByRole('dialog', { name: /suspend this tenant\?/i })
  await expect(suspendDialog).toBeVisible()

  // Execute and capture the PATCH so we can assert the body sends the
  // right status transition. A regression that sent the wrong status
  // (e.g. ACTIVE → ACTIVE) would pass a naive UI assertion.
  const [suspendResp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes(`/v1/admin/tenants/${targetTenantId}`) && r.request().method() === 'PATCH',
      { timeout: 15_000 },
    ),
    suspendDialog.getByRole('button', { name: /suspend tenant/i }).click(),
  ])
  expect(suspendResp.status()).toBeGreaterThanOrEqual(200)
  expect(suspendResp.status()).toBeLessThan(300)
  const suspendBody = suspendResp.request().postDataJSON() as { status?: string } | null
  expect(suspendBody?.status).toBe('SUSPENDED')

  // Status badge flips. The badge is rendered via StatusBadge component
  // as 'SUSPENDED' text; scoping to the h1 region would couple to
  // markup — just look anywhere in the detail header area.
  await expect(page.getByText('SUSPENDED').first()).toBeVisible({ timeout: 10_000 })

  // Reactivate round-trip so the test leaves state clean for reruns.
  await page.getByRole('button', { name: /^reactivate$/i }).click()
  const reactivateDialog = page.getByRole('dialog', { name: /reactivate this tenant\?/i })
  await expect(reactivateDialog).toBeVisible()
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes(`/v1/admin/tenants/${targetTenantId}`) && r.request().method() === 'PATCH',
      { timeout: 15_000 },
    ),
    reactivateDialog.getByRole('button', { name: /reactivate tenant/i }).click(),
  ])
  await expect(page.getByText('ACTIVE').first()).toBeVisible({ timeout: 10_000 })
})

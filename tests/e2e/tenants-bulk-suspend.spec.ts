import { test, expect, request as pwRequest } from '@playwright/test'
import { ADMIN_KEY, getFixtures, loginAsAdmin } from './fixtures'

/**
 * Tenants bulk suspend — same sequential-with-cancel pattern as
 * webhooks-bulk but against /v1/admin/tenants/{id} PATCH status.
 *
 * Regression class: selection state, sequential loop completion,
 * status-refresh post-bulk. Restoring both tenants to ACTIVE at the
 * end keeps the seed fixture clean for any later specs in the run.
 *
 * Self-contained: creates one secondary tenant in beforeAll so the
 * test has at least two to bulk-select.
 */

let secondaryTenantId = ''
let secondaryTenantName = ''

test.beforeAll(async () => {
  secondaryTenantId = `e2e-bulk-secondary-${Date.now()}`
  secondaryTenantName = `E2E Bulk Secondary ${Date.now()}`

  const ctx = await pwRequest.newContext({ baseURL: process.env.DASHBOARD_URL || 'http://localhost:8080' })
  const res = await ctx.post('/v1/admin/tenants', {
    headers: { 'X-Admin-API-Key': ADMIN_KEY },
    data: { tenant_id: secondaryTenantId, name: secondaryTenantName },
  })
  if (!res.ok()) {
    throw new Error(`tenants-bulk setup: create tenant failed: ${res.status()} ${await res.text()}`)
  }
  await ctx.dispose()
})

test('selecting two tenants and Suspend selected flips them to SUSPENDED; Reactivate flips back', async ({ page }) => {
  const fx = getFixtures()

  await loginAsAdmin(page)
  await page.goto('/tenants')

  // Wait for listTenants to populate the table.
  await page.waitForResponse(
    (r) => r.url().includes('/v1/admin/tenants') && r.request().method() === 'GET',
    { timeout: 10_000 },
  )

  // Our two target tenants' rows must be present before we can select
  // them. Scope per-tenant for clarity.
  const row1 = page.getByRole('row').filter({ hasText: fx.tenantId })
  const row2 = page.getByRole('row').filter({ hasText: secondaryTenantId })
  await expect(row1).toBeVisible({ timeout: 10_000 })
  await expect(row2).toBeVisible()

  // Check both rows. Per-row checkboxes have aria-label "Select <name>"
  // which is ambiguous across many rows — target the row first, then
  // its checkbox.
  await row1.locator('input[type="checkbox"]').check()
  await row2.locator('input[type="checkbox"]').check()

  // Suspend. Bulk bar uses the short label "Suspend" (the "N selected"
  // count to its left conveys scope) since the floating-toolbar rework.
  await page.getByRole('toolbar', { name: /bulk tenant actions/i }).getByRole('button', { name: /^suspend$/i }).click()
  const suspendDialog = page.getByRole('dialog', { name: /suspend \d+ tenants\?/i })
  await expect(suspendDialog).toBeVisible()

  // Execute and wait for BOTH patch responses (proves the sequential
  // loop ran to completion, not just the first).
  const suspendPatches = [fx.tenantId, secondaryTenantId].map((id) =>
    page.waitForResponse(
      (r) => r.url().includes(`/v1/admin/tenants/${id}`) && r.request().method() === 'PATCH',
      { timeout: 15_000 },
    ),
  )
  await suspendDialog.getByRole('button', { name: /suspend all/i }).click()
  for (const r of await Promise.all(suspendPatches)) {
    expect(r.status()).toBeGreaterThanOrEqual(200)
    expect(r.status()).toBeLessThan(300)
  }

  // Both rows now show SUSPENDED.
  await expect(row1.getByText('SUSPENDED')).toBeVisible({ timeout: 10_000 })
  await expect(row2.getByText('SUSPENDED')).toBeVisible({ timeout: 10_000 })

  // Reactivate round-trip — restores the seed tenant to ACTIVE so
  // later specs see the expected state. Re-select (selection may have
  // been cleared after bulk; re-check defensively).
  await row1.locator('input[type="checkbox"]').check()
  await row2.locator('input[type="checkbox"]').check()
  await page.getByRole('toolbar', { name: /bulk tenant actions/i }).getByRole('button', { name: /^reactivate$/i }).click()
  const reactivateDialog = page.getByRole('dialog', { name: /reactivate \d+ tenants\?/i })
  await expect(reactivateDialog).toBeVisible()

  const reactivatePatches = [fx.tenantId, secondaryTenantId].map((id) =>
    page.waitForResponse(
      (r) => r.url().includes(`/v1/admin/tenants/${id}`) && r.request().method() === 'PATCH',
      { timeout: 15_000 },
    ),
  )
  await reactivateDialog.getByRole('button', { name: /reactivate all/i }).click()
  await Promise.all(reactivatePatches)

  await expect(row1.getByText('ACTIVE')).toBeVisible({ timeout: 10_000 })
  await expect(row2.getByText('ACTIVE')).toBeVisible({ timeout: 10_000 })
})

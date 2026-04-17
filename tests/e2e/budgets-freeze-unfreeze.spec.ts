import { test, expect } from '@playwright/test'
import { getFixtures, loginAsAdmin } from './fixtures'

/**
 * Budgets freeze/unfreeze round-trip.
 *
 * Regression class: the confirm-dialog → API call → optimistic-refresh
 * chain on the status-transition buttons. Each row has a Freeze button
 * when status=ACTIVE and Unfreeze when status=FROZEN, behind a
 * ConfirmAction. A regression in:
 *   - the row-level filter (button visible on wrong status)
 *   - the confirm dialog wiring (confirm fires wrong endpoint)
 *   - the refresh after status change (row shows stale status)
 * would all pass unit tests + HTTP probes but break in-browser.
 *
 * Operates on the seeded budget from global.setup — tenant:{tenantId}
 * with USD_MICROCENTS. Freezes it, verifies the status and button
 * flip, then unfreezes to leave the fixture in its original state so
 * other specs aren't affected.
 */
test('operator freezes an ACTIVE budget and then unfreezes it', async ({ page }) => {
  const fx = getFixtures()

  await loginAsAdmin(page)
  await page.goto('/budgets')

  // Wait for tenants load before interacting with the picker.
  await page.waitForResponse(
    (r) => r.url().includes('/v1/admin/tenants') && r.request().method() === 'GET',
    { timeout: 10_000 },
  )

  // Select seeded tenant, wait for that tenant's budgets to render.
  // listBudgets() sends `tenant_id=<id>` (NOT `tenant=<id>` — the admin
  // plane uses tenant_id; only the runtime-plane /v1/reservations uses
  // `tenant`). Filter on the correct param name or the wait times out.
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes('/v1/admin/budgets') &&
        r.url().includes(`tenant_id=${fx.tenantId}`) &&
        r.request().method() === 'GET',
      { timeout: 10_000 },
    ),
    page.locator('#budget-tenant').selectOption(fx.tenantId),
  ])

  // Locate the seeded budget row by its scope (unique per run because
  // the seeded tenant_id is timestamp-suffixed).
  const budgetRow = page.getByRole('row').filter({ hasText: fx.budgetScope })
  await expect(budgetRow).toBeVisible({ timeout: 10_000 })

  // Row actions live behind a kebab menu; Freeze / Unfreeze are
  // mutually-exclusive menuitems gated on status. The regression guard
  // is "the visible menuitem matches the current status" — open the
  // menu and check both presence and absence.
  const kebab = budgetRow.getByRole('button', { name: /actions for budget/i })
  const freezeItem = page.getByRole('menuitem', { name: /^freeze$/i })
  const unfreezeItem = page.getByRole('menuitem', { name: /^unfreeze$/i })

  // Initial state (ACTIVE): Freeze menuitem visible, Unfreeze absent.
  await kebab.click()
  await expect(freezeItem).toBeVisible()
  await expect(unfreezeItem).toHaveCount(0)

  // Click Freeze. The menu closes and the ConfirmAction modal opens.
  await freezeItem.click()
  const freezeConfirm = page.getByRole('dialog', { name: /freeze this budget/i })
  await expect(freezeConfirm).toBeVisible()

  const [freezeResponse] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/v1/admin/budgets/freeze') && r.request().method() === 'POST',
      { timeout: 10_000 },
    ),
    freezeConfirm.getByRole('button', { name: /^freeze budget$/i }).click(),
  ])
  expect(freezeResponse.status()).toBeGreaterThanOrEqual(200)
  expect(freezeResponse.status()).toBeLessThan(300)

  // After freeze: status badge reads FROZEN and the menu now exposes
  // Unfreeze instead of Freeze.
  await expect(budgetRow.getByText('FROZEN')).toBeVisible({ timeout: 5_000 })
  await kebab.click()
  await expect(unfreezeItem).toBeVisible()
  await expect(freezeItem).toHaveCount(0)

  // Now unfreeze — restores the fixture to ACTIVE so subsequent specs
  // aren't surprised.
  await unfreezeItem.click()
  const unfreezeConfirm = page.getByRole('dialog', { name: /unfreeze this budget/i })
  await expect(unfreezeConfirm).toBeVisible()

  const [unfreezeResponse] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/v1/admin/budgets/unfreeze') && r.request().method() === 'POST',
      { timeout: 10_000 },
    ),
    unfreezeConfirm.getByRole('button', { name: /^unfreeze budget$/i }).click(),
  ])
  expect(unfreezeResponse.status()).toBeGreaterThanOrEqual(200)
  expect(unfreezeResponse.status()).toBeLessThan(300)

  // Back to original state.
  await expect(budgetRow.getByText('ACTIVE')).toBeVisible({ timeout: 5_000 })
  await kebab.click()
  await expect(freezeItem).toBeVisible()
  await expect(unfreezeItem).toHaveCount(0)
})

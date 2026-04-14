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

  // Initial state: Freeze button visible, Unfreeze hidden.
  const freezeBtn = budgetRow.getByRole('button', { name: /^freeze$/i })
  const unfreezeBtn = budgetRow.getByRole('button', { name: /^unfreeze$/i })
  await expect(freezeBtn).toBeVisible()
  await expect(unfreezeBtn).toBeHidden()

  // Freeze. ConfirmAction is a separate modal with its own confirm
  // button; scope strictly to avoid clicking the row-level button.
  await freezeBtn.click()
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

  // After freeze: Unfreeze button visible, Freeze gone, status badge
  // reads FROZEN. The StatusBadge renders the literal status text.
  await expect(unfreezeBtn).toBeVisible({ timeout: 5_000 })
  await expect(freezeBtn).toBeHidden()
  await expect(budgetRow.getByText('FROZEN')).toBeVisible()

  // Now unfreeze — restores the fixture to ACTIVE so subsequent specs
  // aren't surprised.
  await unfreezeBtn.click()
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
  await expect(freezeBtn).toBeVisible({ timeout: 5_000 })
  await expect(unfreezeBtn).toBeHidden()
  await expect(budgetRow.getByText('ACTIVE')).toBeVisible()
})

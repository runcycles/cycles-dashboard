import { test, expect, request as pwRequest } from '@playwright/test'
import { ADMIN_KEY, getFixtures, loginAsAdmin } from './fixtures'

/**
 * Tenant-wide emergency freeze — v0.1.25.21 (#7).
 *
 * TenantDetailView renders an "Emergency Freeze (N)" button that performs a
 * complete cursor scan, binds confirmation to that immutable ACTIVE-budget
 * snapshot, and freezes it with bounded concurrency. This is the
 * highest-blast-radius button in the UI.
 *
 * Regression class: the button's visibility gate (only when N>0
 * ACTIVE budgets exist), bounded batch, and post-operation status refresh.
 * Plus the confirmation copy
 * that spells out the blast radius (count + tenant) — if that
 * regresses silent, operators lose an important sanity prompt.
 *
 * Self-contained: creates a second budget on the seeded tenant in
 * beforeAll so the count is 2+ (more meaningful than a one-budget
 * freeze).
 */

let secondBudgetScope = ''

test.beforeAll(async () => {
  const fx = getFixtures()
  secondBudgetScope = `${fx.budgetScope}/workspace:emergency-e2e`

  const ctx = await pwRequest.newContext({ baseURL: process.env.DASHBOARD_URL || 'http://localhost:8080' })
  const res = await ctx.post('/v1/admin/budgets', {
    headers: { 'X-Admin-API-Key': ADMIN_KEY },
    data: {
      tenant_id: fx.tenantId,
      scope: secondBudgetScope,
      unit: 'USD_MICROCENTS',
      allocated: { unit: 'USD_MICROCENTS', amount: 5_000_000 },
    },
  })
  // 409 DUPLICATE_RESOURCE means the budget already exists — from a prior
  // attempt of this same run (Playwright re-runs beforeAll on retry) or a
  // re-used seed tenant. Either way the precondition (a 2nd budget exists)
  // is satisfied, so treat it as success. Without this, any first-attempt
  // failure poisons every retry's setup and the test can never self-heal.
  if (!res.ok() && res.status() !== 409) {
    throw new Error(`emergency-freeze setup: create 2nd budget failed: ${res.status()} ${await res.text()}`)
  }
  await ctx.dispose()
})

test('Emergency Freeze freezes every ACTIVE budget in the completed tenant snapshot', async ({ page }) => {
  const fx = getFixtures()

  await loginAsAdmin(page)
  await page.goto(`/tenants/${fx.tenantId}`)

  // No raw waitForResponse for the tenant-detail GET here: registering it
  // *after* goto() races the SPA's fetch (if the response lands first the
  // wait hangs to its timeout — the original source of this test's flake).
  // The button-visible assertion below already waits for the tenant +
  // budgets to load and render, so it's both sufficient and race-free.

  // The Emergency Freeze button is only visible when there are N>0
  // ACTIVE budgets. Count is rendered in the button label: e.g.
  // "Emergency Freeze (2)". A regression that hid the count or
  // showed the button with 0 would break operator trust.
  const emergencyBtn = page.getByRole('button', { name: /emergency freeze \(\d+\)/i })
  await expect(emergencyBtn).toBeVisible({ timeout: 10_000 })

  // Click performs a fresh scan before opening the immutable confirmation.
  await emergencyBtn.click()
  const confirmDialog = page.getByRole('dialog', { name: /emergency freeze scanned budgets/i })
  await expect(confirmDialog).toBeVisible()

  // Execute. Wait for each budget's freeze call — at least two (our
  // seed budget + the secondary one we added). Use a scope-filter so
  // we match the correct budget freezes, not unrelated ones.
  const expectedFreezeCalls = Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes('/v1/admin/budgets/freeze') &&
        r.request().method() === 'POST' &&
        r.url().includes(encodeURIComponent(fx.budgetScope).split('/')[0]),
      { timeout: 20_000 },
    ),
    page.waitForResponse(
      (r) =>
        r.url().includes('/v1/admin/budgets/freeze') &&
        r.request().method() === 'POST' &&
        r.url().includes('emergency-e2e'),
      { timeout: 20_000 },
    ),
  ])

  await confirmDialog.getByRole('button', { name: /freeze \d+ budgets/i }).click()
  const freezeResponses = await expectedFreezeCalls
  for (const r of freezeResponses) {
    expect(r.status()).toBeGreaterThanOrEqual(200)
    expect(r.status()).toBeLessThan(300)
  }

  // After the bounded batch completes, the button's count drops to
  // 0 — or the button disappears entirely (canManageBudgets &&
  // activeBudgets.length > 0). We assert the button is gone, which
  // covers both cases.
  await expect(
    page.getByRole('button', { name: /emergency freeze \(/i }),
  ).toBeHidden({ timeout: 10_000 })

  // Spot-check one of the budget rows shows FROZEN — the status
  // table refresh happened alongside the button-gone check.
  await expect(page.getByText('FROZEN').first()).toBeVisible({ timeout: 10_000 })
})

import { test, expect, request as pwRequest } from '@playwright/test'
import { ADMIN_KEY, getFixtures, loginAsAdmin } from './fixtures'

/**
 * Tenant-wide emergency freeze — v0.1.25.21 (#7).
 *
 * TenantDetailView renders an "Emergency Freeze (N)" button that
 * sequentially freezes every ACTIVE budget for the tenant. Same
 * sequential-with-cancel pattern as the bulk ops, but with an
 * incident-response framing (one click → entire tenant budget
 * lockdown). This is the highest-blast-radius button in the UI.
 *
 * Regression class: the button's visibility gate (only when N>0
 * ACTIVE budgets exist), the sequential loop, and the
 * post-operation status-refresh. Plus the confirm-dialog copy
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
  if (!res.ok()) {
    throw new Error(`emergency-freeze setup: create 2nd budget failed: ${res.status()} ${await res.text()}`)
  }
  await ctx.dispose()
})

test('Emergency Freeze button sequentially freezes every ACTIVE budget for the tenant', async ({ page }) => {
  const fx = getFixtures()

  await loginAsAdmin(page)
  await page.goto(`/tenants/${fx.tenantId}`)

  // Wait for the tenant detail load (tenant + budgets + keys + policies).
  await page.waitForResponse(
    (r) =>
      r.url().includes(`/v1/admin/tenants/${fx.tenantId}`) &&
      r.request().method() === 'GET',
    { timeout: 10_000 },
  )

  // The Emergency Freeze button is only visible when there are N>0
  // ACTIVE budgets. Count is rendered in the button label: e.g.
  // "Emergency Freeze (2)". A regression that hid the count or
  // showed the button with 0 would break operator trust.
  const emergencyBtn = page.getByRole('button', { name: /emergency freeze \(\d+\)/i })
  await expect(emergencyBtn).toBeVisible({ timeout: 10_000 })

  // Click to open the confirm dialog. Title spells out the count
  // and the blast radius.
  await emergencyBtn.click()
  const confirmDialog = page.getByRole('dialog', { name: /emergency freeze all budgets/i })
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

  // After the sequential loop completes, the button's count drops to
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

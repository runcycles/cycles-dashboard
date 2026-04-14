import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './fixtures'

/**
 * Flow 1 — admin login → introspect → capability-gated sidebar.
 *
 * Regression class: any break in the chain from login submit through
 * POST /v1/auth/introspect through capabilities parse through the
 * Sidebar's v-if="item.cap !== false" gate. Unit tests mock fetch; this
 * spec drives a real browser against a real server so a mis-parsed
 * introspect response or a stale sessionStorage key surfaces here and
 * not in prod.
 */
test('admin key login lands on an authenticated page with the full sidebar', async ({ page }) => {
  await loginAsAdmin(page)

  // Post-auth: the 8 capability-gated nav entries must be rendered.
  // Admin key has permissions=["*"] → every view_* capability is true →
  // every sidebar link renders. Use the nav's link role so we don't
  // accidentally match headings or other Overview/Tenants text elsewhere.
  const nav = page.getByRole('navigation').first()
  const expectedEntries = [
    /overview/i,
    /tenants/i,
    /budgets/i,
    /events/i,
    /api\s*keys/i,
    /webhooks/i,
    /reservations/i,
    /audit/i,
  ]
  for (const pattern of expectedEntries) {
    await expect(nav.getByRole('link', { name: pattern })).toBeVisible()
  }

  // Direct-nav to an admin-only view confirms the route isn't redirecting
  // away (which would indicate the capability gate is mis-wired).
  await page.goto('/tenants')
  await expect(page).toHaveURL(/\/tenants$/)
})

test('invalid admin key surfaces an error and does not navigate', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel(/api key/i).fill('definitely-not-a-valid-admin-key')
  await page.getByRole('button', { name: /login/i }).click()

  // The URL must stay on /login — a silent navigation here would mean
  // the error path isn't being handled and the SPA is treating a bad
  // auth as success.
  await expect(page).toHaveURL(/\/login/)

  // And an error message must render. The existing LoginView surfaces
  // server-provided messages like "Invalid admin API key" into the
  // <p> below the input; we don't assert specific wording so the test
  // survives server-side copy changes.
  await expect(page.locator('p.text-red-600').first()).toBeVisible()
})

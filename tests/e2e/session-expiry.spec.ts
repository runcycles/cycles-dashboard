import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './fixtures'

/**
 * Session idle-expiry enforcement.
 *
 * useAuthStore's isAuthenticated checks LAST_ACTIVITY_KEY in
 * sessionStorage against a 30-minute idle window. If the gap exceeds
 * IDLE_TIMEOUT_MS, the store clears its state and navigation returns
 * user to /login with expired=true.
 *
 * Rather than actually idle for 30+ minutes, tamper with the stored
 * activity timestamp to simulate the expiry, then trigger a navigation
 * that re-checks auth. This directly exercises the guard without a
 * time-based flake surface.
 *
 * Regression class: the idle-expiry guard itself. A change to the
 * timeout math, the storage key name, or the navigation guard's
 * check order could leave sessions valid indefinitely — silent
 * security regression unit tests can't easily catch.
 */
test('session redirects to /login when last-activity is older than idle timeout', async ({ page }) => {
  await loginAsAdmin(page)
  // We're on an authenticated route ('/'). Verify the session is live.
  await expect(page).not.toHaveURL(/\/login/)

  // Tamper with LAST_ACTIVITY_KEY to 31 minutes ago. The auth store's
  // idle threshold is 30 minutes, so 31 puts us comfortably over.
  // Key name is 'cycles_last_activity' per src/stores/auth.ts.
  const thirtyOneMinutesAgo = Date.now() - (31 * 60 * 1000)
  await page.evaluate((ts) => {
    sessionStorage.setItem('cycles_last_activity', String(ts))
  }, thirtyOneMinutesAgo)

  // Navigate to any authenticated route — the router's beforeEach
  // runs, consults auth.isAuthenticated, sees the stale timestamp,
  // clears the session, and redirects to /login with expired=true.
  await page.goto('/reservations')

  // Landed on /login. The router guard sees apiKey in sessionStorage,
  // calls auth.restore(), which checks timestamps, finds the stale
  // activity, invokes logout(), and returns false → guard redirects
  // to /login with ?redirect= (NOT ?expired=1 — that query flag is
  // set only by App.vue's 15-second interval-driven checkTimeout
  // path, a different code path from the router guard). We assert
  // the redirect happened, not which exact query string carried it.
  await expect(page).toHaveURL(/\/login/)

  // sessionStorage must be cleared of the key material — a regression
  // that left the apiKey behind would allow re-entry if the user
  // clicked Back before the login form re-validated. This is the
  // critical security assertion.
  const apiKeyLeft = await page.evaluate(() => sessionStorage.getItem('cycles_admin_key'))
  expect(apiKeyLeft, 'sessionStorage apiKey must be cleared on idle-expiry').toBeNull()

  // And the login form is rendered in a usable state. The button is
  // disabled while the key field is empty (correct behavior — we
  // don't want to enable submit until the operator has typed
  // something). The presence check plus the initial-empty-state
  // check are enough to prove we landed on a fresh login page,
  // not a stuck mid-auth state.
  await expect(page.getByLabel(/api key/i)).toBeVisible()
  await expect(page.getByLabel(/api key/i)).toHaveValue('')
})

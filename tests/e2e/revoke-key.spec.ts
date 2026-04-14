import { test, expect, request as pwRequest } from '@playwright/test'
import { ADMIN_KEY, getFixtures, loginAsAdmin } from './fixtures'

/**
 * Revoke-key — single-key incident-response flow via ApiKeysView.
 * The operator action when a tenant's key has been leaked.
 *
 * Regression class: row-level Revoke click → pendingRevoke → Confirm
 * dialog → revokeApiKey(id, reason) → toast.success + list refresh.
 * A regression where the dialog stays open on success, the toast
 * fails to render, or the list doesn't refresh (so the operator
 * can't verify the revoke took effect) only surfaces in a real
 * browser — HTTP probes test the backend endpoint in isolation.
 *
 * Self-contained: creates its own API key under the seed tenant.
 * Doesn't touch the seed-key that the reservation specs rely on.
 */

let revokeKeyId = ''
let revokeKeyName = ''

test.beforeAll(async () => {
  const fx = getFixtures()
  revokeKeyName = `e2e-revoke-target-${Date.now()}`

  const ctx = await pwRequest.newContext({ baseURL: process.env.DASHBOARD_URL || 'http://localhost:8080' })
  const res = await ctx.post('/v1/admin/api-keys', {
    headers: { 'X-Admin-API-Key': ADMIN_KEY },
    data: {
      tenant_id: fx.tenantId,
      name: revokeKeyName,
      permissions: ['budgets:read'],
    },
  })
  if (!res.ok()) {
    throw new Error(`revoke-key setup: create key failed: ${res.status()} ${await res.text()}`)
  }
  const body = await res.json()
  revokeKeyId = body.key_id
  if (!revokeKeyId) {
    throw new Error(`revoke-key setup: response missing key_id: ${JSON.stringify(body)}`)
  }
  await ctx.dispose()
})

test('operator revokes a leaked API key and the row reflects REVOKED status', async ({ page }) => {
  const fx = getFixtures()
  await loginAsAdmin(page)
  await page.goto('/api-keys')

  // ApiKeysView calls listTenants then issues a listApiKeys per tenant
  // — wait on the tenants fetch first so the filter dropdown is
  // populated before we try to select our target.
  await page.waitForResponse(
    (r) => r.url().includes('/v1/admin/tenants') && r.request().method() === 'GET',
    { timeout: 10_000 },
  )

  // Filter to the seeded tenant so the target row is easy to locate
  // regardless of other tenants/keys in the shared table. Matches the
  // pattern used in api-keys-edit.spec.ts.
  await page.locator('#keys-tenant').selectOption(fx.tenantId)

  // Row filtering by key name — unique within tenant scope.
  const targetRow = page.getByRole('row').filter({ hasText: revokeKeyName })
  await expect(targetRow).toBeVisible({ timeout: 10_000 })

  // Click the row's Revoke button. Row-scoped to avoid ambiguity with
  // any other keys that might also show a Revoke button.
  await targetRow.getByRole('button', { name: /^revoke$/i }).click()

  // ConfirmAction dialog with row-name in its message, scope the
  // confirm button via role="dialog".
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(revokeKeyName)

  const [revokeResp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes(`/v1/admin/api-keys/${revokeKeyId}`) && r.request().method() === 'DELETE',
      { timeout: 15_000 },
    ),
    // Confirm button label comes from ConfirmAction's confirmLabel
    // prop. Match loosely since the exact copy ("Revoke Key" / "Revoke")
    // is ops-facing UX that may evolve — the regression class is
    // catch-wiring, not button copy.
    dialog.getByRole('button', { name: /revoke/i }).click(),
  ])
  expect(revokeResp.status()).toBeGreaterThanOrEqual(200)
  expect(revokeResp.status()).toBeLessThan(300)

  // Dialog must close on success — a dialog that lingers indicates the
  // success path didn't run cleanly (pendingRevoke wasn't cleared).
  await expect(dialog).toBeHidden({ timeout: 5_000 })

  // And the row now shows REVOKED (not ACTIVE). This proves the list
  // refreshed after the revoke — a regression that skipped the refresh
  // would leave the row stale and the operator unable to confirm the
  // action took effect.
  await expect(targetRow.getByText('REVOKED')).toBeVisible({ timeout: 10_000 })
})

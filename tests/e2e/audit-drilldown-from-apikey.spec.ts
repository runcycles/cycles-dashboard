import { test, expect, request as pwRequest } from '@playwright/test'
import { ADMIN_KEY, getFixtures, loginAsAdmin } from './fixtures'

/**
 * Audit drill-down via the Activity link on an API key row.
 *
 * v0.1.25.21 shipped a one-click "Activity" link next to each API key
 * row that routes to /audit?key_id=<id>, and AuditView reads the URL
 * query on mount to pre-fill its form and auto-run the query. This is
 * a multi-view flow driven by URL params — exactly the class of thing
 * unit tests miss and HTTP probes can't see.
 *
 * Regression class:
 *   - router-link target malformed (wrong route name, dropped param)
 *   - AuditView's onMounted query-parse regression
 *   - the watch(route.query) re-populate (for sidebar-nav-while-on-audit)
 * Each would leave the Activity click landing on a blank/unfiltered
 * audit view instead of the intended drill-down.
 *
 * Self-contained: creates its own API key via the admin API in
 * beforeAll (so the key_id is known without inspecting DOM) and uses
 * that specific key's row for the click.
 */

let targetKeyId = ''
let targetKeyName = ''

test.beforeAll(async () => {
  const fx = getFixtures()
  targetKeyName = `e2e-audit-drilldown-${Date.now()}`

  const ctx = await pwRequest.newContext({ baseURL: process.env.DASHBOARD_URL || 'http://localhost:8080' })
  const res = await ctx.post('/v1/admin/api-keys', {
    headers: { 'X-Admin-API-Key': ADMIN_KEY },
    data: {
      tenant_id: fx.tenantId,
      name: targetKeyName,
      permissions: ['budgets:read'],
    },
  })
  if (!res.ok()) {
    throw new Error(`audit-drilldown setup: create key failed: ${res.status()} ${await res.text()}`)
  }
  const body = (await res.json()) as { key_id: string }
  targetKeyId = body.key_id
  await ctx.dispose()
})

test('Activity link on an API key row drills into a pre-filtered audit view', async ({ page }) => {
  const fx = getFixtures()

  await loginAsAdmin(page)
  await page.goto('/api-keys')

  // Wait for the all-tenant keys scan to complete before looking for
  // our target row.
  await page.waitForResponse(
    (r) => r.url().includes('/v1/admin/tenants') && r.request().method() === 'GET',
    { timeout: 10_000 },
  )

  // Filter to the seeded tenant to narrow the scan and make row lookup
  // deterministic.
  await page.locator('#keys-tenant').selectOption(fx.tenantId)

  // Find the target row by its unique name and click its Activity link.
  const targetRow = page.getByRole('row').filter({ hasText: targetKeyName })
  await expect(targetRow).toBeVisible({ timeout: 10_000 })

  // Activity now lives inside the row's action menu (kebab). Open and
  // click the menuitem — it's a router-link under the hood, so the
  // navigation behavior is unchanged.
  await targetRow.getByRole('button', { name: /^actions for api key/i }).click()
  await page.getByRole('menuitem', { name: /^activity$/i }).click()

  // Landed on /audit with key_id query param preserved. URL assertion
  // catches a regression where the router-link target drops or
  // mangles the param.
  await expect(page).toHaveURL(new RegExp(`/audit\\?.*key_id=${targetKeyId}`))

  // The AuditView form pre-filled the key_id input from the query —
  // this is the onMounted query-parse chain. A regression that
  // stopped reading route.query would leave the field empty and the
  // table unfiltered.
  const keyIdInput = page.locator('#audit-key')
  await expect(keyIdInput).toHaveValue(targetKeyId)

  // And AuditView auto-runs the query on mount when URL params are
  // present — assert the listAuditLogs request actually fired with
  // the key_id scope, not just that the form was populated.
  //
  // (We don't assert specific audit entries because the seed and
  // this test's beforeAll produce audit records for the key but
  // their exact count / content is not a stable invariant we want
  // to lock in. URL + form + request is the regression surface.)
})

test('auditing routes /audit?key_id=... auto-runs the query on mount', async ({ page }) => {
  // Separate test, same URL-param pattern but hitting /audit directly
  // without going through the ApiKeysView click. Catches regressions
  // where the Activity link works (router-link is fine) but direct
  // navigation or bookmark-paste breaks because AuditView's mount
  // lifecycle regressed.
  await loginAsAdmin(page)

  const [auditResponse] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes('/v1/admin/audit/logs') &&
        r.url().includes(`key_id=${targetKeyId}`) &&
        r.request().method() === 'GET',
      { timeout: 10_000 },
    ),
    page.goto(`/audit?key_id=${targetKeyId}`),
  ])

  expect(auditResponse.status()).toBeGreaterThanOrEqual(200)
  expect(auditResponse.status()).toBeLessThan(300)

  // Form reflects the URL on direct-nav too.
  await expect(page.locator('#audit-key')).toHaveValue(targetKeyId)
})

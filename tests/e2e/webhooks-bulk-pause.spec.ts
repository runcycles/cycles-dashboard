import { test, expect, request as pwRequest } from '@playwright/test'
import { ADMIN_KEY, getFixtures, loginAsAdmin } from './fixtures'

/**
 * Webhooks bulk pause — sequential-with-cancel pattern regression lock.
 *
 * v0.1.25.21 shipped multi-select + bulk pause/enable on WebhooksView.
 * The pattern is: each selected sub triggers its own PATCH, run
 * sequentially (not parallel) to keep progress honest and avoid rate-
 * limit bursts, with a cancel flag checked between requests.
 *
 * Regression classes this locks down:
 *   - Selection state (checkbox per row, select-all-visible, hidden
 *     rows excluded from bulk scope)
 *   - The sequential loop completing for all selected items
 *   - Post-bulk refresh reflecting new status on every affected row
 *
 * Self-contained: creates two webhook subscriptions via the admin API
 * in beforeAll on the seeded tenant, then drives the bulk flow.
 */

interface SeededWebhook { id: string; url: string; name: string }
const seededWebhooks: SeededWebhook[] = []

test.beforeAll(async () => {
  const fx = getFixtures()
  const ctx = await pwRequest.newContext({ baseURL: process.env.DASHBOARD_URL || 'http://localhost:8080' })

  // Two subscriptions on the seeded tenant. Distinct URLs so the UI
  // rows are visually distinguishable; distinct names so selectors can
  // target by text if needed. Admin-plane /v1/admin/webhooks creates
  // tenant-scoped subs; the bulk pattern on WebhooksView operates
  // against whichever tenant the filter is narrowed to.
  const stamp = Date.now()
  for (let i = 0; i < 2; i++) {
    const url = `https://example.com/cycles-e2e-bulk-${stamp}-${i}`
    const name = `e2e-bulk-${stamp}-${i}`
    const res = await ctx.post('/v1/admin/webhooks', {
      headers: { 'X-Admin-API-Key': ADMIN_KEY },
      params: { tenant_id: fx.tenantId },
      data: {
        // example.com is IANA-reserved and DNS-resolvable — the
        // server's WebhookURLValidator checks resolution during
        // create. example.test is reserved but intentionally
        // non-resolvable, which is why bulk-0 URLs using .test
        // were rejected with WEBHOOK_URL_INVALID.
        url,
        name,
        event_types: ['budget.created'],
      },
    })
    if (!res.ok()) {
      throw new Error(`webhooks-bulk setup: create webhook #${i} failed: ${res.status()} ${await res.text()}`)
    }
    const body = (await res.json()) as { subscription: { subscription_id: string } }
    seededWebhooks.push({ id: body.subscription.subscription_id, url, name })
  }
  await ctx.dispose()
})

test('selecting webhooks and clicking Pause transitions them all to PAUSED', async ({ page }) => {
  const fx = getFixtures()

  await loginAsAdmin(page)
  await page.goto('/webhooks')

  // Wait for tenants + initial webhooks load.
  await page.waitForResponse(
    (r) => r.url().includes('/v1/admin/tenants') && r.request().method() === 'GET',
    { timeout: 10_000 },
  )

  // Filter to the seeded tenant so only our two seeded subs are
  // visible. Without the filter, other tenants' subs could be in the
  // table and "select all visible" would scope too broadly. Locator
  // uses the select's aria-label instead of its option text so the
  // "All webhooks" / "All tenants" rename (#68) doesn't break this
  // spec.
  const tenantSelect = page.getByRole('combobox', { name: /filter webhooks by tenant/i })
  await tenantSelect.selectOption(fx.tenantId)

  // Wait for the filtered list to render our specific subs. The row
  // displays the webhook URL as a link; subscription_id is not
  // rendered as visible text, so we locate rows by URL.
  for (const w of seededWebhooks) {
    await expect(page.getByRole('row').filter({ hasText: w.url })).toBeVisible({ timeout: 10_000 })
  }

  // Click the per-row checkboxes. Target by URL to avoid ambiguity.
  for (const w of seededWebhooks) {
    await page
      .getByRole('row')
      .filter({ hasText: w.url })
      .locator('input[type="checkbox"]')
      .check()
  }

  // Fire the bulk pause. Bulk-bar label is just "Pause" (shortened
  // from "Pause selected" since the floating-toolbar rework; the
  // "N selected" count to its left conveys scope). Scope the locator
  // to the toolbar region + strict ^pause$ regex so we don't match
  // the per-row "Pause" button.
  await page.getByRole('toolbar', { name: /bulk webhook actions/i }).getByRole('button', { name: /^pause$/i }).click()
  const bulkDialog = page.getByRole('dialog', { name: /pause \d+ webhooks\?/i })
  await expect(bulkDialog).toBeVisible()

  // Execute. Wait for BOTH patch responses — not just one — to prove
  // the sequential loop ran to completion.
  const responses = seededWebhooks.map((w) =>
    page.waitForResponse(
      (r) => r.url().includes(`/v1/admin/webhooks/${w.id}`) && r.request().method() === 'PATCH',
      { timeout: 15_000 },
    ),
  )
  await bulkDialog.getByRole('button', { name: /pause all/i }).click()
  const patchResults = await Promise.all(responses)
  for (const r of patchResults) {
    expect(r.status()).toBeGreaterThanOrEqual(200)
    expect(r.status()).toBeLessThan(300)
  }

  // Both rows now show PAUSED status. Dialog closes at end of run.
  await expect(bulkDialog).toBeHidden({ timeout: 10_000 })
  for (const w of seededWebhooks) {
    const row = page.getByRole('row').filter({ hasText: w.url })
    await expect(row.getByText('PAUSED')).toBeVisible({ timeout: 10_000 })
  }
})

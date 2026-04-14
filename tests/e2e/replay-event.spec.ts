import { test, expect, request as pwRequest } from '@playwright/test'
import { ADMIN_KEY, getFixtures, loginAsAdmin } from './fixtures'

/**
 * Replay-event — webhook event-replay flow via WebhookDetailView.
 * The operator action when downstream consumers missed events during
 * an outage window and need them re-delivered.
 *
 * Regression class: Replay button → FormDialog → submitReplay →
 * replayWebhookEvents(id, body) → result banner. The form optionally
 * takes from/to dates and max_events; the spec submits max_events only
 * to keep the test resilient to time-window logic in the server. The
 * key assertion is that the request fires with the expected body shape
 * and the banner renders the events_queued count — a regression in
 * either the client-side body construction or the banner render would
 * leak a silent failure to an operator trying to remediate an outage.
 *
 * Self-contained: creates its own webhook subscription under the seed
 * tenant so repeated runs don't depend on existing deliveries.
 */

let webhookId = ''

test.beforeAll(async () => {
  const fx = getFixtures()

  const ctx = await pwRequest.newContext({ baseURL: process.env.DASHBOARD_URL || 'http://localhost:8080' })
  const res = await ctx.post('/v1/admin/webhooks', {
    headers: { 'X-Admin-API-Key': ADMIN_KEY },
    data: {
      tenant_id: fx.tenantId,
      url: `https://example.invalid/e2e-replay-${Date.now()}`,
      // Server requires at least one event type. `budget.created` is the
      // same event used by webhooks-bulk-pause's setup; no tenant events
      // are actually needed for the replay flow (the endpoint returns
      // 2xx with events_queued=0 when the time window is empty).
      event_types: ['budget.created'],
    },
  })
  if (!res.ok()) {
    throw new Error(`replay-event setup: create webhook failed: ${res.status()} ${await res.text()}`)
  }
  const body = await res.json()
  webhookId = body.subscription_id
  if (!webhookId) {
    throw new Error(`replay-event setup: response missing subscription_id: ${JSON.stringify(body)}`)
  }
  await ctx.dispose()
})

test('operator submits a replay and sees the events_queued banner', async ({ page }) => {
  await loginAsAdmin(page)
  await page.goto(`/webhooks/${webhookId}`)

  // Wait for the webhook detail GET.
  await page.waitForResponse(
    (r) => r.url().includes(`/v1/admin/webhooks/${webhookId}`) && r.request().method() === 'GET',
    { timeout: 10_000 },
  )

  // Click Replay to open the FormDialog.
  await page.getByRole('button', { name: /^replay$/i }).click()
  const dialog = page.getByRole('dialog', { name: /replay events/i })
  await expect(dialog).toBeVisible()

  // Form pre-fills max_events=100. Leave it. Submit.
  const [replayResp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes(`/v1/admin/webhooks/${webhookId}/replay`) && r.request().method() === 'POST',
      { timeout: 15_000 },
    ),
    dialog.getByRole('button', { name: /start replay/i }).click(),
  ])
  expect(replayResp.status()).toBeGreaterThanOrEqual(200)
  expect(replayResp.status()).toBeLessThan(300)

  // Body assertion — max_events should be a number, not a string. A
  // regression that skipped the `Number()` coercion would send "100"
  // and some servers coerce, others 400. Lock the number type here.
  const replayBody = replayResp.request().postDataJSON() as { max_events?: number } | null
  expect(replayBody?.max_events).toBe(100)

  // Dialog closes on success; result banner shows events_queued.
  await expect(dialog).toBeHidden({ timeout: 5_000 })
  // The banner is persistent (no auto-clear per the comment in the
  // view), so asserting visibility without a timeout race is fine.
  await expect(page.getByText(/events queued for replay/i)).toBeVisible({ timeout: 5_000 })
})

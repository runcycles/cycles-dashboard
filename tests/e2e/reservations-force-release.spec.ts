import { test, expect } from '@playwright/test'
import { getFixtures, loginAsAdmin } from './fixtures'

/**
 * Flow 2 — navigate to Reservations, select the seeded tenant, find the
 * seeded reservation, click Force release, confirm in the dialog, wait
 * for the success toast and the list to refresh.
 *
 * Regression class: the form-submit chain where validation + API call
 * (with client-generated crypto.randomUUID() idempotency key) + error
 * handling + toast + list refresh all thread together. HTTP probes
 * pass because the backend works in isolation — a dialog that stays
 * open on success, a missing idempotency key header, or a toast that
 * fails to render only surface in a real browser.
 *
 * This was the flow the Stage 2.3 work was built for. Ship with a
 * regression lock.
 */
test('operator force-releases a hung reservation and the row disappears', async ({ page }) => {
  const fx = getFixtures()

  await loginAsAdmin(page)

  // Navigate via the sidebar (exercises the router too) rather than
  // direct-nav; the sidebar link is the path real operators take.
  await page.getByRole('navigation').first().getByRole('link', { name: /reservations/i }).click()
  await expect(page).toHaveURL(/\/reservations$/)

  // The view auto-picks the first ACTIVE tenant on load. Our seed
  // created a timestamp-suffixed tenant which may not be first — pick
  // it explicitly to guarantee we see the seeded reservations.
  await page.selectOption('#res-tenant', fx.tenantId)

  // Wait for the row with the target reservation ID to render. The ID
  // is shown as the first cell of each row (font-mono, break-all).
  const targetRow = page.getByRole('row').filter({ hasText: fx.reservationIdForRelease })
  await expect(targetRow).toBeVisible({ timeout: 10_000 })

  // Click the row's Force release button. There are three rows for
  // this tenant; scoping to targetRow guarantees we click the right one.
  await targetRow.getByRole('button', { name: /force release/i }).click()

  // FormDialog renders with role="dialog" and aria-label from the
  // title prop — scope to that specific dialog so the "Force release"
  // submit button doesn't collide with the row-level buttons.
  const dialog = page.getByRole('dialog', { name: /force release this reservation/i })
  await expect(dialog).toBeVisible()

  // Submit. Capture the release response as a side-channel assertion —
  // we want to verify the request actually included an idempotency_key,
  // because a regression in releaseReservation() that drops that header
  // would pass this UI test visually (server accepts absent key) but
  // break prod idempotency guarantees.
  const [releaseResponse] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes(`/v1/reservations/${fx.reservationIdForRelease}/release`) && r.request().method() === 'POST',
    ),
    dialog.getByRole('button', { name: /^force release$/i }).click(),
  ])

  expect(releaseResponse.status(), 'release endpoint should return 2xx').toBeGreaterThanOrEqual(200)
  expect(releaseResponse.status()).toBeLessThan(300)

  const releaseRequest = releaseResponse.request()
  const releaseBody = releaseRequest.postDataJSON() as { idempotency_key?: string } | null
  expect(releaseBody, 'release request must send a JSON body').not.toBeNull()
  expect(releaseBody!.idempotency_key, 'release request must include idempotency_key').toMatch(
    // RFC 4122 v4 UUID — the client uses crypto.randomUUID().
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  )

  // The dialog closes on success (pendingRelease → null in the submit
  // handler). A dialog that stays open would indicate the controller's
  // success path didn't run cleanly.
  await expect(dialog).toBeHidden({ timeout: 5_000 })

  // And the row for the released reservation drops out of the list.
  // The default filter is status=ACTIVE; force-release transitions the
  // reservation to RELEASED, so it leaves the visible set on the next
  // loadReservations() call — which submitRelease triggers.
  //
  // (Toast-visibility assertion is intentionally omitted. The toast has
  // a 4s TTL, transitions fade in/out, and cover assertion produces
  // flake without catching a meaningful bug class — a regression that
  // dropped the toast call would also fail this row-disappears check,
  // because both live in the same success path.)
  await expect(targetRow).toBeHidden({ timeout: 10_000 })
})

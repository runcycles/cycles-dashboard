import { test, expect } from '@playwright/test'
import { getFixtures, loginAsAdmin } from './fixtures'

/**
 * Flow 3 — the v0.1.25.22 sort-accessor regression lock.
 *
 * The bug: ReservationsView's `reserved` column stored its data as an
 * object `{unit, amount}`. The original useSort() without an accessor
 * stringified the object to "[object Object]" for every row, so every
 * pairwise comparison returned 0 — clicking the Reserved header became
 * a silent no-op. Unit tests passed. Typecheck passed. HTTP probes
 * passed. Manual review caught it at review round on PR #35.
 *
 * This spec clicks the Reserved column header and asserts the rows
 * actually reorder. A future regression where the accessor is removed
 * or broken will make the assertion fail.
 *
 * Depends on fixtures creating two reservations with distinct amounts
 * (small=30k, large=75k). If both amounts were equal the sort would
 * be a valid no-op and the test couldn't distinguish bug from working.
 */
test('clicking the Reserved column header reorders reservations by amount', async ({ page }) => {
  const fx = getFixtures()

  await loginAsAdmin(page)
  await page.goto('/reservations')

  // Wait for the tenant list load to finish. The view calls
  // listTenants() then loadReservations() on mount; we don't want to
  // interact with #res-tenant before it has options populated, or
  // assert on rows before the reservations list responds.
  await page.waitForResponse(
    (r) => r.url().includes('/v1/admin/tenants') && r.request().method() === 'GET',
    { timeout: 10_000 },
  )

  // Select the seeded tenant and wait for that tenant's reservations
  // list response. Without waiting for the specific response, the row
  // assertions below can race the initial (empty) render.
  const [, ] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes('/v1/reservations') &&
        r.url().includes(`tenant=${fx.tenantId}`) &&
        r.request().method() === 'GET',
      { timeout: 10_000 },
    ),
    page.selectOption('#res-tenant', fx.tenantId),
  ])

  // Wait until both sort-target rows are present before interacting.
  // The force-release spec (if it ran first) removes the for-release
  // reservation but leaves small + large — we only need those two.
  await expect(page.getByRole('row').filter({ hasText: fx.reservationIdSmall })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('row').filter({ hasText: fx.reservationIdLarge })).toBeVisible()

  // Helper: read the reservation_id shown in the first data row. Data
  // rows are identified by their font-mono first cell matching a
  // reservation id our fixtures know about.
  const firstDataRowReservationId = async (): Promise<string> => {
    const rows = page.getByRole('row')
    const count = await rows.count()
    for (let i = 0; i < count; i++) {
      const rowText = (await rows.nth(i).textContent()) ?? ''
      if (rowText.includes(fx.reservationIdSmall)) return fx.reservationIdSmall
      if (rowText.includes(fx.reservationIdLarge)) return fx.reservationIdLarge
    }
    throw new Error('No seeded reservation row found; view not rendering fixtures')
  }

  // Click Reserved → ascending. The accessor must return the numeric
  // .amount for the comparator to actually order these. If the accessor
  // is broken (returns the object), the sort is a no-op.
  await page.getByRole('columnheader', { name: /sort by reserved/i }).click()

  // After ascending sort, the smaller-amount reservation must be first.
  await expect.poll(firstDataRowReservationId, {
    message: 'Reserved column asc sort should place the 30k reservation first',
    timeout: 5_000,
  }).toBe(fx.reservationIdSmall)

  // Click again → descending. Large should be first now.
  await page.getByRole('columnheader', { name: /sort by reserved/i }).click()

  await expect.poll(firstDataRowReservationId, {
    message: 'Reserved column desc sort should place the 75k reservation first',
    timeout: 5_000,
  }).toBe(fx.reservationIdLarge)

  // And the aria-sort attribute flipped — belt-and-suspenders: if the
  // visual order changed but the ARIA state didn't (or vice versa),
  // something's inconsistent between the SortHeader view and the useSort
  // state.
  const header = page.getByRole('columnheader', { name: /sort by reserved/i })
  await expect(header).toHaveAttribute('aria-sort', 'descending')
})

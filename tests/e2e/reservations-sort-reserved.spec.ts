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

  // Helper: return the row indexes of the small and large reservation
  // rows. Comparing these indexes to each other is strictly stronger
  // than "which id is in the first row" — the latter depends on what
  // other reservations are in the table (e.g. the force-release spec
  // may or may not have run first, changing the third row's presence
  // and therefore the default created_at order). Pairwise ordering of
  // just small vs large is independent of that.
  const smallVsLargeOrder = async (): Promise<'small-first' | 'large-first' | 'unknown'> => {
    const rows = page.getByRole('row')
    const count = await rows.count()
    let smallIdx = -1
    let largeIdx = -1
    for (let i = 0; i < count; i++) {
      const txt = (await rows.nth(i).textContent()) ?? ''
      if (txt.includes(fx.reservationIdSmall)) smallIdx = i
      if (txt.includes(fx.reservationIdLarge)) largeIdx = i
    }
    if (smallIdx === -1 || largeIdx === -1) return 'unknown'
    return smallIdx < largeIdx ? 'small-first' : 'large-first'
  }

  // Click Reserved → ascending. The accessor must return the numeric
  // .amount for the comparator to actually order these. If the accessor
  // is broken (returns the object), the sort degenerates to a stable
  // no-op preserving created_at order — which, given seed creation
  // order (forRelease → small → large), would also be small-first for
  // asc. So the asc assertion alone doesn't catch the bug. The desc
  // assertion below IS the regression lock: desc requires actual
  // reordering, which a no-op sort cannot produce.
  await page.getByRole('columnheader', { name: /sort by reserved/i }).click()

  await expect.poll(smallVsLargeOrder, {
    message: 'Reserved column asc sort: small (30k) must precede large (75k)',
    timeout: 5_000,
  }).toBe('small-first')

  // Click again → descending. Large must precede small. A broken
  // accessor produces a stable no-op (all compares return 0), which
  // means the order is unchanged from asc (small-first) — this
  // assertion then fails, catching the v0.1.25.22 regression class.
  await page.getByRole('columnheader', { name: /sort by reserved/i }).click()

  await expect.poll(smallVsLargeOrder, {
    message: 'Reserved column desc sort: large (75k) must precede small (30k)',
    timeout: 5_000,
  }).toBe('large-first')

  // And the aria-sort attribute flipped — belt-and-suspenders: if the
  // visual order changed but the ARIA state didn't (or vice versa),
  // something's inconsistent between the SortHeader view and the useSort
  // state.
  const header = page.getByRole('columnheader', { name: /sort by reserved/i })
  await expect(header).toHaveAttribute('aria-sort', 'descending')
})

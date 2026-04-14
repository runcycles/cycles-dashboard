import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './fixtures'

/**
 * Dark-mode toggle — the sidebar's moon/sun button.
 *
 * useDarkMode toggles a `dark` class on <html> (Tailwind's darkMode:
 * 'class' strategy) and persists the preference to localStorage. The
 * Sidebar button has aria-label "Switch to dark mode" or "Switch to
 * light mode" depending on current state.
 *
 * Regression class: the composable's subscribe/publish wiring. A
 * broken toggle handler, a missing <html> class mutation, or a stale
 * aria-label that doesn't flip with state would all pass typecheck +
 * unit tests (where there's no real DOM to observe the class on) but
 * break in the real browser.
 */
test('dark-mode toggle flips the html.dark class and its own aria-label', async ({ page }) => {
  await loginAsAdmin(page)

  // Read the initial state. Different CI environments / OS settings
  // may default to different preferences — we assert the toggle
  // behavior, not the initial value.
  const initialIsDark = await page.evaluate(() =>
    document.documentElement.classList.contains('dark'),
  )
  const initialLabel = initialIsDark ? /switch to light mode/i : /switch to dark mode/i
  const flippedLabel = initialIsDark ? /switch to dark mode/i : /switch to light mode/i

  const toggle = page.getByRole('button', { name: initialLabel })
  await expect(toggle).toBeVisible()

  await toggle.click()

  // <html> class flipped.
  await expect(page.locator('html')).toHaveClass(
    initialIsDark ? /^(?!.*\bdark\b).*$/ : /\bdark\b/,
    { timeout: 2_000 },
  )

  // And the button's own aria-label now reflects the new state — so
  // the next click reverses correctly. Assert via a fresh query for
  // the flipped label text.
  await expect(page.getByRole('button', { name: flippedLabel })).toBeVisible()

  // Click again to return to the initial state (leaves the page in
  // the state other specs expect — matters only for local reruns
  // without compose-down).
  await page.getByRole('button', { name: flippedLabel }).click()
  const finalIsDark = await page.evaluate(() =>
    document.documentElement.classList.contains('dark'),
  )
  expect(finalIsDark).toBe(initialIsDark)
})

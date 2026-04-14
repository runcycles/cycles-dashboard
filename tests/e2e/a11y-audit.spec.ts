import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { loginAsAdmin } from './fixtures'

/**
 * Accessibility audit via axe-core. Baseline coverage for the main
 * dashboard surfaces.
 *
 * Severity ratchet. Currently blocks on 'critical' only. 'Serious'-
 * level violations — color-contrast failures on the Tailwind-grey
 * rows and filters — are observed but not blocking. Rationale: the
 * dashboard has pre-existing color-contrast issues across nearly every
 * view; failing on all serious violations would require a design pass
 * and block this PR's purpose (establishing regression coverage).
 *
 * To ratchet the floor:
 *   1. Fix all violations at the current threshold.
 *   2. Confirm the audit is clean.
 *   3. Add the next impact level to BLOCKING_IMPACTS.
 *   4. Cycle.
 *
 * Regression class: DOM/markup changes that remove aria-labels, break
 * label-for associations, or introduce hit-stopping a11y defects
 * (e.g. an unlabeled interactive element, a form without a label).
 * These pass typecheck + unit tests + other e2e specs but silently
 * make the dashboard unusable for screen readers and keyboard users.
 */

// WCAG 2.0/2.1 AA is the practical target. Axe's built-in tag for that
// is wcag2aa + wcag21aa (the 2.1 additions). Avoid wcag2a-only to skip
// overly-lenient rules.
const AUDIT_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa']

// Severities that fail the test. Raise the floor by adding 'serious',
// then 'moderate', then 'minor' as each level gets cleaned up.
const BLOCKING_IMPACTS: ReadonlyArray<string> = ['critical']

// Pretty-print violations in the failure message so the trace artifact
// tells the whole story without needing to re-run axe locally.
function formatViolations(violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations']): string {
  if (violations.length === 0) return ''
  return violations
    .map((v) => {
      const nodes = v.nodes.slice(0, 3).map((n) => `      - ${n.target.join(' ')}`).join('\n')
      const truncated = v.nodes.length > 3 ? `\n      ... +${v.nodes.length - 3} more` : ''
      return `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.helpUrl}\n${nodes}${truncated}`
    })
    .join('\n\n')
}

test('login page has no critical a11y violations', async ({ page }) => {
  await page.goto('/login')

  const results = await new AxeBuilder({ page }).withTags(AUDIT_TAGS).analyze()
  const blocking = results.violations.filter((v) =>
    BLOCKING_IMPACTS.includes(v.impact ?? ''),
  )
  expect(blocking, `\n${formatViolations(blocking)}`).toEqual([])
})

test('overview page (post-login) has no critical a11y violations', async ({ page }) => {
  await loginAsAdmin(page)
  // loginAsAdmin lands on '/' which is the Overview route.

  const results = await new AxeBuilder({ page })
    .withTags(AUDIT_TAGS)
    // Exclude third-party / uncontrollable widgets if any get added
    // later (e.g. embedded Grafana iframe). Empty today.
    // .exclude('...')
    .analyze()

  const blocking = results.violations.filter((v) =>
    BLOCKING_IMPACTS.includes(v.impact ?? ''),
  )
  expect(blocking, `\n${formatViolations(blocking)}`).toEqual([])
})

test('reservations page (post-login) has no critical a11y violations', async ({ page }) => {
  await loginAsAdmin(page)
  await page.goto('/reservations')

  // Give the view's initial listTenants + listReservations roundtrip a
  // beat to settle before auditing — axe reads the live DOM, and a
  // spinner mid-analysis can produce noisy timing-sensitive reports.
  await page.waitForResponse(
    (r) => r.url().includes('/v1/admin/tenants') && r.request().method() === 'GET',
    { timeout: 10_000 },
  )

  const results = await new AxeBuilder({ page }).withTags(AUDIT_TAGS).analyze()
  const blocking = results.violations.filter((v) =>
    BLOCKING_IMPACTS.includes(v.impact ?? ''),
  )
  expect(blocking, `\n${formatViolations(blocking)}`).toEqual([])
})

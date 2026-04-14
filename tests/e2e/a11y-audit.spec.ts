import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { getFixtures, loginAsAdmin } from './fixtures'

/**
 * Accessibility audit via axe-core. Covers every significant dashboard
 * surface at the WCAG 2.0/2.1 AA level.
 *
 * Severity ratchet — CURRENT FLOOR: moderate + serious + critical.
 *
 *   Introduced at 'critical' only (earlier PR). Raised to include
 *   'serious' after a focused fix pass: color-contrast swaps
 *   (text-gray-400 → text-gray-600 on white with dark:text-gray-400
 *   preserved for dark mode), missing select-name labels, and
 *   nested-interactive refactors on Events/Audit rows.
 *
 *   Ratchet to 'moderate' was a free step — a discovery sweep found
 *   zero moderate-level violations after the serious fix pass
 *   (many moderate rules happen to overlap with the serious ones
 *   we already addressed, and the remainder didn't trigger on this
 *   codebase).
 *
 *   'minor' is ALSO currently clean. We deliberately hold the floor
 *   at moderate so incidental UI tweaks (landmark labels, region
 *   annotations) don't block unrelated PRs; keep 'minor' as the
 *   next step when you want stricter enforcement.
 *
 *   To ratchet to all-levels (minor included):
 *     1. Sweep with IMPACTS=['minor', …] to confirm still clean.
 *     2. Add 'minor' to BLOCKING_IMPACTS.
 *     3. Profit.
 *
 * Regression class: DOM/markup changes that remove aria-labels, break
 * label-for associations, re-introduce color-contrast failures, or
 * nest interactive controls inside another interactive element.
 * These pass typecheck + unit tests + other e2e specs but silently
 * make the dashboard unusable for screen readers and keyboard users.
 */

// WCAG 2.0/2.1 AA target tags.
const AUDIT_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa']

// Severities that fail the test. Raise to include 'minor' once we
// want the strictest enforcement (currently also clean — verified
// 2026-04-14).
const BLOCKING_IMPACTS: ReadonlyArray<string> = ['moderate', 'serious', 'critical']

// Pretty-print violations into the failure message so the CI trace
// artifact tells the whole story without requiring a local re-run.
function formatViolations(
  violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations'],
): string {
  if (violations.length === 0) return ''
  return violations
    .map((v) => {
      const nodes = v.nodes.slice(0, 3).map((n) => `      - ${n.target.join(' ')}`).join('\n')
      const truncated = v.nodes.length > 3 ? `\n      ... +${v.nodes.length - 3} more` : ''
      return `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.helpUrl}\n${nodes}${truncated}`
    })
    .join('\n\n')
}

async function auditPage(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page }).withTags(AUDIT_TAGS).analyze()
  return results.violations.filter((v) => BLOCKING_IMPACTS.includes(v.impact ?? ''))
}

test('login page has no moderate+ a11y violations', async ({ page }) => {
  await page.goto('/login')
  const blocking = await auditPage(page)
  expect(blocking, `\n${formatViolations(blocking)}`).toEqual([])
})

test('overview page (post-login) has no moderate+ a11y violations', async ({ page }) => {
  await loginAsAdmin(page)
  // loginAsAdmin lands on '/' which is the Overview route.
  const blocking = await auditPage(page)
  expect(blocking, `\n${formatViolations(blocking)}`).toEqual([])
})

test('tenants list has no moderate+ a11y violations', async ({ page }) => {
  await loginAsAdmin(page)
  await page.goto('/tenants')
  await page.waitForResponse(
    (r) => r.url().includes('/v1/admin/tenants') && r.request().method() === 'GET',
    { timeout: 10_000 },
  )
  const blocking = await auditPage(page)
  expect(blocking, `\n${formatViolations(blocking)}`).toEqual([])
})

test('tenant detail has no moderate+ a11y violations', async ({ page }) => {
  const fx = getFixtures()
  await loginAsAdmin(page)
  await page.goto(`/tenants/${fx.tenantId}`)
  await page.waitForResponse(
    (r) =>
      r.url().includes(`/v1/admin/tenants/${fx.tenantId}`) &&
      r.request().method() === 'GET',
    { timeout: 10_000 },
  )
  const blocking = await auditPage(page)
  expect(blocking, `\n${formatViolations(blocking)}`).toEqual([])
})

test('budgets list has no moderate+ a11y violations', async ({ page }) => {
  const fx = getFixtures()
  await loginAsAdmin(page)
  await page.goto('/budgets')
  await page.waitForResponse(
    (r) => r.url().includes('/v1/admin/tenants') && r.request().method() === 'GET',
    { timeout: 10_000 },
  )
  // Pick the seeded tenant so the table actually has rows to audit —
  // empty-state-only audits miss table-specific violations.
  await page.locator('#budget-tenant').selectOption(fx.tenantId).catch(() => {})
  await page.waitForLoadState('networkidle')
  const blocking = await auditPage(page)
  expect(blocking, `\n${formatViolations(blocking)}`).toEqual([])
})

test('events list has no moderate+ a11y violations', async ({ page }) => {
  await loginAsAdmin(page)
  await page.goto('/events')
  await page.waitForLoadState('networkidle')
  const blocking = await auditPage(page)
  expect(blocking, `\n${formatViolations(blocking)}`).toEqual([])
})

test('api keys list has no moderate+ a11y violations', async ({ page }) => {
  await loginAsAdmin(page)
  await page.goto('/api-keys')
  await page.waitForResponse(
    (r) => r.url().includes('/v1/admin/tenants') && r.request().method() === 'GET',
    { timeout: 10_000 },
  )
  await page.waitForLoadState('networkidle')
  const blocking = await auditPage(page)
  expect(blocking, `\n${formatViolations(blocking)}`).toEqual([])
})

test('webhooks list has no moderate+ a11y violations', async ({ page }) => {
  await loginAsAdmin(page)
  await page.goto('/webhooks')
  await page.waitForLoadState('networkidle')
  const blocking = await auditPage(page)
  expect(blocking, `\n${formatViolations(blocking)}`).toEqual([])
})

test('audit page has no moderate+ a11y violations', async ({ page }) => {
  await loginAsAdmin(page)
  await page.goto('/audit')
  await page.waitForLoadState('networkidle')
  const blocking = await auditPage(page)
  expect(blocking, `\n${formatViolations(blocking)}`).toEqual([])
})

test('reservations page has no moderate+ a11y violations', async ({ page }) => {
  await loginAsAdmin(page)
  await page.goto('/reservations')
  await page.waitForResponse(
    (r) => r.url().includes('/v1/admin/tenants') && r.request().method() === 'GET',
    { timeout: 10_000 },
  )
  await page.waitForLoadState('networkidle')
  const blocking = await auditPage(page)
  expect(blocking, `\n${formatViolations(blocking)}`).toEqual([])
})

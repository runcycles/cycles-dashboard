/**
 * Shared helpers for Playwright specs. Reads the fixture data seeded by
 * global.setup.ts and exposes small reusable pieces of the login flow
 * so each spec doesn't re-navigate the admin-key paste-in from scratch.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'

export interface Fixtures {
  tenantId: string
  tenantName: string
  tenantApiKey: string
  budgetId: string
  budgetScope: string
  reservationIdForRelease: string
  reservationIdSmall: string
  reservationIdLarge: string
}

const FIXTURES_PATH = path.resolve('test-results', 'fixtures.json')

let cached: Fixtures | null = null

export function getFixtures(): Fixtures {
  if (cached) return cached
  if (!fs.existsSync(FIXTURES_PATH)) {
    throw new Error(
      `fixtures.json missing at ${FIXTURES_PATH}. Did globalSetup run? ` +
        `(Run via \`npm run test:e2e\` so Playwright invokes the setup.)`,
    )
  }
  cached = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf-8')) as Fixtures
  return cached
}

export const ADMIN_KEY = process.env.ADMIN_API_KEY || 'admin-bootstrap-key'

/**
 * Drive the login form with the admin key and wait for redirect to the
 * post-auth root route. Factored out so each spec starts from a known
 * authenticated state without duplicating selectors.
 */
export async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/login')
  // The login form has a single password-type input for the key.
  await page.getByLabel(/api key/i).fill(ADMIN_KEY)
  // Submit via the primary action button.
  await page.getByRole('button', { name: /log\s*in|sign\s*in|submit/i }).click()
  // Post-auth the SPA navigates off /login — the exact route is '/', but
  // we allow any non-/login path to avoid coupling to the Overview view's
  // specific content.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 })
}

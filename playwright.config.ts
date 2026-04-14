import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright E2E tests for the Cycles dashboard.
 *
 * These tests run against a LIVE compose stack — `docker-compose.yml`
 * brings up redis + cycles-server + cycles-server-admin + the dashboard
 * container on :8080. Playwright is intentionally NOT using `webServer`
 * because the compose stack is the source of truth; double-managing the
 * lifecycle is error-prone.
 *
 * Local dev loop:
 *   ADMIN_API_KEY=admin-bootstrap-key docker compose -f docker-compose.yml up -d --wait
 *   npm run test:e2e
 *   docker compose down -v
 *
 * CI invokes this from `.github/workflows/e2e.yml` after the HTTP probes
 * pass — the probes catch routing/plumbing bugs, Playwright catches
 * JavaScript-layer bugs (the v0.1.25.22 sort-accessor class).
 */
export default defineConfig({
  testDir: './tests/e2e',

  // Global setup: seed a tenant, API key, budget, and reservation so
  // the specs have a known fixture set. Runs once before the suite.
  globalSetup: './tests/e2e/global.setup.ts',

  // Parallelism is OK for these specs — each reads the shared seeded
  // fixtures but the force-release spec does mutate one reservation.
  // fullyParallel: false keeps specs deterministic; flip to true later
  // if the suite grows and we make per-test fixtures.
  fullyParallel: false,
  workers: 1,

  // Reasonable defaults; bump if a spec genuinely needs more.
  timeout: 30_000,
  expect: { timeout: 5_000 },

  // Retry once on CI only — masks intermittent flake without hiding
  // consistent failures. Local runs fail fast.
  retries: process.env.CI ? 1 : 0,

  // HTML report is the primary artifact on CI failure. Also emit a
  // JSON report for any future tooling that wants machine-readable
  // results. `never` opens the browser locally so CLI stays non-
  // interactive by default.
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],
  ],

  use: {
    baseURL: process.env.DASHBOARD_URL || 'http://localhost:8080',

    // Failure-path captures only — keeps passing runs fast and
    // artifact-free, gives the triage person full context when
    // something breaks.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  // Chromium only. Cross-browser coverage adds CI time and flake
  // without a commensurate regression-catch rate for the bug classes
  // we care about. If a specific bug turns out to be Firefox/WebKit-
  // only, we can add a targeted project at that point.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})

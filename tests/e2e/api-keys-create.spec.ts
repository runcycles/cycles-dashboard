import { test, expect } from '@playwright/test'
import { getFixtures, loginAsAdmin } from './fixtures'

/**
 * API key create flow — the shown-once-secret pattern is the specific
 * regression class this spec locks down. Unit tests mock fetch and
 * don't exercise:
 *   - The SecretReveal modal that pops after create
 *   - The Close button's disabled state (gated on the "I have copied
 *     and saved" checkbox — prevents accidental dismissal losing the
 *     secret forever)
 *   - The Copy button's state-toggle ("Copy" → "Copied!")
 *
 * A regression that closes the dialog before the checkbox is checked,
 * or that hides the secret text, or that breaks the copy handler, is
 * equivalent to losing a credential. High-blast-radius bug class.
 *
 * Self-contained: uses the seeded tenant as the parent, creates a new
 * key through the UI, then verifies the created-key flow end-to-end.
 */
test('creating an API key reveals the secret with a gated confirmation + close', async ({ page, context }) => {
  const fx = getFixtures()

  // Grant clipboard permissions so the Copy button's writeText call
  // doesn't prompt or throw in the browser. Without this, the click
  // handler still runs (we test visible state-toggle), but a future
  // assertion on clipboard contents would need the grant anyway.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])

  await loginAsAdmin(page)
  await page.goto('/api-keys')

  // Wait for the initial tenants + keys load. Without this, opening
  // the Create dialog before tenants populate leaves the select empty.
  await page.waitForResponse(
    (r) => r.url().includes('/v1/admin/tenants') && r.request().method() === 'GET',
    { timeout: 10_000 },
  )

  // Open the create dialog from the page-level action button.
  await page.getByRole('button', { name: /create api key/i }).first().click()

  const createDialog = page.getByRole('dialog', { name: /create api key/i })
  await expect(createDialog).toBeVisible()

  // Fill the form. Pick the seeded tenant explicitly so we know the
  // key is scoped where we expect. Name is unique per run so the row
  // assertion after close doesn't collide with prior test keys.
  await createDialog.locator('#ck-tenant').selectOption(fx.tenantId)
  const keyName = `e2e-create-${Date.now()}`
  await createDialog.locator('#ck-name').fill(keyName)

  // Check two permissions — the form requires at least one in body
  // only if .length > 0; the server validates. Pick minimally
  // non-empty so the test exercises the multi-select wiring.
  //
  // Target checkboxes by input[value=...] rather than label text: the
  // PermissionPicker displays only the short tail ("read") under each
  // section header ("Budgets"), so getByLabel("budgets:read") matches
  // nothing. The value attribute still carries the full permission
  // string, making it a stable selector that survives the visual
  // grouping structure.
  await createDialog.locator('input[type="checkbox"][value="budgets:read"]').check()
  await createDialog.locator('input[type="checkbox"][value="balances:read"]').check()

  // Submit. Capture the response body so we can assert the server
  // issued a key_secret we can later verify is actually rendered.
  const [createResponse] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/v1/admin/api-keys') && r.request().method() === 'POST',
      { timeout: 10_000 },
    ),
    createDialog.getByRole('button', { name: /create key/i }).click(),
  ])
  expect(createResponse.status(), 'create returned 2xx').toBeGreaterThanOrEqual(200)
  expect(createResponse.status()).toBeLessThan(300)
  const createBody = (await createResponse.json()) as { key_id: string; key_secret: string }

  // The create dialog closes and the SecretReveal opens. role="dialog"
  // + aria-label="API Key Created" per SecretReveal.vue.
  await expect(createDialog).toBeHidden()
  const revealDialog = page.getByRole('dialog', { name: /api key created/i })
  await expect(revealDialog).toBeVisible()

  // The full secret must be visible in the reveal dialog exactly once.
  // This is the critical assertion — a regression that hides the
  // secret here would permanently lose the credential.
  await expect(revealDialog.getByText(createBody.key_secret)).toBeVisible()

  // The Close button is DISABLED until the confirmation checkbox is
  // checked. This prevents accidental dismissal. If a regression
  // allowed close without confirmation, the user could lose the
  // secret before copying.
  const closeBtn = revealDialog.getByRole('button', { name: /^close$/i })
  await expect(closeBtn).toBeDisabled()

  // Exercise the copy button — its visible state flips "Copy" →
  // "Copied!". We don't assert clipboard contents here (headless vs
  // headed, CI permissions, etc.) — the state-toggle assertion
  // verifies the click handler ran.
  const copyBtn = revealDialog.getByRole('button', { name: /^copy$/i })
  await copyBtn.click()
  await expect(revealDialog.getByRole('button', { name: /copied!/i })).toBeVisible()

  // Tick the confirmation and close.
  await revealDialog.getByLabel(/i have copied and saved/i).check()
  await expect(closeBtn).toBeEnabled()
  await closeBtn.click()
  await expect(revealDialog).toBeHidden()

  // The new key appears in the table with the name we set; the
  // full secret MUST NOT appear anywhere in the DOM after close —
  // that's the "shown once" contract.
  await expect(page.getByRole('row').filter({ hasText: keyName })).toBeVisible({ timeout: 10_000 })
  const pageContent = await page.content()
  expect(
    pageContent,
    'full key_secret must not be rendered anywhere in the DOM after the reveal dialog closes',
  ).not.toContain(createBody.key_secret)
})

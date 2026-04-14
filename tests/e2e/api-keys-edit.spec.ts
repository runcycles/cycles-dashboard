import { test, expect, request as pwRequest } from '@playwright/test'
import { ADMIN_KEY, getFixtures, loginAsAdmin } from './fixtures'

/**
 * API key edit flow — exercises updateApiKey through the UI.
 *
 * Regression class: form-submit chain (multi-select permissions +
 * scope_filter comma-split + name rename) → PATCH /v1/admin/api-keys/{id}
 * → toast + list refresh. Unit tests mock fetch and don't cover the
 * multi-select → request-body translation, and HTTP probes don't drive
 * the form at all.
 *
 * Self-contained: creates its own fresh key via the admin API in
 * beforeAll, then tests the UI edit flow against that specific key.
 * Doesn't mutate the seed fixtures other tests depend on.
 */

let editKeyId = ''
let editKeyOriginalName = ''
const editKeyNewName = `e2e-edit-renamed-${Date.now()}`

test.beforeAll(async () => {
  const fx = getFixtures()
  editKeyOriginalName = `e2e-edit-target-${Date.now()}`

  const ctx = await pwRequest.newContext({ baseURL: process.env.DASHBOARD_URL || 'http://localhost:8080' })
  const res = await ctx.post('/v1/admin/api-keys', {
    headers: { 'X-Admin-API-Key': ADMIN_KEY },
    data: {
      tenant_id: fx.tenantId,
      name: editKeyOriginalName,
      // Start with read-only perms so the edit can observably add
      // a write perm; an update that goes through but silently drops
      // the new perm list would pass the name-check but fail here.
      permissions: ['budgets:read', 'policies:read'],
    },
  })
  if (!res.ok()) {
    throw new Error(`edit-spec setup: create key failed: ${res.status()} ${await res.text()}`)
  }
  const body = (await res.json()) as { key_id: string }
  editKeyId = body.key_id
  await ctx.dispose()
})

test('editing an API key renames it and updates permissions visibly', async ({ page }) => {
  const fx = getFixtures()

  await loginAsAdmin(page)
  await page.goto('/api-keys')

  // Wait until the all-tenant keys scan finishes. ApiKeysView calls
  // listTenants then issues a listApiKeys per tenant — for our small
  // seed set this resolves quickly but racing the render leads to
  // "row not found" failures.
  await page.waitForResponse(
    (r) => r.url().includes('/v1/admin/tenants') && r.request().method() === 'GET',
    { timeout: 10_000 },
  )

  // Filter to our seeded tenant so the target key row is easy to
  // locate regardless of other tenants/keys in the shared table.
  await page.locator('#keys-tenant').selectOption(fx.tenantId)

  // Find the row by the original name (which we set unique above).
  const targetRow = page.getByRole('row').filter({ hasText: editKeyOriginalName })
  await expect(targetRow).toBeVisible({ timeout: 10_000 })

  // Open the edit dialog. Scoped to the target row so we don't click
  // an Edit button on a different key.
  await targetRow.getByRole('button', { name: /^edit$/i }).click()

  const editDialog = page.getByRole('dialog', { name: /edit api key/i })
  await expect(editDialog).toBeVisible()

  // Rename + add a permission the key didn't have (budgets:write).
  await editDialog.locator('#ek-name').fill(editKeyNewName)
  await editDialog.getByLabel('budgets:write').check()

  // Submit. Assert the PATCH request went out, returned 2xx, and
  // carried both the new name AND the expanded permissions array —
  // a regression that dropped permissions from the body would pass
  // the name-assertion but fail this one.
  const [updateResponse] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes(`/v1/admin/api-keys/${editKeyId}`) && r.request().method() === 'PATCH',
      { timeout: 10_000 },
    ),
    editDialog.getByRole('button', { name: /save changes/i }).click(),
  ])
  expect(updateResponse.status()).toBeGreaterThanOrEqual(200)
  expect(updateResponse.status()).toBeLessThan(300)
  const requestBody = updateResponse.request().postDataJSON() as {
    name: string
    permissions?: string[]
  }
  expect(requestBody.name).toBe(editKeyNewName)
  expect(requestBody.permissions, 'PATCH must include the updated permissions array').toContain(
    'budgets:write',
  )
  expect(requestBody.permissions).toContain('budgets:read')
  expect(requestBody.permissions).toContain('policies:read')

  // Dialog closes, list refreshes, row reflects the new name.
  await expect(editDialog).toBeHidden()
  await expect(page.getByRole('row').filter({ hasText: editKeyNewName })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('row').filter({ hasText: editKeyOriginalName })).toHaveCount(0)
})

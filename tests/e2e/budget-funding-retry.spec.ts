import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { ADMIN_KEY, loginAsAdmin } from './fixtures'

test('retrying a credit after a lost response funds the ledger once', async ({ page, request }) => {
  const tenantId = `funding-retry-${randomUUID()}`
  const scope = `tenant:${tenantId}`
  const unit = 'USD_MICROCENTS'
  const headers = { 'X-Admin-API-Key': ADMIN_KEY }
  const tenant = await request.post('/v1/admin/tenants', {
    headers, data: { tenant_id: tenantId, name: 'Funding retry test' },
  })
  expect(tenant.ok()).toBe(true)
  const budget = await request.post('/v1/admin/budgets', {
    headers,
    data: { tenant_id: tenantId, scope, unit, allocated: { unit, amount: 1000 } },
  })
  expect(budget.ok()).toBe(true)

  await loginAsAdmin(page)
  await page.goto(`/budgets?${new URLSearchParams({ scope, unit })}`)
  await page.getByRole('button', { name: 'Fund Budget' }).click()
  const dialog = page.getByRole('dialog', { name: 'Fund Budget' })
  await dialog.getByLabel(/Amount/).fill('100')

  const keys: string[] = []
  await page.route('**/v1/admin/budgets/fund?**', async route => {
    keys.push(route.request().postDataJSON().idempotency_key)
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    if (keys.length === 1) {
      // The service has committed. Only the browser loses the response.
      await route.abort('connectionreset')
    } else {
      await route.fulfill({ response })
    }
  })
  await dialog.getByRole('button', { name: 'Execute' }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await dialog.getByRole('button', { name: 'Execute' }).click()
  await expect(dialog).toBeHidden()

  expect(keys[0]).toBeTruthy()
  expect(keys).toEqual([keys[0], keys[0]])
  const ledger = await request.get('/v1/admin/budgets/lookup', { headers, params: { scope, unit } })
  expect(ledger.ok()).toBe(true)
  expect((await ledger.json()).allocated.amount).toBe(1100)
})

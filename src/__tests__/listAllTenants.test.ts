// listAllTenants — the tenant-directory cursor walk behind every tenant
// picker. A bare listTenants() returns the server's 50-row default
// page, which silently truncated the Budgets / API Keys / Webhooks /
// Reservations dropdowns on larger fleets.

import { describe, it, expect, vi } from 'vitest'
import { listAllTenants } from '../utils/listAllTenants'
import { CURSOR_WALK_MAX_PAGES } from '../utils/cursorWalk'
import type { Tenant } from '../types'

function tenant(id: string): Tenant {
  return { tenant_id: id, name: id, status: 'ACTIVE', created_at: '2026-01-01T00:00:00Z' }
}

describe('listAllTenants', () => {
  it('requests the max page size and follows next_cursor until has_more is false', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ tenants: [tenant('a')], has_more: true, next_cursor: 'c1' })
      .mockResolvedValueOnce({ tenants: [tenant('b')], has_more: false })
    const res = await listAllTenants(list)
    expect(res.tenants.map(t => t.tenant_id)).toEqual(['a', 'b'])
    expect(res.partial).toBe(false)
    expect(list).toHaveBeenNthCalledWith(1, { limit: '100' })
    expect(list).toHaveBeenNthCalledWith(2, { limit: '100', cursor: 'c1' })
  })

  it('reports partial when the fleet exceeds the page cap', async () => {
    const list = vi.fn().mockResolvedValue({ tenants: [tenant('x')], has_more: true, next_cursor: 'more' })
    const res = await listAllTenants(list)
    expect(list).toHaveBeenCalledTimes(CURSOR_WALK_MAX_PAGES)
    expect(res.partial).toBe(true)
  })

  it('tolerates a response with no has_more / next_cursor (single page)', async () => {
    const list = vi.fn().mockResolvedValue({ tenants: [tenant('only')] })
    const res = await listAllTenants(list)
    expect(res).toEqual({ tenants: [tenant('only')], partial: false })
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('propagates a list failure', async () => {
    const list = vi.fn().mockRejectedValue(new Error('down'))
    await expect(listAllTenants(list)).rejects.toThrow('down')
  })
})

// Full tenant directory for pickers and name lookups.
//
// listTenants defaults to 50 rows and clamps `limit` to 100, so a bare
// call silently truncates: tenant dropdowns stopped at 50 entries and
// ReservationsView rejected a valid `?tenant_id=` beyond the first page
// as "Unknown tenant id". Views that need the directory (not a page of
// it) walk the cursor instead.
//
// Capped by walkCursorPages (10 pages × 100 rows). `partial` is true
// when the fleet is larger than the cap, so callers can avoid treating
// "not in the list" as "does not exist".

import { listTenants as listTenantsDefault } from '../api/client'
import type { Tenant } from '../types'
import { walkCursorPages, LIST_PAGE_LIMIT } from './cursorWalk'

export interface TenantDirectory {
  tenants: Tenant[]
  partial: boolean
}

export async function listAllTenants(
  list: typeof listTenantsDefault = listTenantsDefault,
): Promise<TenantDirectory> {
  const walk = await walkCursorPages<Tenant>(async (cursor) => {
    const res = await list({ limit: String(LIST_PAGE_LIMIT), ...(cursor ? { cursor } : {}) })
    return { items: res.tenants, hasMore: !!res.has_more, nextCursor: res.next_cursor ?? '' }
  })
  return { tenants: walk.items, partial: walk.partial }
}

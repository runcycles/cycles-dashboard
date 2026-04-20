// Spec v0.1.25.29 CASCADE SEMANTICS: `CLOSED` is the one terminal tenant
// status. Rule 1 cascades owned objects into their own terminal states at
// close time; Rule 2 blocks any further mutation against them with 409
// TENANT_CLOSED. So for the dashboard, "owner is CLOSED" means
// "everything beneath it is read-only forever." This helper centralizes
// the predicate so every view agrees on what "terminal" means.

import type { Tenant } from '../types'

export const TERMINAL_TENANT_STATUSES = ['CLOSED'] as const

export function isTerminalTenant(t: Pick<Tenant, 'status'> | null | undefined): boolean {
  if (!t?.status) return false
  return (TERMINAL_TENANT_STATUSES as readonly string[]).includes(t.status)
}

// Spec v0.1.25.31 CASCADE SEMANTICS: `CLOSED` is the one terminal tenant
// status. Rule 1 cascades owned objects into their own terminal states at
// close time (budgets → CLOSED, webhooks → DISABLED, api-keys → REVOKED,
// open reservations → RELEASED); Rule 2 blocks any further mutation
// against them with 409 TENANT_CLOSED. So for the dashboard, "owner is
// CLOSED" means "everything beneath it is read-only forever." This helper
// centralizes the predicate so every view agrees on what "terminal" means.

import type { Tenant, BudgetLedger, WebhookSubscription, ApiKey } from '../types'

export const TERMINAL_TENANT_STATUSES = ['CLOSED'] as const

export function isTerminalTenant(t: Pick<Tenant, 'status'> | null | undefined): boolean {
  if (!t?.status) return false
  return (TERMINAL_TENANT_STATUSES as readonly string[]).includes(t.status)
}

// Per-child terminal states, spec v0.1.25.31 Rule 1. Open-enum
// contract: we match "is a known terminal value" rather than "is not
// a known non-terminal value" so future additive statuses default to
// "still pending" and keep the banner honest.
const TERMINAL_BUDGET_STATUSES = ['CLOSED'] as const
const TERMINAL_WEBHOOK_STATUSES = ['DISABLED'] as const
const TERMINAL_API_KEY_STATUSES = ['REVOKED', 'EXPIRED'] as const

export interface CascadeChildren {
  budgets: Pick<BudgetLedger, 'status'>[]
  webhooks: Pick<WebhookSubscription, 'status'>[]
  apiKeys: Pick<ApiKey, 'status'>[]
}

export interface CascadePendingCounts {
  budgets: number
  webhooks: number
  apiKeys: number
  total: number
}

export function cascadePendingCounts(children: CascadeChildren): CascadePendingCounts {
  const budgets = children.budgets.filter(b => !b.status || !(TERMINAL_BUDGET_STATUSES as readonly string[]).includes(b.status)).length
  const webhooks = children.webhooks.filter(w => !w.status || !(TERMINAL_WEBHOOK_STATUSES as readonly string[]).includes(w.status)).length
  const apiKeys = children.apiKeys.filter(k => !k.status || !(TERMINAL_API_KEY_STATUSES as readonly string[]).includes(k.status)).length
  return { budgets, webhooks, apiKeys, total: budgets + webhooks + apiKeys }
}

// Signal for the cascade-recovery banner: CLOSED tenant with at least
// one non-terminal child. Spec v0.1.25.31 Rule 1(c) convergence via
// operator re-issue.
export function cascadeIsIncomplete(
  tenant: Pick<Tenant, 'status'> | null | undefined,
  children: CascadeChildren,
): boolean {
  if (!isTerminalTenant(tenant)) return false
  return cascadePendingCounts(children).total > 0
}

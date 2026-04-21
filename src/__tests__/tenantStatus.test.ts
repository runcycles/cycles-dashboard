// Unit test for src/utils/tenantStatus.ts — the terminal-tenant
// predicate introduced for spec v0.1.25.29 CASCADE SEMANTICS, plus the
// cascadePendingCounts / cascadeIsIncomplete helpers added for the
// v0.1.25.44 cascade-recovery banner. Cheap to keep exhaustive: these
// helpers are load-bearing for the tombstone banner, the CLOSE
// cascade-preview dialog, the recovery banner, and any future caller
// that needs to answer "is this tenant a sink?" or "did the cascade
// finish?".

import { describe, it, expect } from 'vitest'
import {
  isTerminalTenant,
  TERMINAL_TENANT_STATUSES,
  cascadePendingCounts,
  cascadeIsIncomplete,
} from '../utils/tenantStatus'

describe('isTerminalTenant', () => {
  it('returns true for CLOSED (the one spec-terminal status)', () => {
    expect(isTerminalTenant({ status: 'CLOSED' })).toBe(true)
  })

  it('returns false for ACTIVE', () => {
    expect(isTerminalTenant({ status: 'ACTIVE' })).toBe(false)
  })

  it('returns false for SUSPENDED (reversible back to ACTIVE)', () => {
    expect(isTerminalTenant({ status: 'SUSPENDED' })).toBe(false)
  })

  it('returns false for null', () => {
    expect(isTerminalTenant(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isTerminalTenant(undefined)).toBe(false)
  })

  it('returns false when status is missing from the record', () => {
    expect(isTerminalTenant({} as { status: string })).toBe(false)
  })

  it('returns false for an unrecognized status string (forward-compat)', () => {
    expect(isTerminalTenant({ status: 'ARCHIVED' })).toBe(false)
  })
})

describe('TERMINAL_TENANT_STATUSES', () => {
  it('contains CLOSED', () => {
    expect(TERMINAL_TENANT_STATUSES).toContain('CLOSED')
  })

  it('has exactly one entry today (spec v0.1.25.29)', () => {
    expect(TERMINAL_TENANT_STATUSES).toHaveLength(1)
  })
})

// Empty-children fixture reused across cascade cases.
const empty = { budgets: [], webhooks: [], apiKeys: [] }

describe('cascadePendingCounts', () => {
  it('returns all zeros for no children', () => {
    expect(cascadePendingCounts(empty)).toEqual({ budgets: 0, webhooks: 0, apiKeys: 0, total: 0 })
  })

  it('counts ACTIVE + FROZEN budgets as pending; CLOSED as terminal', () => {
    const result = cascadePendingCounts({
      ...empty,
      budgets: [{ status: 'ACTIVE' }, { status: 'FROZEN' }, { status: 'CLOSED' }],
    })
    expect(result.budgets).toBe(2)
    expect(result.total).toBe(2)
  })

  it('counts ACTIVE + PAUSED webhooks as pending; DISABLED as terminal', () => {
    const result = cascadePendingCounts({
      ...empty,
      webhooks: [{ status: 'ACTIVE' }, { status: 'PAUSED' }, { status: 'DISABLED' }],
    })
    expect(result.webhooks).toBe(2)
    expect(result.total).toBe(2)
  })

  it('counts ACTIVE api-keys as pending; REVOKED + EXPIRED as terminal', () => {
    const result = cascadePendingCounts({
      ...empty,
      apiKeys: [{ status: 'ACTIVE' }, { status: 'REVOKED' }, { status: 'EXPIRED' }],
    })
    expect(result.apiKeys).toBe(1)
    expect(result.total).toBe(1)
  })

  it('sums pending across all three axes', () => {
    const result = cascadePendingCounts({
      budgets: [{ status: 'ACTIVE' }, { status: 'FROZEN' }, { status: 'CLOSED' }],
      webhooks: [{ status: 'PAUSED' }, { status: 'DISABLED' }],
      apiKeys: [{ status: 'ACTIVE' }],
    })
    expect(result).toEqual({ budgets: 2, webhooks: 1, apiKeys: 1, total: 4 })
  })

  it('treats unknown status strings as pending (forward-compat)', () => {
    const result = cascadePendingCounts({
      budgets: [{ status: 'ARCHIVED' } as { status: string }],
      webhooks: [],
      apiKeys: [],
    })
    expect(result.budgets).toBe(1)
  })

  it('treats missing status as pending (defensive)', () => {
    const result = cascadePendingCounts({
      budgets: [{} as { status: string }],
      webhooks: [{} as { status: string }],
      apiKeys: [{} as { status: string }],
    })
    expect(result.total).toBe(3)
  })
})

describe('cascadeIsIncomplete', () => {
  it('returns false for ACTIVE tenant regardless of children (banner only shows on CLOSED)', () => {
    expect(
      cascadeIsIncomplete(
        { status: 'ACTIVE' },
        { budgets: [{ status: 'FROZEN' }], webhooks: [], apiKeys: [] },
      ),
    ).toBe(false)
  })

  it('returns false for CLOSED tenant with all children terminal', () => {
    expect(
      cascadeIsIncomplete(
        { status: 'CLOSED' },
        {
          budgets: [{ status: 'CLOSED' }],
          webhooks: [{ status: 'DISABLED' }],
          apiKeys: [{ status: 'REVOKED' }],
        },
      ),
    ).toBe(false)
  })

  it('returns true for CLOSED tenant with a pending budget', () => {
    expect(
      cascadeIsIncomplete(
        { status: 'CLOSED' },
        { budgets: [{ status: 'FROZEN' }], webhooks: [], apiKeys: [] },
      ),
    ).toBe(true)
  })

  it('returns true for CLOSED tenant with a pending webhook', () => {
    expect(
      cascadeIsIncomplete(
        { status: 'CLOSED' },
        { budgets: [], webhooks: [{ status: 'ACTIVE' }], apiKeys: [] },
      ),
    ).toBe(true)
  })

  it('returns true for CLOSED tenant with a pending api-key', () => {
    expect(
      cascadeIsIncomplete(
        { status: 'CLOSED' },
        { budgets: [], webhooks: [], apiKeys: [{ status: 'ACTIVE' }] },
      ),
    ).toBe(true)
  })

  it('returns false for null tenant', () => {
    expect(cascadeIsIncomplete(null, empty)).toBe(false)
  })

  it('returns false for CLOSED tenant with empty children (clean cascade)', () => {
    expect(cascadeIsIncomplete({ status: 'CLOSED' }, empty)).toBe(false)
  })
})

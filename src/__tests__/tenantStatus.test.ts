// Unit test for src/utils/tenantStatus.ts — the terminal-tenant
// predicate introduced for spec v0.1.25.29 CASCADE SEMANTICS. Cheap to
// keep exhaustive: the helper is load-bearing for the tombstone banner,
// the CLOSE cascade-preview dialog, and any future caller that needs to
// answer "is this tenant a sink?".

import { describe, it, expect } from 'vitest'
import { isTerminalTenant, TERMINAL_TENANT_STATUSES } from '../utils/tenantStatus'

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

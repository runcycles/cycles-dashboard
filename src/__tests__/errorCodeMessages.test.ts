// Unit test for src/utils/errorCodeMessages.ts. Covers the two
// surfaces: per-row formatErrorCode() and request-level
// formatBulkRequestError(). Forward-compat is the load-bearing
// invariant — unknown codes must NEVER throw and MUST include the
// code in the returned string so operators can triage.

import { describe, it, expect } from 'vitest'
import { formatErrorCode, formatBulkRequestError } from '../utils/errorCodeMessages'

describe('formatErrorCode — per-row', () => {
  it('BUDGET_EXCEEDED without message renders a canonical string', () => {
    expect(formatErrorCode('BUDGET_EXCEEDED')).toBe('Budget exceeded (insufficient remaining balance).')
  })

  it('BUDGET_EXCEEDED with server-provided message appends the detail', () => {
    expect(formatErrorCode('BUDGET_EXCEEDED', 'requested 100, remaining 42')).toBe(
      'Budget exceeded — requested 100, remaining 42',
    )
  })

  it('INVALID_TRANSITION without message renders a canonical string', () => {
    expect(formatErrorCode('INVALID_TRANSITION')).toBe('Invalid state for this action.')
  })

  it('INVALID_TRANSITION with message appends the detail', () => {
    expect(formatErrorCode('INVALID_TRANSITION', 'tenant is SUSPENDED')).toBe(
      'Invalid state for this action — tenant is SUSPENDED',
    )
  })

  it('INTERNAL_ERROR without message falls back to a retry hint', () => {
    expect(formatErrorCode('INTERNAL_ERROR')).toBe('Server error — retry or contact support.')
  })

  it('INTERNAL_ERROR with message surfaces the server prose', () => {
    expect(formatErrorCode('INTERNAL_ERROR', 'downstream timeout')).toBe(
      'Server error — downstream timeout',
    )
  })

  // Rule 2 of spec v0.1.25.29 CASCADE SEMANTICS — the race path when a
  // stale tab attempts to mutate an object whose owning tenant was just
  // closed. The canonical prose must frame the ownership relationship so
  // operators don't think the specific row is broken.
  it('TENANT_CLOSED without message renders the canonical read-only prose', () => {
    expect(formatErrorCode('TENANT_CLOSED')).toBe('Tenant is closed — this object is read-only.')
  })

  it('TENANT_CLOSED with message parenthesizes server detail', () => {
    expect(formatErrorCode('TENANT_CLOSED', 'tenant tenant-42 closed at 2026-04-20T10:12:00Z')).toBe(
      'Tenant is closed — this object is read-only (tenant tenant-42 closed at 2026-04-20T10:12:00Z)',
    )
  })

  // Forward-compat: a code the catalogue has never seen (e.g. a future
  // spec addition) must render as `code: message` so operators see the
  // new code verbatim and can paste it into audit filters.
  it('unknown code with message renders as "code: message"', () => {
    expect(formatErrorCode('FUTURE_CODE', 'new spec field is bogus')).toBe(
      'FUTURE_CODE: new spec field is bogus',
    )
  })

  it('unknown code without message renders the bare code', () => {
    expect(formatErrorCode('FUTURE_CODE')).toBe('FUTURE_CODE')
  })

  it('unknown code with whitespace-only message renders the bare code', () => {
    expect(formatErrorCode('FUTURE_CODE', '   ')).toBe('FUTURE_CODE')
  })

  it('empty code falls back to the message', () => {
    expect(formatErrorCode(undefined, 'something went wrong')).toBe('something went wrong')
  })

  it('empty code with empty message falls back to "Unknown error"', () => {
    expect(formatErrorCode(undefined)).toBe('Unknown error')
    expect(formatErrorCode('', '')).toBe('Unknown error')
  })

  it('does not throw on arbitrary code strings (safety)', () => {
    expect(() => formatErrorCode('!!!~#$%')).not.toThrow()
    expect(() => formatErrorCode('\n\t')).not.toThrow()
  })
})

describe('formatBulkRequestError — request-level', () => {
  it('LIMIT_EXCEEDED without details renders the narrow-the-filter copy', () => {
    expect(formatBulkRequestError('LIMIT_EXCEEDED', 'tenants')).toBe(
      'Filter matches more than 500 tenants — narrow the filter before retrying.',
    )
  })

  it('LIMIT_EXCEEDED embeds total_matched when server echoes it', () => {
    expect(formatBulkRequestError('LIMIT_EXCEEDED', 'webhooks', 500, { total_matched: 1234 })).toBe(
      'Filter matches more than 500 webhooks (server matched 1,234) — narrow the filter before retrying.',
    )
  })

  it('LIMIT_EXCEEDED honours serverMaxPerRequest override', () => {
    expect(formatBulkRequestError('LIMIT_EXCEEDED', 'budgets', 100)).toBe(
      'Filter matches more than 100 budgets — narrow the filter before retrying.',
    )
  })

  it('COUNT_MISMATCH renders a capitalized-plural drift explainer', () => {
    expect(formatBulkRequestError('COUNT_MISMATCH', 'tenants')).toBe(
      'Tenants list changed between preview and submit — close and reopen the preview to retry.',
    )
    expect(formatBulkRequestError('COUNT_MISMATCH', 'budgets')).toBe(
      'Budgets list changed between preview and submit — close and reopen the preview to retry.',
    )
  })

  it('returns null for non-bulk-safety codes (caller falls back to toMessage)', () => {
    expect(formatBulkRequestError('INTERNAL_ERROR', 'tenants')).toBeNull()
    expect(formatBulkRequestError('VALIDATION_FAILED', 'tenants')).toBeNull()
    expect(formatBulkRequestError(undefined, 'tenants')).toBeNull()
  })

  it('ignores non-numeric total_matched in details', () => {
    expect(formatBulkRequestError('LIMIT_EXCEEDED', 'tenants', 500, { total_matched: 'many' })).toBe(
      'Filter matches more than 500 tenants — narrow the filter before retrying.',
    )
  })
})

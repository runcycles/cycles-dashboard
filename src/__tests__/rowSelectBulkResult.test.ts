import { describe, it, expect } from 'vitest'
import { synthesizeRowSelectBulkResult } from '../utils/rowSelectBulkResult'
import { ApiError } from '../api/client'
import type { BatchResult } from '../utils/rateLimitedBatch'

// v0.1.25.37 (slice B): rateLimitedBatch-based row-select bulk paths
// (TenantsView, WebhooksView, BudgetsView, TenantDetailView emergency
// freeze) convert {done, failed, cancelled, errors} into a
// BulkActionResultDialog-compatible response via this synthesizer.

describe('synthesizeRowSelectBulkResult', () => {
  const tenants = [
    { tenant_id: 'acme' },
    { tenant_id: 'globex' },
    { tenant_id: 'initech' },
  ]
  const idOf = (t: { tenant_id: string }) => t.tenant_id

  it('enumerates all targets as succeeded when none failed', () => {
    const result: BatchResult = {
      done: 3, failed: 0, cancelled: false, errors: [],
    }
    const out = synthesizeRowSelectBulkResult({
      targets: tenants, result, succeededIndices: [0, 1, 2], idOf,
    })
    expect(out.succeeded.map(s => s.id)).toEqual(['acme', 'globex', 'initech'])
    expect(out.failed).toEqual([])
    expect(out.skipped).toEqual([])
    expect(out.total_matched).toBe(3)
  })

  it('maps errors[].index into failed[] with id + error_code + message', () => {
    const apiErr = new ApiError(409, 'boom', 'BUDGET_EXCEEDED')
    const result: BatchResult = {
      done: 3, failed: 1, cancelled: false,
      errors: [{ index: 1, error: apiErr }],
    }
    const out = synthesizeRowSelectBulkResult({
      targets: tenants, result, succeededIndices: [0, 2], idOf,
    })
    expect(out.succeeded.map(s => s.id)).toEqual(['acme', 'initech'])
    expect(out.failed).toEqual([
      { id: 'globex', error_code: 'BUDGET_EXCEEDED', message: 'boom' },
    ])
    expect(out.skipped).toEqual([])
  })

  it('uses plain toMessage for non-ApiError failures and leaves error_code undefined', () => {
    const result: BatchResult = {
      done: 2, failed: 1, cancelled: false,
      errors: [{ index: 0, error: new Error('network blip') }],
    }
    const out = synthesizeRowSelectBulkResult({
      targets: tenants.slice(0, 2), result, succeededIndices: [1], idOf,
    })
    expect(out.failed).toEqual([
      { id: 'acme', error_code: undefined, message: 'network blip' },
    ])
  })

  it('marks unreached targets as skipped when the batch was cancelled', () => {
    // Operator cancelled mid-run — only tenants[0] settled successfully,
    // tenants[1] + [2] never started.
    const result: BatchResult = {
      done: 1, failed: 0, cancelled: true, errors: [],
    }
    const out = synthesizeRowSelectBulkResult({
      targets: tenants, result, succeededIndices: [0], idOf,
    })
    expect(out.succeeded.map(s => s.id)).toEqual(['acme'])
    expect(out.skipped).toEqual([
      { id: 'globex', reason: 'Not reached (operation cancelled)' },
      { id: 'initech', reason: 'Not reached (operation cancelled)' },
    ])
    expect(out.failed).toEqual([])
  })

  it('when cancelled with a mix of outcomes, partitions cleanly across three arrays', () => {
    // tenants[0] succeeded, tenants[1] failed, tenants[2] unreached.
    const apiErr = new ApiError(500, 'nope', 'INTERNAL_ERROR')
    const result: BatchResult = {
      done: 2, failed: 1, cancelled: true,
      errors: [{ index: 1, error: apiErr }],
    }
    const out = synthesizeRowSelectBulkResult({
      targets: tenants, result, succeededIndices: [0], idOf,
    })
    expect(out.succeeded.map(s => s.id)).toEqual(['acme'])
    expect(out.failed).toEqual([
      { id: 'globex', error_code: 'INTERNAL_ERROR', message: 'nope' },
    ])
    expect(out.skipped).toEqual([
      { id: 'initech', reason: 'Not reached (operation cancelled)' },
    ])
  })

  it('total_matched is always the input target count, not done', () => {
    const result: BatchResult = {
      done: 1, failed: 0, cancelled: true, errors: [],
    }
    const out = synthesizeRowSelectBulkResult({
      targets: tenants, result, succeededIndices: [0], idOf,
    })
    expect(out.total_matched).toBe(3)
  })
})

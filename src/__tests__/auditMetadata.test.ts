// Unit tests for the bulk-action audit metadata shape guard. Shared by
// AuditView's conditional render and BulkActionAuditDetail's no-op
// fallback, so mis-classification would either hide the new v0.1.25.30
// renderer OR crash on pre-.30 entries that lack the enriched keys.

import { describe, it, expect } from 'vitest'
import {
  BULK_ACTION_OPERATIONS,
  hasBulkAuditShape,
  isBulkActionOperation,
} from '../utils/auditMetadata'

describe('isBulkActionOperation', () => {
  it('recognizes the three cycles-governance-admin bulk ops', () => {
    for (const op of BULK_ACTION_OPERATIONS) {
      expect(isBulkActionOperation(op)).toBe(true)
    }
  })

  it('rejects non-bulk operations, empty, and undefined', () => {
    expect(isBulkActionOperation('createBudget')).toBe(false)
    expect(isBulkActionOperation('')).toBe(false)
    expect(isBulkActionOperation(undefined)).toBe(false)
  })
})

describe('hasBulkAuditShape', () => {
  it('returns false for non-bulk operations regardless of metadata', () => {
    expect(hasBulkAuditShape('createTenant', { succeeded_ids: ['x'] })).toBe(false)
  })

  it('returns false when metadata is missing or not an object', () => {
    expect(hasBulkAuditShape('bulkActionBudgets', null)).toBe(false)
    expect(hasBulkAuditShape('bulkActionBudgets', undefined)).toBe(false)
  })

  it('returns true when succeeded_ids is present', () => {
    expect(hasBulkAuditShape('bulkActionTenants', { succeeded_ids: [] })).toBe(true)
  })

  it('returns true when failed_rows or skipped_rows is present', () => {
    expect(hasBulkAuditShape('bulkActionWebhooks', { failed_rows: [] })).toBe(true)
    expect(hasBulkAuditShape('bulkActionWebhooks', { skipped_rows: [] })).toBe(true)
  })

  it('returns true when filter object is present', () => {
    expect(hasBulkAuditShape('bulkActionBudgets', { filter: { tenant_id: 'acme' } })).toBe(true)
  })

  it('returns true when duration_ms is present', () => {
    expect(hasBulkAuditShape('bulkActionBudgets', { duration_ms: 1234 })).toBe(true)
  })

  it('returns false when none of the five keys are present (pre-.30 shape)', () => {
    expect(hasBulkAuditShape('bulkActionBudgets', { actor_type: 'ADMIN_ON_BEHALF_OF' })).toBe(false)
  })

  it('rejects a filter that is an array (guards against spec mis-read)', () => {
    expect(hasBulkAuditShape('bulkActionBudgets', { filter: [] })).toBe(false)
  })
})

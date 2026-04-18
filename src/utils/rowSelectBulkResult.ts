import { ApiError } from '../api/client'
import { toMessage } from './errors'
import type { BulkActionRowOutcome } from '../types'
import type { BatchResult } from './rateLimitedBatch'

// Converts the rateLimitedBatch {done, failed, cancelled, errors[]} result
// — the shape returned by the row-select bulk paths in TenantsView /
// WebhooksView / BudgetsView / TenantDetailView — into the
// BulkActionResultDialog-compatible response shape.
//
// Pre-fix, each of those four paths dropped err.error to console.warn
// and rendered a "N failed — check console for details" toast. Operators
// had no in-dashboard view of which row failed or why. This synthesizer
// lets the row-select paths reuse the same BulkActionResultDialog that
// the filter-apply paths already render, with per-row error_code +
// message + Copy ID + Save JSON affordances.
//
// The caller provides the settled-succeeded indices (captured by pushing
// from inside the worker on success) so the non-cancelled path can
// enumerate succeeded rows and the cancelled path can mark unreached
// rows as skipped.

export interface RowSelectBulkResponse {
  succeeded: BulkActionRowOutcome[]
  failed: BulkActionRowOutcome[]
  skipped: BulkActionRowOutcome[]
  total_matched: number
}

export function synthesizeRowSelectBulkResult<T>(args: {
  targets: readonly T[]
  result: BatchResult
  succeededIndices: readonly number[]
  idOf: (t: T) => string
}): RowSelectBulkResponse {
  const { targets, result, succeededIndices, idOf } = args
  const succeededSet = new Set(succeededIndices)
  const errorIndexSet = new Set(result.errors.map(e => e.index))

  const succeeded: BulkActionRowOutcome[] = []
  for (const i of succeededIndices) {
    succeeded.push({ id: idOf(targets[i]) })
  }

  const failed: BulkActionRowOutcome[] = result.errors.map(err => {
    const code = err.error instanceof ApiError ? err.error.errorCode : undefined
    return {
      id: idOf(targets[err.index]),
      error_code: code,
      message: toMessage(err.error),
    }
  })

  // Cancelled runs leave some targets unreached — neither settled-success
  // nor settled-failure. Surface them as skipped with a clear reason so
  // the operator can retry just that tail.
  const skipped: BulkActionRowOutcome[] = []
  if (result.cancelled) {
    for (let i = 0; i < targets.length; i++) {
      if (!succeededSet.has(i) && !errorIndexSet.has(i)) {
        skipped.push({
          id: idOf(targets[i]),
          reason: 'Not reached (operation cancelled)',
        })
      }
    }
  }

  return {
    succeeded,
    failed,
    skipped,
    total_matched: targets.length,
  }
}

import { describe, expect, it } from 'vitest'
import { useAppliedQuery } from '../composables/useAppliedQuery'

describe('useAppliedQuery', () => {
  it('returns immutable applied snapshots and advances the epoch only for filter transitions', () => {
    const ownership = useAppliedQuery({ status: 'ACTIVE' })
    const initial = ownership.snapshotApplied()

    expect(Object.isFrozen(initial)).toBe(true)
    expect(Object.isFrozen(initial.params)).toBe(true)
    expect(initial).toEqual({ epoch: 0, params: { status: 'ACTIVE' } })

    ownership.beginPageOne()
    ownership.beginPageOne()
    ownership.invalidateAppliedSignature()
    expect(ownership.filterEpoch.value).toBe(0)

    const next = ownership.startFilterTransition({ status: 'PAUSED' })!
    expect(next.epoch).toBe(1)
    expect(ownership.appliedParams.value).toEqual({ status: 'PAUSED' })
  })

  it('lets only the newest page-one request commit without invalidating cursor snapshots', () => {
    const ownership = useAppliedQuery({ search: 'same-filter' })
    const cursorWalk = ownership.snapshotApplied()
    const older = ownership.beginPageOne()
    const newer = ownership.beginPageOne()

    expect(ownership.ownsPageOne(older)).toBe(false)
    expect(ownership.ownsPageOne(newer)).toBe(true)
    expect(ownership.ownsFilterSnapshot(cursorWalk)).toBe(true)
  })

  it('invalidates page-one and cursor work when filters change', () => {
    const ownership = useAppliedQuery({ tenant_id: 'old' })
    const cursorWalk = ownership.snapshotApplied()
    const pageOne = ownership.beginPageOne()

    ownership.startFilterTransition({ tenant_id: 'new' })

    expect(ownership.ownsPageOne(pageOne)).toBe(false)
    expect(ownership.ownsFilterSnapshot(cursorWalk)).toBe(false)
  })

  it('supports success-time commit for explicit-submit views', () => {
    const ownership = useAppliedQuery({ tenant_id: 'old' })
    const transition = ownership.startFilterTransition(
      { tenant_id: 'candidate' },
      { force: true, commit: 'success' },
    )!

    expect(ownership.appliedParams.value).toEqual({ tenant_id: 'old' })
    expect(ownership.commitFilterTransition(transition)).toBe(true)
    expect(ownership.appliedParams.value).toEqual({ tenant_id: 'candidate' })

    const stale = ownership.startFilterTransition(
      { tenant_id: 'stale' },
      { force: true, commit: 'success' },
    )!
    ownership.startFilterTransition({ tenant_id: 'newest' }, { force: true })
    expect(ownership.commitFilterTransition(stale)).toBe(false)
    expect(ownership.appliedParams.value).toEqual({ tenant_id: 'newest' })
  })

  it('deduplicates watcher echoes but permits explicit and post-failure retries', () => {
    const ownership = useAppliedQuery()

    expect(ownership.startFilterTransition({ search: 'budget' })).not.toBeNull()
    expect(ownership.startFilterTransition({ search: 'budget' })).toBeNull()
    expect(ownership.filterEpoch.value).toBe(1)

    expect(ownership.startFilterTransition({ search: 'budget' }, { force: true })).not.toBeNull()
    expect(ownership.filterEpoch.value).toBe(2)

    ownership.invalidateAppliedSignature()
    expect(ownership.startFilterTransition({ search: 'budget' })).not.toBeNull()
    expect(ownership.filterEpoch.value).toBe(3)
  })
})

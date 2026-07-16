import { readonly, ref } from 'vue'

export type AppliedQueryParams = Readonly<Record<string, string>>

export interface AppliedQuerySnapshot {
  readonly epoch: number
  readonly params: AppliedQueryParams
}

export interface PageOneRequest extends AppliedQuerySnapshot {
  readonly sequence: number
}

export interface StartFilterTransitionOptions {
  /** Explicit submits must be able to retry an unchanged query. */
  force?: boolean
  /**
   * Instant-apply views commit before page one loads; explicit-submit views
   * keep the prior applied tuple until the candidate page succeeds.
   */
  commit?: 'start' | 'success'
}

function freezeParams(params: AppliedQueryParams): AppliedQueryParams {
  return Object.freeze({ ...params })
}

function snapshot(epoch: number, params: AppliedQueryParams): AppliedQuerySnapshot {
  return Object.freeze({ epoch, params: freezeParams(params) })
}

/**
 * Owns the two generations shared by cursor-backed list views:
 *
 * - `filterEpoch` changes only when a filter/sort tuple is deliberately
 *   applied. A routine page-one poll (successful or failed) never invalidates
 *   a same-filter Load-more or export walk.
 * - `pageOneSequence` changes for every page-one request. Only the newest
 *   request may commit rows, cursors, loading state, or errors.
 *
 * Snapshots are shallow-frozen because query params are string primitives.
 * Callers should capture one snapshot for an entire cursor operation and use
 * `ownsFilterSnapshot` after each await before committing its response.
 */
export function useAppliedQuery(initialParams: AppliedQueryParams = {}) {
  const appliedParams = ref<AppliedQueryParams>(freezeParams(initialParams))
  const filterEpoch = ref(0)
  let pageOneSequence = 0
  let lastAppliedSignature: string | null = null

  function startFilterTransition(
    params: AppliedQueryParams,
    options: StartFilterTransitionOptions = {},
  ): AppliedQuerySnapshot | null {
    const frozen = freezeParams(params)
    const signature = JSON.stringify(frozen)
    if (!options.force && signature === lastAppliedSignature) return null

    lastAppliedSignature = signature
    const transition = snapshot(++filterEpoch.value, frozen)
    if ((options.commit ?? 'start') === 'start') {
      appliedParams.value = transition.params
    }
    return transition
  }

  function commitFilterTransition(transition: AppliedQuerySnapshot): boolean {
    if (!ownsFilterSnapshot(transition)) return false
    appliedParams.value = transition.params
    return true
  }

  function snapshotApplied(): AppliedQuerySnapshot {
    return snapshot(filterEpoch.value, appliedParams.value)
  }

  function ownsFilterSnapshot(candidate: AppliedQuerySnapshot): boolean {
    return candidate.epoch === filterEpoch.value
  }

  function beginPageOne(candidate: AppliedQuerySnapshot = snapshotApplied()): PageOneRequest {
    return Object.freeze({
      sequence: ++pageOneSequence,
      epoch: candidate.epoch,
      params: candidate.params,
    })
  }

  function ownsPageOne(request: PageOneRequest): boolean {
    return request.sequence === pageOneSequence && ownsFilterSnapshot(request)
  }

  function invalidateAppliedSignature(): void {
    lastAppliedSignature = null
  }

  return {
    appliedParams: readonly(appliedParams),
    filterEpoch: readonly(filterEpoch),
    startFilterTransition,
    commitFilterTransition,
    snapshotApplied,
    ownsFilterSnapshot,
    beginPageOne,
    ownsPageOne,
    invalidateAppliedSignature,
  }
}

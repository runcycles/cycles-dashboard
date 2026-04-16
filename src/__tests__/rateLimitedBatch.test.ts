// W4 (scale-hardening): bounded-concurrency batch runner with
// 429-aware retry. These tests cover the four load-bearing contracts:
//   1. Concurrency is actually bounded (not sequential, not unbounded)
//   2. 429 errors retry with exponential backoff up to maxRetries
//   3. Non-429 errors fail the item immediately (no retry)
//   4. AbortSignal halts further task dispatch (in-flight completes)

import { describe, it, expect, vi } from 'vitest'
import { rateLimitedBatch } from '../utils/rateLimitedBatch'
import { ApiError } from '../api/client'

function apiError(status: number): ApiError {
  return new ApiError(status, `HTTP ${status}`)
}

// Deterministic sleep using vi.useFakeTimers is awkward here because
// the worker-pool loop awaits Promise.all, and advancing timers mid-
// Promise coordination gets finicky. Instead we accept small real
// sleeps (~10-50ms) for the tests that exercise backoff; tests that
// don't need backoff finish instantly.

describe('rateLimitedBatch', () => {
  it('processes every item and reports done count', async () => {
    const items = [1, 2, 3, 4, 5]
    const seen: number[] = []
    const res = await rateLimitedBatch(items, async (n) => {
      seen.push(n)
    })
    expect(res.done).toBe(5)
    expect(res.failed).toBe(0)
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5])
  })

  it('bounds in-flight concurrency to the concurrency option', async () => {
    // Use release-on-demand promises to observe concurrency directly:
    // start 6 items with concurrency=2; exactly 2 should be in-flight
    // at any moment.
    let inFlight = 0
    let maxInFlight = 0
    const resolvers: Array<() => void> = []
    const pending: Array<Promise<void>> = []

    const batchPromise = rateLimitedBatch([1, 2, 3, 4, 5, 6], async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      const p = new Promise<void>((resolve) => { resolvers.push(resolve) })
      pending.push(p)
      await p
      inFlight--
    }, { concurrency: 2 })

    // Let microtasks settle so the first 2 workers have entered the body.
    await Promise.resolve()
    await Promise.resolve()
    expect(maxInFlight).toBeLessThanOrEqual(2)

    // Release all in order — the pool pulls the next item as each slot frees.
    while (resolvers.length > 0) {
      const r = resolvers.shift()!
      r()
      await Promise.resolve()
      await Promise.resolve()
    }
    const res = await batchPromise
    expect(res.done).toBe(6)
    expect(maxInFlight).toBe(2)
  })

  it('retries 429 errors with backoff and eventually succeeds', async () => {
    let attempt = 0
    const res = await rateLimitedBatch(['only'], async () => {
      attempt++
      if (attempt < 3) throw apiError(429)
      // Third attempt succeeds.
    }, { baseDelayMs: 1, maxRetries: 3 })
    expect(attempt).toBe(3)
    expect(res.done).toBe(1)
    expect(res.failed).toBe(0)
  })

  it('gives up after maxRetries 429s and counts the item as failed', async () => {
    let attempts = 0
    const res = await rateLimitedBatch(['only'], async () => {
      attempts++
      throw apiError(429)
    }, { baseDelayMs: 1, maxRetries: 2 })
    // maxRetries=2 → initial + 2 retries = 3 total attempts.
    expect(attempts).toBe(3)
    expect(res.done).toBe(1)
    expect(res.failed).toBe(1)
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0].index).toBe(0)
    expect((res.errors[0].error as ApiError).status).toBe(429)
  })

  it('does NOT retry non-429 errors (fails immediately)', async () => {
    let attempts = 0
    const res = await rateLimitedBatch(['only'], async () => {
      attempts++
      throw apiError(500) // server error, not rate limit
    }, { baseDelayMs: 1, maxRetries: 5 })
    expect(attempts).toBe(1)
    expect(res.failed).toBe(1)
  })

  it('reports failed items via the errors array without blocking progress', async () => {
    const res = await rateLimitedBatch(['a', 'b', 'c', 'd'], async (item) => {
      if (item === 'b') throw new Error('kaboom')
    })
    expect(res.done).toBe(4)
    expect(res.failed).toBe(1)
    expect(res.errors).toHaveLength(1)
    expect((res.errors[0].error as Error).message).toBe('kaboom')
  })

  it('onProgress fires after each item settles', async () => {
    const calls: Array<[number, number, number]> = []
    await rateLimitedBatch([1, 2, 3], async () => {}, {
      onProgress: (done, total, failed) => calls.push([done, total, failed]),
    })
    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual([1, 3, 0])
    expect(calls[2]).toEqual([3, 3, 0])
  })

  it('halts further task dispatch when the signal aborts', async () => {
    // 10 items, concurrency 1 (sequential), each sleeping 20ms.
    // Abort after ~25ms — first 1-2 complete, rest skipped.
    const controller = new AbortController()
    let processed = 0
    const p = rateLimitedBatch(Array.from({ length: 10 }, (_, i) => i), async () => {
      processed++
      await new Promise(r => setTimeout(r, 20))
    }, { concurrency: 1, signal: controller.signal })
    setTimeout(() => controller.abort(), 25)
    const res = await p
    expect(res.cancelled).toBe(true)
    // We should have processed fewer than all 10 — exact count depends
    // on machine timing, but verifying bound is the point.
    expect(processed).toBeLessThan(10)
  })

  it('aborts out of a 429 backoff sleep without waiting for it to expire', async () => {
    // The sleep between 429 retries must settle immediately on abort,
    // otherwise cancelling a bulk op during a long backoff would leave
    // the user staring at "Working…" for seconds. Set baseDelayMs high
    // enough that a naive setTimeout-only sleep would blow past the
    // test timeout; assert the whole run returns in well under that
    // delay once we abort.
    const controller = new AbortController()
    const start = Date.now()
    const p = rateLimitedBatch(['only'], async () => {
      // Always 429 — without abort this would wait the full backoff.
      throw apiError(429)
    }, {
      baseDelayMs: 5000,  // 5s — far longer than we're willing to wait
      maxRetries: 5,
      signal: controller.signal,
    })
    // Let the first attempt fail + the backoff sleep begin, then abort.
    setTimeout(() => controller.abort(), 20)
    const res = await p
    const elapsed = Date.now() - start
    expect(res.cancelled).toBe(true)
    // Must have returned well before the 5s backoff would have expired.
    expect(elapsed).toBeLessThan(1000)
  })

  it('aborting before start returns immediately with cancelled=true', async () => {
    // Defensive: if the caller passes an already-aborted signal, the
    // runner must exit on the first worker-pool iteration rather than
    // starting any work.
    const controller = new AbortController()
    controller.abort()
    let ran = 0
    const res = await rateLimitedBatch([1, 2, 3], async () => { ran++ }, {
      signal: controller.signal,
    })
    expect(res.cancelled).toBe(true)
    expect(ran).toBe(0)
  })
})

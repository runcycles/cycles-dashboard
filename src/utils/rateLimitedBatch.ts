import { ApiError } from '../api/client'

/**
 * Runs `worker` across `items` with bounded concurrency and 429-aware
 * exponential backoff. Used by bulk operations (TenantsView suspend/
 * reactivate, WebhooksView pause/enable) so a burst of writes against
 * the admin tier doesn't trip rate limits.
 *
 * ## Concurrency
 * A small worker pool (default 4) pulls the next unclaimed index as
 * each slot settles — NOT fixed-size batches. This keeps the in-flight
 * count near the cap even when individual requests vary in latency.
 *
 * ## 429 backoff
 * If `worker` throws an `ApiError` with status 429, the utility waits
 * `baseDelayMs * 2^attempt + jitter` and retries up to `maxRetries`
 * times. Other errors fail the item immediately (no retry). Jitter is
 * ±50% so multiple items hitting a 429 don't retry in lockstep.
 *
 * ## Cancellation
 * Pass an `AbortSignal` and the loop returns at the next worker-pool
 * iteration boundary. In-flight `worker()` promises run to completion;
 * only UNSTARTED items are skipped. This matches the user's expected
 * "cancel bulk op" semantics — half-finished writes aren't rolled back.
 *
 * ## Progress
 * `onProgress(done, total, failed)` fires after each item settles.
 * Callers typically forward it into a Vue ref that drives a progress
 * dialog.
 *
 * ## Return value
 * `{ done, failed, cancelled, errors }`. `done` counts every settled
 * item (success + failed + cancelled). `errors` is an array of
 * `{ index, error }` for every non-429 failure (so the calling view
 * can log / surface specifics without needing to pipe through its own
 * error accumulator).
 */

export interface BatchOptions {
  /** Max in-flight workers. Default 4 — well under Chrome's per-host 6-connection cap. */
  concurrency?: number
  /** Max retry attempts on 429. Default 3 (so 4 total attempts per item). */
  maxRetries?: number
  /** Base delay for the first 429 backoff. Default 500ms. */
  baseDelayMs?: number
  /** Abort when this signal fires. In-flight workers still settle. */
  signal?: AbortSignal
  /** Fires after each item settles. */
  onProgress?: (done: number, total: number, failed: number) => void
}

export interface BatchError {
  index: number
  error: unknown
}

export interface BatchResult {
  done: number
  failed: number
  cancelled: boolean
  errors: BatchError[]
}

function isRateLimitError(e: unknown): boolean {
  return e instanceof ApiError && e.status === 429
}

// Sleep that settles immediately on abort rather than hanging until
// the timer fires. Used by the 429 backoff loop so a cancel doesn't
// wait for a multi-second retry delay.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function rateLimitedBatch<T>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<void>,
  opts: BatchOptions = {},
): Promise<BatchResult> {
  const concurrency = opts.concurrency ?? 4
  const maxRetries = opts.maxRetries ?? 3
  const baseDelay = opts.baseDelayMs ?? 500
  const signal = opts.signal
  const total = items.length

  let done = 0
  let failed = 0
  const errors: BatchError[] = []
  let cancelled = false
  let nextIndex = 0

  async function runOneWithRetry(index: number): Promise<void> {
    const item = items[index]
    let attempt = 0
    while (true) {
      if (signal?.aborted) throw new Error('aborted')
      try {
        await worker(item, index)
        return
      } catch (e) {
        if (isRateLimitError(e) && attempt < maxRetries) {
          // Exponential backoff with ±50% jitter. Adding jitter prevents
          // a cohort of 4 concurrent requests all retrying in lockstep,
          // which would re-trip the same rate limit together.
          const base = baseDelay * Math.pow(2, attempt)
          const jittered = base * (0.5 + Math.random())
          try {
            await sleep(jittered, signal)
          } catch {
            throw new Error('aborted')
          }
          attempt++
          continue
        }
        throw e
      }
    }
  }

  async function pumpWorker(): Promise<void> {
    while (true) {
      if (signal?.aborted) { cancelled = true; return }
      const index = nextIndex++
      if (index >= total) return
      try {
        await runOneWithRetry(index)
        done++
      } catch (e) {
        // Aborts are NOT failures — don't increment done/failed. The
        // item simply never completed. onProgress stays at its pre-
        // abort value, so operators see an honest "N/M processed"
        // count in the summary rather than a misleading N/N count.
        if (e instanceof Error && e.message === 'aborted') {
          cancelled = true
          return
        }
        done++
        failed++
        errors.push({ index, error: e })
      }
      opts.onProgress?.(done, total, failed)
    }
  }

  // Spin up min(concurrency, total) pump workers — each pulls the
  // next unclaimed index until the list is exhausted.
  const pumpCount = Math.min(concurrency, total)
  const workers = Array.from({ length: pumpCount }, () => pumpWorker())
  await Promise.all(workers)

  return { done, failed, cancelled, errors }
}

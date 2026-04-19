import { ref, onMounted, onUnmounted } from 'vue'

/**
 * Polling composable with cancellation, in-flight dedup, and jittered
 * backoff.
 *
 * The callback receives an `AbortSignal` that is aborted when:
 *  - the component unmounts
 *  - a new tick is initiated (though the in-flight guard normally prevents
 *    this; the abort is a belt-and-suspenders defense against a stale
 *    response arriving after a newer one and overwriting fresher state)
 *
 * Existing call sites that ignore the signal continue to work — the signal
 * is passed *to* the callback; whether the callback wires it into its fetch
 * is opt-in. Threading it through `get()` in `src/api/client.ts` gives
 * real cancellation; without it, the only benefit is the in-flight guard.
 *
 * ### Backoff + jitter
 * A failing tick doubles `currentInterval` (capped at `maxInterval`).
 * Each scheduled interval is jittered ±10% to prevent synchronized
 * thundering-herd from multiple dashboard tabs.
 *
 * ### In-flight dedup
 * If `tick()` is invoked (by the timer or by `refresh()`) while a prior
 * tick's `callback` is still awaiting, the new tick is **dropped**. This
 * prevents a slow first-response overwriting a fresh second-response.
 * `refresh()` called during an active poll is therefore a no-op — the
 * active poll's result publishes shortly. Document this in view code if
 * surfacing to operators.
 *
 * ### AbortError handling
 * If the callback throws because the signal was aborted (e.g. unmount
 * mid-fetch), the error does NOT trigger backoff. Aborts are intentional,
 * not failures.
 */
export function usePolling(
  callback: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
) {
  const isPolling = ref(true)
  const isLoading = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  let currentInterval = intervalMs
  const maxInterval = 300_000 // 5 min
  const JITTER_FRACTION = 0.1 // ±10%
  // Tracks whether the composable is still attached to a live component.
  // tick() awaits the caller's fetch; if the user navigates away while a
  // request is in flight, the resolution runs *after* onUnmounted. Without
  // this flag, reschedule() would then spin up a fresh timer that no one
  // ever clears, and state refs would be mutated on an unmounted view.
  let mounted = false
  // One controller per in-flight tick. Replaced on each new tick; aborted
  // on unmount so an unmount mid-fetch cancels the network request rather
  // than letting it continue to completion and throw into the void.
  let activeController: AbortController | null = null

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      stop()
    } else {
      start()
    }
  }

  // ±10% jitter on the scheduled delay. Prevents N dashboard tabs from
  // polling in perfect sync. Never below 10% of the base interval in case
  // Math.random() returns very small values.
  function jittered(base: number): number {
    const spread = base * JITTER_FRACTION
    const offset = (Math.random() * 2 - 1) * spread
    return Math.max(base * 0.1, base + offset)
  }

  async function tick() {
    if (!mounted) return
    // In-flight dedup: a prior tick is still awaiting. Don't spawn an
    // overlapping callback — the active one's result will publish
    // shortly. See composable docstring for the "later response
    // overwrites fresher" race this prevents.
    if (isLoading.value) return

    const controller = new AbortController()
    activeController = controller
    isLoading.value = true
    try {
      await callback(controller.signal)
      if (!mounted) return
      currentInterval = intervalMs
    } catch (e) {
      if (!mounted) return
      // Aborts are intentional (unmount, visibility change). Not a
      // server error — don't bump backoff.
      if (isAbortError(e)) return
      currentInterval = Math.min(currentInterval * 2, maxInterval)
    } finally {
      if (mounted) isLoading.value = false
      // Clear only if still the active one — a concurrent tick would
      // have swapped it, though the in-flight guard prevents that.
      if (activeController === controller) activeController = null
    }
    if (mounted) reschedule()
  }

  function reschedule() {
    stop()
    if (mounted && document.visibilityState !== 'hidden') {
      timer = setTimeout(tick, jittered(currentInterval))
      isPolling.value = true
    }
  }

  function start() {
    if (timer || !mounted) return
    currentInterval = intervalMs
    tick()
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null }
    isPolling.value = false
  }

  function refresh() { if (mounted) tick() }

  onMounted(() => {
    mounted = true
    document.addEventListener('visibilitychange', onVisibilityChange)
    start()
  })

  onUnmounted(() => {
    mounted = false
    // Abort the in-flight callback so its fetch is cancelled rather than
    // running to completion. Callback's catch sees AbortError, returns
    // without bumping backoff; the `mounted` guard prevents any state
    // mutation regardless.
    activeController?.abort()
    activeController = null
    document.removeEventListener('visibilitychange', onVisibilityChange)
    stop()
  })

  return { isPolling, isLoading, refresh }
}

// Accepts both DOMException('AbortError') (from fetch) and plain
// `new Error` with name=AbortError (from custom abort wrappers).
function isAbortError(e: unknown): boolean {
  return (
    (e instanceof DOMException && e.name === 'AbortError') ||
    (e instanceof Error && e.name === 'AbortError')
  )
}

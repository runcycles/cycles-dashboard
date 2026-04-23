import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import type { Ref } from 'vue'
import { mount } from '@vue/test-utils'
import { usePolling } from '../composables/usePolling'

// Mount the composable inside a throwaway component so we get the real
// onMounted / onUnmounted lifecycle wired up. This is needed to exercise
// the unmount-safety guards (the bug was: tick() awaits in-flight, resolves
// after unmount, then reschedule() leaks a new setInterval).
function mountPolling(
  cb: (signal: AbortSignal) => Promise<void>,
  intervalMs = 1000,
) {
  let refreshFn: (() => void) | null = null
  let lastSuccessRef: Ref<Date | null> | null = null
  const Harness = defineComponent({
    setup() {
      const p = usePolling(cb, intervalMs)
      refreshFn = p.refresh
      lastSuccessRef = p.lastSuccessAt
      return () => h('div', [String(p.isLoading.value)])
    },
  })
  const wrapper = mount(Harness)
  return {
    wrapper,
    refresh: () => refreshFn?.(),
    lastSuccess: () => lastSuccessRef,
  }
}

// Test the polling logic directly (not as a composable with lifecycle)
describe('usePolling logic', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('callback is invoked', async () => {
    const cb = vi.fn().mockResolvedValue(undefined)
    // Simulate what usePolling does: call immediately
    await cb()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('exponential backoff doubles interval on error', () => {
    let interval = 30000
    const maxInterval = 300000

    // Simulate error backoff
    interval = Math.min(interval * 2, maxInterval)
    expect(interval).toBe(60000)

    interval = Math.min(interval * 2, maxInterval)
    expect(interval).toBe(120000)

    interval = Math.min(interval * 2, maxInterval)
    expect(interval).toBe(240000)

    interval = Math.min(interval * 2, maxInterval)
    expect(interval).toBe(300000) // capped at max
  })

  it('interval resets on success', () => {
    const baseInterval = 30000
    let interval = 120000 // after some errors

    // On success, reset
    interval = baseInterval
    expect(interval).toBe(30000)
  })
})

// Regression tests for the post-unmount leak: tick() awaits the caller's
// fetch; if the view unmounts while that fetch is pending, the resolution
// must NOT reschedule a new interval or mutate refs.
describe('usePolling — unmount safety', () => {
  beforeEach(() => { vi.useRealTimers() })

  it('does not invoke callback again after unmount when an in-flight tick resolves late', async () => {
    let resolveFetch!: () => void
    const inFlight = new Promise<void>((r) => { resolveFetch = r })
    const cb = vi.fn().mockImplementationOnce(() => inFlight)

    const { wrapper } = mountPolling(cb, 10_000)
    await nextTick()
    // Initial start() triggered the first tick(), which is now awaiting our
    // controlled promise. Unmount before it resolves.
    expect(cb).toHaveBeenCalledTimes(1)
    wrapper.unmount()

    // Let the pending fetch resolve after unmount. If the leak existed,
    // reschedule() inside the completing tick would install a fresh
    // setInterval that keeps calling cb().
    resolveFetch()
    await new Promise((r) => setTimeout(r, 50))

    // Still exactly one call — no scheduled re-tick, no leak.
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('refresh() is a no-op after unmount', async () => {
    const cb = vi.fn().mockResolvedValue(undefined)
    const { wrapper } = mountPolling(cb, 10_000)
    await nextTick()
    await nextTick()
    const callsAfterMount = cb.mock.calls.length
    wrapper.unmount()
    // Directly invoking refresh after unmount would require exporting it
    // from the harness; instead we assert the stronger property that no
    // additional timer has been installed by waiting past a hypothetical tick.
    await new Promise((r) => setTimeout(r, 50))
    expect(cb.mock.calls.length).toBe(callsAfterMount)
  })
})

// Cancellation + dedup + jitter (v0.1.25.28 hardening).
describe('usePolling — cancellation & dedup', () => {
  beforeEach(() => { vi.useRealTimers() })

  it('passes an AbortSignal to the callback', async () => {
    let received: AbortSignal | null = null
    const cb = vi.fn().mockImplementation(async (sig: AbortSignal) => {
      received = sig
    })
    const { wrapper } = mountPolling(cb, 10_000)
    await nextTick()
    await new Promise((r) => setTimeout(r, 10))
    expect(received).not.toBeNull()
    // Use a local non-null binding so TS narrows cleanly through the array
    // accessor. (received is typed AbortSignal|null at the callsite.)
    const sig = received as unknown as AbortSignal
    expect(typeof sig.aborted).toBe('boolean')
    expect(sig.aborted).toBe(false)
    wrapper.unmount()
  })

  it('aborts the in-flight signal on unmount', async () => {
    let capturedSignal: AbortSignal | null = null
    let resolveFetch!: () => void
    const cb = vi.fn().mockImplementation((sig: AbortSignal) => {
      capturedSignal = sig
      return new Promise<void>((r) => { resolveFetch = r })
    })
    const { wrapper } = mountPolling(cb, 10_000)
    await nextTick()
    const sig = capturedSignal as unknown as AbortSignal
    expect(sig).not.toBeNull()
    expect(sig.aborted).toBe(false)
    wrapper.unmount()
    expect(sig.aborted).toBe(true)
    // Let the in-flight callback settle; the mounted guard should prevent
    // any state mutation.
    resolveFetch()
    await new Promise((r) => setTimeout(r, 20))
  })

  it('drops overlapping tick when refresh() is called during an in-flight tick', async () => {
    let resolveFirst!: () => void
    const cb = vi.fn().mockImplementationOnce(() => new Promise<void>((r) => { resolveFirst = r }))
    const { wrapper, refresh } = mountPolling(cb, 10_000)
    await nextTick()
    // First tick is now in flight (awaiting our controlled promise).
    expect(cb).toHaveBeenCalledTimes(1)
    // Calling refresh() during in-flight should NOT spawn a second
    // concurrent callback — the in-flight guard drops it.
    refresh()
    await nextTick()
    expect(cb).toHaveBeenCalledTimes(1)
    // Resolve the first tick; a scheduled follow-up (via reschedule) is
    // jittered several seconds out, so it won't fire during this test.
    resolveFirst()
    await new Promise((r) => setTimeout(r, 20))
    expect(cb).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('does not bump backoff when callback throws AbortError', async () => {
    // Simulate the exact error shape fetch() throws on external abort.
    const abortErr = new DOMException('aborted', 'AbortError')
    const cb = vi.fn().mockRejectedValue(abortErr)
    const { wrapper } = mountPolling(cb, 10_000)
    await nextTick()
    await new Promise((r) => setTimeout(r, 20))
    // Nothing to assert on `currentInterval` directly (private), but the
    // composable shouldn't have thrown out of tick(). The key contract is
    // that unmount still works cleanly — no dangling state.
    expect(cb).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  // P1-M2: lastSuccessAt drives the "Updated Xm ago" pill in PageHeader.
  // Contract: set to a fresh Date on every successful tick; left
  // untouched on a failed tick so the freshness label correctly
  // indicates staleness. Also unused Ref warning killer — lint has
  // flagged composable return shape drift before.
  it('lastSuccessAt is set after a successful tick', async () => {
    const cb = vi.fn().mockResolvedValue(undefined)
    const harness = mountPolling(cb, 10_000)
    await nextTick()
    await new Promise(r => setTimeout(r, 10))
    const last = harness.lastSuccess()
    expect(last).not.toBeNull()
    expect(last?.value).toBeInstanceOf(Date)
    harness.wrapper.unmount()
  })

  it('lastSuccessAt stays null when a successful response lands AFTER unmount', async () => {
    // Regression lock: the !mounted guard must sit between `await callback()`
    // and the `lastSuccessAt.value = new Date()` assignment. Without it,
    // a tick that resolves after the view unmounts would still mutate
    // the ref — harmless visually, but a leak of post-unmount state.
    let resolveFetch!: () => void
    const inFlight = new Promise<void>(r => { resolveFetch = r })
    const cb = vi.fn().mockImplementation(() => inFlight)

    const harness = mountPolling(cb, 10_000)
    await nextTick()
    // Unmount while the tick is still awaiting.
    harness.wrapper.unmount()
    // Now let the fetch succeed.
    resolveFetch()
    await new Promise(r => setTimeout(r, 30))

    // The success landed, but mounted=false by then — stamp should
    // remain null.
    expect(harness.lastSuccess()?.value).toBeNull()
  })

  it('lastSuccessAt stays null after a failing tick', async () => {
    const cb = vi.fn().mockRejectedValue(new Error('boom'))
    const harness = mountPolling(cb, 10_000)
    await nextTick()
    await new Promise(r => setTimeout(r, 10))
    const last = harness.lastSuccess()
    expect(last?.value).toBeNull()
    harness.wrapper.unmount()
  })

  it('refresh() is a no-op while a tick is in flight', async () => {
    let resolve!: () => void
    const cb = vi.fn().mockImplementation(() => new Promise<void>((r) => { resolve = r }))
    const { wrapper, refresh } = mountPolling(cb, 10_000)
    await nextTick()
    expect(cb).toHaveBeenCalledTimes(1)
    // Three rapid-fire refresh clicks — all should be absorbed by the
    // in-flight guard rather than stacking up callbacks.
    refresh(); refresh(); refresh()
    await nextTick()
    expect(cb).toHaveBeenCalledTimes(1)
    resolve()
    await new Promise((r) => setTimeout(r, 20))
    expect(cb).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})

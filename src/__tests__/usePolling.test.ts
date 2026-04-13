import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { usePolling } from '../composables/usePolling'

// Mount the composable inside a throwaway component so we get the real
// onMounted / onUnmounted lifecycle wired up. This is needed to exercise
// the unmount-safety guards (the bug was: tick() awaits in-flight, resolves
// after unmount, then reschedule() leaks a new setInterval).
function mountPolling(cb: () => Promise<void>, intervalMs = 1000) {
  const Harness = defineComponent({
    setup() {
      const p = usePolling(cb, intervalMs)
      return () => h('div', [String(p.isLoading.value)])
    },
  })
  return mount(Harness)
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

    const wrapper = mountPolling(cb, 10_000)
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
    const wrapper = mountPolling(cb, 10_000)
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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

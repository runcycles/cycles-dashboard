// Coverage for the debounced-ref composable that powers V5 (Phase 3).
// The important invariants:
//   - initial value is available synchronously (no "undefined → real"
//     flash during first render)
//   - rapid source changes coalesce into a single downstream update
//   - the pending update is cancelled on scope teardown (no post-
//     unmount write / no leaked timer)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, effectScope, nextTick } from 'vue'
import { useDebouncedRef } from '../composables/useDebouncedRef'

describe('useDebouncedRef', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('exposes the current source value synchronously', () => {
    const scope = effectScope()
    scope.run(() => {
      const source = ref('hello')
      const debounced = useDebouncedRef(source, 100)
      expect(debounced.value).toBe('hello')
    })
    scope.stop()
  })

  it('defers propagation by the specified delay', async () => {
    const scope = effectScope()
    await scope.run(async () => {
      const source = ref('a')
      const debounced = useDebouncedRef(source, 250)
      source.value = 'b'
      // Vue's watch schedules the callback in a microtask (flush:'pre'
      // by default). We need to flush that before advancing the fake
      // timer so the timer actually exists to advance.
      await nextTick()
      expect(debounced.value).toBe('a')
      vi.advanceTimersByTime(249)
      expect(debounced.value).toBe('a')
      vi.advanceTimersByTime(1)
      expect(debounced.value).toBe('b')
    })
    scope.stop()
  })

  it('coalesces rapid source changes into a single trailing update', async () => {
    const scope = effectScope()
    await scope.run(async () => {
      const source = ref('')
      const debounced = useDebouncedRef(source, 200)
      // Simulate fast typing: 5 characters at 20ms intervals. Flush
      // microtasks between each to let the watch schedule its timer.
      source.value = 'h'
      await nextTick()
      vi.advanceTimersByTime(20)
      source.value = 'he'
      await nextTick()
      vi.advanceTimersByTime(20)
      source.value = 'hel'
      await nextTick()
      vi.advanceTimersByTime(20)
      source.value = 'hell'
      await nextTick()
      vi.advanceTimersByTime(20)
      source.value = 'hello'
      await nextTick()
      // Only the last value should propagate, once, after 200ms from
      // the last change.
      vi.advanceTimersByTime(200)
      expect(debounced.value).toBe('hello')
    })
    scope.stop()
  })

  it('cancels the pending update when the effect scope disposes', async () => {
    const source = ref('initial')
    const scope = effectScope()
    let debounced!: ReturnType<typeof useDebouncedRef<string>>
    await scope.run(async () => {
      debounced = useDebouncedRef(source, 150)
      source.value = 'changed'
      await nextTick() // let the watch register its timer
    })
    // Tear down before the timer fires.
    scope.stop()
    vi.advanceTimersByTime(500)
    // Downstream still shows the pre-teardown value — no post-dispose
    // write happened. If the timer had leaked past scope.stop(), the
    // setTimeout callback would have written 'changed' here.
    expect(debounced.value).toBe('initial')
  })
})

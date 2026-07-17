import { ref } from 'vue'

type PollingCallback = (signal: AbortSignal) => unknown

/**
 * Single-tick usePolling double for view tests that do not exercise timers.
 *
 * Keep the returned state as genuine Vue refs. Plain `{ value }` lookalikes
 * are not valid watch sources and are not unwrapped when passed to child
 * component props, which turns harmless test setup into noisy Vue warnings.
 */
export function createPollingMock(callback: PollingCallback) {
  const controller = new AbortController()
  const isPolling = ref(true)
  const isLoading = ref(false)
  const lastSuccessAt = ref<Date | null>(null)

  const run = () => callback(controller.signal)
  void run()

  return {
    isPolling,
    isLoading,
    lastSuccessAt,
    refresh: run,
  }
}

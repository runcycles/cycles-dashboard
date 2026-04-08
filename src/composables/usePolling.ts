import { ref, onMounted, onUnmounted } from 'vue'

export function usePolling(callback: () => Promise<void>, intervalMs: number) {
  const isPolling = ref(true)
  let timer: ReturnType<typeof setInterval> | null = null
  let currentInterval = intervalMs
  const maxInterval = 300_000 // 5 min

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      stop()
    } else {
      start()
    }
  }

  async function tick() {
    try {
      await callback()
      currentInterval = intervalMs // reset on success
    } catch {
      currentInterval = Math.min(currentInterval * 2, maxInterval) // backoff on error
    }
    reschedule()
  }

  function reschedule() {
    stop()
    if (document.visibilityState !== 'hidden') {
      timer = setInterval(tick, currentInterval)
      isPolling.value = true
    }
  }

  function start() {
    if (timer) return
    currentInterval = intervalMs
    tick()
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
    isPolling.value = false
  }

  function refresh() { tick() }

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibilityChange)
    start()
  })

  onUnmounted(() => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    stop()
  })

  return { isPolling, refresh }
}

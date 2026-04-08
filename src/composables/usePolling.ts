import { ref, onMounted, onUnmounted } from 'vue'

export function usePolling(callback: () => Promise<void>, intervalMs: number) {
  const isPolling = ref(true)
  const isLoading = ref(false)
  const lastUpdated = ref<string | null>(null)
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
    isLoading.value = true
    try {
      await callback()
      currentInterval = intervalMs
      lastUpdated.value = new Date().toISOString()
    } catch {
      currentInterval = Math.min(currentInterval * 2, maxInterval)
    } finally {
      isLoading.value = false
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

  return { isPolling, isLoading, lastUpdated, refresh }
}

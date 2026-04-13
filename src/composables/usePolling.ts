import { ref, onMounted, onUnmounted } from 'vue'

export function usePolling(callback: () => Promise<void>, intervalMs: number) {
  const isPolling = ref(true)
  const isLoading = ref(false)
  const lastUpdated = ref<string | null>(null)
  let timer: ReturnType<typeof setInterval> | null = null
  let currentInterval = intervalMs
  const maxInterval = 300_000 // 5 min
  // Tracks whether the composable is still attached to a live component.
  // tick() awaits the caller's fetch; if the user navigates away while a
  // request is in flight, the resolution runs *after* onUnmounted. Without
  // this flag, reschedule() would then spin up a fresh setInterval that no
  // one ever clears, and state refs would be mutated on an unmounted view.
  let mounted = false

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      stop()
    } else {
      start()
    }
  }

  async function tick() {
    if (!mounted) return
    isLoading.value = true
    try {
      await callback()
      if (!mounted) return
      currentInterval = intervalMs
      lastUpdated.value = new Date().toISOString()
    } catch {
      if (!mounted) return
      currentInterval = Math.min(currentInterval * 2, maxInterval)
    } finally {
      if (mounted) isLoading.value = false
    }
    if (mounted) reschedule()
  }

  function reschedule() {
    stop()
    if (mounted && document.visibilityState !== 'hidden') {
      timer = setInterval(tick, currentInterval)
      isPolling.value = true
    }
  }

  function start() {
    if (timer || !mounted) return
    currentInterval = intervalMs
    tick()
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
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
    document.removeEventListener('visibilitychange', onVisibilityChange)
    stop()
  })

  return { isPolling, isLoading, lastUpdated, refresh }
}

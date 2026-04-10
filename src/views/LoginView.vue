<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useRoute } from 'vue-router'
import { sanitizeRedirect } from '../utils/sanitize'

const auth = useAuthStore()
const route = useRoute()
const key = ref('')
const error = ref('')
const loading = ref(false)
// `showLoading` is the *visual* loading state, delayed by 200ms so fast
// responses (local dev, warm cache) don't flash "Connecting..." + dim before
// the page navigates away.
const showLoading = ref(false)
let loadingVisualTimer: ReturnType<typeof setTimeout> | null = null
const expired = route.query.expired === '1'

// Rate limiting: exponential backoff after failed attempts
const failedAttempts = ref(0)
const lockedUntil = ref(0)
const lockRemaining = ref(0)
let lockTimer: ReturnType<typeof setInterval> | null = null

const isLocked = computed(() => lockRemaining.value > 0)

function startLockCountdown() {
  if (lockTimer) clearInterval(lockTimer)
  lockTimer = setInterval(() => {
    const remaining = Math.ceil((lockedUntil.value - Date.now()) / 1000)
    lockRemaining.value = Math.max(0, remaining)
    if (lockRemaining.value <= 0 && lockTimer) {
      clearInterval(lockTimer)
      lockTimer = null
    }
  }, 250)
}

async function submit() {
  if (isLocked.value || loading.value) return
  error.value = ''
  loading.value = true
  // Only flip the visual loading state if the request is slow enough to
  // warrant feedback — avoids a sub-perceptual flash on fast responses.
  loadingVisualTimer = setTimeout(() => { showLoading.value = true }, 200)
  let navigating = false
  try {
    const ok = await auth.login(key.value)
    if (ok) {
      navigating = true
      failedAttempts.value = 0
      if (lockTimer) { clearInterval(lockTimer); lockTimer = null }
      const redirect = (route.query.redirect as string) || '/'
      const target = sanitizeRedirect(redirect, window.location.origin)
      // Use full page navigation to guarantee clean state — avoids stale
      // router query params (expired=1) and session checker race conditions
      window.location.href = target
      return
    }
    failedAttempts.value++
    if (failedAttempts.value >= 3) {
      const delaySec = Math.min(60, 5 * Math.pow(2, failedAttempts.value - 3))
      lockedUntil.value = Date.now() + delaySec * 1000
      lockRemaining.value = delaySec
      startLockCountdown()
      error.value = `Too many failed attempts. Try again in ${delaySec}s.`
    } else {
      error.value = 'Invalid admin key'
    }
  } catch {
    error.value = 'Connection failed. Please try again.'
  } finally {
    if (loadingVisualTimer) { clearTimeout(loadingVisualTimer); loadingVisualTimer = null }
    // When we're navigating away, leave the visual state as-is so the button
    // doesn't pop back to "Login" during the browser's unload delay.
    if (!navigating) {
      showLoading.value = false
      loading.value = false
    }
  }
}

onUnmounted(() => {
  if (lockTimer) { clearInterval(lockTimer); lockTimer = null }
  if (loadingVisualTimer) { clearTimeout(loadingVisualTimer); loadingVisualTimer = null }
})
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
    <div class="bg-white dark:bg-gray-900 rounded-lg shadow-md p-8 w-full max-w-sm">
      <div class="flex items-center gap-3 mb-4">
        <img src="/runcycles-logo.svg" alt="Cycles" class="w-10 h-10" />
        <h1 class="text-xl font-semibold text-gray-900 dark:text-white">Cycles Admin</h1>
      </div>
      <p v-if="expired" class="text-sm text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2 mb-4">Your session expired due to inactivity. Please log in again.</p>
      <p class="text-sm text-gray-500 dark:text-gray-400 mb-6">Enter your admin API key to continue.</p>
      <form @submit.prevent="submit">
        <label for="admin-api-key" class="sr-only">Admin API Key</label>
        <input
          id="admin-api-key"
          v-model="key"
          type="password"
          placeholder="X-Admin-API-Key"
          aria-label="Admin API Key"
          class="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-white rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
          autofocus
        />
        <p v-if="error" class="text-red-600 text-sm mt-2">{{ error }}</p>
        <button
          type="submit"
          :disabled="!key || loading || isLocked"
          class="mt-4 w-full bg-gray-900 text-white py-2 rounded-md text-sm font-medium hover:bg-gray-800 disabled:cursor-not-allowed transition-opacity duration-150"
          :class="{ 'opacity-50': !key || showLoading || isLocked }"
        >
          {{ isLocked ? `Locked (${lockRemaining}s)` : showLoading ? 'Connecting...' : 'Login' }}
        </button>
      </form>
    </div>
  </div>
</template>

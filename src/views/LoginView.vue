<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useRouter, useRoute } from 'vue-router'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const key = ref('')
const error = ref('')
const loading = ref(false)
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
  if (isLocked.value) return
  error.value = ''
  loading.value = true
  const ok = await auth.login(key.value)
  if (ok) {
    failedAttempts.value = 0
    if (lockTimer) { clearInterval(lockTimer); lockTimer = null }
    const redirect = (route.query.redirect as string) || '/'
    // Navigate BEFORE setting loading=false so AppLayout renders with correct route
    await router.push(redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/')
    loading.value = false
    return
  } else {
    failedAttempts.value++
    if (failedAttempts.value >= 3) {
      // Exponential backoff: 5s, 10s, 20s, 40s... capped at 60s
      const delaySec = Math.min(60, 5 * Math.pow(2, failedAttempts.value - 3))
      lockedUntil.value = Date.now() + delaySec * 1000
      lockRemaining.value = delaySec
      startLockCountdown()
      error.value = `Too many failed attempts. Try again in ${delaySec}s.`
    } else {
      error.value = 'Invalid admin key'
    }
  }
}

onUnmounted(() => {
  if (lockTimer) { clearInterval(lockTimer); lockTimer = null }
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
        <input
          v-model="key"
          type="password"
          placeholder="X-Admin-API-Key"
          class="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-white rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
          autofocus
        />
        <p v-if="error" class="text-red-600 text-sm mt-2">{{ error }}</p>
        <button
          type="submit"
          :disabled="!key || loading || isLocked"
          class="mt-4 w-full bg-gray-900 text-white py-2 rounded-md text-sm font-medium hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ isLocked ? `Locked (${lockRemaining}s)` : loading ? 'Connecting...' : 'Login' }}
        </button>
      </form>
    </div>
  </div>
</template>

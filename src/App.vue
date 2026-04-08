<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from './stores/auth'
import { useDarkMode } from './composables/useDarkMode'
import AppLayout from './components/AppLayout.vue'

const auth = useAuthStore()
const router = useRouter()
useDarkMode()

// Track user activity for idle timeout
const activityEvents = ['mousedown', 'keydown', 'scroll', 'touchstart'] as const
function onActivity() { auth.touchActivity() }

// Periodically check for session timeout
let timeoutChecker: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  for (const evt of activityEvents) {
    document.addEventListener(evt, onActivity, { passive: true })
  }
  timeoutChecker = setInterval(() => {
    if (auth.checkTimeout()) {
      router.push({ name: 'login', query: { expired: '1' } })
    }
  }, 15_000) // check every 15 seconds
})

onUnmounted(() => {
  for (const evt of activityEvents) {
    document.removeEventListener(evt, onActivity)
  }
  if (timeoutChecker) clearInterval(timeoutChecker)
})
</script>

<template>
  <AppLayout v-if="auth.isAuthenticated" />
  <router-view v-else />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

// Public route (meta.public = true) so unauthenticated users aren't bounced
// to /login when they follow a stale or mistyped link — Gmail / GitHub /
// Linear all render a 404 regardless of auth. CTAs adapt to auth state so
// the page lands the operator on the right next step.
const primary = computed(() =>
  auth.isAuthenticated
    ? { label: 'Back to Overview', to: { name: 'overview' as const } }
    : { label: 'Go to Login', to: { name: 'login' as const } },
)

const attemptedPath = computed(() => route.fullPath)
</script>

<template>
  <div class="max-w-md mx-auto py-16 text-center">
    <p class="text-6xl font-semibold text-gray-300 dark:text-gray-700 tracking-tight">404</p>
    <h1 class="mt-4 text-lg font-medium text-gray-900 dark:text-white">Page not found</h1>
    <p class="muted-sm mt-2">
      The URL you followed may be outdated or mistyped.
    </p>
    <p class="muted-sm mt-1 font-mono text-xs break-all">{{ attemptedPath }}</p>
    <div class="mt-6 flex items-center justify-center gap-3">
      <button
        type="button"
        class="btn-pill-primary"
        @click="router.push(primary.to)"
      >{{ primary.label }}</button>
      <button
        type="button"
        class="btn-pill-secondary"
        @click="router.back()"
      >Go back</button>
    </div>
  </div>
</template>

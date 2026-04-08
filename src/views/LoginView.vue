<script setup lang="ts">
import { ref } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useRouter } from 'vue-router'

const auth = useAuthStore()
const router = useRouter()
const key = ref('')
const error = ref('')
const loading = ref(false)

async function submit() {
  error.value = ''
  loading.value = true
  const ok = await auth.login(key.value)
  loading.value = false
  if (ok) {
    router.push('/')
  } else {
    error.value = 'Invalid admin key'
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50">
    <div class="bg-white rounded-lg shadow-md p-8 w-full max-w-sm">
      <h1 class="text-xl font-semibold text-gray-900 mb-1">Cycles Admin</h1>
      <p class="text-sm text-gray-500 mb-6">Enter your admin API key to continue.</p>
      <form @submit.prevent="submit">
        <input
          v-model="key"
          type="password"
          placeholder="X-Admin-API-Key"
          class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
          autofocus
        />
        <p v-if="error" class="text-red-600 text-sm mt-2">{{ error }}</p>
        <button
          type="submit"
          :disabled="!key || loading"
          class="mt-4 w-full bg-gray-900 text-white py-2 rounded-md text-sm font-medium hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ loading ? 'Connecting...' : 'Login' }}
        </button>
      </form>
    </div>
  </div>
</template>

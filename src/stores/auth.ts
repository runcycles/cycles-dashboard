import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Capabilities } from '../types'

export const useAuthStore = defineStore('auth', () => {
  const apiKey = ref('')
  const capabilities = ref<Capabilities | null>(null)

  const isAuthenticated = computed(() => !!apiKey.value && !!capabilities.value)

  async function login(key: string): Promise<boolean> {
    apiKey.value = key
    try {
      const res = await fetch('/v1/auth/introspect', {
        headers: { 'X-Admin-API-Key': key },
      })
      if (!res.ok) { apiKey.value = ''; return false }
      const data = await res.json()
      if (!data.authenticated) { apiKey.value = ''; return false }
      capabilities.value = data.capabilities
      return true
    } catch {
      apiKey.value = ''
      return false
    }
  }

  function logout() {
    apiKey.value = ''
    capabilities.value = null
  }

  return { apiKey, capabilities, isAuthenticated, login, logout }
})

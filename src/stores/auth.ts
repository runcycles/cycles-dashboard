import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type { Capabilities } from '../types'

export const useAuthStore = defineStore('auth', () => {
  const apiKey = ref(sessionStorage.getItem('cycles_admin_key') || '')
  const capabilities = ref<Capabilities | null>(null)

  const isAuthenticated = computed(() => !!apiKey.value && !!capabilities.value)

  // Persist key to sessionStorage (survives refresh, cleared on tab close)
  watch(apiKey, (val) => {
    if (val) sessionStorage.setItem('cycles_admin_key', val)
    else sessionStorage.removeItem('cycles_admin_key')
  })

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

  // Restore session: if key exists in sessionStorage, re-introspect
  async function restore(): Promise<boolean> {
    if (!apiKey.value) return false
    return login(apiKey.value)
  }

  function logout() {
    apiKey.value = ''
    capabilities.value = null
  }

  return { apiKey, capabilities, isAuthenticated, login, restore, logout }
})

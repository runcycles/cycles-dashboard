import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type { Capabilities } from '../types'

const IDLE_TIMEOUT_MS = 30 * 60 * 1000    // 30 minutes
const ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000  // 8 hours
const SESSION_KEY = 'cycles_admin_key'
const SESSION_START_KEY = 'cycles_session_start'
const LAST_ACTIVITY_KEY = 'cycles_last_activity'

export const useAuthStore = defineStore('auth', () => {
  const apiKey = ref(sessionStorage.getItem(SESSION_KEY) || '')
  const capabilities = ref<Capabilities | null>(null)

  const isAuthenticated = computed(() => !!apiKey.value && !!capabilities.value)

  // Persist key to sessionStorage (survives refresh, cleared on tab close)
  watch(apiKey, (val) => {
    if (val) sessionStorage.setItem(SESSION_KEY, val)
    else {
      sessionStorage.removeItem(SESSION_KEY)
      sessionStorage.removeItem(SESSION_START_KEY)
      sessionStorage.removeItem(LAST_ACTIVITY_KEY)
    }
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
      const now = String(Date.now())
      sessionStorage.setItem(SESSION_START_KEY, now)
      sessionStorage.setItem(LAST_ACTIVITY_KEY, now)
      return true
    } catch {
      apiKey.value = ''
      return false
    }
  }

  // Restore session: check timeouts, then re-introspect
  async function restore(): Promise<boolean> {
    if (!apiKey.value) return false
    const now = Date.now()
    const sessionStart = Number(sessionStorage.getItem(SESSION_START_KEY) || '0')
    const lastActivity = Number(sessionStorage.getItem(LAST_ACTIVITY_KEY) || '0')

    // Absolute timeout: force re-login after max session duration
    if (sessionStart && now - sessionStart > ABSOLUTE_TIMEOUT_MS) {
      logout()
      return false
    }
    // Idle timeout: force re-login if no activity
    if (lastActivity && now - lastActivity > IDLE_TIMEOUT_MS) {
      logout()
      return false
    }
    return login(apiKey.value)
  }

  // Track user activity for idle timeout
  function touchActivity() {
    if (apiKey.value) {
      sessionStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()))
    }
  }

  // Check if session has expired (called periodically)
  function checkTimeout(): boolean {
    if (!apiKey.value) return false
    const now = Date.now()
    const sessionStart = Number(sessionStorage.getItem(SESSION_START_KEY) || '0')
    const lastActivity = Number(sessionStorage.getItem(LAST_ACTIVITY_KEY) || '0')
    if ((sessionStart && now - sessionStart > ABSOLUTE_TIMEOUT_MS) ||
        (lastActivity && now - lastActivity > IDLE_TIMEOUT_MS)) {
      logout()
      return true
    }
    return false
  }

  function logout() {
    apiKey.value = ''
    capabilities.value = null
  }

  return { apiKey, capabilities, isAuthenticated, login, restore, touchActivity, checkTimeout, logout }
})

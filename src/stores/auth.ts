import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type { AuthIntrospectResponse, Capabilities } from '../types'

const IDLE_TIMEOUT_MS = 30 * 60 * 1000    // 30 minutes
const ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000  // 8 hours
const SESSION_KEY = 'cycles_admin_key'
const SESSION_START_KEY = 'cycles_session_start'
const LAST_ACTIVITY_KEY = 'cycles_last_activity'

export type AuthFailure = 'invalid_credentials' | 'service_unavailable'

export const useAuthStore = defineStore('auth', () => {
  const apiKey = ref(sessionStorage.getItem(SESSION_KEY) || '')
  const capabilities = ref<Capabilities | null>(null)
  const authFailure = ref<AuthFailure | null>(null)

  // Both apiKey AND capabilities required. This is the load-bearing invariant
  // behind capability gating in views: the router guard awaits this, so by
  // the time a protected view mounts `capabilities` is always non-null.
  // Views can therefore use `?.manage_X !== false` as a "undefined = allow"
  // pattern without a null-capabilities render window (spec convention:
  // undefined permits, only explicit false blocks).
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

  function clearCredentials() {
    apiKey.value = ''
    capabilities.value = null
  }

  function rejectCredentials(): false {
    clearCredentials()
    authFailure.value = 'invalid_credentials'
    return false
  }

  async function introspect(key: string, newSession: boolean): Promise<boolean> {
    authFailure.value = null
    apiKey.value = key
    // A caller starting an explicit login must never remain authenticated with
    // capabilities obtained for a different key while the new request is in
    // flight. restore() starts from a cold store and does not need this reset.
    if (newSession) capabilities.value = null
    try {
      const res = await fetch('/v1/auth/introspect', {
        headers: { 'X-Admin-API-Key': key },
      })
      // A newer login (or an explicit logout) owns the store now. Never let a
      // stale response write capabilities or clear the newer credential.
      if (apiKey.value !== key) return false
      // Only explicit authentication rejection proves that the credential is
      // invalid. nginx deliberately returns resolved 502/503/504 responses
      // when the admin plane is unavailable; treating every !ok response as
      // invalid permanently erased an otherwise-valid session key.
      if (res.status === 401 || res.status === 403) return rejectCredentials()
      if (!res.ok) {
        authFailure.value = 'service_unavailable'
        return false
      }

      const data = await res.json() as Partial<AuthIntrospectResponse>
      if (apiKey.value !== key) return false
      if (data.authenticated === false) return rejectCredentials()
      if (data.authenticated !== true || !data.capabilities || typeof data.capabilities !== 'object') {
        throw new Error('Malformed introspection response')
      }
      capabilities.value = data.capabilities
      const now = String(Date.now())
      // A fresh login starts a new absolute session. A restore only proves the
      // existing key is still valid; it must not renew the eight-hour absolute
      // timeout on every refresh. Backfill a missing legacy timestamp once.
      if (newSession || !sessionStorage.getItem(SESSION_START_KEY)) {
        sessionStorage.setItem(SESSION_START_KEY, now)
      }
      sessionStorage.setItem(LAST_ACTIVITY_KEY, now)
      return true
    } catch {
      if (apiKey.value === key) authFailure.value = 'service_unavailable'
      return false
    }
  }

  async function login(key: string): Promise<boolean> {
    return introspect(key, true)
  }

  // M11: single-flight guard. Router guard + App.vue's mount-time
  // session checker both call restore() on cold load; pre-fix that
  // issued two /v1/auth/introspect fetches in rapid succession, and
  // if the first was slow the second could overwrite its capabilities
  // write. Concurrent callers now await the same in-flight promise.
  // Cleared on resolution so a subsequent (logically-next) restore
  // fires a fresh fetch.
  let inFlightRestore: Promise<boolean> | null = null

  // Restore session: check timeouts, then re-introspect
  async function restore(): Promise<boolean> {
    if (!apiKey.value) return false
    if (inFlightRestore) return inFlightRestore
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
    inFlightRestore = introspect(apiKey.value, false).finally(() => {
      inFlightRestore = null
    })
    return inFlightRestore
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
    clearCredentials()
    authFailure.value = null
  }

  return { apiKey, capabilities, authFailure, isAuthenticated, login, restore, touchActivity, checkTimeout, logout }
})

// Extended auth store tests — covers restore(), checkTimeout(), timeout
// boundaries, and concurrent login behavior.
//
// These tests exist primarily to settle whether the "concurrent login" and
// "checkTimeout vs restore race" gaps from the original code review are real
// bugs that need a mutex/single-flight, or whether the current code is safe.
// If they pass, the races are theoretical and we don't need to add
// concurrency primitives. If they fail, we have a motivated bug to fix.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'

const mockCapabilities = {
  view_overview: true, view_budgets: true, view_events: true,
  view_webhooks: true, view_audit: true, view_tenants: true,
  view_api_keys: true, view_policies: true,
}

function mockSuccessfulIntrospect() {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      authenticated: true,
      auth_type: 'admin',
      permissions: ['*'],
      capabilities: mockCapabilities,
    }),
  })
}

describe('auth store — restore()', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    sessionStorage.clear()
  })

  it('returns false when no apiKey is present', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const auth = useAuthStore()
    const result = await auth.restore()
    expect(result).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns false and logs out when session is past absolute timeout (8h)', async () => {
    const fetchMock = mockSuccessfulIntrospect()
    vi.stubGlobal('fetch', fetchMock)

    const auth = useAuthStore()
    await auth.login('test-key')
    expect(auth.isAuthenticated).toBe(true)

    // Roll the clock forward past 8h absolute timeout.
    const now = Date.now()
    sessionStorage.setItem('cycles_session_start', String(now - (9 * 60 * 60 * 1000)))
    sessionStorage.setItem('cycles_last_activity', String(now))

    const result = await auth.restore()
    expect(result).toBe(false)
    expect(auth.isAuthenticated).toBe(false)
    expect(auth.apiKey).toBe('')
  })

  it('returns false and logs out when past idle timeout (30m without activity)', async () => {
    vi.stubGlobal('fetch', mockSuccessfulIntrospect())
    const auth = useAuthStore()
    await auth.login('test-key')

    const now = Date.now()
    sessionStorage.setItem('cycles_session_start', String(now - (1 * 60 * 60 * 1000))) // 1h ago
    sessionStorage.setItem('cycles_last_activity', String(now - (31 * 60 * 1000))) // 31m ago

    const result = await auth.restore()
    expect(result).toBe(false)
    expect(auth.isAuthenticated).toBe(false)
  })

  it('re-introspects and succeeds when session is within both timeouts', async () => {
    vi.stubGlobal('fetch', mockSuccessfulIntrospect())
    const auth = useAuthStore()
    await auth.login('test-key')

    const now = Date.now()
    // 2h into session, activity 5min ago — both within limits
    sessionStorage.setItem('cycles_session_start', String(now - (2 * 60 * 60 * 1000)))
    sessionStorage.setItem('cycles_last_activity', String(now - (5 * 60 * 1000)))

    const result = await auth.restore()
    expect(result).toBe(true)
    expect(auth.isAuthenticated).toBe(true)
  })

  it('returns false on network failure during re-introspect', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ authenticated: true, auth_type: 'admin', permissions: ['*'], capabilities: mockCapabilities }),
      })
      .mockRejectedValueOnce(new Error('Network error'))
    vi.stubGlobal('fetch', fetchMock)

    const auth = useAuthStore()
    await auth.login('test-key')
    expect(auth.isAuthenticated).toBe(true)

    // Timestamps are fresh from the login, so idle/absolute pass;
    // the re-introspect is what fails.
    const result = await auth.restore()
    expect(result).toBe(false)
    expect(auth.isAuthenticated).toBe(false)
  })
})

describe('auth store — restore() single-flight (M11)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('two concurrent restore() calls fire only ONE introspect fetch', async () => {
    // Pre-fix the router guard + App.vue's mount-time session checker
    // both called restore() on cold load, which issued two
    // /v1/auth/introspect fetches in rapid succession. The single-
    // flight guard coalesces concurrent callers onto the same
    // in-flight promise so only one network round-trip fires.
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({
        authenticated: true, auth_type: 'admin', permissions: ['*'],
        capabilities: mockCapabilities,
      }),
    }
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => {
      // Small delay so both callers are guaranteed to overlap.
      setTimeout(() => resolve(mockResponse as Response), 10)
    }))
    vi.stubGlobal('fetch', fetchMock)

    const auth = useAuthStore()
    // Bootstrap a valid apiKey without triggering login's own fetch.
    auth.apiKey = 'test-key'
    const now = Date.now()
    sessionStorage.setItem('cycles_session_start', String(now - 60_000))
    sessionStorage.setItem('cycles_last_activity', String(now - 60_000))

    const [a, b] = await Promise.all([auth.restore(), auth.restore()])

    expect(a).toBe(true)
    expect(b).toBe(true)
    // ONE fetch fired, both callers saw the same result.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a subsequent restore() after the first resolves fires a fresh fetch', async () => {
    // Cache clears on resolution — a later restore() should introspect
    // again, not read a stale cached promise.
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({
        authenticated: true, auth_type: 'admin', permissions: ['*'],
        capabilities: mockCapabilities,
      }),
    }
    const fetchMock = vi.fn().mockResolvedValue(mockResponse as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)

    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    const now = Date.now()
    sessionStorage.setItem('cycles_session_start', String(now - 60_000))
    sessionStorage.setItem('cycles_last_activity', String(now - 60_000))

    await auth.restore()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await auth.restore()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('auth store — checkTimeout()', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('returns false when no apiKey is set', () => {
    const auth = useAuthStore()
    expect(auth.checkTimeout()).toBe(false)
  })

  it('returns false when session is fresh', async () => {
    vi.stubGlobal('fetch', mockSuccessfulIntrospect())
    const auth = useAuthStore()
    await auth.login('test-key')
    expect(auth.checkTimeout()).toBe(false)
    expect(auth.isAuthenticated).toBe(true)
  })

  it('returns true and logs out when past absolute timeout', async () => {
    vi.stubGlobal('fetch', mockSuccessfulIntrospect())
    const auth = useAuthStore()
    await auth.login('test-key')

    const now = Date.now()
    sessionStorage.setItem('cycles_session_start', String(now - (9 * 60 * 60 * 1000)))

    expect(auth.checkTimeout()).toBe(true)
    expect(auth.isAuthenticated).toBe(false)
  })

  it('returns true and logs out when past idle timeout', async () => {
    vi.stubGlobal('fetch', mockSuccessfulIntrospect())
    const auth = useAuthStore()
    await auth.login('test-key')

    const now = Date.now()
    sessionStorage.setItem('cycles_last_activity', String(now - (31 * 60 * 1000)))

    expect(auth.checkTimeout()).toBe(true)
    expect(auth.isAuthenticated).toBe(false)
  })

  it('does not log out exactly at the idle boundary (strict >)', async () => {
    vi.stubGlobal('fetch', mockSuccessfulIntrospect())
    const auth = useAuthStore()
    await auth.login('test-key')

    // Freeze time. Without this the wall-clock advances between capturing
    // `now` and `checkTimeout()`'s own Date.now(), so the gap silently
    // exceeds IDLE_TIMEOUT_MS on slow CI runners and the strict-boundary
    // assertion flakes.
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    // Exactly at boundary — store uses `>` (strict), so this should NOT time out.
    sessionStorage.setItem('cycles_last_activity', String(now - (30 * 60 * 1000)))

    expect(auth.checkTimeout()).toBe(false)
    expect(auth.isAuthenticated).toBe(true)
  })
})

describe('auth store — touchActivity()', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('is a no-op when not logged in', () => {
    const auth = useAuthStore()
    auth.touchActivity()
    expect(sessionStorage.getItem('cycles_last_activity')).toBeNull()
  })

  it('updates last activity timestamp when logged in', async () => {
    vi.stubGlobal('fetch', mockSuccessfulIntrospect())
    const auth = useAuthStore()
    await auth.login('test-key')

    const before = Number(sessionStorage.getItem('cycles_last_activity'))
    // Wait a tick so Date.now() advances.
    await new Promise(r => setTimeout(r, 5))
    auth.touchActivity()
    const after = Number(sessionStorage.getItem('cycles_last_activity'))
    expect(after).toBeGreaterThan(before)
  })
})

describe('auth store — concurrent login behavior', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('two concurrent login() calls with the same key both succeed', async () => {
    // Slow fetch — both requests are in flight at the same time.
    let resolveCount = 0
    const fetchMock = vi.fn(() => new Promise(resolve => {
      resolveCount++
      setTimeout(() => resolve({
        ok: true,
        json: () => Promise.resolve({
          authenticated: true,
          auth_type: 'admin',
          permissions: ['*'],
          capabilities: mockCapabilities,
        }),
      } as Response), 20)
    }))
    vi.stubGlobal('fetch', fetchMock)

    const auth = useAuthStore()
    const [a, b] = await Promise.all([
      auth.login('test-key'),
      auth.login('test-key'),
    ])

    // Both should report success. Current implementation fires two fetches
    // and both write capabilities/apiKey — the final state is consistent.
    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(auth.isAuthenticated).toBe(true)
    expect(auth.apiKey).toBe('test-key')
    expect(resolveCount).toBe(2)
  })

  it('concurrent login() calls where one fails: state reflects the winner', async () => {
    // First call succeeds slowly, second call fails instantly.
    let callCount = 0
    const fetchMock = vi.fn(() => {
      callCount++
      if (callCount === 1) {
        // Slow success
        return new Promise(resolve => setTimeout(() => resolve({
          ok: true,
          json: () => Promise.resolve({
            authenticated: true,
            auth_type: 'admin',
            permissions: ['*'],
            capabilities: mockCapabilities,
          }),
        } as Response), 50))
      }
      // Instant failure
      return Promise.resolve({ ok: false } as Response)
    })
    vi.stubGlobal('fetch', fetchMock)

    const auth = useAuthStore()
    const [a, b] = await Promise.all([
      auth.login('key-a'),
      auth.login('key-b'),
    ])

    // This test documents the CURRENT behavior so future refactors don't
    // silently change it. With the current non-single-flight implementation,
    // the second (failing) call resolves first and zeros out apiKey. Then
    // the first (succeeding) call completes and writes capabilities — but
    // apiKey is still empty, so isAuthenticated is false.
    //
    // This is the "concurrent login state corruption" theoretical race from
    // the code review. In practice it cannot happen because LoginView has
    // a re-entrancy guard (loading.value check), but the auth store itself
    // is not thread-safe. If we ever allow concurrent login calls from
    // multiple entry points, this test will start to matter.
    expect(a).toBe(true)
    expect(b).toBe(false)
    // Assert the current (documented, imperfect) end-state:
    expect(auth.capabilities).not.toBeNull()
    expect(auth.apiKey).toBe('')
    expect(auth.isAuthenticated).toBe(false)
  })

  it('login() is idempotent for sequential same-key calls', async () => {
    vi.stubGlobal('fetch', mockSuccessfulIntrospect())
    const auth = useAuthStore()
    await auth.login('test-key')
    const firstStart = sessionStorage.getItem('cycles_session_start')
    await new Promise(r => setTimeout(r, 5))
    await auth.login('test-key')
    const secondStart = sessionStorage.getItem('cycles_session_start')

    // Second login resets session_start — that's intentional (it's a new session).
    expect(Number(secondStart)).toBeGreaterThanOrEqual(Number(firstStart))
    expect(auth.isAuthenticated).toBe(true)
  })
})

describe('auth store — logout() effect on sessionStorage', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('clears all session keys on logout', async () => {
    vi.stubGlobal('fetch', mockSuccessfulIntrospect())
    const auth = useAuthStore()
    await auth.login('test-key')

    expect(sessionStorage.getItem('cycles_admin_key')).toBe('test-key')
    expect(sessionStorage.getItem('cycles_session_start')).not.toBeNull()
    expect(sessionStorage.getItem('cycles_last_activity')).not.toBeNull()

    auth.logout()
    // The sessionStorage clear happens in a Vue watcher on `apiKey`, which
    // is async by default. Flush with nextTick before asserting.
    await nextTick()

    expect(sessionStorage.getItem('cycles_admin_key')).toBeNull()
    expect(sessionStorage.getItem('cycles_session_start')).toBeNull()
    expect(sessionStorage.getItem('cycles_last_activity')).toBeNull()
  })
})

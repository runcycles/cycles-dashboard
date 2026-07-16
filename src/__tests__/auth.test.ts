import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'

describe('auth store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('starts unauthenticated', () => {
    const auth = useAuthStore()
    expect(auth.isAuthenticated).toBe(false)
    expect(auth.apiKey).toBe('')
    expect(auth.capabilities).toBeNull()
  })

  it('login succeeds with valid key', async () => {
    const mockResponse = {
      authenticated: true,
      auth_type: 'admin',
      permissions: ['*'],
      capabilities: {
        view_overview: true, view_budgets: true, view_events: true,
        view_webhooks: true, view_audit: true, view_tenants: true,
        view_api_keys: true, view_policies: true,
      },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }))

    const auth = useAuthStore()
    const result = await auth.login('test-key')

    expect(result).toBe(true)
    expect(auth.isAuthenticated).toBe(true)
    expect(auth.apiKey).toBe('test-key')
    expect(auth.capabilities?.view_overview).toBe(true)
  })

  it('login fails with invalid key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }))

    const auth = useAuthStore()
    const result = await auth.login('bad-key')

    expect(result).toBe(false)
    expect(auth.isAuthenticated).toBe(false)
    expect(auth.apiKey).toBe('')
    expect(auth.authFailure).toBe('invalid_credentials')
  })

  it('login keeps the submitted key on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))

    const auth = useAuthStore()
    const result = await auth.login('any-key')

    expect(result).toBe(false)
    expect(auth.isAuthenticated).toBe(false)
    expect(auth.apiKey).toBe('any-key')
    expect(auth.authFailure).toBe('service_unavailable')
  })

  it('login keeps the submitted key when the proxy returns 503', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))

    const auth = useAuthStore()
    const result = await auth.login('retry-key')

    expect(result).toBe(false)
    expect(auth.apiKey).toBe('retry-key')
    expect(auth.capabilities).toBeNull()
    expect(auth.authFailure).toBe('service_unavailable')
  })

  it('login clears the key when a successful introspection rejects it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ authenticated: false }),
    }))

    const auth = useAuthStore()
    expect(await auth.login('rejected-key')).toBe(false)
    expect(auth.apiKey).toBe('')
    expect(auth.authFailure).toBe('invalid_credentials')
  })

  it('logout clears state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        authenticated: true, auth_type: 'admin', permissions: ['*'],
        capabilities: { view_overview: true, view_budgets: true, view_events: true,
          view_webhooks: true, view_audit: true, view_tenants: true,
          view_api_keys: true, view_policies: true },
      }),
    }))

    const auth = useAuthStore()
    await auth.login('test-key')
    expect(auth.isAuthenticated).toBe(true)

    auth.logout()
    expect(auth.isAuthenticated).toBe(false)
    expect(auth.apiKey).toBe('')
    expect(auth.capabilities).toBeNull()
  })
})

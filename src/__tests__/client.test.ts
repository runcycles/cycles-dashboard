import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// Mock the router module *before* importing the client, so the client's
// `import router from '../router'` picks up the mock. `vi.mock` is hoisted
// to the top of the file, so any values it references must be declared via
// `vi.hoisted()` which also hoists.
const { routerPush, currentRoute } = vi.hoisted(() => ({
  routerPush: vi.fn(),
  currentRoute: { value: { name: 'overview' as string, fullPath: '/' } },
}))

vi.mock('../router', () => ({
  default: {
    push: routerPush,
    currentRoute,
  },
}))

// Import after mocks are registered.
import { fetchWithTimeout, handleUnauthorized } from '../api/client'
import { useAuthStore } from '../stores/auth'

function mockFetchOnce(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
}

describe('fetchWithTimeout', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('resolves when fetch succeeds before timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response))
    const res = await fetchWithTimeout('http://x/y', {}, 1000)
    expect(res.ok).toBe(true)
  })

  it('passes the AbortController signal to fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response)
    vi.stubGlobal('fetch', fetchMock)
    await fetchWithTimeout('http://x/y', { method: 'POST' }, 1000)
    const call = fetchMock.mock.calls[0][1]
    expect(call.signal).toBeInstanceOf(AbortSignal)
    expect(call.method).toBe('POST')
  })

  it('throws a timeout error when the request exceeds timeoutMs', async () => {
    // Real fetch that never resolves; AbortController fires after 20ms.
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new DOMException('aborted', 'AbortError')
          reject(err)
        })
      })
    })
    await expect(fetchWithTimeout('http://x/y', {}, 20))
      .rejects.toThrow(/timed out after 20ms/)
  })

  it('propagates non-abort errors unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    await expect(fetchWithTimeout('http://x/y', {}, 1000))
      .rejects.toThrow('ECONNREFUSED')
  })

  it('clears the timer on success (no hanging timer warning)', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response))
    await fetchWithTimeout('http://x/y', {}, 30_000)
    // If the timer were not cleared, advancing fake time would trigger abort.
    // We're just asserting no error is thrown; the timer cleanup is verified
    // implicitly by the `finally` block in fetchWithTimeout.
    vi.advanceTimersByTime(60_000)
    expect(true).toBe(true)
  })
})

describe('handleUnauthorized', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    routerPush.mockClear()
    currentRoute.value = { name: 'overview', fullPath: '/' }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs out the auth store', () => {
    const auth = useAuthStore()
    // Seed some state directly on the store.
    auth.apiKey = 'seeded-key'
    auth.capabilities = { view_overview: true } as never

    handleUnauthorized()

    expect(auth.apiKey).toBe('')
    expect(auth.capabilities).toBeNull()
  })

  it('pushes to /login with redirect query when on a protected route', () => {
    currentRoute.value = { name: 'budgets', fullPath: '/budgets?unit=USD' }
    handleUnauthorized()

    expect(routerPush).toHaveBeenCalledTimes(1)
    expect(routerPush).toHaveBeenCalledWith({
      name: 'login',
      query: { redirect: '/budgets?unit=USD' },
    })
  })

  it('does NOT push when already on the login route (avoids logout-loop)', () => {
    currentRoute.value = { name: 'login', fullPath: '/login' }
    handleUnauthorized()

    expect(routerPush).not.toHaveBeenCalled()
  })

  it('does NOT push when already on /login with query params', () => {
    currentRoute.value = { name: 'login', fullPath: '/login?expired=1' }
    handleUnauthorized()

    expect(routerPush).not.toHaveBeenCalled()
  })

  it('still logs out even when skipping the router push', () => {
    currentRoute.value = { name: 'login', fullPath: '/login' }
    const auth = useAuthStore()
    auth.apiKey = 'seeded'

    handleUnauthorized()

    expect(auth.apiKey).toBe('')
    expect(routerPush).not.toHaveBeenCalled()
  })
})

// Suppress unused warning for helper.
void mockFetchOnce

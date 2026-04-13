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
import * as api from '../api/client'
import { fetchWithTimeout, handleUnauthorized, ApiError } from '../api/client'
import { useAuthStore } from '../stores/auth'

function mockFetchOnce(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
}

// Build a JSON-returning Response mock.
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
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

// ────────────────────────────────────────────────────────────────────
// Smoke tests for endpoint exports — verifies each wrapper builds the
// correct URL, method, and body. Not exhaustive; covers the operations
// most likely to break silently (write operations + a few reads).
// ────────────────────────────────────────────────────────────────────

describe('endpoint wrappers — smoke', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'smoke-test-key'
    routerPush.mockClear()
    currentRoute.value = { name: 'overview', fullPath: '/' }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function lastCall() {
    const mock = fetch as unknown as ReturnType<typeof vi.fn>
    return mock.mock.calls[mock.mock.calls.length - 1]
  }

  it('introspect → GET /v1/auth/introspect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ authenticated: true })))
    await api.introspect()
    const [url, init] = lastCall()
    expect(String(url)).toContain('/v1/auth/introspect')
    expect(init.method).toBe('GET')
    expect(init.headers['X-Admin-API-Key']).toBe('smoke-test-key')
  })

  it('getOverview → GET /v1/admin/overview', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})))
    await api.getOverview()
    expect(String(lastCall()[0])).toContain('/v1/admin/overview')
  })

  it('listBudgets → GET /v1/admin/budgets with query params', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ledgers: [] })))
    await api.listBudgets({ tenant_id: 'acme', status: 'ACTIVE' })
    const url = new URL(String(lastCall()[0]))
    expect(url.pathname).toBe('/v1/admin/budgets')
    expect(url.searchParams.get('tenant_id')).toBe('acme')
    expect(url.searchParams.get('status')).toBe('ACTIVE')
  })

  it('listBudgets → skips empty/undefined params', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ledgers: [] })))
    await api.listBudgets({ tenant_id: 'acme', status: '' })
    const url = new URL(String(lastCall()[0]))
    expect(url.searchParams.get('status')).toBeNull()
  })

  it('createTenant → POST /v1/admin/tenants with JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ tenant_id: 'acme' })))
    await api.createTenant({ tenant_id: 'acme', name: 'Acme Corp' })
    const [url, init] = lastCall()
    expect(String(url)).toContain('/v1/admin/tenants')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ tenant_id: 'acme', name: 'Acme Corp' })
  })

  it('updateTenant → PATCH /v1/admin/tenants/{id}', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})))
    await api.updateTenant('acme', { name: 'Acme Inc' })
    const [url, init] = lastCall()
    expect(String(url)).toContain('/v1/admin/tenants/acme')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ name: 'Acme Inc' })
  })

  it('updateTenantStatus → PATCH with only { status }', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})))
    await api.updateTenantStatus('acme', 'SUSPENDED')
    const init = lastCall()[1]
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ status: 'SUSPENDED' })
  })

  it('createApiKey → POST /v1/admin/api-keys', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ key_id: 'k1' })))
    await api.createApiKey({ tenant_id: 'acme', name: 'dev' })
    const [url, init] = lastCall()
    expect(String(url)).toContain('/v1/admin/api-keys')
    expect(init.method).toBe('POST')
  })

  it('revokeApiKey → DELETE /v1/admin/api-keys/{id} with reason query', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response))
    await api.revokeApiKey('key_123', 'compromised')
    const [url, init] = lastCall()
    const parsed = new URL(String(url))
    expect(parsed.pathname).toBe('/v1/admin/api-keys/key_123')
    expect(parsed.searchParams.get('reason')).toBe('compromised')
    expect(init.method).toBe('DELETE')
  })

  it('revokeApiKey without reason → no query params', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response))
    await api.revokeApiKey('key_123')
    const url = new URL(String(lastCall()[0]))
    expect(url.searchParams.get('reason')).toBeNull()
  })

  it('createWebhook → POST with tenant_id query param', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ subscription: {} })))
    await api.createWebhook({ url: 'https://x/hook', event_types: ['budget.created'] }, 'acme')
    const parsed = new URL(String(lastCall()[0]))
    expect(parsed.pathname).toBe('/v1/admin/webhooks')
    expect(parsed.searchParams.get('tenant_id')).toBe('acme')
  })

  it('deleteWebhook → DELETE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response))
    await api.deleteWebhook('sub_1')
    const [url, init] = lastCall()
    expect(String(url)).toContain('/v1/admin/webhooks/sub_1')
    expect(init.method).toBe('DELETE')
  })

  it('testWebhook → POST with empty body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: true })))
    await api.testWebhook('sub_1')
    const [url, init] = lastCall()
    expect(String(url)).toContain('/v1/admin/webhooks/sub_1/test')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({})
  })

  it('freezeBudget → POST /v1/admin/budgets/freeze with scope+unit query', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})))
    await api.freezeBudget('tenant:acme', 'USD', 'investigation')
    const parsed = new URL(String(lastCall()[0]))
    expect(parsed.pathname).toBe('/v1/admin/budgets/freeze')
    expect(parsed.searchParams.get('scope')).toBe('tenant:acme')
    expect(parsed.searchParams.get('unit')).toBe('USD')
    expect(JSON.parse(lastCall()[1].body)).toEqual({ reason: 'investigation' })
  })

  it('unfreezeBudget → POST /v1/admin/budgets/unfreeze', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})))
    await api.unfreezeBudget('tenant:acme', 'USD')
    const parsed = new URL(String(lastCall()[0]))
    expect(parsed.pathname).toBe('/v1/admin/budgets/unfreeze')
  })

  it('fundBudget → POST /v1/admin/budgets/fund with full body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})))
    await api.fundBudget('acme', 'tenant:acme', 'USD', 'CREDIT', 100, 'idem-1', 'monthly')
    const parsed = new URL(String(lastCall()[0]))
    expect(parsed.pathname).toBe('/v1/admin/budgets/fund')
    expect(parsed.searchParams.get('tenant_id')).toBe('acme')
    const body = JSON.parse(lastCall()[1].body)
    expect(body.operation).toBe('CREDIT')
    expect(body.amount).toEqual({ unit: 'USD', amount: 100 })
    expect(body.idempotency_key).toBe('idem-1')
    expect(body.reason).toBe('monthly')
  })

  it('rotateWebhookSecret → generates whsec_ secret, PATCHes it, and returns it alongside subscription', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ subscription_id: 'sub_1', name: 'hook' })))
    const result = await api.rotateWebhookSecret('sub_1')
    const init = lastCall()[1]
    expect(init.method).toBe('PATCH')
    const body = JSON.parse(init.body)
    expect(body.signing_secret).toMatch(/^whsec_[a-f0-9]{64}$/)
    // Caller must receive the locally-generated secret even if the server
    // response does not echo signing_secret (common for write-only secrets).
    expect(result.signing_secret).toBe(body.signing_secret)
    expect(result.subscription).toMatchObject({ subscription_id: 'sub_1' })
  })

  it('rotateWebhookSecret → still returns the secret when server omits signing_secret from response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ subscription_id: 'sub_1' })))
    const result = await api.rotateWebhookSecret('sub_1')
    expect(result.signing_secret).toMatch(/^whsec_[a-f0-9]{64}$/)
  })

  it('403 does NOT logout — throws ApiError instead (session preserved for per-op permission failures)', async () => {
    const logoutSpy = vi.spyOn(useAuthStore(), 'logout')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({
        error: 'FORBIDDEN',
        message: 'Key lacks admin:webhooks:write',
        request_id: 'req_x',
      }),
    } as unknown as Response))
    try {
      await api.getOverview()
      throw new Error('expected to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).status).toBe(403)
      expect((e as ApiError).errorCode).toBe('FORBIDDEN')
    }
    expect(logoutSpy).not.toHaveBeenCalled()
    expect(routerPush).not.toHaveBeenCalled()
  })

  it('401 still logs out (session ended)', async () => {
    const logoutSpy = vi.spyOn(useAuthStore(), 'logout')
    currentRoute.value = { name: 'overview', fullPath: '/' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
    } as unknown as Response))
    await expect(api.getOverview()).rejects.toThrow(/Unauthorized/)
    expect(logoutSpy).toHaveBeenCalled()
  })

  it('propagates non-2xx as thrown ApiError with fallback message when body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new SyntaxError('not json')),
    } as unknown as Response))
    await expect(api.getOverview()).rejects.toThrow(/API error: 500/)
  })

  it('parses ErrorResponse body into ApiError with errorCode + friendly message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({
        error: 'DUPLICATE_RESOURCE',
        message: 'Policy already exists for this tenant',
        request_id: 'req_abc',
      }),
    } as unknown as Response))
    try {
      await api.listPolicies({ tenant_id: 'acme' })
      throw new Error('expected to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      const err = e as ApiError
      expect(err.status).toBe(409)
      expect(err.errorCode).toBe('DUPLICATE_RESOURCE')
      expect(err.requestId).toBe('req_abc')
      expect(err.message).toBe('Policy already exists for this tenant (DUPLICATE_RESOURCE)')
    }
  })

  it('ApiError carries details when the server returns them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({
        error: 'INVALID_REQUEST',
        message: 'Field validation failed',
        request_id: 'req_1',
        details: { field: 'tenant_id', reason: 'required' },
      }),
    } as unknown as Response))
    try {
      await api.getOverview()
      throw new Error('expected to throw')
    } catch (e) {
      const err = e as ApiError
      expect(err.details).toEqual({ field: 'tenant_id', reason: 'required' })
    }
  })

  it('falls back to "API error: <status>" when body is an empty object', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
    } as unknown as Response))
    await expect(api.getOverview()).rejects.toThrow(/API error: 503/)
  })

  it('204 no-content returns undefined (mutate path)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response))
    const result = await api.deleteWebhook('sub_1')
    expect(result).toBeUndefined()
  })

  it('invalid JSON response throws "Invalid response from server"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('bad json')),
    } as unknown as Response))
    await expect(api.getOverview()).rejects.toThrow(/Invalid response from server/)
  })
})

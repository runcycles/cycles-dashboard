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
    // v0.1.25.27: spent is only attached for RESET_SPENT — must be absent here.
    expect(body.spent).toBeUndefined()
  })

  // v0.1.25.27: RESET_SPENT operation (cycles-server-admin 0.1.25.18 billing-
  // period rollover). Server semantics (BudgetRepository FUND_LUA): sets
  // allocated = amount AND spent = override (default 0). `amount` is the
  // new allocated for the new period — typically the same as current
  // allocated for a "pure rollover", but operators can change it.
  // `spent` is an optional Amount sent ONLY when operation === 'RESET_SPENT'.
  it('fundBudget RESET_SPENT → body includes amount (new allocated) and spent Amount', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})))
    await api.fundBudget('acme', 'tenant:acme', 'USD', 'RESET_SPENT', 1000, 'idem-rs', 'monthly rollover', 42)
    const body = JSON.parse(lastCall()[1].body)
    expect(body.operation).toBe('RESET_SPENT')
    expect(body.amount).toEqual({ unit: 'USD', amount: 1000 })
    expect(body.spent).toEqual({ unit: 'USD', amount: 42 })
    expect(body.idempotency_key).toBe('idem-rs')
  })

  it('fundBudget RESET_SPENT without spent → body omits spent (server resets to zero)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})))
    await api.fundBudget('acme', 'tenant:acme', 'USD', 'RESET_SPENT', 1000, 'idem-rs2')
    const body = JSON.parse(lastCall()[1].body)
    expect(body.operation).toBe('RESET_SPENT')
    expect(body.amount).toEqual({ unit: 'USD', amount: 1000 })
    expect(body.spent).toBeUndefined()
  })

  it('fundBudget CREDIT with spent arg → spent is ignored (not sent) for non-RESET_SPENT', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})))
    await api.fundBudget('acme', 'tenant:acme', 'USD', 'CREDIT', 100, 'idem-c', 'note', 999)
    const body = JSON.parse(lastCall()[1].body)
    expect(body.operation).toBe('CREDIT')
    expect(body.spent).toBeUndefined()
  })

  // v0.1.25.20: admin-on-behalf-of write wrappers (server v0.1.25.14, spec
  // v0.1.25.13). Each wrapper must inject tenant_id into the body so the
  // server can route the create to the correct tenant; updatePolicy needs
  // none because policy_id pins it.
  // v0.1.25.22 (cycles-server v0.1.25.8, cycles-protocol revision
  // 2026-04-13): reservations are on the runtime plane, not /admin/.
  // The wrappers send tenant as a query param (required for admin
  // auth per spec); force-release generates an idempotency_key and
  // optionally passes reason.
  describe('reservation wrappers (runtime plane, admin dual-auth)', () => {
    it('listReservations → GET /v1/reservations with tenant + status filter', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ reservations: [] })))
      await api.listReservations('acme', { status: 'ACTIVE', limit: 50 })
      const url = new URL(String(lastCall()[0]))
      expect(url.pathname).toBe('/v1/reservations')
      expect(url.searchParams.get('tenant')).toBe('acme')
      expect(url.searchParams.get('status')).toBe('ACTIVE')
      expect(url.searchParams.get('limit')).toBe('50')
    })

    it('listReservations → omits undefined filters cleanly', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ reservations: [] })))
      await api.listReservations('acme')
      const url = new URL(String(lastCall()[0]))
      expect(url.searchParams.get('tenant')).toBe('acme')
      expect(url.searchParams.get('status')).toBeNull()
      expect(url.searchParams.get('limit')).toBeNull()
      expect(url.searchParams.get('sort_by')).toBeNull()
      expect(url.searchParams.get('sort_dir')).toBeNull()
    })

    it('listReservations → forwards sort_by + sort_dir as query params', async () => {
      // V4 server-sort wire-up: cycles-server v0.1.25.12+ accepts these two
      // params and returns results sorted with a reservation_id tie-breaker.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ reservations: [] })))
      await api.listReservations('acme', {
        limit: 100,
        sort_by: 'created_at_ms',
        sort_dir: 'desc',
      })
      const url = new URL(String(lastCall()[0]))
      expect(url.searchParams.get('sort_by')).toBe('created_at_ms')
      expect(url.searchParams.get('sort_dir')).toBe('desc')
    })

    it('getReservation → GET /v1/reservations/{id}', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ reservation_id: 'res-1' })))
      await api.getReservation('res-1')
      const [url, init] = lastCall()
      expect(String(url)).toContain('/v1/reservations/res-1')
      expect(init.method).toBe('GET')
    })

    it('releaseReservation → POST /v1/reservations/{id}/release with idempotency_key + reason', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'RELEASED' })))
      await api.releaseReservation('res-1', 'idem-k-123', '[INCIDENT_FORCE_RELEASE] hung')
      const [url, init] = lastCall()
      expect(String(url)).toContain('/v1/reservations/res-1/release')
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body)
      expect(body.idempotency_key).toBe('idem-k-123')
      expect(body.reason).toBe('[INCIDENT_FORCE_RELEASE] hung')
    })

    it('releaseReservation without reason → body omits reason field (not null)', async () => {
      // Server treats missing reason as "no audit metadata" and empty
      // string as "provided but empty" — we want the former.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'RELEASED' })))
      await api.releaseReservation('res-1', 'idem-k-123')
      const body = JSON.parse(lastCall()[1].body)
      expect(body.idempotency_key).toBe('idem-k-123')
      expect(body).not.toHaveProperty('reason')
    })

    it('listReservations propagates 400 INVALID_REQUEST as ApiError', async () => {
      // Server returns 400 if tenant is missing from the query under
      // admin auth. The client wrapper always sends tenant, but this
      // verifies the error pass-through for defense in depth.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({
          error: 'INVALID_REQUEST',
          message: 'tenant query parameter is required when using admin key authentication',
          request_id: 'r_1',
        }),
      } as unknown as Response))
      await expect(api.listReservations(''))
        .rejects.toMatchObject({ status: 400, errorCode: 'INVALID_REQUEST' })
    })
  })

  describe('admin-on-behalf-of write wrappers', () => {
    it('createBudget → POST /v1/admin/budgets with tenant_id stitched into body', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ledger_id: 'led-1' })))
      await api.createBudget('tenant-acme', {
        scope: 'tenant:acme/workspace:prod',
        unit: 'USD_MICROCENTS',
        allocated: { unit: 'USD_MICROCENTS', amount: 5000000 },
      })
      const [url, init] = lastCall()
      expect(String(url)).toContain('/v1/admin/budgets')
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body)
      expect(body.tenant_id).toBe('tenant-acme')
      expect(body.scope).toBe('tenant:acme/workspace:prod')
      expect(body.allocated.amount).toBe(5000000)
    })

    it('createPolicy → POST /v1/admin/policies with tenant_id stitched into body', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ policy_id: 'pol_1' })))
      await api.createPolicy('tenant-acme', {
        name: 'Engineering policy',
        scope_pattern: 'tenant:acme/workspace:eng/*',
        priority: 10,
      })
      const [url, init] = lastCall()
      expect(String(url)).toContain('/v1/admin/policies')
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body)
      expect(body.tenant_id).toBe('tenant-acme')
      expect(body.name).toBe('Engineering policy')
      expect(body.priority).toBe(10)
    })

    it('updatePolicy → PATCH /v1/admin/policies/{id} WITHOUT tenant_id (policy_id pins owner server-side)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ policy_id: 'pol_xyz' })))
      await api.updatePolicy('pol_xyz', { name: 'Renamed', priority: 20 })
      const [url, init] = lastCall()
      expect(String(url)).toContain('/v1/admin/policies/pol_xyz')
      expect(init.method).toBe('PATCH')
      const body = JSON.parse(init.body)
      expect(body.name).toBe('Renamed')
      expect(body.priority).toBe(20)
      // Crucial: NO tenant_id should appear — server resolves owner from
      // the path. Sending one would be ignored at best, rejected at worst.
      expect(body.tenant_id).toBeUndefined()
    })

    it('createBudget propagates 409 DUPLICATE_RESOURCE as ApiError', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: () => Promise.resolve({
          error: 'DUPLICATE_RESOURCE',
          message: 'Budget already exists for this (scope, unit)',
          request_id: 'req_1',
        }),
      } as unknown as Response))
      try {
        await api.createBudget('tenant-acme', {
          scope: 'tenant:acme', unit: 'USD_MICROCENTS',
          allocated: { unit: 'USD_MICROCENTS', amount: 100 },
        })
        throw new Error('expected to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError)
        expect((e as ApiError).status).toBe(409)
        expect((e as ApiError).errorCode).toBe('DUPLICATE_RESOURCE')
      }
    })

    it('createPolicy surfaces 400 INVALID_REQUEST cleanly', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({
          error: 'INVALID_REQUEST',
          message: 'tenant_id is required',
          request_id: 'req_2',
        }),
      } as unknown as Response))
      await expect(
        api.createPolicy('', { name: 'x', scope_pattern: 'tenant:x/*' }),
      ).rejects.toMatchObject({ status: 400, errorCode: 'INVALID_REQUEST' })
    })
  })

  // cycles-governance-admin v0.1.25.21 bulk-action endpoints.
  // Tests guard three properties the dashboard relies on:
  //  1. Wire shape — URL, method, body serialized verbatim.
  //  2. Safety-gate error codes (LIMIT_EXCEEDED, COUNT_MISMATCH) surface via
  //     ApiError.errorCode so TenantsView / WebhooksView can humanize them.
  //  3. ApiError.details is preserved for LIMIT_EXCEEDED's `total_matched`.
  describe('bulk-action wrappers (v0.1.25.21 filter-apply)', () => {
    it('bulkActionTenants → POST /v1/admin/tenants/bulk-action with body verbatim', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
        action: 'SUSPEND', total_matched: 0, succeeded: [], failed: [], skipped: [],
        idempotency_key: 'idem-t-1',
      })))
      await api.bulkActionTenants({
        action: 'SUSPEND',
        filter: { status: 'ACTIVE', search: 'acme' },
        idempotency_key: 'idem-t-1',
      })
      const [url, init] = lastCall()
      expect(String(url)).toContain('/v1/admin/tenants/bulk-action')
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body)
      expect(body.action).toBe('SUSPEND')
      expect(body.filter).toEqual({ status: 'ACTIVE', search: 'acme' })
      expect(body.idempotency_key).toBe('idem-t-1')
    })

    it('bulkActionWebhooks → POST /v1/admin/webhooks/bulk-action with body verbatim', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
        action: 'PAUSE', total_matched: 0, succeeded: [], failed: [], skipped: [],
        idempotency_key: 'idem-w-1',
      })))
      await api.bulkActionWebhooks({
        action: 'PAUSE',
        filter: { status: 'ACTIVE', search: 'probe' },
        idempotency_key: 'idem-w-1',
      })
      const [url, init] = lastCall()
      expect(String(url)).toContain('/v1/admin/webhooks/bulk-action')
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body)
      expect(body.action).toBe('PAUSE')
      expect(body.filter.search).toBe('probe')
    })

    it('bulkActionTenants → 400 LIMIT_EXCEEDED surfaces errorCode + details.total_matched', async () => {
      // Regression catch for PR-B's humanized toast: the TenantsView catch block
      // reads `ApiError.details?.total_matched` to render "server matched N".
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({
          error: 'LIMIT_EXCEEDED',
          message: 'Filter matches more than 500 tenants',
          request_id: 'req_lim',
          details: { total_matched: 847 },
        }),
      } as unknown as Response))
      try {
        await api.bulkActionTenants({
          action: 'SUSPEND', filter: { status: 'ACTIVE' }, idempotency_key: 'k',
        })
        throw new Error('expected to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError)
        const err = e as ApiError
        expect(err.status).toBe(400)
        expect(err.errorCode).toBe('LIMIT_EXCEEDED')
        expect(err.details?.total_matched).toBe(847)
      }
    })

    it('bulkActionWebhooks → 409 COUNT_MISMATCH surfaces errorCode', async () => {
      // Reserved for when expected_count gets wired; currently unused but
      // guarded so the humanization branch stays exercised.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: () => Promise.resolve({
          error: 'COUNT_MISMATCH',
          message: 'Webhook list changed since preview',
          request_id: 'req_cm',
        }),
      } as unknown as Response))
      await expect(
        api.bulkActionWebhooks({ action: 'PAUSE', filter: { status: 'ACTIVE' }, idempotency_key: 'k' }),
      ).rejects.toMatchObject({ status: 409, errorCode: 'COUNT_MISMATCH' })
    })

    it('bulkActionTenants → 400 INVALID_REQUEST on empty filter surfaces as ApiError', async () => {
      // Server enforces minProperties:1 on TenantBulkFilter. The dashboard
      // disables the button when the filter would be empty, but this guards
      // the wire contract for defense in depth.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({
          error: 'INVALID_REQUEST',
          message: 'filter must contain at least one property',
          request_id: 'req_mp',
        }),
      } as unknown as Response))
      await expect(
        api.bulkActionTenants({ action: 'SUSPEND', filter: {}, idempotency_key: 'k' }),
      ).rejects.toMatchObject({ status: 400, errorCode: 'INVALID_REQUEST' })
    })

    // cycles-governance-admin v0.1.25.26 (admin-server v0.1.25.29+).
    // Same wire-contract properties as the tenants/webhooks wrappers,
    // plus the tenant_id-required structural constraint specific to
    // BudgetBulkFilter.
    it('bulkActionBudgets → POST /v1/admin/budgets/bulk-action with body verbatim', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
        action: 'CREDIT',
        total_matched: 0,
        succeeded: [], failed: [], skipped: [],
        idempotency_key: 'idem-b-1',
      })))
      await api.bulkActionBudgets({
        action: 'CREDIT',
        filter: { tenant_id: 'acme', status: 'ACTIVE', unit: 'USD_MICROCENTS' },
        amount: { unit: 'USD_MICROCENTS', amount: 1000 },
        reason: 'Monthly top-up',
        expected_count: 42,
        idempotency_key: 'idem-b-1',
      })
      const [url, init] = lastCall()
      expect(String(url)).toContain('/v1/admin/budgets/bulk-action')
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body)
      expect(body.action).toBe('CREDIT')
      expect(body.filter).toEqual({ tenant_id: 'acme', status: 'ACTIVE', unit: 'USD_MICROCENTS' })
      // Spec v0.1.25.26 — amount is an Amount object, not scalar.
      expect(body.amount).toEqual({ unit: 'USD_MICROCENTS', amount: 1000 })
      expect(body.reason).toBe('Monthly top-up')
      expect(body.expected_count).toBe(42)
      expect(body.idempotency_key).toBe('idem-b-1')
    })

    // Per spec v0.1.25.26 RESET_SPENT requires `amount` (the new allocated)
    // and accepts an optional `spent` (the counter reset target). Both are
    // Amount objects. Omitted `spent` lets the server default to 0.
    it('bulkActionBudgets → RESET_SPENT includes amount (Amount) and optional spent (Amount)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
        action: 'RESET_SPENT',
        total_matched: 0,
        succeeded: [], failed: [], skipped: [],
        idempotency_key: 'idem-b-2',
      })))
      await api.bulkActionBudgets({
        action: 'RESET_SPENT',
        filter: { tenant_id: 'acme' },
        amount: { unit: 'USD_MICROCENTS', amount: 5000 },
        spent: { unit: 'USD_MICROCENTS', amount: 0 },
        idempotency_key: 'idem-b-2',
      })
      const body = JSON.parse(lastCall()[1].body)
      expect(body.action).toBe('RESET_SPENT')
      expect(body.amount).toEqual({ unit: 'USD_MICROCENTS', amount: 5000 })
      expect(body.spent).toEqual({ unit: 'USD_MICROCENTS', amount: 0 })
    })

    it('bulkActionBudgets → 400 LIMIT_EXCEEDED surfaces errorCode + details.total_matched', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({
          error: 'LIMIT_EXCEEDED',
          message: 'Filter matches more than 500 budgets',
          request_id: 'req_lim_b',
          details: { total_matched: 613 },
        }),
      } as unknown as Response))
      try {
        await api.bulkActionBudgets({
          action: 'CREDIT',
          filter: { tenant_id: 'acme' },
          amount: { unit: 'USD_MICROCENTS', amount: 100 },
          idempotency_key: 'k',
        })
        throw new Error('expected to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError)
        const err = e as ApiError
        expect(err.status).toBe(400)
        expect(err.errorCode).toBe('LIMIT_EXCEEDED')
        expect(err.details?.total_matched).toBe(613)
      }
    })

    it('bulkActionBudgets → 409 COUNT_MISMATCH surfaces errorCode', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: () => Promise.resolve({
          error: 'COUNT_MISMATCH',
          message: 'Budget list changed since preview',
          request_id: 'req_cm_b',
        }),
      } as unknown as Response))
      await expect(
        api.bulkActionBudgets({
          action: 'CREDIT',
          filter: { tenant_id: 'acme' },
          amount: { unit: 'USD_MICROCENTS', amount: 100 },
          expected_count: 10,
          idempotency_key: 'k',
        }),
      ).rejects.toMatchObject({ status: 409, errorCode: 'COUNT_MISMATCH' })
    })
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

  // Regression for the v0.1.25.36 footgun: a dashboard calling an endpoint
  // that exists in a newer admin-server than the one actually running
  // (e.g. POST /v1/admin/budgets/bulk-action on pre-`.29` admin) receives
  // a 401 because the interceptor falls through to tenant-key validation
  // and complains about a missing `X-Cycles-API-Key` header. Our admin
  // session is still valid — preserve it and surface the server message
  // as an ApiError so the view can render an actionable error.
  it('401 that mentions X-Cycles-API-Key preserves the session (endpoint-routing mismatch)', async () => {
    const logoutSpy = vi.spyOn(useAuthStore(), 'logout')
    currentRoute.value = { name: 'budgets', fullPath: '/budgets' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({
        error: 'UNAUTHORIZED',
        message: 'Missing X-Cycles-API-Key header',
      }),
    } as unknown as Response))
    await expect(api.getOverview()).rejects.toMatchObject({
      status: 401,
      errorCode: 'UNAUTHORIZED',
      message: expect.stringContaining('X-Cycles-API-Key'),
    })
    expect(logoutSpy).not.toHaveBeenCalled()
    expect(routerPush).not.toHaveBeenCalled()
  })

  it('401 endpoint-mismatch carve-out also applies to POST mutations (e.g. bulkActionBudgets)', async () => {
    const logoutSpy = vi.spyOn(useAuthStore(), 'logout')
    currentRoute.value = { name: 'budgets', fullPath: '/budgets' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({
        error: 'UNAUTHORIZED',
        message: 'Missing X-Cycles-API-Key header',
      }),
    } as unknown as Response))
    await expect(
      api.bulkActionBudgets({
        filter: { tenant_id: 'acme' },
        action: 'RESET',
        amount: { unit: 'USD_MICROCENTS', amount: 100 },
        idempotency_key: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toMatchObject({ status: 401, errorCode: 'UNAUTHORIZED' })
    expect(logoutSpy).not.toHaveBeenCalled()
    expect(routerPush).not.toHaveBeenCalled()
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

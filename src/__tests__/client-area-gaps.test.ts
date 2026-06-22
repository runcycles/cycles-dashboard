import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// Mirror client.test.ts's router mock so the client's `import router` is
// satisfied without pulling in the real router.
const { routerPush, currentRoute } = vi.hoisted(() => ({
  routerPush: vi.fn(),
  currentRoute: { value: { name: 'overview' as string, fullPath: '/' } },
}))
vi.mock('../router', () => ({
  default: { push: routerPush, currentRoute },
}))

import * as api from '../api/client'
import { useAuthStore } from '../stores/auth'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

describe('Area A/C client wrappers — reservation projections, filters, evidence', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().apiKey = 'test-key'
    routerPush.mockClear()
    currentRoute.value = { name: 'overview', fullPath: '/' }
  })
  afterEach(() => vi.restoreAllMocks())

  function lastUrl(): URL {
    const mock = fetch as unknown as ReturnType<typeof vi.fn>
    return new URL(String(mock.mock.calls[mock.mock.calls.length - 1][0]))
  }

  it('listReservations forwards the include projection token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ reservations: [] })))
    await api.listReservations('acme', { include: 'metadata,committed_metadata' })
    expect(lastUrl().searchParams.get('include')).toBe('metadata,committed_metadata')
  })

  it('listReservations forwards all three time-window pairs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ reservations: [] })))
    await api.listReservations('acme', {
      from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z',
      expires_from: '2026-01-05T00:00:00.000Z', expires_to: '2026-01-10T00:00:00.000Z',
      finalized_from: '2026-01-06T00:00:00.000Z', finalized_to: '2026-01-07T00:00:00.000Z',
    })
    const p = lastUrl().searchParams
    expect(p.get('from')).toBe('2026-01-01T00:00:00.000Z')
    expect(p.get('to')).toBe('2026-02-01T00:00:00.000Z')
    expect(p.get('expires_from')).toBe('2026-01-05T00:00:00.000Z')
    expect(p.get('expires_to')).toBe('2026-01-10T00:00:00.000Z')
    expect(p.get('finalized_from')).toBe('2026-01-06T00:00:00.000Z')
    expect(p.get('finalized_to')).toBe('2026-01-07T00:00:00.000Z')
  })

  it('listReservations forwards subject filters and skips blank bounds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ reservations: [] })))
    await api.listReservations('acme', {
      workspace: 'prod', app: 'billing', workflow: 'wf1', agent: 'a1', toolset: 'ts1',
      from: '', expires_from: '',
    })
    const p = lastUrl().searchParams
    expect(p.get('workspace')).toBe('prod')
    expect(p.get('app')).toBe('billing')
    expect(p.get('workflow')).toBe('wf1')
    expect(p.get('agent')).toBe('a1')
    expect(p.get('toolset')).toBe('ts1')
    // Blank bounds are dropped (spec treats blank as unset).
    expect(p.get('from')).toBeNull()
    expect(p.get('expires_from')).toBeNull()
  })

  it('getReservation requests both metadata projections', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ reservation_id: 'r1' })))
    await api.getReservation('r1')
    const url = lastUrl()
    expect(url.pathname).toBe('/v1/reservations/r1')
    expect(url.searchParams.get('include')).toBe('metadata,committed_metadata,evidence')
  })

  it('getEvidence → GET /v1/evidence/{id}', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ evidence_id: 'abc' })))
    await api.getEvidence('a'.repeat(64))
    expect(lastUrl().pathname).toBe(`/v1/evidence/${'a'.repeat(64)}`)
  })

  it('getEvidenceJwks → GET /v1/.well-known/cycles-jwks.json', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ keys: [] })))
    await api.getEvidenceJwks()
    expect(lastUrl().pathname).toBe('/v1/.well-known/cycles-jwks.json')
  })

  it('releaseReservation surfaces cycles_evidence from the response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      status: 'RELEASED',
      cycles_evidence: { evidence_id: 'e1', cycles_evidence_url: 'https://x/v1/evidence/e1' },
    })))
    const res = await api.releaseReservation('r1', 'idem-1')
    expect(res.cycles_evidence?.evidence_id).toBe('e1')
  })
})

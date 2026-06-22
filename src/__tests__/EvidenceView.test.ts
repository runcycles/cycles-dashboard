// EvidenceView: fetch + render, transient-404 retry affordance, malformed
// id guard, and signer-key resolution against a JWK Set.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import { ApiError } from '../api/client'

const getEvidenceMock = vi.fn()
const getEvidenceJwksMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    getEvidence: (...a: unknown[]) => getEvidenceMock(...a),
    getEvidenceJwks: (...a: unknown[]) => getEvidenceJwksMock(...a),
  }
})

const routeRef: { query: Record<string, string> } = { query: {} }
const replaceMock = vi.fn()
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: replaceMock }),
    useRoute: () => routeRef,
    RouterLink: { template: '<a><slot /></a>' },
  }
})

const HEX64 = 'a'.repeat(64)
const ENVELOPE = {
  schema_version: 'cycles-evidence/v0.1',
  artifact_type: 'release',
  server_id: 'https://cycles.example/v1',
  signer_did: 'did:cycles:abc#key-1',
  issued_at_ms: 1_700_000_000_000,
  payload: { release: { released: { unit: 'USD_MICROCENTS', amount: 5 } } },
  evidence_id: HEX64,
  signature: 'b'.repeat(128),
}

function stdMount() {
  return { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } }
}

async function mountView() {
  const { default: EvidenceView } = await import('../views/EvidenceView.vue')
  const w = mount(EvidenceView, stdMount())
  await flushPromises()
  return w
}

describe('EvidenceView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().apiKey = 'test-key'
    getEvidenceMock.mockReset()
    getEvidenceJwksMock.mockReset()
    replaceMock.mockReset()
    routeRef.query = {}
  })

  it('auto-fetches and renders the envelope when ?id= is present', async () => {
    routeRef.query = { id: HEX64 }
    getEvidenceMock.mockResolvedValue(ENVELOPE)
    const w = await mountView()
    expect(getEvidenceMock).toHaveBeenCalledWith(HEX64)
    expect(w.text()).toContain('release envelope')
    expect(w.text()).toContain('did:cycles:abc#key-1')
  })

  it('rejects a malformed id without calling the API', async () => {
    const w = await mountView()
    await w.find('#ev-id').setValue('not-hex')
    const fetchBtn = w.findAll('button').find(b => b.text() === 'Fetch')
    expect(fetchBtn).toBeTruthy()
    await fetchBtn!.trigger('click')
    await flushPromises()
    expect(getEvidenceMock).not.toHaveBeenCalled()
    expect(w.text()).toContain('64 lowercase hex')
  })

  it('shows a retry affordance on a transient 404', async () => {
    routeRef.query = { id: HEX64 }
    getEvidenceMock.mockRejectedValue(new ApiError(404, 'not found'))
    const w = await mountView()
    expect(w.text()).toContain('not available yet')
    expect(w.text()).toContain('Retry')
  })

  it('resolves a signer key valid at the envelope issuance time', async () => {
    routeRef.query = { id: HEX64 }
    getEvidenceMock.mockResolvedValue(ENVELOPE)
    getEvidenceJwksMock.mockResolvedValue({
      keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'xx', kid: 'key-1', cycles_nbf_ms: 1, cycles_exp_ms: null }],
    })
    const w = await mountView()
    const resolveBtn = w.findAll('button').find(b => b.text().includes('Resolve signer key'))
    expect(resolveBtn).toBeTruthy()
    await resolveBtn!.trigger('click')
    await flushPromises()
    expect(getEvidenceJwksMock).toHaveBeenCalled()
    expect(w.text()).toContain("valid at the envelope's issuance time")
  })

  it('validates against issuance time, not now — a since-retired key still resolves', async () => {
    // Envelope issued at t=1700000000000. The key window [nbf, exp) covers
    // issuance but exp is in the past relative to Date.now(), so a
    // now-based check would wrongly flag it. Locks the audit-semantics fix.
    routeRef.query = { id: HEX64 }
    getEvidenceMock.mockResolvedValue(ENVELOPE)
    getEvidenceJwksMock.mockResolvedValue({
      keys: [{
        kty: 'OKP', crv: 'Ed25519', x: 'xx', kid: 'key-1',
        cycles_nbf_ms: 1_699_000_000_000,
        cycles_exp_ms: 1_700_000_000_001, // expired ~2023, but > issued_at_ms
      }],
    })
    const w = await mountView()
    const resolveBtn = w.findAll('button').find(b => b.text().includes('Resolve signer key'))
    await resolveBtn!.trigger('click')
    await flushPromises()
    expect(w.text()).toContain("valid at the envelope's issuance time")
    expect(w.text()).not.toContain('NOT valid')
  })

  it('reports when no signer key matches', async () => {
    routeRef.query = { id: HEX64 }
    getEvidenceMock.mockResolvedValue(ENVELOPE)
    getEvidenceJwksMock.mockResolvedValue({ keys: [] })
    const w = await mountView()
    const resolveBtn = w.findAll('button').find(b => b.text().includes('Resolve signer key'))
    await resolveBtn!.trigger('click')
    await flushPromises()
    expect(w.text()).toContain('No published signer key')
  })
})

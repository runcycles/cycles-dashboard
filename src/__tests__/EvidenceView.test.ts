// EvidenceView: fetch + render, transient-404 retry affordance, malformed
// id guard, and signer-key resolution against a JWK Set.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { reactive } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import { toasts } from '../composables/useToast'
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

// Reactive so the component's watch(() => route.query.id) fires when a
// test mutates the query (query-only navigation reuses the component).
const routeRef = reactive<{ query: Record<string, string> }>({ query: {} })
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

  it('resolves a raw-hex signer_did against the JWK Set (no #kid fragment)', async () => {
    // This is what the runtime server actually emits: signer_did is a raw
    // 64-hex public key, and the JWK is matched by decoding its base64url x.
    const hex = 'ab'.repeat(32)
    const x = Buffer.from(hex, 'hex').toString('base64url')
    routeRef.query = { id: HEX64 }
    getEvidenceMock.mockResolvedValue({ ...ENVELOPE, signer_did: hex })
    getEvidenceJwksMock.mockResolvedValue({
      keys: [{ kty: 'OKP', crv: 'Ed25519', x, kid: 'raw-key', cycles_nbf_ms: 0, cycles_exp_ms: null }],
    })
    const w = await mountView()
    const resolveBtn = w.findAll('button').find(b => b.text().includes('Resolve signer key'))
    await resolveBtn!.trigger('click')
    await flushPromises()
    expect(w.text()).toContain('raw-key')
    expect(w.text()).toContain("valid at the envelope's issuance time")
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

  it('re-fetches and refreshes state on query-only navigation (id A → id B)', async () => {
    const idA = 'a'.repeat(64)
    const idB = 'b'.repeat(64)
    routeRef.query = { id: idA }
    getEvidenceMock.mockImplementation((id: string) =>
      Promise.resolve({ ...ENVELOPE, evidence_id: id, artifact_type: id === idB ? 'commit' : 'release' }),
    )
    const w = await mountView()
    expect(getEvidenceMock).toHaveBeenLastCalledWith(idA)
    expect(w.text()).toContain('release envelope')

    // Query-only navigation — the component is reused, onMounted does not re-run.
    routeRef.query = { id: idB }
    await flushPromises()
    expect(getEvidenceMock).toHaveBeenLastCalledWith(idB)
    expect(w.text()).toContain('commit envelope')
  })

  it('clears the envelope when navigating back to bare /evidence', async () => {
    routeRef.query = { id: HEX64 }
    getEvidenceMock.mockResolvedValue(ENVELOPE)
    const w = await mountView()
    expect(w.text()).toContain('release envelope')

    routeRef.query = {}
    await flushPromises()
    expect(w.text()).not.toContain('release envelope')
    expect(w.text()).toContain('No envelope loaded')
  })

  // Round 5 (F6): copyEnvelope rebuilt on the shared writeClipboardJson
  // helper — success keeps the toast, failure uses the app-wide
  // 'clipboard unavailable' copy instead of throwing hand-rolled.
  it('Copy JSON copies the full envelope and toasts success', async () => {
    routeRef.query = { id: HEX64 }
    getEvidenceMock.mockResolvedValue(ENVELOPE)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText }, writable: true, configurable: true,
    })
    toasts.value = []
    const w = await mountView()

    const btn = w.findAll('button').find(b => b.text() === 'Copy JSON')
    expect(btn).toBeTruthy()
    await btn!.trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(JSON.parse(writeText.mock.calls[0][0]).evidence_id).toBe(HEX64)
    expect(toasts.value.some(t => t.type === 'success' && t.message === 'Envelope JSON copied')).toBe(true)
    toasts.value = []
  })

  it('Copy JSON failure toasts the unified "Copy failed — clipboard unavailable"', async () => {
    routeRef.query = { id: HEX64 }
    getEvidenceMock.mockResolvedValue(ENVELOPE)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      writable: true, configurable: true,
    })
    toasts.value = []
    const w = await mountView()

    const btn = w.findAll('button').find(b => b.text() === 'Copy JSON')
    await btn!.trigger('click')
    await flushPromises()

    expect(toasts.value.some(t => t.type === 'error' && t.message === 'Copy failed — clipboard unavailable')).toBe(true)
    toasts.value = []
  })
})

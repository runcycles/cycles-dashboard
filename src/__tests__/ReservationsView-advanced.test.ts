// Covers ReservationsView's Area-A additions: the include-metadata
// toggle (drives buildFilterParams' include token) and the detail-fetch
// action. Mount harness mirrors ReservationsView-url-deeplink.test.ts.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

const listReservationsMock = vi.fn()
const listTenantsMock = vi.fn()
const getReservationMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listReservations: (...a: unknown[]) => listReservationsMock(...a),
    listTenants: (...a: unknown[]) => listTenantsMock(...a),
    getReservation: (...a: unknown[]) => getReservationMock(...a),
  }
})

const routeRef: { query: Record<string, string>; params: Record<string, string> } = { query: {}, params: {} }
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useRoute: () => routeRef,
    RouterLink: { template: '<a><slot /></a>' },
  }
})

vi.mock('../composables/usePolling', () => ({
  usePolling: (fn: () => Promise<void> | void) => {
    void fn()
    return { refresh: async () => { void fn() }, isLoading: { value: false } }
  },
}))

vi.mock('@tanstack/vue-virtual', async () => {
  const { computed, isRef } = await import('vue')
  return {
    useVirtualizer: (optsRef: unknown) => {
      const read = () => (isRef(optsRef) ? optsRef.value : optsRef) as { count: number; estimateSize: () => number }
      return computed(() => {
        const opts = read()
        const size = opts.estimateSize?.() ?? 52
        const items = Array.from({ length: opts.count }, (_, index) => ({
          index, key: index, start: index * size, size, end: (index + 1) * size, lane: 0,
        }))
        return { getVirtualItems: () => items, getTotalSize: () => opts.count * size }
      })
    },
  }
})

const FULL_CAPS: Capabilities = {
  view_overview: true, view_budgets: true, view_events: true,
  view_webhooks: true, view_audit: true, view_tenants: true,
  view_api_keys: true, view_policies: true,
  manage_budgets: true, manage_tenants: true, manage_api_keys: true,
  manage_webhooks: true, manage_policies: true, manage_reservations: true,
}

function stdMount() {
  return { global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, Teleport: true } } }
}

describe('ReservationsView — advanced filters', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listReservationsMock.mockReset()
    listTenantsMock.mockReset()
    getReservationMock.mockReset()
    listReservationsMock.mockResolvedValue({ reservations: [], has_more: false })
    listTenantsMock.mockResolvedValue({ tenants: [{ tenant_id: 'acme', status: 'ACTIVE' }], has_more: false })
    routeRef.query = {}
    routeRef.params = {}
  })

  it('toggling include-metadata re-queries with the include token', async () => {
    const { default: ReservationsView } = await import('../views/ReservationsView.vue')
    const w = mount(ReservationsView, stdMount())
    await flushPromises()

    // Reveal advanced filters, then check the include toggle.
    await w.find('[data-testid="res-advanced-toggle"]').trigger('click')
    await w.find('[data-testid="res-include-metadata"]').setValue(true)
    await flushPromises()

    const withInclude = listReservationsMock.mock.calls.find(
      (args) => (args[1] as { include?: string })?.include === 'metadata,committed_metadata,evidence',
    )
    expect(withInclude).toBeDefined()
  })

  it('debounces subject-filter typing (no per-keystroke fetch)', async () => {
    const { default: ReservationsView } = await import('../views/ReservationsView.vue')
    const w = mount(ReservationsView, stdMount())
    await flushPromises()
    await w.find('[data-testid="res-advanced-toggle"]').trigger('click')

    const hasWorkspaceCall = () => listReservationsMock.mock.calls.some(
      (args) => (args[1] as { workspace?: string })?.workspace === 'prod',
    )

    await w.find('#res-subj-workspace').setValue('prod')
    await flushPromises()
    // Immediately after typing, the debounced reload has not fired yet.
    expect(hasWorkspaceCall()).toBe(false)

    // After the debounce window, exactly one reload carries the filter.
    await new Promise((r) => setTimeout(r, 350))
    await flushPromises()
    expect(hasWorkspaceCall()).toBe(true)
  })

  it('detail dialog renders one-click evidence links from the reservation', async () => {
    const row = {
      reservation_id: 'res-ev', status: 'COMMITTED', scope_path: 'tenant:acme',
      reserved: { unit: 'TOKENS', amount: 1000 }, created_at_ms: 1, expires_at_ms: 2,
    }
    listReservationsMock.mockResolvedValue({ reservations: [row], has_more: false })
    getReservationMock.mockResolvedValue({
      ...row,
      evidence: {
        reserve: { evidence_id: 'a'.repeat(64), cycles_evidence_url: 'http://h/v1/evidence/' + 'a'.repeat(64) },
        commit: { evidence_id: 'b'.repeat(64), cycles_evidence_url: 'http://h/v1/evidence/' + 'b'.repeat(64) },
      },
    })
    const { default: ReservationsView } = await import('../views/ReservationsView.vue')
    const w = mount(ReservationsView, stdMount())
    await flushPromises()

    // Open the row's kebab menu, then click "View details".
    const kebab = w.findAll('button').find(b => (b.attributes('aria-label') || '').startsWith('Actions for reservation'))
    expect(kebab).toBeTruthy()
    await kebab!.trigger('click')
    const viewDetails = w.findAll('button, a').find(el => el.text() === 'View details')
    expect(viewDetails).toBeTruthy()
    await viewDetails!.trigger('click')
    await flushPromises()

    expect(getReservationMock).toHaveBeenCalledWith('res-ev')
    const links = w.findAll('a').filter(a => a.text().includes('evidence'))
    expect(links.map(l => l.text())).toEqual(
      expect.arrayContaining(['View reserve evidence →', 'View commit evidence →']),
    )
  })

  it('Clear resets advanced filters and the affordance appears only when active', async () => {
    const { default: ReservationsView } = await import('../views/ReservationsView.vue')
    const w = mount(ReservationsView, stdMount())
    await flushPromises()
    await w.find('[data-testid="res-advanced-toggle"]').trigger('click')

    // No active filters → no Clear button.
    expect(w.find('[data-testid="res-clear-filters"]').exists()).toBe(false)

    await w.find('[data-testid="res-include-metadata"]').setValue(true)
    await flushPromises()
    const clear = w.find('[data-testid="res-clear-filters"]')
    expect(clear.exists()).toBe(true)

    await clear.trigger('click')
    await flushPromises()
    expect((w.find('[data-testid="res-include-metadata"]').element as HTMLInputElement).checked).toBe(false)
    expect(w.find('[data-testid="res-clear-filters"]').exists()).toBe(false)
  })
})

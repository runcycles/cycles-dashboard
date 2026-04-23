// v0.1.25.53 bug #4: ApiKeysView honors `?expiring_within_7d=1` as a
// client-side filter. The Overview "Expiring Keys" card's "View all"
// link now carries this param so the drill-down matches the card.
// The admin spec has no server-side expires_before param on
// listApiKeys (only status=ACTIVE|REVOKED|EXPIRED), so the filter
// runs client-side on top of the loaded page — matching the Overview
// card's own filterExpiringKeys() semantics.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities, ApiKey } from '../types'

const listApiKeysMock = vi.fn()
const listTenantsMock = vi.fn()
const routeQuery: Record<string, string> = {}

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listTenants: (...args: unknown[]) => listTenantsMock(...args),
    listApiKeys: (...args: unknown[]) => listApiKeysMock(...args),
    revokeApiKey: vi.fn(),
    createApiKey: vi.fn(),
    updateApiKey: vi.fn(),
  }
})

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useRoute: () => ({ query: routeQuery, params: {} }),
    RouterLink: { template: '<a><slot /></a>' },
  }
})

vi.mock('../composables/usePolling', () => ({
  usePolling: (fn: () => Promise<void> | void) => {
    void fn()
    return {
      refresh: async () => { void fn() },
      isLoading: { value: false },
    }
  },
}))

vi.mock('@tanstack/vue-virtual', async () => {
  const { computed, isRef } = await import('vue')
  return {
    useVirtualizer: (optsRef: unknown) => {
      const read = () => (isRef(optsRef) ? optsRef.value : optsRef) as {
        count: number
        estimateSize: () => number
      }
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

function key(id: string, overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    key_id: id,
    tenant_id: 't-alpha',
    name: id,
    status: 'ACTIVE',
    permissions: [],
    created_at: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

function in7d(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

describe('ApiKeysView — ?expiring_within_7d=1 client-side filter', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listApiKeysMock.mockReset()
    listTenantsMock.mockReset()
    listTenantsMock.mockResolvedValue({ tenants: [] })
    for (const k of Object.keys(routeQuery)) delete routeQuery[k]
  })

  it('hides rows outside the 7-day window when the URL filter is set', async () => {
    routeQuery.expiring_within_7d = '1'
    listApiKeysMock.mockResolvedValue({
      keys: [
        key('k-soon',  { expires_at: in7d(3) }),   // inside window
        key('k-later', { expires_at: in7d(30) }),  // outside window
        key('k-none',  { expires_at: undefined }), // no expiry
      ],
      has_more: false,
    })
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = mount(ApiKeysView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
    await flushPromises(); await flushPromises()

    expect(w.text()).toContain('k-soon')
    expect(w.text()).not.toContain('k-later')
    expect(w.text()).not.toContain('k-none')
  })

  it('renders the "Expiring within 7d" chip with a dismiss control when the URL filter is set', async () => {
    routeQuery.expiring_within_7d = '1'
    listApiKeysMock.mockResolvedValue({ keys: [], has_more: false })
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = mount(ApiKeysView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
    await flushPromises(); await flushPromises()

    const chip = w.find('[data-testid="api-keys-expiring-filter-chip"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('Expiring within 7d')
    expect(chip.find('button').exists()).toBe(true)
  })

  it('does NOT filter when the URL param is absent', async () => {
    listApiKeysMock.mockResolvedValue({
      keys: [
        key('k-soon',  { expires_at: in7d(3) }),
        key('k-later', { expires_at: in7d(30) }),
      ],
      has_more: false,
    })
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = mount(ApiKeysView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
    await flushPromises(); await flushPromises()

    expect(w.text()).toContain('k-soon')
    expect(w.text()).toContain('k-later')
    expect(w.find('[data-testid="api-keys-expiring-filter-chip"]').exists()).toBe(false)
  })

  it('dismissing the chip clears the filter and shows all rows', async () => {
    routeQuery.expiring_within_7d = '1'
    listApiKeysMock.mockResolvedValue({
      keys: [
        key('k-soon',  { expires_at: in7d(3) }),
        key('k-later', { expires_at: in7d(30) }),
      ],
      has_more: false,
    })
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = mount(ApiKeysView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
    await flushPromises(); await flushPromises()

    // Starts filtered.
    expect(w.text()).not.toContain('k-later')

    await w.find('[data-testid="api-keys-expiring-filter-chip"] button').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('k-soon')
    expect(w.text()).toContain('k-later')
  })
})

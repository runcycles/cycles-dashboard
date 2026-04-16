// Wire-up test for the v0.1.25.22 cross-tenant /admin/api-keys path.
//
// Before: ApiKeysView iterated tenants and called listApiKeys(tenant_id)
// once per tenant — O(N tenants) requests per poll, capped at 100 with
// a banner.
// After: a single listApiKeys() call (no tenant_id) returns rows across
// every tenant with cursor pagination.
//
// These tests pin the new contract: on mount the view makes exactly one
// listApiKeys call, with no tenant_id param, and surfaces all returned
// keys regardless of tenant.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

const listApiKeysMock = vi.fn()
const listTenantsMock = vi.fn()

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
    useRoute: () => ({ query: {}, params: {} }),
    RouterLink: { template: '<a><slot /></a>' },
  }
})

// Drive the polling callback once on mount, like the real composable.
vi.mock('../composables/usePolling', () => ({
  usePolling: (fn: () => Promise<void> | void) => {
    void fn()
    return {
      refresh: async () => { void fn() },
      isLoading: { value: false },
      lastUpdated: { value: null },
    }
  },
}))

// jsdom has no layout — stub useVirtualizer so all rows render.
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

describe('ApiKeysView — cross-tenant list wire-up', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listApiKeysMock.mockReset()
    listTenantsMock.mockReset()
    listTenantsMock.mockResolvedValue({
      tenants: [
        { tenant_id: 't-alpha', name: 'Alpha', status: 'ACTIVE', created_at: '2026-04-01T00:00:00Z' },
        { tenant_id: 't-beta',  name: 'Beta',  status: 'ACTIVE', created_at: '2026-04-01T00:00:00Z' },
      ],
    })
  })

  it('issues exactly one listApiKeys call with no tenant_id param on mount', async () => {
    listApiKeysMock.mockResolvedValueOnce({
      keys: [
        { key_id: 'k1', tenant_id: 't-alpha', name: 'a', status: 'ACTIVE', permissions: [], created_at: '2026-04-01T00:00:00Z' },
        { key_id: 'k2', tenant_id: 't-beta',  name: 'b', status: 'ACTIVE', permissions: [], created_at: '2026-04-01T00:00:00Z' },
      ],
      has_more: false,
    })
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    mount(ApiKeysView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
    await flushPromises()
    await flushPromises()

    // The core wire-up assertion: one call, no per-tenant fan-out.
    expect(listApiKeysMock).toHaveBeenCalledTimes(1)
    const params = listApiKeysMock.mock.calls[0][0] as Record<string, string>
    expect(params.tenant_id).toBeUndefined()
    // limit is forwarded so the server can page us correctly.
    expect(params.limit).toBeDefined()
  })

  it('forwards tenant_id when the tenant filter is set', async () => {
    listApiKeysMock.mockResolvedValue({ keys: [], has_more: false })
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = mount(ApiKeysView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
    await flushPromises(); await flushPromises()

    listApiKeysMock.mockClear()
    const select = w.find<HTMLSelectElement>('#keys-tenant')
    expect(select.exists()).toBe(true)
    await select.setValue('t-alpha')
    await flushPromises(); await flushPromises()

    expect(listApiKeysMock).toHaveBeenCalled()
    const params = listApiKeysMock.mock.calls[0][0] as Record<string, string>
    expect(params.tenant_id).toBe('t-alpha')
  })

  it('follows next_cursor when Load more is clicked', async () => {
    listApiKeysMock
      .mockResolvedValueOnce({
        keys: [
          { key_id: 'k1', tenant_id: 't-alpha', name: 'a', status: 'ACTIVE', permissions: [], created_at: '2026-04-01T00:00:00Z' },
        ],
        has_more: true,
        next_cursor: 't-alpha|k1',
      })
      .mockResolvedValueOnce({
        keys: [
          { key_id: 'k2', tenant_id: 't-beta', name: 'b', status: 'ACTIVE', permissions: [], created_at: '2026-04-01T00:00:00Z' },
        ],
        has_more: false,
      })
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = mount(ApiKeysView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
    await flushPromises(); await flushPromises()

    const loadMoreBtn = w.findAll('button').find(b => b.text() === 'Load more')
    expect(loadMoreBtn, 'Load more button should render while has_more is true').toBeDefined()
    await loadMoreBtn!.trigger('click')
    await flushPromises()

    expect(listApiKeysMock).toHaveBeenCalledTimes(2)
    const secondCallParams = listApiKeysMock.mock.calls[1][0] as Record<string, string>
    expect(secondCallParams.cursor).toBe('t-alpha|k1')
  })
})

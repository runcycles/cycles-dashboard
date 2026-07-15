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
const replaceMock = vi.fn()
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
    useRouter: () => ({ push: vi.fn(), replace: replaceMock }),
    useRoute: () => ({ query: routeQuery, params: {} }),
    RouterLink: { template: '<a><slot /></a>' },
  }
})

// Pass-through debounce so the ?search= write-back specs don't need
// fake-timer choreography; existing specs only read the initial value
// and are unaffected by immediacy.
vi.mock('../composables/useDebouncedRef', () => ({
  useDebouncedRef: <T>(source: { value: T }) => source,
}))

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
    key_prefix: `cyc_test_${id}`,
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

  it('renders the key_prefix column so operators can correlate stored secrets', async () => {
    listApiKeysMock.mockResolvedValue({
      keys: [key('k-1', { expires_at: undefined })],
      has_more: false,
    })
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = mount(ApiKeysView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
    await flushPromises(); await flushPromises()

    const headers = w.findAll('[role="columnheader"]').map(h => h.text())
    expect(headers).toContain('Prefix')
    expect(w.text()).toContain('cyc_test_k-1')
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

describe('ApiKeysView — ?search= deep-link hydration (Overview expiring-key rows)', () => {
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

  it('hydrates ?search= into the search input and sends it server-side', async () => {
    routeQuery.search = 'key-soon'
    listApiKeysMock.mockResolvedValue({
      keys: [key('key-soon', { expires_at: in7d(3) })],
      has_more: false,
    })
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = mount(ApiKeysView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
    await flushPromises(); await flushPromises()

    // The visible search input reflects the URL param…
    expect((w.find('#keys-search').element as HTMLInputElement).value).toBe('key-soon')
    // …and the initial fetch is already scoped server-side.
    const firstCall = listApiKeysMock.mock.calls[0]?.[0] ?? {}
    expect(firstCall.search).toBe('key-soon')
  })

  it('client-side filter also applies, so the landing state shows only the match', async () => {
    routeQuery.search = 'key-soon'
    // Simulate a pre-v0.1.25.21 server that ignores the search param.
    listApiKeysMock.mockResolvedValue({
      keys: [
        key('key-soon',  { expires_at: in7d(3) }),
        key('key-other', { expires_at: in7d(30) }),
      ],
      has_more: false,
    })
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = mount(ApiKeysView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
    await flushPromises(); await flushPromises()

    expect(w.text()).toContain('key-soon')
    expect(w.text()).not.toContain('key-other')
  })
})

// F5 — ?expiring_within_7d was one-directional too: dismissing the pill
// (or clearFilters) only reset the ref, leaving the param in the URL —
// reload/share re-applied the dismissed filter, and the ?search
// write-back (which spreads ...route.query) kept re-propagating it.
// The ref → URL write-back removes the param on dismiss.
describe('ApiKeysView — ?expiring_within_7d URL write-back (F5)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listApiKeysMock.mockReset()
    listTenantsMock.mockReset()
    replaceMock.mockReset()
    listTenantsMock.mockResolvedValue({ tenants: [] })
    listApiKeysMock.mockResolvedValue({ keys: [], has_more: false })
    for (const k of Object.keys(routeQuery)) delete routeQuery[k]
    // Simulate the router applying each replace to the current route so
    // follow-up write-backs (e.g. the ?search spread) see the URL state
    // the previous replace produced — mirrors real router behavior.
    replaceMock.mockImplementation(({ query }: { query: Record<string, string | undefined> }) => {
      for (const k of Object.keys(routeQuery)) delete routeQuery[k]
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) routeQuery[k] = v
      }
    })
  })

  async function mountView() {
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = mount(ApiKeysView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
    await flushPromises(); await flushPromises()
    return w
  }

  it('dismissing the pill removes ?expiring_within_7d from the URL (preserving other params)', async () => {
    routeQuery.expiring_within_7d = '1'
    routeQuery.search = 'acme'
    const w = await mountView()
    await w.find('[data-testid="api-keys-expiring-filter-chip"] button').trigger('click')
    await flushPromises()

    expect(replaceMock).toHaveBeenCalled()
    const arg = replaceMock.mock.calls.at(-1)![0] as { query: Record<string, string | undefined> }
    expect(arg.query.expiring_within_7d).toBeUndefined()
    expect(arg.query.search).toBe('acme')
  })

  it('clearFilters removes the param too', async () => {
    routeQuery.expiring_within_7d = '1'
    const w = await mountView()
    const clear = w.findAll('button').find(b => b.text() === 'Clear')
    expect(clear).toBeDefined()
    await clear!.trigger('click')
    await flushPromises()

    const arg = replaceMock.mock.calls.at(-1)![0] as { query: Record<string, string | undefined> }
    expect(arg.query.expiring_within_7d).toBeUndefined()
  })

  it('the ?search write-back no longer resurrects a dismissed filter', async () => {
    routeQuery.expiring_within_7d = '1'
    const w = await mountView()
    // Dismiss the pill — the write-back strips the param from the URL.
    await w.find('[data-testid="api-keys-expiring-filter-chip"] button').trigger('click')
    await flushPromises()
    expect(routeQuery.expiring_within_7d).toBeUndefined()

    // Now type a search term. Pre-fix, this replace spread the STALE
    // route.query and re-wrote expiring_within_7d='1' into the URL.
    await w.find('#keys-search').setValue('acme')
    await flushPromises()
    const arg = replaceMock.mock.calls.at(-1)![0] as { query: Record<string, string | undefined> }
    expect(arg.query.search).toBe('acme')
    expect(arg.query.expiring_within_7d).toBeUndefined()
  })

  it('does not replace on mount when URL and ref already agree (loop guard)', async () => {
    routeQuery.expiring_within_7d = '1'
    await mountView()
    expect(replaceMock).not.toHaveBeenCalled()
  })

  // F5 (presence normalization): only '1' means "filter on". Any other
  // value hydrates the ref false, and pre-fix the `ref === (param ===
  // '1')` comparison read false === false as "in sync" — the junk param
  // was never stripped and the ?search write-back's route.query spread
  // re-propagated it forever. The write-back now strips any non-'1'
  // value on landing.
  it('landing with ?expiring_within_7d=true strips the malformed param and leaves the list unfiltered', async () => {
    routeQuery.expiring_within_7d = 'true'
    listApiKeysMock.mockResolvedValue({
      keys: [
        key('k-soon',  { expires_at: in7d(3) }),
        key('k-later', { expires_at: in7d(30) }),
      ],
      has_more: false,
    })
    const w = await mountView()

    // Param stripped from the URL (replace applied by the mock router).
    expect(replaceMock).toHaveBeenCalled()
    expect(routeQuery.expiring_within_7d).toBeUndefined()
    // List unfiltered, no filter chip.
    expect(w.text()).toContain('k-soon')
    expect(w.text()).toContain('k-later')
    expect(w.find('[data-testid="api-keys-expiring-filter-chip"]').exists()).toBe(false)

    // And the ?search write-back can no longer resurrect it.
    await w.find('#keys-search').setValue('acme')
    await flushPromises()
    const arg = replaceMock.mock.calls.at(-1)![0] as { query: Record<string, string | undefined> }
    expect(arg.query.expiring_within_7d).toBeUndefined()
  })

  it('landing with a valueless ?expiring_within_7d strips it too (any non-"1" form)', async () => {
    // vue-router represents `?expiring_within_7d` (no value) as null.
    ;(routeQuery as Record<string, string | null>).expiring_within_7d = null
    const w = await mountView()
    expect(replaceMock).toHaveBeenCalled()
    expect(routeQuery.expiring_within_7d).toBeUndefined()
    expect(w.find('[data-testid="api-keys-expiring-filter-chip"]').exists()).toBe(false)
  })
})

// F6 — the sync was one-way: ?search= hydrated the ref, but operator
// edits never wrote back, so reloading/sharing the URL re-applied a
// cleared filter. The debounced write-back mirrors TenantsView's
// bidirectional pattern.
describe('ApiKeysView — ?search= URL write-back (F6)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listApiKeysMock.mockReset()
    listTenantsMock.mockReset()
    replaceMock.mockReset()
    listTenantsMock.mockResolvedValue({ tenants: [] })
    listApiKeysMock.mockResolvedValue({ keys: [], has_more: false })
    for (const k of Object.keys(routeQuery)) delete routeQuery[k]
  })

  async function mountView() {
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = mount(ApiKeysView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
    await flushPromises(); await flushPromises()
    return w
  }

  it('typing a search term writes ?search= to the URL via router.replace', async () => {
    const w = await mountView()
    await w.find('#keys-search').setValue('acme')
    await flushPromises()
    expect(replaceMock).toHaveBeenCalled()
    const arg = replaceMock.mock.calls.at(-1)![0] as { query: Record<string, string | undefined> }
    expect(arg.query.search).toBe('acme')
  })

  it('clearing the search removes the param instead of leaving a stale ?search=', async () => {
    routeQuery.search = 'acme'
    const w = await mountView()
    await w.find('#keys-search').setValue('')
    await flushPromises()
    expect(replaceMock).toHaveBeenCalled()
    const arg = replaceMock.mock.calls.at(-1)![0] as { query: Record<string, string | undefined> }
    expect(arg.query.search).toBeUndefined()
  })

  it('does not replace when the URL already matches (loop guard)', async () => {
    routeQuery.search = 'acme'
    await mountView()
    // Hydration set search='acme'; the URL already carries it — the
    // write-back watcher must not fire a redundant replace.
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it('preserves unrelated query params on write-back', async () => {
    routeQuery.expiring_within_7d = '1'
    const w = await mountView()
    await w.find('#keys-search').setValue('acme')
    await flushPromises()
    const arg = replaceMock.mock.calls.at(-1)![0] as { query: Record<string, string | undefined> }
    expect(arg.query.expiring_within_7d).toBe('1')
    expect(arg.query.search).toBe('acme')
  })
})

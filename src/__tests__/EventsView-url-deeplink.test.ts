// Deep-link smoke test for EventsView.
//
// Catches the class of bug where initial-mount URL params hit a TDZ
// ReferenceError, a null-deref, or any other crash during setup — the
// kind of failure that renders blank pages and leaves the router in
// a broken state (see TenantsView ?status=ACTIVE regression).
//
// Covers every filter surfaced as a URL query by applyFilters():
//   /events?category=runtime
//   /events?type=reservation.denied
//   /events?tenant_id=acme
//   /events?scope=tenant:acme/*
//   /events?correlation_id=corr_abc
//   /events?search=stuck
//   /events?from=2026-04-01T00:00&to=2026-04-17T00:00
//
// Plus combos and unknown values — the view should tolerate anything
// the URL throws at it without crashing the mount.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

const listEventsMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listEvents: (...args: unknown[]) => listEventsMock(...args),
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
    return {
      refresh: async () => { void fn() },
      isLoading: { value: false },
      lastUpdated: { value: null },
    }
  },
}))

vi.mock('../composables/useDebouncedRef', () => ({
  useDebouncedRef: <T>(source: { value: T }) => source,
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

const QUERIES: Array<[string, Record<string, string>]> = [
  ['?category=runtime', { category: 'runtime' }],
  ['?type=reservation.denied', { type: 'reservation.denied' }],
  ['?tenant_id=acme', { tenant_id: 'acme' }],
  ['?scope=tenant:acme/*', { scope: 'tenant:acme/*' }],
  ['?correlation_id=corr_abc', { correlation_id: 'corr_abc' }],
  ['?search=stuck', { search: 'stuck' }],
  ['?from=...&to=... (time range)', { from: '2026-04-01T00:00', to: '2026-04-17T00:00' }],
  ['?category=runtime&tenant_id=acme (combo)', { category: 'runtime', tenant_id: 'acme' }],
  // v0.1.25.39 — W3C Trace Context deep-link (admin v0.1.25.31 / protocol v0.1.25.28)
  ['?trace_id=0123456789abcdef0123456789abcdef', { trace_id: '0123456789abcdef0123456789abcdef' }],
  ['?request_id=req_abc123', { request_id: 'req_abc123' }],
]

describe('EventsView — URL deep-link smoke', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listEventsMock.mockReset()
    listEventsMock.mockResolvedValue({ events: [], has_more: false })
    routeRef.query = {}
    routeRef.params = {}
  })

  for (const [label, query] of QUERIES) {
    it(`mounts without throwing when URL is ${label}`, async () => {
      routeRef.query = query
      const { default: EventsView } = await import('../views/EventsView.vue')
      const w = mount(EventsView, stdMount())
      await flushPromises()
      expect(w.find('h1').exists()).toBe(true)
    })
  }
})

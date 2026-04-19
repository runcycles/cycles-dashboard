// Deep-link smoke test for WebhooksView.
//
// Catches the class of bug where initial-mount URL params hit a TDZ
// ReferenceError, a null-deref, or any other crash during setup — the
// kind of failure that renders blank pages and leaves the router in
// a broken state (see TenantsView ?status=ACTIVE regression).
//
// Covers the Overview tile drill-down URLs wired in v0.1.25.30:
//   /webhooks?status=ACTIVE
//   /webhooks?status=PAUSED
//   /webhooks?status=DISABLED
//   /webhooks?failing=1  (drill-down from "with_failures" chip)
//
// Plus garbage values + combinations + ?status=BOGUS (must ignore, not crash).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

const listWebhooksMock = vi.fn()
const listTenantsMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listWebhooks: (...args: unknown[]) => listWebhooksMock(...args),
    listTenants: (...args: unknown[]) => listTenantsMock(...args),
    getWebhookSecurityConfig: vi.fn().mockResolvedValue({ allow_http: false, require_signed_payload: true }),
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
  ['?status=ACTIVE', { status: 'ACTIVE' }],
  ['?status=PAUSED', { status: 'PAUSED' }],
  ['?status=DISABLED', { status: 'DISABLED' }],
  ['?status=BOGUS (unknown value ignored)', { status: 'BOGUS' }],
  ['?failing=1', { failing: '1' }],
  ['?failing=true', { failing: 'true' }],
  ['?failing=1&status=ACTIVE (combo)', { failing: '1', status: 'ACTIVE' }],
]

describe('WebhooksView — URL deep-link smoke', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listWebhooksMock.mockReset()
    listTenantsMock.mockReset()
    listWebhooksMock.mockResolvedValue({ subscriptions: [], has_more: false })
    listTenantsMock.mockResolvedValue({ tenants: [], has_more: false })
    routeRef.query = {}
    routeRef.params = {}
  })

  for (const [label, query] of QUERIES) {
    it(`mounts without throwing when URL is ${label}`, async () => {
      routeRef.query = query
      const { default: WebhooksView } = await import('../views/WebhooksView.vue')
      const w = mount(WebhooksView, stdMount())
      await flushPromises()
      expect(w.find('h1').exists()).toBe(true)
    })
  }
})

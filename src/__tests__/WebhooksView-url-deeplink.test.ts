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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { reactive } from 'vue'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'

// The reactive routeRef below is shared across tests — auto-unmount so
// a previous test's still-mounted component can't react to the next
// test's route mutations.
enableAutoUnmount(afterEach)
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities, WebhookListResponse } from '../types'

const listWebhooksMock = vi.fn()
const listTenantsMock = vi.fn()

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listWebhooks: (...args: unknown[]) => listWebhooksMock(...args),
    listTenants: (...args: unknown[]) => listTenantsMock(...args),
    getWebhookSecurityConfig: vi.fn().mockResolvedValue({ allow_http: false, require_signed_payload: true }),
  }
})

// `name` matches the real route — the view's URL → ref watchers are
// route-identity-guarded (F3), and their `immediate` hydration run
// checks it at setup. Reactive so tests can reassign routeRef.query to
// simulate same-route navigation (back/forward) without a remount.
const routeRef: { query: Record<string, string>; params: Record<string, string>; name: string } =
  reactive({ query: {}, params: {}, name: 'webhooks' })

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
    routeRef.name = 'webhooks'
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

  // v0.1.25.53 regression: Overview's "active" counter-strip tile drill-down
  // (?status=ACTIVE) must forward status to the server so the list page isn't
  // crowded by rows that client-side filter will throw away. Pre-fix, a fleet
  // of 62 ACTIVE webhooks could show 12 because page 1 (default sort:
  // consecutive_failures-desc) was dominated by DISABLED/failing rows.
  it('forwards ?status=ACTIVE to listWebhooks as a server-side param', async () => {
    routeRef.query = { status: 'ACTIVE' }
    const { default: WebhooksView } = await import('../views/WebhooksView.vue')
    mount(WebhooksView, stdMount())
    await flushPromises()
    const params = listWebhooksMock.mock.calls.at(-1)?.[0] as Record<string, string> | undefined
    expect(params?.status).toBe('ACTIVE')
  })

  it('forwards ?status=PAUSED to listWebhooks as a server-side param', async () => {
    routeRef.query = { status: 'PAUSED' }
    const { default: WebhooksView } = await import('../views/WebhooksView.vue')
    mount(WebhooksView, stdMount())
    await flushPromises()
    const params = listWebhooksMock.mock.calls.at(-1)?.[0] as Record<string, string> | undefined
    expect(params?.status).toBe('PAUSED')
  })

  it('advances freshness when a direct filter reload commits successfully', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-07-16T12:00:00Z'))
      const { default: WebhooksView } = await import('../views/WebhooksView.vue')
      const w = mount(WebhooksView, stdMount())
      await flushPromises()
      expect((w.vm as unknown as { lastSuccessAt: Date }).lastSuccessAt.toISOString()).toBe('2026-07-16T12:00:00.000Z')

      vi.setSystemTime(new Date('2026-07-16T12:05:00Z'))
      routeRef.query = { status: 'PAUSED' }
      await flushPromises()

      expect((w.vm as unknown as { lastSuccessAt: Date }).lastSuccessAt.toISOString()).toBe('2026-07-16T12:05:00.000Z')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not send status param when no filter is set', async () => {
    routeRef.query = {}
    const { default: WebhooksView } = await import('../views/WebhooksView.vue')
    mount(WebhooksView, stdMount())
    await flushPromises()
    const params = listWebhooksMock.mock.calls.at(-1)?.[0] as Record<string, string> | undefined
    expect(params?.status).toBeUndefined()
  })

  // Round 4 (F3): the ?status watcher was adopt-only — Back to a bare
  // /webhooks kept the stale deep-linked filter, so a bare URL showed
  // filtered data (the defect class rounds 2–3 fixed for the other
  // params). Param absent now resets to the unfiltered default.
  it('Back to a bare URL (param removed) resets a deep-linked status filter', async () => {
    routeRef.query = { status: 'PAUSED' }
    const { default: WebhooksView } = await import('../views/WebhooksView.vue')
    const w = mount(WebhooksView, stdMount())
    await flushPromises()
    const select = w.find('select[aria-label="Filter webhooks by status"]')
    expect((select.element as HTMLSelectElement).value).toBe('PAUSED')
    listWebhooksMock.mockClear()

    // Browser Back to bare /webhooks — same-route, no remount.
    routeRef.query = {}
    await flushPromises()
    expect((select.element as HTMLSelectElement).value).toBe('')
    // The reset refetched without the status param.
    const params = listWebhooksMock.mock.calls.at(-1)?.[0] as Record<string, string> | undefined
    expect(params?.status).toBeUndefined()
  })

  it('keeps the bare-URL result when the prior status request resolves last', async () => {
    const paused = deferred<WebhookListResponse>()
    const unfiltered = deferred<WebhookListResponse>()
    listWebhooksMock.mockImplementation((params?: Record<string, string>) =>
      params?.status === 'PAUSED' ? paused.promise : unfiltered.promise,
    )
    routeRef.query = { status: 'PAUSED' }
    const { default: WebhooksView } = await import('../views/WebhooksView.vue')
    const w = mount(WebhooksView, stdMount())
    await vi.waitFor(() => {
      expect(listWebhooksMock.mock.calls.some(args => args[0]?.status === 'PAUSED')).toBe(true)
    })

    routeRef.query = {}
    await vi.waitFor(() => {
      expect(listWebhooksMock.mock.calls.some(args => args[0]?.status === undefined)).toBe(true)
    })
    unfiltered.resolve({
      subscriptions: [{
        subscription_id: 'sub-current', url: 'https://current.example/hook', status: 'ACTIVE',
        event_types: ['budget.updated'], created_at: '2026-01-01T00:00:00Z', tenant_id: 'acme',
      }],
      has_more: false,
    })
    await flushPromises()
    expect(w.text()).toContain('current.example')

    paused.resolve({
      subscriptions: [{
        subscription_id: 'sub-stale', url: 'https://stale.example/hook', status: 'PAUSED',
        event_types: ['budget.updated'], created_at: '2026-01-01T00:00:00Z', tenant_id: 'acme',
      }],
      has_more: false,
    })
    await flushPromises()
    expect((w.find('select[aria-label="Filter webhooks by status"]').element as HTMLSelectElement).value).toBe('')
    expect(w.text()).toContain('current.example')
    expect(w.text()).not.toContain('stale.example')
  })

  // Route-identity guard still holds: navigating AWAY to a route that
  // carries its own ?status must not clear or adopt into this view.
  it('a navigation away to /tenants?status=ACTIVE does not touch the filter', async () => {
    routeRef.query = { status: 'PAUSED' }
    const { default: WebhooksView } = await import('../views/WebhooksView.vue')
    const w = mount(WebhooksView, stdMount())
    await flushPromises()
    listWebhooksMock.mockClear()

    routeRef.name = 'tenants'
    routeRef.query = { status: 'ACTIVE' }
    await flushPromises()
    const select = w.find('select[aria-label="Filter webhooks by status"]')
    expect((select.element as HTMLSelectElement).value).toBe('PAUSED')
    expect(listWebhooksMock).not.toHaveBeenCalled()
  })
})

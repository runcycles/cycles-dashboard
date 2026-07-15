// Deep-link smoke test for ReservationsView.
//
// Catches the class of bug where initial-mount URL params hit a TDZ
// ReferenceError, a null-deref, or any other crash during setup — the
// kind of failure that renders blank pages and leaves the router in
// a broken state (see TenantsView ?status=ACTIVE regression).
//
// Covers the ?status= deep-link surface:
//   /reservations?status=ACTIVE
//   /reservations?status=COMMITTED
//   /reservations?status=RELEASED
//   /reservations?status=EXPIRED
//
// Plus ?status=BOGUS (unknown value must be ignored, not crash).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { reactive } from 'vue'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'

// The reactive routeRef below is shared across tests — auto-unmount so
// a previous test's still-mounted component can't react to the next
// test's route mutations.
enableAutoUnmount(afterEach)
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

const listReservationsMock = vi.fn()
const listTenantsMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listReservations: (...args: unknown[]) => listReservationsMock(...args),
    listTenants: (...args: unknown[]) => listTenantsMock(...args),
  }
})

// Reactive so the view's route.query watchers fire when tests reassign
// routeRef.query — simulates same-route navigation (e.g. the /res
// palette command) without a remount. Carries `name` because the view's
// query watchers are route-identity-guarded (F3) — tests flip it to
// simulate navigating away to a route with same-named params.
const routeRef: { query: Record<string, string>; params: Record<string, string>; name: string } =
  reactive({ query: {}, params: {}, name: 'reservations' })

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
  ['?status=COMMITTED', { status: 'COMMITTED' }],
  ['?status=RELEASED', { status: 'RELEASED' }],
  ['?status=EXPIRED', { status: 'EXPIRED' }],
  ['?status=BOGUS (unknown value ignored)', { status: 'BOGUS' }],
]

describe('ReservationsView — URL deep-link smoke', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listReservationsMock.mockReset()
    listTenantsMock.mockReset()
    listReservationsMock.mockResolvedValue({ reservations: [], has_more: false })
    listTenantsMock.mockResolvedValue({ tenants: [], has_more: false })
    routeRef.query = {}
    routeRef.params = {}
    routeRef.name = 'reservations'
  })

  for (const [label, query] of QUERIES) {
    it(`mounts without throwing when URL is ${label}`, async () => {
      routeRef.query = query
      const { default: ReservationsView } = await import('../views/ReservationsView.vue')
      const w = mount(ReservationsView, stdMount())
      await flushPromises()
      expect(w.find('h1').exists()).toBe(true)
    })
  }

  it('M14: pre-selects the tenant from ?tenant_id= and skips the first-ACTIVE default', async () => {
    // Pre-fix ReservationsView ignored the URL and always defaulted to
    // the first-ACTIVE tenant — a deep-link like
    // /reservations?tenant_id=beta from an Overview drill-down landed
    // on 'alpha' (alphabetic first) instead. Now the URL wins.
    routeRef.query = { tenant_id: 'beta' }
    listTenantsMock.mockResolvedValue({
      tenants: [
        { tenant_id: 'alpha', status: 'ACTIVE' },
        { tenant_id: 'beta', status: 'ACTIVE' },
      ],
      has_more: false,
    })
    const { default: ReservationsView } = await import('../views/ReservationsView.vue')
    mount(ReservationsView, stdMount())
    await flushPromises()
    // The polling callback calls listReservations with the filter.
    const call = listReservationsMock.mock.calls.find(args => args[0] === 'beta')
    expect(call).toBeDefined()
  })

  it('M14: drops a stale ?tenant_id= that no longer exists and falls back to default', async () => {
    routeRef.query = { tenant_id: 'deleted-tenant' }
    listTenantsMock.mockResolvedValue({
      tenants: [{ tenant_id: 'acme', status: 'ACTIVE' }],
      has_more: false,
    })
    const { default: ReservationsView } = await import('../views/ReservationsView.vue')
    mount(ReservationsView, stdMount())
    await flushPromises()
    // Stale tenant_id is replaced by the first-ACTIVE default.
    const call = listReservationsMock.mock.calls.find(args => args[0] === 'acme')
    expect(call).toBeDefined()
    // And no call under the stale id fired.
    const staleCall = listReservationsMock.mock.calls.find(args => args[0] === 'deleted-tenant')
    expect(staleCall).toBeUndefined()
  })

  // F3 — same-route navigation (the /res palette command) updates
  // route.query without remounting the component, so the setup-time
  // read alone made the command a no-op when the operator was already
  // on Reservations. The view now watches ?tenant_id.
  it('F3: reacts to a ?tenant_id change while mounted (palette /res command)', async () => {
    routeRef.query = {}
    listTenantsMock.mockResolvedValue({
      tenants: [
        { tenant_id: 'alpha', status: 'ACTIVE' },
        { tenant_id: 'beta', status: 'ACTIVE' },
      ],
      has_more: false,
    })
    const { default: ReservationsView } = await import('../views/ReservationsView.vue')
    mount(ReservationsView, stdMount())
    await flushPromises()
    // Defaulted to first-ACTIVE tenant.
    expect(listReservationsMock.mock.calls.some(args => args[0] === 'alpha')).toBe(true)
    listReservationsMock.mockClear()

    // Palette pushes /reservations?tenant_id=beta — no remount.
    routeRef.query = { tenant_id: 'beta' }
    await flushPromises()
    expect(listReservationsMock.mock.calls.some(args => args[0] === 'beta')).toBe(true)
  })

  // F2 (bare-URL consistency): a bare /reservations must mean the SAME
  // state no matter how the operator arrives — a fresh mount of the
  // bare URL auto-selects the first-ACTIVE default (loadTenants), so
  // Back to a bare entry re-defaults to that same tenant instead of
  // clearing to an empty list (which made one URL render two states).
  it('F2: Back to a bare URL (param removed) re-defaults to the first ACTIVE tenant', async () => {
    routeRef.query = { tenant_id: 'beta' }
    listTenantsMock.mockResolvedValue({
      tenants: [
        { tenant_id: 'alpha', status: 'ACTIVE' },
        { tenant_id: 'beta', status: 'ACTIVE' },
      ],
      has_more: false,
    })
    const { default: ReservationsView } = await import('../views/ReservationsView.vue')
    const w = mount(ReservationsView, stdMount())
    await flushPromises()
    expect((w.find('#res-tenant').element as HTMLSelectElement).value).toBe('beta')
    listReservationsMock.mockClear()

    // Browser Back to bare /reservations — param removed → the filter
    // re-defaults to the same tenant a fresh bare-URL mount would pick,
    // and the list refetches under that scope.
    routeRef.query = {}
    await flushPromises()
    expect((w.find('#res-tenant').element as HTMLSelectElement).value).toBe('alpha')
    expect(listReservationsMock.mock.calls.some(args => args[0] === 'alpha')).toBe(true)
  })

  // F3 (route-identity guard): the ?tenant_id watcher fires during
  // navigation AWAY too (before unmount). A destination route carrying
  // a same-named param (e.g. /budgets?tenant_id=beta) must not mutate
  // this view's filter or fire a spurious fetch on the way out.
  it('F3: a navigation away to a route with a tenant_id param does not refetch or change the filter', async () => {
    routeRef.query = { tenant_id: 'alpha' }
    listTenantsMock.mockResolvedValue({
      tenants: [
        { tenant_id: 'alpha', status: 'ACTIVE' },
        { tenant_id: 'beta', status: 'ACTIVE' },
      ],
      has_more: false,
    })
    const { default: ReservationsView } = await import('../views/ReservationsView.vue')
    const w = mount(ReservationsView, stdMount())
    await flushPromises()
    expect((w.find('#res-tenant').element as HTMLSelectElement).value).toBe('alpha')
    listReservationsMock.mockClear()

    // Router commits /budgets?tenant_id=beta — name and query flip
    // while this component is still mounted (guards run before unmount).
    routeRef.name = 'budgets'
    routeRef.query = { tenant_id: 'beta' }
    await flushPromises()
    expect(listReservationsMock).not.toHaveBeenCalled()
    expect((w.find('#res-tenant').element as HTMLSelectElement).value).toBe('alpha')
  })
})

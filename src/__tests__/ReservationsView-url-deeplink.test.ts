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
import type { Capabilities, ReservationListResponse } from '../types'

const listReservationsMock = vi.fn()
const listTenantsMock = vi.fn()

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

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
const routeRef: { query: Record<string, string | (string | null)[] | null>; params: Record<string, string>; name: string } =
  reactive({ query: {}, params: {}, name: 'reservations' })

// Shared replace spy so tests can assert the URL write-back / correction
// calls the view makes (F4 strips unknown ?tenant_id values, for one).
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

vi.mock('../composables/usePolling', async () => {
  const { createPollingMock } = await import('./helpers/createPollingMock')
  return {
    POLLING_STALE: Symbol('polling-stale'),
    usePolling: createPollingMock,
  }
})

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
    replaceMock.mockReset()
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

  it('uses the first duplicated ?tenant_id value instead of resetting to the default tenant', async () => {
    routeRef.query = { tenant_id: ['beta', 'alpha'] }
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
    expect(listReservationsMock.mock.calls.some(args => args[0] === 'beta')).toBe(true)
    expect(listReservationsMock.mock.calls.some(args => args[0] === 'alpha')).toBe(false)
  })

  it('reports a tenant-catalog failure to the poller instead of clearing it as success', async () => {
    listTenantsMock.mockRejectedValue(new Error('tenant catalog unavailable'))
    const { default: ReservationsView } = await import('../views/ReservationsView.vue')
    const w = mount(ReservationsView, stdMount())
    await flushPromises()

    const result = await (w.vm as unknown as { refresh: () => Promise<unknown> }).refresh()
    expect(result).toBe(false)
    expect(w.text()).toContain('tenant catalog unavailable')
    expect(listReservationsMock).not.toHaveBeenCalled()
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

  it('keeps the newest tenant result when an older request resolves last', async () => {
    routeRef.query = { tenant_id: 'alpha' }
    listTenantsMock.mockResolvedValue({
      tenants: [
        { tenant_id: 'alpha', status: 'ACTIVE' },
        { tenant_id: 'beta', status: 'ACTIVE' },
      ],
      has_more: false,
    })
    const alpha = deferred<ReservationListResponse>()
    const beta = deferred<ReservationListResponse>()
    listReservationsMock.mockImplementation((tenantId: string) =>
      tenantId === 'alpha' ? alpha.promise : beta.promise,
    )

    const { default: ReservationsView } = await import('../views/ReservationsView.vue')
    const w = mount(ReservationsView, stdMount())
    await vi.waitFor(() => {
      expect(listReservationsMock.mock.calls.some(args => args[0] === 'alpha')).toBe(true)
    })

    routeRef.query = { tenant_id: 'beta' }
    await vi.waitFor(() => {
      expect(listReservationsMock.mock.calls.some(args => args[0] === 'beta')).toBe(true)
    })

    beta.resolve({
      reservations: [{
        reservation_id: 'res-beta', status: 'ACTIVE', scope_path: 'tenant:beta',
        reserved: { unit: 'TOKENS', amount: 2 }, created_at_ms: 2, expires_at_ms: 3,
      }],
      has_more: false,
    })
    await flushPromises()
    expect(w.text()).toContain('res-beta')

    alpha.resolve({
      reservations: [{
        reservation_id: 'res-alpha-stale', status: 'ACTIVE', scope_path: 'tenant:alpha',
        reserved: { unit: 'TOKENS', amount: 1 }, created_at_ms: 1, expires_at_ms: 2,
      }],
      has_more: false,
    })
    await flushPromises()
    expect((w.find('#res-tenant').element as HTMLSelectElement).value).toBe('beta')
    expect(w.text()).toContain('res-beta')
    expect(w.text()).not.toContain('res-alpha-stale')
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

  // Round 4 (F3): the ?status watcher was adopt-only — Back to a bare
  // /reservations kept a deep-linked status, so a bare URL showed
  // filtered data. Param absent now resets to the 'ACTIVE' default a
  // fresh bare-URL mount picks.
  it('Back to a bare URL (status param removed) resets a deep-linked ?status to ACTIVE', async () => {
    routeRef.query = { tenant_id: 'alpha', status: 'RELEASED' }
    listTenantsMock.mockResolvedValue({
      tenants: [{ tenant_id: 'alpha', status: 'ACTIVE' }],
      has_more: false,
    })
    const { default: ReservationsView } = await import('../views/ReservationsView.vue')
    const w = mount(ReservationsView, stdMount())
    await flushPromises()
    expect((w.find('#res-status').element as HTMLSelectElement).value).toBe('RELEASED')
    listReservationsMock.mockClear()

    // Browser Back to /reservations?tenant_id=alpha — status removed.
    routeRef.query = { tenant_id: 'alpha' }
    await flushPromises()
    expect((w.find('#res-status').element as HTMLSelectElement).value).toBe('ACTIVE')
    // The reset refetched under the default status.
    const call = listReservationsMock.mock.calls.at(-1)
    expect((call?.[1] as { status?: string } | undefined)?.status).toBe('ACTIVE')
  })

  // Round 4 (F4): the ?tenant_id watcher adopted ANY string — the mount
  // path validates against the loaded tenant list, but a mid-session
  // '/res acme-typo' palette command blanked the dropdown, 404'd the
  // fetch, and stamped the junk param into the URL. The watcher now
  // validates too: unknown id → keep the current filter, warn, and
  // correct the URL back to the current (valid) value.
  it('F4: a ?tenant_id change to an unknown id keeps the filter, warns, and corrects the URL', async () => {
    const { toasts } = await import('../composables/useToast')
    toasts.value = []
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
    replaceMock.mockReset()

    // Palette typo: /reservations?tenant_id=acme-typo — no remount.
    routeRef.query = { tenant_id: 'acme-typo' }
    await flushPromises()

    // Filter unchanged, no fetch under the junk id.
    expect((w.find('#res-tenant').element as HTMLSelectElement).value).toBe('alpha')
    expect(listReservationsMock.mock.calls.some(args => args[0] === 'acme-typo')).toBe(false)
    // Operator told why nothing happened.
    expect(toasts.value.some(t => t.type === 'warning' && t.message.includes('acme-typo'))).toBe(true)
    // URL corrected back to the current (valid) tenant.
    expect(replaceMock).toHaveBeenCalled()
    const arg = replaceMock.mock.calls.at(-1)![0] as { query: Record<string, string | undefined> }
    expect(arg.query.tenant_id).toBe('alpha')
    toasts.value = []
  })

  it('F4: a ?tenant_id change to a known id still adopts (regression guard)', async () => {
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
    listReservationsMock.mockClear()

    routeRef.query = { tenant_id: 'beta' }
    await flushPromises()
    expect((w.find('#res-tenant').element as HTMLSelectElement).value).toBe('beta')
    expect(listReservationsMock.mock.calls.some(args => args[0] === 'beta')).toBe(true)
  })

  it('F4: the mount path warns too when a deep-linked tenant does not exist', async () => {
    const { toasts } = await import('../composables/useToast')
    toasts.value = []
    routeRef.query = { tenant_id: 'deleted-tenant' }
    listTenantsMock.mockResolvedValue({
      tenants: [{ tenant_id: 'acme', status: 'ACTIVE' }],
      has_more: false,
    })
    const { default: ReservationsView } = await import('../views/ReservationsView.vue')
    mount(ReservationsView, stdMount())
    await flushPromises()
    expect(toasts.value.some(t => t.type === 'warning' && t.message.includes('deleted-tenant'))).toBe(true)
    toasts.value = []
  })
})

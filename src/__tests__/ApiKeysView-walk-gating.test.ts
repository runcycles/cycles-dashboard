// Round 5 (F2 + F5): expiring-filter walk gating + queued mode-switch.
//
// F2 — usePolling's refresh() is a documented no-op while a tick is in
// flight, and expiring-mode ticks span up to 11 requests. Toggling the
// filter chip (or Back to a bare URL) mid-walk was silently dropped:
// wrong-mode data stayed on screen for up to 60s, including an
// ACTIVE-only walk presented as the full list with load-more gone.
// The view now queues the refresh (OverviewView's pendingManualRefresh
// pattern) AND discards a walk/fetch that settles after the mode
// flipped (commit-time mode check — belt and suspenders).
//
// F5 — the walk was ungated: every 60s background tick re-ran up to 10
// pages per open tab. User-initiated triggers (mode entry, manual
// refresh, sort/search/tenant change) arm forceWalk and walk
// immediately; ambient background ticks re-walk only every 5th tick.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { reactive, type Ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities, ApiKey } from '../types'

const listApiKeysMock = vi.fn()
const listTenantsMock = vi.fn()
const replaceMock = vi.fn()

// Reactive so the view's route.query watchers fire when a test mutates
// the query (same-route navigation keeps the component mounted).
const routeRef = reactive<{ name: string; query: Record<string, unknown>; params: Record<string, string> }>({
  name: 'api-keys',
  query: {},
  params: {},
})

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
    useRoute: () => routeRef,
    RouterLink: { template: '<a><slot /></a>' },
  }
})

// Pass-through debounce — filter changes apply synchronously.
vi.mock('../composables/useDebouncedRef', () => ({
  useDebouncedRef: <T>(source: { value: T }) => source,
}))

// usePolling mock mirroring the real composable's contract precisely
// enough for F2/F5: a controllable isLoading ref plus a refresh() that
// no-ops while isLoading is true (the in-flight dedup the view must
// queue around). Background ticks are simulated by invoking
// pollState.callback directly — the real timer path calls the same fn.
const pollState = vi.hoisted(() => ({
  callback: null as null | (() => Promise<void> | void),
  isLoading: null as null | Ref<boolean>,
  refreshRuns: 0,
}))

vi.mock('../composables/usePolling', async () => {
  const { ref } = await import('vue')
  return {
    usePolling: (fn: () => Promise<void> | void) => {
      pollState.callback = fn
      const isLoading = ref(false)
      pollState.isLoading = isLoading
      pollState.refreshRuns = 0
      void fn() // initial tick
      return {
        refresh: () => {
          // In-flight dedup — same behavior as the real tick().
          if (isLoading.value) return
          pollState.refreshRuns++
          void fn()
        },
        isLoading,
        lastSuccessAt: ref<Date | null>(null),
      }
    },
  }
})

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

// Track wrappers and unmount after each test — routeRef is SHARED and
// reactive, so a still-mounted component from an earlier test would
// react to a later test's query mutations (its watchers fire the shared
// mocks and pollute call counts).
const mounted: Array<{ unmount: () => void }> = []
async function mountView() {
  const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
  const w = mount(ApiKeysView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, Teleport: true } } })
  mounted.push(w)
  await flushPromises(); await flushPromises()
  return w
}

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

beforeEach(() => {
  setActivePinia(createPinia())
  const auth = useAuthStore()
  auth.apiKey = 'test-key'
  auth.capabilities = FULL_CAPS
  listApiKeysMock.mockReset()
  listTenantsMock.mockReset()
  replaceMock.mockReset()
  listTenantsMock.mockResolvedValue({ tenants: [] })
  routeRef.query = {}
  routeRef.params = {}
  // Apply each replace to the reactive route, like the real router —
  // the view's URL→ref watchers must see the state a write-back
  // produced.
  replaceMock.mockImplementation(({ query }: { query: Record<string, string | undefined> }) => {
    const next: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) next[k] = v
    }
    routeRef.query = next
  })
})

describe('ApiKeysView — expiring-walk gating on background ticks (round 5 F5)', () => {
  it('background ticks 1-4 skip the walk; tick 5 re-walks', async () => {
    routeRef.query = { expiring_within_7d: '1' }
    listApiKeysMock.mockResolvedValue({ keys: [key('k-soon', { expires_at: in7d(3) })], has_more: false })
    await mountView()

    // Initial tick walked (deep-link mount must populate the view).
    expect(listApiKeysMock).toHaveBeenCalled()
    expect((listApiKeysMock.mock.calls[0][0] as Record<string, string>).status).toBe('ACTIVE')
    listApiKeysMock.mockClear()
    listTenantsMock.mockClear()

    // Ambient background ticks 1-4: cheap tenants fetch only, no walk —
    // expiry state changes at human cadence, not every 60s.
    for (let tick = 1; tick <= 4; tick++) {
      await pollState.callback!()
      await flushPromises()
      expect(listApiKeysMock).not.toHaveBeenCalled()
    }
    expect(listTenantsMock).toHaveBeenCalledTimes(4)

    // Tick 5 (~5 min at POLL_SLOW_MS): the walk re-runs.
    await pollState.callback!()
    await flushPromises()
    expect(listApiKeysMock).toHaveBeenCalled()
    expect((listApiKeysMock.mock.calls[0][0] as Record<string, string>).status).toBe('ACTIVE')
  })

  it('a sort change walks immediately (user-initiated, not gated)', async () => {
    routeRef.query = { expiring_within_7d: '1' }
    listApiKeysMock.mockResolvedValue({ keys: [key('k-soon', { expires_at: in7d(3) })], has_more: false })
    const w = await mountView()
    listApiKeysMock.mockClear()

    // One background tick just ran the gate down — a sort click must
    // still walk right away.
    await pollState.callback!()
    await flushPromises()
    expect(listApiKeysMock).not.toHaveBeenCalled()

    await w.find('[aria-label="Sort by Name"]').trigger('click')
    await flushPromises()
    expect(listApiKeysMock).toHaveBeenCalled()
    const params = listApiKeysMock.mock.calls[0][0] as Record<string, string>
    expect(params.status).toBe('ACTIVE')
    expect(params.sort_by).toBe('name')
  })

  it('a search change walks immediately too', async () => {
    routeRef.query = { expiring_within_7d: '1' }
    listApiKeysMock.mockResolvedValue({ keys: [key('k-soon', { expires_at: in7d(3) })], has_more: false })
    const w = await mountView()
    listApiKeysMock.mockClear()

    await w.find('#keys-search').setValue('soon')
    await flushPromises()
    expect(listApiKeysMock).toHaveBeenCalled()
    const params = listApiKeysMock.mock.calls[0][0] as Record<string, string>
    expect(params.status).toBe('ACTIVE')
    expect(params.search).toBe('soon')
  })
})

describe('ApiKeysView — mode switch during an in-flight tick (round 5 F2)', () => {
  it('disabling the filter mid-walk queues the refetch and discards the stale walk commit', async () => {
    routeRef.query = { expiring_within_7d: '1' }
    // The walk's page fetch hangs until we resolve it.
    const resolvers: Array<(v: unknown) => void> = []
    listApiKeysMock.mockImplementation(() => new Promise((res) => { resolvers.push(res) }))
    const w = await mountView()
    expect(resolvers).toHaveLength(1) // walk page 1 in flight
    pollState.isLoading!.value = true // tick is in flight
    await flushPromises()

    // Operator dismisses the chip mid-walk. usePolling would drop the
    // refresh — the view must queue it instead.
    await w.find('[data-testid="api-keys-expiring-filter-chip"] button').trigger('click')
    await flushPromises()
    expect(pollState.refreshRuns).toBe(0)

    // The walk settles AFTER the flip, with ACTIVE-only data. It must
    // NOT be committed as the normal-mode list.
    resolvers[0]({ keys: [key('k-active-walk', { expires_at: in7d(3) })], has_more: false })
    await flushPromises()
    expect(w.text()).not.toContain('k-active-walk')

    // Tick settles → the queued refetch replays under the new mode.
    listApiKeysMock.mockImplementation(() =>
      Promise.resolve({ keys: [key('k-normal-1'), key('k-normal-2')], has_more: true, next_cursor: 'c2' }))
    pollState.isLoading!.value = false
    await flushPromises(); await flushPromises()
    expect(pollState.refreshRuns).toBe(1)

    // Committed data matches the final (normal) mode: unscoped fetch,
    // pagination restored.
    const params = listApiKeysMock.mock.calls.at(-1)![0] as Record<string, string>
    expect(params.status).toBeUndefined()
    expect(w.text()).toContain('k-normal-1')
    expect(w.text()).toContain('Load more')
  })

  it('enabling the filter mid-tick queues too, and the replayed run walks immediately', async () => {
    routeRef.query = {}
    listApiKeysMock.mockResolvedValue({ keys: [key('k-normal-1')], has_more: false })
    await mountView()
    listApiKeysMock.mockClear()

    // A normal-mode tick is in flight when the URL flips the filter on
    // (e.g. Forward-nav to the filtered URL).
    pollState.isLoading!.value = true
    routeRef.query = { expiring_within_7d: '1' }
    await flushPromises()
    expect(pollState.refreshRuns).toBe(0)
    expect(listApiKeysMock).not.toHaveBeenCalled()

    // Tick settles → queued refetch replays in walk mode, forced (no
    // 5-tick wait).
    listApiKeysMock.mockResolvedValue({ keys: [key('k-soon', { expires_at: in7d(3) })], has_more: false })
    pollState.isLoading!.value = false
    await flushPromises(); await flushPromises()
    expect(pollState.refreshRuns).toBe(1)
    expect(listApiKeysMock).toHaveBeenCalled()
    expect((listApiKeysMock.mock.calls[0][0] as Record<string, string>).status).toBe('ACTIVE')
  })

  it('a normal-mode fetch settling after the filter flipped ON is discarded (no single page posing as the walked set)', async () => {
    routeRef.query = {}
    const resolvers: Array<(v: unknown) => void> = []
    listApiKeysMock.mockImplementation(() => new Promise((res) => { resolvers.push(res) }))
    const w = await mountView()
    expect(resolvers).toHaveLength(1) // normal page-1 fetch in flight
    pollState.isLoading!.value = true
    await flushPromises()

    routeRef.query = { expiring_within_7d: '1' } // flip ON mid-fetch
    await flushPromises()

    // The stale single page settles with has_more — committing it would
    // show load-more in walk mode.
    resolvers[0]({ keys: [key('k-stale-page')], has_more: true, next_cursor: 'c2' })
    await flushPromises()
    expect(w.text()).not.toContain('k-stale-page')
    expect(w.text()).not.toContain('Load more')
  })
})

// Round 5 (F3): same-route URL sync for EventsView.
//
// The `/event <id>` palette command pushes /events?search=<id>. When the
// operator is ALREADY on EventsView the component isn't remounted — only
// the route.query watcher can pick the param up. Pre-fix that watcher
// synced only trace_id / request_id / correlation_id: the search ref
// never updated (command was a no-op), and if a trace filter was set the
// watcher CLEARED it, so the debounced applyFilters rewrote the URL from
// the refs and stripped ?search entirely — the command undid itself.
// The watcher now re-syncs every param the view hydrates on mount,
// reset-style (URL-authoritative), aligned with AuditView.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { reactive } from 'vue'
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

// Reactive so the component's route.query watcher fires when a test
// mutates the query (same-route navigation keeps the component mounted).
const routeRef = reactive<{ name: string; query: Record<string, unknown>; params: Record<string, string> }>({
  name: 'events',
  query: {},
  params: {},
})
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
  const { ref } = await import('vue')
  return {
    usePolling: (fn: () => Promise<void> | void) => {
      void fn()
      return {
        refresh: async () => { void fn() },
        isLoading: ref(false),
        lastSuccessAt: ref<Date | null>(null),
      }
    },
  }
})

// Pass-through debounce — text-filter changes apply synchronously.
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

const TRACE = '0123456789abcdef0123456789abcdef'

// Track wrappers and unmount after each test — routeRef is SHARED and
// reactive, so a still-mounted component from an earlier test would
// react to a later test's query mutations.
const mounted: Array<{ unmount: () => void }> = []
async function mountView() {
  const { default: EventsView } = await import('../views/EventsView.vue')
  const w = mount(EventsView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, Teleport: true } } })
  mounted.push(w)
  await flushPromises()
  return w
}

beforeEach(() => {
  setActivePinia(createPinia())
  const auth = useAuthStore()
  auth.apiKey = 'test-key'
  auth.capabilities = FULL_CAPS
  listEventsMock.mockReset()
  listEventsMock.mockResolvedValue({ events: [], has_more: false })
  replaceMock.mockReset()
  routeRef.query = {}
  routeRef.params = {}
  // Apply each replace to the reactive route, like the real router —
  // applyFilters' write-back must be visible to the query watcher so a
  // sync loop (if one existed) would actually manifest in the test.
  replaceMock.mockImplementation(({ query }: { query: Record<string, string | undefined> }) => {
    const next: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) next[k] = v
    }
    routeRef.query = next
  })
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

describe('EventsView — same-route URL sync (round 5 F3)', () => {
  it('a same-route push with ?search syncs the search ref and refetches', async () => {
    const w = await mountView()
    listEventsMock.mockClear()

    // The `/event abc123` palette command while already on /events.
    routeRef.query = { search: 'abc123' }
    await flushPromises()

    expect((w.find('#ev-search').element as HTMLInputElement).value).toBe('abc123')
    expect(listEventsMock).toHaveBeenCalled()
    const params = listEventsMock.mock.calls.at(-1)![0] as Record<string, string>
    expect(params.search).toBe('abc123')
  })

  it('a pre-set trace filter is reset URL-authoritatively without stripping ?search from the URL', async () => {
    routeRef.query = { trace_id: TRACE }
    const w = await mountView()
    expect((w.find('#ev-trace').element as HTMLInputElement).value).toBe(TRACE)
    listEventsMock.mockClear()

    // Palette push replaces the whole query: search in, trace_id gone.
    routeRef.query = { search: 'abc123' }
    await flushPromises()

    // Refs reflect the URL (reset-style): search set, trace cleared.
    expect((w.find('#ev-search').element as HTMLInputElement).value).toBe('abc123')
    expect((w.find('#ev-trace').element as HTMLInputElement).value).toBe('')
    // The refetch is scoped to the new URL state…
    const params = listEventsMock.mock.calls.at(-1)![0] as Record<string, string>
    expect(params.search).toBe('abc123')
    expect(params.trace_id).toBeUndefined()
    // …and the write-back did NOT strip ?search (pre-fix the cleared
    // trace ref triggered applyFilters, which rewrote the URL from refs
    // that never learned about ?search).
    expect(routeRef.query.search).toBe('abc123')
    expect(routeRef.query.trace_id).toBeUndefined()
  })

  it('a stale in-flight load resolving AFTER a newer one is discarded (round 9 sequence guard)', async () => {
    // This harness doesn't stub the virtualizer, so rows never render in
    // jsdom — assert on the Load-more affordance instead: the stale R1
    // carries has_more:true, so if it wrongly commits, the button appears.
    const w = await mountView()
    listEventsMock.mockClear()

    // R1 = slow poll-style load; R2 = newer filtered load. R2 resolves
    // first; R1 late — must not overwrite the newer committed state.
    let resolveR1!: (v: unknown) => void
    const r1 = new Promise((r) => { resolveR1 = r })
    let calls = 0
    listEventsMock.mockImplementation(() =>
      calls++ === 0 ? r1 : Promise.resolve({ events: [], has_more: false }))

    await w.find('form').trigger('submit')      // R1 in flight (slow)
    routeRef.query = { search: 'abc' }          // newer load R2
    await flushPromises()
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(w.text()).not.toContain('Load more')

    resolveR1({ events: [], has_more: true, next_cursor: 'cur-old' })
    await flushPromises()
    // Pre-guard, the stale R1 committed has_more=true here.
    expect(w.text()).not.toContain('Load more')
  })

  it('a stale loadMore resolving AFTER a filter change is discarded (round 9: no cursor poisoning, no merge-mode flip)', async () => {
    // Mount with a page that has more to load.
    listEventsMock.mockResolvedValue({ events: [], has_more: true, next_cursor: 'cur-f1' })
    const w = await mountView()
    listEventsMock.mockClear()

    // Load more under filter F1 — response held in flight.
    let resolveMore!: (v: unknown) => void
    const more = new Promise((r) => { resolveMore = r })
    listEventsMock.mockImplementation((params: Record<string, string>) =>
      params?.cursor ? more : Promise.resolve({ events: [], has_more: false }))
    await w.find('button:not([disabled])').element // ensure render settled
    const loadMoreBtn = w.findAll('button').find(b => b.text() === 'Load more')!
    await loadMoreBtn.trigger('click')

    // Filter change while the loadMore page is in flight: the guarded
    // load() commits F2 with has_more=false (no cursor, no Load more).
    routeRef.query = { search: 'f2' }
    await flushPromises()
    expect(w.text()).not.toContain('Load more')

    // Stale F1 page-2 resolves late — must be fully discarded: no
    // cursor poisoning (Load more must NOT reappear via has_more=true).
    resolveMore({ events: [], has_more: true, next_cursor: 'cur-f1-page3' })
    await flushPromises()
    expect(w.text()).not.toContain('Load more')
  })

  it('explicit form submit (Enter) with an UNCHANGED signature still reloads — the manual retry path', async () => {
    const w = await mountView()
    listEventsMock.mockClear()

    // Transient failure leaves an error banner; the operator presses
    // Enter to re-run the identical query. The signature dedupe must
    // not swallow the explicit submit.
    listEventsMock.mockRejectedValueOnce(new Error('502 upstream'))
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(w.text()).toContain('502 upstream')
    expect(listEventsMock).toHaveBeenCalledTimes(1)

    listEventsMock.mockResolvedValueOnce({ events: [], has_more: false })
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(listEventsMock).toHaveBeenCalledTimes(2)
  })

  it('one same-route navigation changing several params fires exactly ONE listEvents call', async () => {
    routeRef.query = { category: 'budget', tenant_id: 't-alpha' }
    const w = await mountView()
    listEventsMock.mockClear()

    // CorrelationIdChip-style pivot: category+tenant out, trace_id in —
    // three refs change, but the identical-signature echoes from the
    // per-ref applyFilters watchers must collapse into a single fetch.
    routeRef.query = { trace_id: TRACE }
    await flushPromises()

    expect((w.find('#ev-trace').element as HTMLInputElement).value).toBe(TRACE)
    expect(listEventsMock).toHaveBeenCalledTimes(1)
    const params = listEventsMock.mock.calls[0][0] as Record<string, string>
    expect(params.trace_id).toBe(TRACE)
    expect(params.category).toBeUndefined()
    expect(params.tenant_id).toBeUndefined()
  })

  it('syncs the params the old watcher missed (category/type/tenant/scope/from/to) reset-style', async () => {
    routeRef.query = { category: 'runtime', tenant_id: 'acme', from: '2026-04-01T00:00' }
    const w = await mountView()
    listEventsMock.mockClear()

    routeRef.query = { type: 'reservation.denied', scope: 'tenant:acme/*', to: '2026-05-01T00:00' }
    await flushPromises()

    // Newly-present params adopted…
    expect((w.find('#ev-type').element as HTMLInputElement).value).toBe('reservation.denied')
    expect((w.find('#ev-scope').element as HTMLInputElement).value).toBe('tenant:acme/*')
    // …absent params reset (URL-authoritative).
    expect((w.find('#ev-category').element as HTMLSelectElement).value).toBe('')
    expect((w.find('#ev-tenant').element as HTMLInputElement).value).toBe('')
    const params = listEventsMock.mock.calls.at(-1)![0] as Record<string, string>
    expect(params.event_type).toBe('reservation.denied')
    expect(params.scope).toBe('tenant:acme/*')
    expect(params.category).toBeUndefined()
    expect(params.tenant_id).toBeUndefined()
    expect(params.from).toBeUndefined()
    expect(params.to).toBe(new Date('2026-05-01T00:00').toISOString())
  })

  it('ignores query changes that belong to another route (navigating away)', async () => {
    const w = await mountView()
    listEventsMock.mockClear()

    routeRef.name = 'audit'
    routeRef.query = { search: 'aud-only' }
    await flushPromises()

    expect((w.find('#ev-search').element as HTMLInputElement).value).toBe('')
    expect(listEventsMock).not.toHaveBeenCalled()
    routeRef.name = 'events'
  })

  it('a duplicated ?search param syncs as its first value instead of crashing (F1)', async () => {
    const w = await mountView()
    listEventsMock.mockClear()

    routeRef.query = { search: ['abc123', 'zzz'] }
    await flushPromises()

    expect((w.find('#ev-search').element as HTMLInputElement).value).toBe('abc123')
    const params = listEventsMock.mock.calls.at(-1)![0] as Record<string, string>
    expect(params.search).toBe('abc123')
  })
})

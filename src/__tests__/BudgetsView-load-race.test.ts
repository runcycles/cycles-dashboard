// Review round 7: loadList request-sequencing guard. A same-route
// ?search navigation (the /budget palette command) fires two staggered,
// NON-identical requests — the route watcher's immediate loadList still
// reads the 300ms-stale debouncedSearch (unfiltered R1), then the
// debounced watcher fires the filtered R2. Without sequencing, a slow
// R1 resolving after R2 committed the unfiltered fleet over the
// filtered view. Only the newest loadList may commit; stale responses
// (results and errors alike) are discarded.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities, BudgetLedger } from '../types'

const listBudgetsMock = vi.fn()
const listTenantsMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listBudgets: (...args: unknown[]) => listBudgetsMock(...args),
    listTenants: (...args: unknown[]) => listTenantsMock(...args),
    listEvents: vi.fn().mockResolvedValue({ events: [] }),
  }
})

const routeRef: { query: Record<string, string> } = { query: {} }

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useRoute: () => routeRef,
    RouterLink: { template: '<a><slot /></a>' },
  }
})

vi.mock('../composables/usePolling', () => {
  const { ref } = require('vue')
  return {
    usePolling: (fn: () => Promise<void> | void) => {
      void fn()
      return { refresh: async () => { void fn() }, isLoading: ref(false) }
    },
  }
})

// Bypass debounce so search edits drive the watchers synchronously.
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
        const size = opts.estimateSize?.() ?? 56
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

function ledger(scope: string): BudgetLedger {
  return {
    ledger_id: `led-${scope}`,
    scope,
    tenant_id: 't-alpha',
    unit: 'USD',
    allocated: { unit: 'USD', amount: 100 },
    spent: { unit: 'USD', amount: 10 },
    reserved: { unit: 'USD', amount: 0 },
    remaining: { unit: 'USD', amount: 90 },
    status: 'ACTIVE',
  } as unknown as BudgetLedger
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('BudgetsView — loadList sequencing guard (round 7)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listBudgetsMock.mockReset()
    listTenantsMock.mockReset()
    listTenantsMock.mockResolvedValue({ tenants: [] })
    for (const k of Object.keys(routeRef.query)) delete routeRef.query[k]
  })

  it('an older in-flight load resolving AFTER a newer one is discarded', async () => {
    // Mount load resolves immediately.
    listBudgetsMock.mockResolvedValueOnce({ ledgers: [ledger('scope-initial')], has_more: false })
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
    await flushPromises()
    expect(w.text()).toContain('scope-initial')

    // Two overlapping filter-driven loads with controllable resolution.
    const r1 = deferred<{ ledgers: BudgetLedger[]; has_more: boolean; next_cursor?: string }>()
    const r2 = deferred<{ ledgers: BudgetLedger[]; has_more: boolean; next_cursor?: string }>()
    // First in-flight load gets r1; every later (newer) load gets r2.
    // The view may fire more than two loads for two edits (write-back
    // echoes) — the spec pins ordering semantics, not the exact count.
    let loadCalls = 0
    listBudgetsMock.mockImplementation(() => (loadCalls++ === 0 ? r1.promise : r2.promise))

    const searchInput = w.find('#budget-search')
    await searchInput.setValue('one')   // fires load R1 (in flight)
    await searchInput.setValue('two')   // fires newer load(s) (in flight)
    expect(loadCalls).toBeGreaterThanOrEqual(2)

    // Newest (R2) resolves first and commits.
    r2.resolve({ ledgers: [ledger('scope-newest')], has_more: true, next_cursor: 'cur-2' })
    await flushPromises()
    expect(w.text()).toContain('scope-newest')

    // Stale R1 resolves late — must be DISCARDED, not committed.
    r1.resolve({ ledgers: [ledger('scope-stale')], has_more: false })
    await flushPromises()
    expect(w.text()).toContain('scope-newest')
    expect(w.text()).not.toContain('scope-stale')
  })

  it('a stale load failing AFTER a newer success does not raise the error banner', async () => {
    listBudgetsMock.mockResolvedValueOnce({ ledgers: [ledger('scope-initial')], has_more: false })
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
    await flushPromises()

    const r1 = deferred<never>()
    const r2 = deferred<{ ledgers: BudgetLedger[]; has_more: boolean }>()
    let loadCalls = 0
    listBudgetsMock.mockImplementation(() => (loadCalls++ === 0 ? r1.promise : r2.promise))

    const searchInput = w.find('#budget-search')
    await searchInput.setValue('one')
    await searchInput.setValue('two')

    r2.resolve({ ledgers: [ledger('scope-newest')], has_more: false })
    await flushPromises()

    // Stale R1 rejects late — its error must not clobber the fresh view.
    r1.promise.catch(() => {}) // avoid unhandled-rejection noise
    ;(r1.resolve as unknown as (v: unknown) => void)(Promise.reject(new Error('stale 502')))
    await flushPromises()
    expect(w.text()).toContain('scope-newest')
    expect(w.text()).not.toContain('stale 502')
  })
})

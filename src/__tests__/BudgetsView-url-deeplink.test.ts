// Deep-link smoke test for BudgetsView.
//
// Catches the class of bug where initial-mount URL params hit a TDZ
// ReferenceError, a null-deref, or any other crash during setup — the
// kind of failure that renders blank pages and leaves the router in
// a broken state (see TenantsView ?status=ACTIVE regression).
//
// Covers both the list-mode filter surface and the detail-mode split:
//   /budgets?status=ACTIVE
//   /budgets?filter=over_limit  (Overview drill-down)
//   /budgets?filter=has_debt    (Overview drill-down)
//   /budgets?scope=tenant:acme/*&unit=USD_MICROCENTS  (detail mode)
//
// Plus combos and ?filter=BOGUS (unknown value ignored, not crash).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

const listBudgetsMock = vi.fn()
const lookupBudgetMock = vi.fn()
const listTenantsMock = vi.fn()
const listEventsMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listBudgets: (...args: unknown[]) => listBudgetsMock(...args),
    lookupBudget: (...args: unknown[]) => lookupBudgetMock(...args),
    listTenants: (...args: unknown[]) => listTenantsMock(...args),
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
  ['?status=ACTIVE', { status: 'ACTIVE' }],
  ['?status=FROZEN', { status: 'FROZEN' }],
  ['?status=CLOSED', { status: 'CLOSED' }],
  ['?filter=over_limit', { filter: 'over_limit' }],
  ['?filter=has_debt', { filter: 'has_debt' }],
  ['?filter=BOGUS (unknown value ignored)', { filter: 'BOGUS' }],
  ['?filter=over_limit&status=ACTIVE (combo)', { filter: 'over_limit', status: 'ACTIVE' }],
  ['?scope=tenant:acme/*&unit=USD_MICROCENTS (detail mode)', { scope: 'tenant:acme/*', unit: 'USD_MICROCENTS' }],
]

describe('BudgetsView — URL deep-link smoke', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listBudgetsMock.mockReset()
    lookupBudgetMock.mockReset()
    listTenantsMock.mockReset()
    listEventsMock.mockReset()
    listBudgetsMock.mockResolvedValue({ ledgers: [], has_more: false })
    lookupBudgetMock.mockResolvedValue({
      ledger_id: 'bgt_test',
      tenant_id: 'acme',
      scope: 'tenant:acme/*',
      unit: 'USD_MICROCENTS',
      status: 'ACTIVE',
      allocated: { amount: 1000, unit: 'USD_MICROCENTS' },
      remaining: { amount: 500, unit: 'USD_MICROCENTS' },
      reserved: { amount: 0, unit: 'USD_MICROCENTS' },
      spent: { amount: 500, unit: 'USD_MICROCENTS' },
      debt: { amount: 0, unit: 'USD_MICROCENTS' },
      overdraft_limit: { amount: 0, unit: 'USD_MICROCENTS' },
      is_over_limit: false,
    })
    listTenantsMock.mockResolvedValue({ tenants: [], has_more: false })
    listEventsMock.mockResolvedValue({ events: [], has_more: false })
    routeRef.query = {}
    routeRef.params = {}
  })

  for (const [label, query] of QUERIES) {
    it(`mounts without throwing when URL is ${label}`, async () => {
      routeRef.query = query
      const { default: BudgetsView } = await import('../views/BudgetsView.vue')
      const w = mount(BudgetsView, stdMount())
      await flushPromises()
      expect(w.find('h1').exists()).toBe(true)
    })
  }
})

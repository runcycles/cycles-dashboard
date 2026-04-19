// Wire-up test for the v0.1.25.22 cross-tenant /admin/budgets path
// and the v0.1.25.19 BudgetLedger.tenant_id wire exposure.
//
// Before: BudgetsView fanned out over the tenant list (capped at 100),
// paginating per tenant, and applied over_limit / has_debt / utilization
// filters client-side — silently missing matches on tenants past the cap
// OR on pages 2+ of any tenant for client-only filters.
// After: a single listBudgets() call pushes every filter to the server:
// over_limit, has_debt, utilization_min, utilization_max, scope_prefix,
// status, unit. Pagination is a single cursor axis `{tenantId}|{ledgerId}`.
//
// These tests pin:
//  1. Mount → one listBudgets call with no tenant_id unless selected.
//  2. /budgets?filter=over_limit → server sees over_limit=true.
//  3. Load more forwards the composite cursor from page 1.
//  4. Utilization percent (0-100 in UI) is converted to ratio (0-1) for server.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

const listBudgetsMock = vi.fn()
const listTenantsMock = vi.fn()
const listEventsMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listBudgets: (...args: unknown[]) => listBudgetsMock(...args),
    listTenants: (...args: unknown[]) => listTenantsMock(...args),
    listEvents: (...args: unknown[]) => listEventsMock(...args),
    lookupBudget: vi.fn(),
    fundBudget: vi.fn(),
    freezeBudget: vi.fn(),
    unfreezeBudget: vi.fn(),
    updateBudgetConfig: vi.fn(),
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

vi.mock('../composables/usePolling', () => ({
  usePolling: (fn: () => Promise<void> | void) => {
    void fn()
    return {
      refresh: async () => { void fn() },
      isLoading: { value: false },
    }
  },
}))

// Bypass the 300ms debounce so tests drive filter changes synchronously.
vi.mock('../composables/useDebouncedRef', () => ({
  useDebouncedRef: <T>(source: { value: T }) => source,
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

function stdMounts() {
  return { stubs: { RouterLink: { template: '<a><slot /></a>' } } }
}

describe('BudgetsView — cross-tenant list wire-up', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listBudgetsMock.mockReset()
    listTenantsMock.mockReset()
    listTenantsMock.mockResolvedValue({ tenants: [] })
    routeRef.query = {}
  })

  it('issues one cross-tenant listBudgets call with no tenant_id on mount', async () => {
    listBudgetsMock.mockResolvedValue({ ledgers: [], has_more: false })
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    mount(BudgetsView, { global: stdMounts() })
    await flushPromises(); await flushPromises()

    expect(listBudgetsMock).toHaveBeenCalledTimes(1)
    const params = listBudgetsMock.mock.calls[0][0] as Record<string, string>
    expect(params.tenant_id).toBeUndefined()
    expect(params.limit).toBeDefined()
  })

  it('pushes over_limit=true to the server when route filter is over_limit', async () => {
    routeRef.query = { filter: 'over_limit' }
    listBudgetsMock.mockResolvedValue({ ledgers: [], has_more: false })
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    mount(BudgetsView, { global: stdMounts() })
    await flushPromises(); await flushPromises()

    expect(listBudgetsMock).toHaveBeenCalled()
    const params = listBudgetsMock.mock.calls[0][0] as Record<string, string>
    expect(params.over_limit).toBe('true')
    expect(params.has_debt).toBeUndefined()
  })

  it('pushes has_debt=true to the server when route filter is has_debt', async () => {
    routeRef.query = { filter: 'has_debt' }
    listBudgetsMock.mockResolvedValue({ ledgers: [], has_more: false })
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    mount(BudgetsView, { global: stdMounts() })
    await flushPromises(); await flushPromises()

    const params = listBudgetsMock.mock.calls[0][0] as Record<string, string>
    expect(params.has_debt).toBe('true')
    expect(params.over_limit).toBeUndefined()
  })

  it('converts UI utilization percent (0-100) to server ratio (0-1)', async () => {
    listBudgetsMock.mockResolvedValue({ ledgers: [], has_more: false })
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises(); await flushPromises()

    listBudgetsMock.mockClear()
    const minInput = w.find<HTMLInputElement>('input[type="number"]')
    expect(minInput.exists()).toBe(true)
    await minInput.setValue('75')
    await flushPromises(); await flushPromises()

    expect(listBudgetsMock).toHaveBeenCalled()
    const params = listBudgetsMock.mock.calls[0][0] as Record<string, string>
    // 75 / 100 = 0.75
    expect(params.utilization_min).toBe('0.75')
  })

  it('forwards next_cursor on Load more', async () => {
    listBudgetsMock
      .mockResolvedValueOnce({
        ledgers: [{
          ledger_id: 'led-1', tenant_id: 't-a', scope: 'tenant:t-a/p',
          unit: 'USD_MICROCENTS', allocated: { unit: 'USD_MICROCENTS', amount: 100 },
          remaining: { unit: 'USD_MICROCENTS', amount: 10 }, status: 'ACTIVE',
          created_at: '2026-04-01T00:00:00Z',
        }],
        has_more: true, next_cursor: 't-a|led-1',
      })
      .mockResolvedValueOnce({ ledgers: [], has_more: false })
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises(); await flushPromises()

    const loadMoreBtn = w.findAll('button').find(b => b.text() === 'Load more')
    expect(loadMoreBtn, 'Load more should render when has_more').toBeDefined()
    await loadMoreBtn!.trigger('click')
    await flushPromises()

    expect(listBudgetsMock).toHaveBeenCalledTimes(2)
    const page2Params = listBudgetsMock.mock.calls[1][0] as Record<string, string>
    expect(page2Params.cursor).toBe('t-a|led-1')
  })

  // V4 stage 2 — server-sort wire-up. The default useSort state
   // (sortKey='utilization', sortDir='desc') must ride every listBudgets
   // call, and Load-more must forward the same tuple because the
   // server's opaque cursor is bound to (sort_by, sort_dir, filters).
  it('forwards the default sort tuple (utilization desc) on initial fetch', async () => {
    listBudgetsMock.mockResolvedValue({ ledgers: [], has_more: false })
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    mount(BudgetsView, { global: stdMounts() })
    await flushPromises(); await flushPromises()

    const params = listBudgetsMock.mock.calls[0][0] as Record<string, string>
    expect(params.sort_by).toBe('utilization')
    expect(params.sort_dir).toBe('desc')
  })

  it('forwards the sort tuple on Load more so cursor binding stays valid', async () => {
    listBudgetsMock
      .mockResolvedValueOnce({
        ledgers: [{
          ledger_id: 'led-1', tenant_id: 't-a', scope: 'tenant:t-a/p',
          unit: 'USD_MICROCENTS', allocated: { unit: 'USD_MICROCENTS', amount: 100 },
          remaining: { unit: 'USD_MICROCENTS', amount: 10 }, status: 'ACTIVE',
          created_at: '2026-04-01T00:00:00Z',
        }],
        has_more: true, next_cursor: 't-a|led-1',
      })
      .mockResolvedValueOnce({ ledgers: [], has_more: false })
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises(); await flushPromises()

    const loadMoreBtn = w.findAll('button').find(b => b.text() === 'Load more')
    await loadMoreBtn!.trigger('click')
    await flushPromises()

    const page2Params = listBudgetsMock.mock.calls[1][0] as Record<string, string>
    expect(page2Params.sort_by).toBe('utilization')
    expect(page2Params.sort_dir).toBe('desc')
    expect(page2Params.cursor).toBe('t-a|led-1')
  })

  it('renders tenant_id from the ledger (prefers wire field over scope-parsing)', async () => {
    listBudgetsMock.mockResolvedValue({
      ledgers: [{
        ledger_id: 'led-1',
        tenant_id: 'acme-corp',
        scope: 'tenant:acme-corp/workspace:prod',
        unit: 'USD_MICROCENTS',
        allocated: { unit: 'USD_MICROCENTS', amount: 100 },
        remaining: { unit: 'USD_MICROCENTS', amount: 50 },
        status: 'ACTIVE',
        created_at: '2026-04-01T00:00:00Z',
      }],
      has_more: false,
    })
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises(); await flushPromises()

    // TenantLink renders the tenant_id as visible text.
    expect(w.text()).toContain('acme-corp')
  })
})

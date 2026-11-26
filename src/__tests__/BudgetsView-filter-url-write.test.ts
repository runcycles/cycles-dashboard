// Budgets filter → URL write-back, the detail round trip, and the audit
// drill-down links.
//
// Pre-fix: tenant / search / utilization filters were hydrated FROM the
// URL but never written TO it. Drilling into a budget and coming back
// reset them (the route.query watcher treats the URL as authoritative)
// while status / unit / scope-prefix survived — an inconsistent list
// and no shareable filtered URL. The row "Activity" link filtered the
// audit log on resource_id=<scope>, which matches no entry: the server
// keys budget audit rows by ledger_id (funding: `scope:UNIT`) and the
// filter is exact-match.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { reactive, h as actualH, defineComponent } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

enableAutoUnmount(afterEach)

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

const routeRef = reactive<{
  name: string
  query: Record<string, string>
  params: Record<string, string>
}>({ name: 'budgets', query: {}, params: {} })

type Nav = { name?: string; query?: Record<string, string | undefined> }
const pushMock = vi.fn()
// replace() behaves like the real router: the query becomes the route's
// query (undefined keys dropped), which re-fires the route.query watcher.
const replaceMock = vi.fn((to: Nav) => {
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(to.query ?? {})) if (v !== undefined) next[k] = v
  routeRef.query = next
})

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: pushMock, replace: replaceMock }),
    useRoute: () => routeRef,
  }
})

vi.mock('../composables/usePolling', async () => {
  const { createPollingMock } = await import('./helpers/createPollingMock')
  return { usePolling: createPollingMock }
})

// Debounce double. Default: mirrors the source synchronously (same as
// the identity mock other view tests use). With `manual` set, updates
// are held until flushDebounce() — like the real composable, a newer
// change replaces the pending one — so tests can act inside the window.
const debounceCtl = vi.hoisted(() => ({
  manual: false,
  pending: new Map<object, () => void>(),
}))
function flushDebounce() {
  const jobs = [...debounceCtl.pending.values()]
  debounceCtl.pending.clear()
  for (const job of jobs) job()
}

vi.mock('../composables/useDebouncedRef', async () => {
  const { ref, watch } = await import('vue')
  return {
    useDebouncedRef: <T>(source: { value: T }) => {
      const out = ref(source.value)
      watch(() => source.value, (next) => {
        if (debounceCtl.manual) debounceCtl.pending.set(out, () => { out.value = next })
        else out.value = next
      }, { flush: 'sync' })
      return out
    },
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

const LEDGER = {
  ledger_id: '7b1f6c1e-0000-4000-8000-000000000001',
  tenant_id: 'acme',
  scope: 'tenant:acme/workspace:prod',
  unit: 'USD_MICROCENTS',
  status: 'ACTIVE',
  allocated: { amount: 1000, unit: 'USD_MICROCENTS' },
  remaining: { amount: 500, unit: 'USD_MICROCENTS' },
  reserved: { amount: 0, unit: 'USD_MICROCENTS' },
  spent: { amount: 500, unit: 'USD_MICROCENTS' },
  debt: { amount: 0, unit: 'USD_MICROCENTS' },
  overdraft_limit: { amount: 0, unit: 'USD_MICROCENTS' },
  is_over_limit: false,
}

// RouterLink double that exposes the target as JSON for assertions.
const RouterLinkStub = defineComponent({
  props: { to: { type: null, required: false, default: null } },
  inheritAttrs: false,
  setup(props, { slots, attrs }) {
    return () => actualH('a', { ...attrs, 'data-to': JSON.stringify(props.to ?? null) }, slots.default?.())
  },
})

async function mountView() {
  const { default: BudgetsView } = await import('../views/BudgetsView.vue')
  const w = mount(BudgetsView, { global: { stubs: { RouterLink: RouterLinkStub, Teleport: true } } })
  await flushPromises()
  return w
}

describe('BudgetsView — filter URL write-back and audit links', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listBudgetsMock.mockReset()
    lookupBudgetMock.mockReset()
    listTenantsMock.mockReset()
    listEventsMock.mockReset()
    pushMock.mockClear()
    replaceMock.mockClear()
    listBudgetsMock.mockResolvedValue({ ledgers: [LEDGER], has_more: false })
    lookupBudgetMock.mockResolvedValue(LEDGER)
    listTenantsMock.mockResolvedValue({
      tenants: [
        { tenant_id: 'acme', name: 'Acme', status: 'ACTIVE', created_at: '2026-01-01T00:00:00Z' },
        { tenant_id: 'beta', name: 'Beta', status: 'ACTIVE', created_at: '2026-01-01T00:00:00Z' },
      ],
      has_more: false,
    })
    listEventsMock.mockResolvedValue({ events: [], has_more: false })
    routeRef.name = 'budgets'
    routeRef.query = {}
    routeRef.params = {}
    debounceCtl.manual = false
    debounceCtl.pending.clear()
  })

  it('does not rewrite the URL on a bare mount', async () => {
    await mountView()
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it('writes the tenant filter to ?tenant_id= and keeps it selected after the URL echo', async () => {
    const w = await mountView()
    const tenant = w.find<HTMLSelectElement>('#budget-tenant')
    await tenant.setValue('acme')
    await flushPromises()
    expect(replaceMock).toHaveBeenCalledTimes(1)
    expect(routeRef.query.tenant_id).toBe('acme')
    // The echo re-fires the route.query watcher — it must not clear the
    // ref (pre-fix the bare URL reset it to "All tenants").
    expect(tenant.element.value).toBe('acme')
    const params = listBudgetsMock.mock.calls[listBudgetsMock.mock.calls.length - 1][0] as Record<string, string>
    expect(params.tenant_id).toBe('acme')
  })

  it('writes search and the utilization range, and removes them when cleared', async () => {
    const w = await mountView()
    await w.find('#budget-search').setValue('  prod ')
    await w.find('#budget-util-min').setValue('90')
    await w.find('#budget-util-max').setValue('100')
    await flushPromises()
    expect(routeRef.query).toMatchObject({ search: 'prod', utilization_min: '90', utilization_max: '100' })
    // Trimmed echo must not clobber the operator's raw input.
    expect(w.find<HTMLInputElement>('#budget-search').element.value).toBe('  prod ')

    await w.find('#budget-search').setValue('')
    await w.find('#budget-util-min').setValue('')
    await flushPromises()
    expect(routeRef.query.search).toBeUndefined()
    expect(routeRef.query.utilization_min).toBeUndefined()
    expect(routeRef.query.utilization_max).toBe('100')
  })

  it('preserves unrelated query params (filter, include_terminal) when writing filters', async () => {
    routeRef.query = { status: 'FROZEN', include_terminal: '1' }
    const w = await mountView()
    await w.find('#budget-tenant').setValue('beta')
    await flushPromises()
    expect(routeRef.query).toEqual({ status: 'FROZEN', include_terminal: '1', tenant_id: 'beta' })
  })

  it('keeps ?status in step with the Status dropdown in both directions', async () => {
    routeRef.query = { status: 'FROZEN' }
    const w = await mountView()
    const status = w.find<HTMLSelectElement>('#budget-status')
    expect(status.element.value).toBe('FROZEN')
    // Dropdown → URL: clearing must drop the stale ?status=FROZEN.
    await status.setValue('')
    await flushPromises()
    expect(routeRef.query.status).toBeUndefined()
    // URL → dropdown: same-route navigation (back/forward, deep link).
    routeRef.query = { status: 'ACTIVE' }
    await flushPromises()
    expect(status.element.value).toBe('ACTIVE')
    const params = listBudgetsMock.mock.calls[listBudgetsMock.mock.calls.length - 1][0] as Record<string, string>
    expect(params.status).toBe('ACTIVE')
  })

  it('carries the list filters through the detail drill-in and the Back arrow', async () => {
    routeRef.query = { tenant_id: 'acme', search: 'prod' }
    const w = await mountView()
    const rowLink = w.findAll('a').find(a => a.text() === LEDGER.scope)
    expect(rowLink).toBeDefined()
    const to = JSON.parse(rowLink!.attributes('data-to')!) as Nav
    expect(to.query).toEqual({ tenant_id: 'acme', search: 'prod', scope: LEDGER.scope, unit: LEDGER.unit })

    // Enter detail mode with the carried query, then use the in-page Back.
    routeRef.query = to.query as Record<string, string>
    await flushPromises()
    replaceMock.mockClear()
    await w.find('button[aria-label="Back to budgets"]').trigger('click')
    expect(pushMock).toHaveBeenCalledWith({ name: 'budgets', query: { tenant_id: 'acme', search: 'prod' } })
    // Detail mode never rewrites the URL.
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it('ignores query changes that belong to another route', async () => {
    const w = await mountView()
    await w.find('#budget-tenant').setValue('acme')
    await flushPromises()
    replaceMock.mockClear()
    routeRef.name = 'reservations'
    routeRef.query = { tenant_id: 'beta' }
    await flushPromises()
    expect(w.find<HTMLSelectElement>('#budget-tenant').element.value).toBe('acme')
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it('a navigation inside the debounce window resets pending input instead of leaking it', async () => {
    // Review finding: type a search on /budgets?tenant_id=acme, then go
    // to bare /budgets before the 300ms debounce fires. Both URLs have
    // an empty search, so "URL equals the debounced value" misread the
    // navigation as this view's own echo, kept the typed text, and the
    // timer then wrote it into the destination URL.
    routeRef.query = { tenant_id: 'acme' }
    const w = await mountView()
    replaceMock.mockClear()
    debounceCtl.manual = true
    await w.find('#budget-search').setValue('prod')
    await flushPromises()
    // Debounce still pending: nothing written yet.
    expect(replaceMock).not.toHaveBeenCalled()

    routeRef.query = {}
    await flushPromises()
    expect(w.find<HTMLInputElement>('#budget-search').element.value).toBe('')
    expect(w.find<HTMLSelectElement>('#budget-tenant').element.value).toBe('')

    flushDebounce()
    await flushPromises()
    expect(replaceMock).not.toHaveBeenCalled()
    expect(routeRef.query).toEqual({})
  })

  it("the view's own URL write does not clobber text typed after the debounce fired", async () => {
    const w = await mountView()
    debounceCtl.manual = true
    const input = w.find<HTMLInputElement>('#budget-search')
    await input.setValue('pro')
    flushDebounce()
    // Operator keeps typing before the router echo is processed.
    await input.setValue('prod')
    await flushPromises()
    expect(routeRef.query.search).toBe('pro')
    expect(input.element.value).toBe('prod')
    flushDebounce()
    await flushPromises()
    expect(routeRef.query.search).toBe('prod')
  })

  it('hydrates a revisited URL after a competing navigation cancels replace', async () => {
    const { createRouter, createMemoryHistory, isNavigationFailure } =
      await vi.importActual<typeof import('vue-router')>('vue-router')
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ name: 'budgets', path: '/budgets', component: {} }],
    })
    router.afterEach((to, _from, failure) => {
      if (!failure) routeRef.query = to.query as Record<string, string>
    })
    await router.push('/budgets')
    let firstWrite!: ReturnType<typeof router.replace>
    replaceMock.mockImplementationOnce(to => (firstWrite = router.replace(to)))
    const w = await mountView()
    const input = w.get<HTMLInputElement>('#budget-search')
    await input.setValue('first')
    await router.push('/budgets?search=second')
    expect(isNavigationFailure(await firstWrite)).toBe(true)
    expect(input.element.value).toBe('second')

    await router.push('/budgets?search=first')
    await flushPromises()
    expect(input.element.value).toBe('first')
    expect(listBudgetsMock.mock.lastCall?.[0].search).toBe('first')
  })

  it('row Activity links filter the audit log by ledger_id, funding by scope:UNIT', async () => {
    const w = await mountView()
    const { default: RowActionsMenu } = await import('../components/RowActionsMenu.vue')
    const items = w.findComponent(RowActionsMenu).props('items') as Array<{ label?: string; to?: Nav }>
    const activity = items.find(i => i.label === 'Activity')!
    const funding = items.find(i => i.label === 'Funding activity')!
    expect(activity.to).toEqual({ name: 'audit', query: { resource_type: 'budget', resource_id: LEDGER.ledger_id } })
    expect(funding.to).toEqual({
      name: 'audit',
      query: { resource_type: 'budget', resource_id: `${LEDGER.scope}:${LEDGER.unit}` },
    })
  })
})

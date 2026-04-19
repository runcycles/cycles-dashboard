// v0.1.25.36: BudgetsView row-select bulk path — Freeze / Unfreeze via
// rateLimitedBatch over per-row freezeBudget / unfreezeBudget wrappers.
// Mirrors the TenantsView / WebhooksView row-select pattern. Freeze and
// unfreeze are NOT in the server-side BUDGET_BULK_ACTIONS enum (spec
// v0.1.25.26 limits that enum to CREDIT/DEBIT/RESET/RESET_SPENT/
// REPAY_DEBT), so this path fans out over the existing per-row endpoints
// instead of hitting POST /v1/admin/budgets/bulk-action.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

const listBudgetsMock = vi.fn()
const listTenantsMock = vi.fn()
const listEventsMock = vi.fn()
const bulkActionBudgetsMock = vi.fn()
const fundBudgetMock = vi.fn()
const freezeBudgetMock = vi.fn()
const unfreezeBudgetMock = vi.fn()
const lookupBudgetMock = vi.fn()
const updateBudgetConfigMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listBudgets: (...args: unknown[]) => listBudgetsMock(...args),
    listTenants: (...args: unknown[]) => listTenantsMock(...args),
    listEvents: (...args: unknown[]) => listEventsMock(...args),
    bulkActionBudgets: (...args: unknown[]) => bulkActionBudgetsMock(...args),
    fundBudget: (...args: unknown[]) => fundBudgetMock(...args),
    freezeBudget: (...args: unknown[]) => freezeBudgetMock(...args),
    unfreezeBudget: (...args: unknown[]) => unfreezeBudgetMock(...args),
    lookupBudget: (...args: unknown[]) => lookupBudgetMock(...args),
    updateBudgetConfig: (...args: unknown[]) => updateBudgetConfigMock(...args),
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

// Bypass debounce so filter changes drive watchers synchronously.
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

function ledger(id: string, opts: Partial<{ scope: string; unit: string; status: string; tenant_id: string }> = {}) {
  return {
    ledger_id: id,
    tenant_id: opts.tenant_id ?? 'acme',
    scope: opts.scope ?? `tenant:${opts.tenant_id ?? 'acme'}/${id}`,
    unit: opts.unit ?? 'USD_MICROCENTS',
    status: opts.status ?? 'ACTIVE',
    allocated: { unit: opts.unit ?? 'USD_MICROCENTS', amount: 1000 },
    remaining: { unit: opts.unit ?? 'USD_MICROCENTS', amount: 500 },
    spent: { unit: opts.unit ?? 'USD_MICROCENTS', amount: 500 },
    debt: { unit: opts.unit ?? 'USD_MICROCENTS', amount: 0 },
  }
}

function stdMounts() {
  return { stubs: { RouterLink: { template: '<a><slot /></a>' }, Teleport: true } }
}

async function selectTenant(w: ReturnType<typeof mount>, id: string) {
  const select = w.find<HTMLSelectElement>('select#budget-tenant')
  expect(select.exists()).toBe(true)
  await select.setValue(id)
  await flushPromises()
}

async function toggleRow(w: ReturnType<typeof mount>, scope: string) {
  const cbs = w.findAll<HTMLInputElement>('input[type="checkbox"]')
    .filter(c => (c.attributes('aria-label') || '').startsWith('Select budget '))
  const target = cbs.find(c => c.attributes('aria-label') === `Select budget ${scope}`)
  expect(target, `row checkbox for scope ${scope}`).toBeDefined()
  await target!.setValue(true)
  await flushPromises()
}

describe('BudgetsView — row-select bulk (v0.1.25.36)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listBudgetsMock.mockReset()
    listTenantsMock.mockReset()
    listEventsMock.mockReset()
    bulkActionBudgetsMock.mockReset()
    fundBudgetMock.mockReset()
    freezeBudgetMock.mockReset()
    unfreezeBudgetMock.mockReset()
    lookupBudgetMock.mockReset()
    updateBudgetConfigMock.mockReset()
    routeRef.query = {}
    document.body.innerHTML = ''
    listTenantsMock.mockResolvedValue({
      tenants: [{ tenant_id: 'acme', name: 'Acme', status: 'ACTIVE', created_at: '2026-01-01T00:00:00Z' }],
      has_more: false,
    })
    listBudgetsMock.mockResolvedValue({ ledgers: [], has_more: false })
  })

  it('hides the floating toolbar when no rows are selected', async () => {
    listBudgetsMock.mockResolvedValue({ ledgers: [ledger('a'), ledger('b')], has_more: false })
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises()
    await selectTenant(w, 'acme')

    const toolbar = w.find('[role="toolbar"][aria-label="Bulk budget actions"]')
    expect(toolbar.exists()).toBe(false)
  })

  it('shows the floating toolbar with Freeze/Unfreeze once a row is selected', async () => {
    listBudgetsMock.mockResolvedValue({ ledgers: [ledger('a'), ledger('b')], has_more: false })
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises()
    await selectTenant(w, 'acme')
    await toggleRow(w, 'tenant:acme/a')

    const toolbar = w.find('[role="toolbar"][aria-label="Bulk budget actions"]')
    expect(toolbar.exists()).toBe(true)
    expect(toolbar.text()).toContain('1 selected')
    expect(toolbar.findAll('button').map(b => b.text())).toEqual(expect.arrayContaining(['Freeze', 'Unfreeze']))
  })

  it('select-all header checkbox selects every visible row', async () => {
    const rows = [ledger('a'), ledger('b'), ledger('c')]
    listBudgetsMock.mockResolvedValue({ ledgers: rows, has_more: false })
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises()
    await selectTenant(w, 'acme')

    const headerCb = w.find<HTMLInputElement>('input[aria-label="Select all visible budgets"]')
    expect(headerCb.exists()).toBe(true)
    await headerCb.setValue(true)
    await flushPromises()

    const toolbar = w.find('[role="toolbar"][aria-label="Bulk budget actions"]')
    expect(toolbar.exists()).toBe(true)
    expect(toolbar.text()).toContain('3 selected')
  })

  it('clears selection when a filter changes', async () => {
    listBudgetsMock.mockResolvedValue({ ledgers: [ledger('a'), ledger('b')], has_more: false })
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises()
    await selectTenant(w, 'acme')
    await toggleRow(w, 'tenant:acme/a')

    expect(w.find('[role="toolbar"][aria-label="Bulk budget actions"]').exists()).toBe(true)

    await w.find<HTMLInputElement>('input#budget-scope').setValue('tenant:acme')
    await flushPromises()

    expect(w.find('[role="toolbar"][aria-label="Bulk budget actions"]').exists()).toBe(false)
  })

  it('bulk Freeze fans out over freezeBudget for every ACTIVE selected row', async () => {
    const rows = [ledger('a'), ledger('b'), ledger('c', { status: 'FROZEN' })]
    listBudgetsMock.mockResolvedValue({ ledgers: rows, has_more: false })
    freezeBudgetMock.mockResolvedValue({})
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises()
    await selectTenant(w, 'acme')

    const headerCb = w.find<HTMLInputElement>('input[aria-label="Select all visible budgets"]')
    await headerCb.setValue(true)
    await flushPromises()

    // Click Freeze on the toolbar.
    await w.findAll('button').find(b => b.text() === 'Freeze')!.trigger('click')
    await flushPromises()

    // Confirm dialog shows the filtered count (2 ACTIVE, 1 FROZEN skipped).
    expect(w.text()).toContain('Freeze 2 budgets?')
    await w.findAll('button').find(b => b.text() === 'Freeze all')!.trigger('click')
    await flushPromises()

    // Only the 2 ACTIVE rows got a freezeBudget call.
    expect(freezeBudgetMock).toHaveBeenCalledTimes(2)
    const calledScopes = freezeBudgetMock.mock.calls.map(c => c[0] as string).sort()
    expect(calledScopes).toEqual(['tenant:acme/a', 'tenant:acme/b'])
    // No calls against the FROZEN row.
    expect(freezeBudgetMock.mock.calls.map(c => c[0] as string)).not.toContain('tenant:acme/c')
    expect(unfreezeBudgetMock).not.toHaveBeenCalled()
  })

  it('bulk Unfreeze fans out over unfreezeBudget for every FROZEN selected row', async () => {
    const rows = [ledger('a', { status: 'FROZEN' }), ledger('b', { status: 'FROZEN' }), ledger('c')]
    listBudgetsMock.mockResolvedValue({ ledgers: rows, has_more: false })
    unfreezeBudgetMock.mockResolvedValue({})
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises()
    await selectTenant(w, 'acme')

    await w.find<HTMLInputElement>('input[aria-label="Select all visible budgets"]').setValue(true)
    await flushPromises()
    await w.findAll('button').find(b => b.text() === 'Unfreeze')!.trigger('click')
    await flushPromises()

    // Confirm dialog shows the filtered count (2 FROZEN, 1 ACTIVE skipped).
    expect(w.text()).toContain('Unfreeze 2 budgets?')
    await w.findAll('button').find(b => b.text() === 'Unfreeze all')!.trigger('click')
    await flushPromises()

    expect(unfreezeBudgetMock).toHaveBeenCalledTimes(2)
    const calledScopes = unfreezeBudgetMock.mock.calls.map(c => c[0] as string).sort()
    expect(calledScopes).toEqual(['tenant:acme/a', 'tenant:acme/b'])
    expect(freezeBudgetMock).not.toHaveBeenCalled()
  })

  it('skips CLOSED budgets from bulk Freeze selection', async () => {
    const rows = [ledger('a'), ledger('b', { status: 'CLOSED' })]
    listBudgetsMock.mockResolvedValue({ ledgers: rows, has_more: false })
    freezeBudgetMock.mockResolvedValue({})
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises()
    await selectTenant(w, 'acme')
    await w.find<HTMLInputElement>('input[aria-label="Select all visible budgets"]').setValue(true)
    await flushPromises()

    await w.findAll('button').find(b => b.text() === 'Freeze')!.trigger('click')
    await flushPromises()
    expect(w.text()).toContain('Freeze 1 budgets?')
    await w.findAll('button').find(b => b.text() === 'Freeze all')!.trigger('click')
    await flushPromises()

    expect(freezeBudgetMock).toHaveBeenCalledTimes(1)
    expect(freezeBudgetMock.mock.calls[0][0]).toBe('tenant:acme/a')
  })

  it('passes a reason string through to freezeBudget so the audit log identifies the bulk origin', async () => {
    listBudgetsMock.mockResolvedValue({ ledgers: [ledger('a')], has_more: false })
    freezeBudgetMock.mockResolvedValue({})
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises()
    await selectTenant(w, 'acme')
    await toggleRow(w, 'tenant:acme/a')
    await w.findAll('button').find(b => b.text() === 'Freeze')!.trigger('click')
    await flushPromises()
    await w.findAll('button').find(b => b.text() === 'Freeze all')!.trigger('click')
    await flushPromises()

    expect(freezeBudgetMock).toHaveBeenCalledWith('tenant:acme/a', 'USD_MICROCENTS', expect.stringContaining('bulk'))
  })

  it('clears selection and reloads list after a successful bulk freeze', async () => {
    listBudgetsMock.mockResolvedValue({ ledgers: [ledger('a'), ledger('b')], has_more: false })
    freezeBudgetMock.mockResolvedValue({})
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises()
    await selectTenant(w, 'acme')
    await w.find<HTMLInputElement>('input[aria-label="Select all visible budgets"]').setValue(true)
    await flushPromises()
    const listCallsBefore = listBudgetsMock.mock.calls.length

    await w.findAll('button').find(b => b.text() === 'Freeze')!.trigger('click')
    await flushPromises()
    await w.findAll('button').find(b => b.text() === 'Freeze all')!.trigger('click')
    await flushPromises()

    // Toolbar gone, selection cleared.
    expect(w.find('[role="toolbar"][aria-label="Bulk budget actions"]').exists()).toBe(false)
    // listBudgets was called again to refresh the list.
    expect(listBudgetsMock.mock.calls.length).toBeGreaterThan(listCallsBefore)
  })

  it('opens per-row result dialog when some per-row freezes fail', async () => {
    const rows = [ledger('a'), ledger('b'), ledger('c')]
    listBudgetsMock.mockResolvedValue({ ledgers: rows, has_more: false })
    // First + third succeed, middle fails.
    freezeBudgetMock.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({})

    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises()
    await selectTenant(w, 'acme')
    await w.find<HTMLInputElement>('input[aria-label="Select all visible budgets"]').setValue(true)
    await flushPromises()
    await w.findAll('button').find(b => b.text() === 'Freeze')!.trigger('click')
    await flushPromises()
    await w.findAll('button').find(b => b.text() === 'Freeze all')!.trigger('click')
    await flushPromises()

    expect(freezeBudgetMock).toHaveBeenCalledTimes(3)
    // v0.1.25.37 (slice B): per-row failures open the BulkActionResultDialog
    // rather than logging to console. The dialog renders the failed row's
    // id + scope label so operators can triage in-app.
    const dialog = w.find('[role="dialog"][aria-label="Freeze budgets — results"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.text()).toContain('tenant:acme/b')
  })
})

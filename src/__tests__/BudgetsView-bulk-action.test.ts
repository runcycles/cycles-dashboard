// Slice C (cycles-governance-admin v0.1.25.26, admin-server v0.1.25.29+):
// integration specs for BudgetsView's filter-apply bulk-action flow.
//
// Pins the dashboard-side guarantees that the tenants/webhooks paths
// already had (preview walk, expected_count gate, LIMIT_EXCEEDED UX,
// per-row result rendering) and the budget-specific structural rule:
// BudgetBulkFilter.tenant_id is REQUIRED — the Bulk-action button must
// be disabled whenever no tenant is selected, and the submitted filter
// must always carry tenant_id even when the operator set no other
// filters.

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

// Bypass debounce so search/filter inputs drive the watchers synchronously.
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

async function openBulkSetup(w: ReturnType<typeof mount>) {
  const btn = w.findAll('button').find(b => b.text() === 'Bulk action…')!
  expect(btn).toBeDefined()
  expect(btn.attributes('disabled')).toBeUndefined()
  await btn.trigger('click')
  await flushPromises()
}

// FormDialog wraps fields in `<form @submit.prevent>`, and jsdom doesn't
// bubble a submit event from a click on a type="submit" button. Trigger
// the submit event on the form directly — mirrors AuditView-filters'
// approach.
async function clickPreview(w: ReturnType<typeof mount>) {
  await w.find('form').trigger('submit')
  await flushPromises()
}

describe('BudgetsView — bulk-action (Slice C, v0.1.25.26)', () => {
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
    // Sensible defaults so initial mount doesn't explode.
    listTenantsMock.mockResolvedValue({ tenants: [{ tenant_id: 'acme', name: 'Acme', status: 'ACTIVE', created_at: '2026-01-01T00:00:00Z' }], has_more: false })
    listBudgetsMock.mockResolvedValue({ ledgers: [], has_more: false })
  })

  it('disables Bulk action when no tenant is selected (tenant_id is required per spec)', async () => {
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises()

    // Button label swaps to the blocker reason when disabled, so the
    // precondition is visible without hovering for a tooltip (Stripe/
    // Linear pattern — state-aware button text beats hover-only signals).
    const bulkBtn = w.findAll('button').find(b => b.text() === 'Select a tenant to bulk-act')
    expect(bulkBtn).toBeDefined()
    expect(bulkBtn!.attributes('disabled')).toBeDefined()
  })

  it('enables Bulk action once a tenant is selected', async () => {
    listBudgetsMock.mockResolvedValue({ ledgers: [ledger('a'), ledger('b')], has_more: false })
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises()

    await selectTenant(w, 'acme')

    const bulkBtn = w.findAll('button').find(b => b.text() === 'Bulk action…')!
    expect(bulkBtn.attributes('disabled')).toBeUndefined()
  })

  it('full happy path: setup → preview → submit sends filter.tenant_id + amount + expected_count', async () => {
    const rows = [ledger('a'), ledger('b'), ledger('c')]
    listBudgetsMock.mockResolvedValue({ ledgers: rows, has_more: false })
    bulkActionBudgetsMock.mockResolvedValue({
      action: 'CREDIT',
      total_matched: 3,
      succeeded: rows.map(r => ({ id: r.ledger_id })),
      failed: [],
      skipped: [],
      idempotency_key: 'kk',
    })

    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises()

    await selectTenant(w, 'acme')
    await openBulkSetup(w)

    // Setup dialog is open — fill amount, Preview.
    expect(w.text()).toContain('Bulk budget action')
    await w.find<HTMLInputElement>('input#bulk-amount').setValue('250')
    await clickPreview(w)

    // Preview walked listBudgets and shows 3 matches.
    expect(w.text()).toContain('3 budgets will be affected')

    // Confirm the bulk action.
    const confirmBtn = w.findAll('button').find(b => b.text().includes('Credit 3 budgets'))!
    expect(confirmBtn.attributes('disabled')).toBeUndefined()
    await confirmBtn.trigger('click')
    await flushPromises()

    expect(bulkActionBudgetsMock).toHaveBeenCalledTimes(1)
    const body = bulkActionBudgetsMock.mock.calls[0][0]
    expect(body.action).toBe('CREDIT')
    expect(body.filter.tenant_id).toBe('acme')
    expect(body.filter.status).toBe('ACTIVE')
    // Spec v0.1.25.26 — amount must be an Amount object {unit, amount},
    // not a scalar number. The server rejects scalar numbers with 400
    // INVALID_REQUEST.
    expect(body.amount).toEqual({ unit: 'USD_MICROCENTS', amount: 250 })
    expect(body.expected_count).toBe(3)
    expect(typeof body.idempotency_key).toBe('string')
    expect(body.idempotency_key.length).toBeGreaterThan(0)
  })

  it('RESET_SPENT sends amount (new allocated) and omits spent when left blank', async () => {
    const rows = [ledger('a'), ledger('b', { status: 'FROZEN' })]
    listBudgetsMock.mockResolvedValue({ ledgers: rows, has_more: false })
    bulkActionBudgetsMock.mockResolvedValue({
      action: 'RESET_SPENT',
      total_matched: 2,
      succeeded: rows.map(r => ({ id: r.ledger_id })),
      failed: [],
      skipped: [],
      idempotency_key: 'kk',
    })

    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises()

    await selectTenant(w, 'acme')
    await openBulkSetup(w)

    // Default action is CREDIT → amount visible, spent hidden.
    expect(w.find('input#bulk-amount').exists()).toBe(true)
    expect(w.find('input#bulk-spent').exists()).toBe(false)

    // Switch to RESET_SPENT → spec v0.1.25.26 requires amount for ALL five
    // actions, so amount stays visible; spent input is revealed alongside it.
    await w.find<HTMLSelectElement>('select#bulk-op').setValue('RESET_SPENT')
    expect(w.find('input#bulk-amount').exists()).toBe(true)
    expect(w.find('input#bulk-spent').exists()).toBe(true)

    // Fill amount (required), leave spent blank (defaults to 0 server-side).
    await w.find<HTMLInputElement>('input#bulk-amount').setValue('1000')
    await clickPreview(w)

    // RESET_SPENT runs on all statuses — both rows match in preview.
    expect(w.text()).toContain('2 budgets will be affected')

    const confirmBtn = w.findAll('button').find(b => b.text().includes('Reset spent 2 budgets'))!
    await confirmBtn.trigger('click')
    await flushPromises()

    const body = bulkActionBudgetsMock.mock.calls[0][0]
    expect(body.action).toBe('RESET_SPENT')
    // RESET_SPENT doesn't gate by status → filter omits status.
    expect(body.filter.status).toBeUndefined()
    // amount wrapped as Amount object; spent omitted (server defaults to 0).
    expect(body.amount).toEqual({ unit: 'USD_MICROCENTS', amount: 1000 })
    expect('spent' in body).toBe(false)
  })

  it('RESET_SPENT sends both amount and spent (each wrapped as Amount) when spent is filled in', async () => {
    const rows = [ledger('a')]
    listBudgetsMock.mockResolvedValue({ ledgers: rows, has_more: false })
    bulkActionBudgetsMock.mockResolvedValue({
      action: 'RESET_SPENT',
      total_matched: 1,
      succeeded: [{ id: 'a' }],
      failed: [],
      skipped: [],
      idempotency_key: 'kk',
    })

    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises()

    await selectTenant(w, 'acme')
    await openBulkSetup(w)

    // Pick a non-default unit to verify the selector plumbs through.
    await w.find<HTMLSelectElement>('select#bulk-unit').setValue('TOKENS')
    await w.find<HTMLSelectElement>('select#bulk-op').setValue('RESET_SPENT')
    await w.find<HTMLInputElement>('input#bulk-amount').setValue('2000')
    await w.find<HTMLInputElement>('input#bulk-spent').setValue('150')
    await clickPreview(w)

    await w.findAll('button').find(b => b.text().includes('Reset spent 1 budgets'))!.trigger('click')
    await flushPromises()

    const body = bulkActionBudgetsMock.mock.calls[0][0]
    expect(body.amount).toEqual({ unit: 'TOKENS', amount: 2000 })
    expect(body.spent).toEqual({ unit: 'TOKENS', amount: 150 })
  })

  it('surfaces LIMIT_EXCEEDED as humanized prose inside the preview dialog', async () => {
    listBudgetsMock.mockResolvedValue({ ledgers: [ledger('a')], has_more: false })
    const { ApiError } = await import('../api/client')
    bulkActionBudgetsMock.mockRejectedValue(
      new ApiError(400, 'Filter matches more than 500 budgets', 'LIMIT_EXCEEDED', 'req1', { total_matched: 742 }),
    )

    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises()

    await selectTenant(w, 'acme')
    await openBulkSetup(w)
    await w.find<HTMLInputElement>('input#bulk-amount').setValue('100')
    await clickPreview(w)

    await w.findAll('button').find(b => b.text().includes('Credit 1 budgets'))!.trigger('click')
    await flushPromises()

    expect(w.text()).toContain('Filter matches more than 500 budgets')
    expect(w.text()).toContain('742')
  })

  it('surfaces COUNT_MISMATCH as humanized prose inside the preview dialog', async () => {
    listBudgetsMock.mockResolvedValue({ ledgers: [ledger('a')], has_more: false })
    const { ApiError } = await import('../api/client')
    bulkActionBudgetsMock.mockRejectedValue(
      new ApiError(409, 'Budget list changed since preview', 'COUNT_MISMATCH', 'req2'),
    )

    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises()

    await selectTenant(w, 'acme')
    await openBulkSetup(w)
    await w.find<HTMLInputElement>('input#bulk-amount').setValue('100')
    await clickPreview(w)

    await w.findAll('button').find(b => b.text().includes('Credit 1 budgets'))!.trigger('click')
    await flushPromises()

    expect(w.text()).toContain('list changed between preview and submit')
  })

  it('opens BulkActionResultDialog with per-row BUDGET_EXCEEDED when some rows fail', async () => {
    const rows = [ledger('a'), ledger('b')]
    listBudgetsMock.mockResolvedValue({ ledgers: rows, has_more: false })
    bulkActionBudgetsMock.mockResolvedValue({
      action: 'DEBIT',
      total_matched: 2,
      succeeded: [{ id: 'a' }],
      failed: [{ id: 'b', error_code: 'BUDGET_EXCEEDED', message: 'requested 500, remaining 100' }],
      skipped: [],
      idempotency_key: 'kk',
    })

    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises()

    await selectTenant(w, 'acme')
    await openBulkSetup(w)
    await w.find<HTMLSelectElement>('select#bulk-op').setValue('DEBIT')
    await w.find<HTMLInputElement>('input#bulk-amount').setValue('500')
    await clickPreview(w)
    await w.findAll('button').find(b => b.text().includes('Debit 2 budgets'))!.trigger('click')
    await flushPromises()

    // Result dialog opened and humanized the per-row BUDGET_EXCEEDED code.
    expect(w.text()).toContain('Debit budgets — results')
    expect(w.text()).toContain('Budget exceeded')
    expect(w.text()).toContain('requested 500, remaining 100')
  })

  it('regenerates idempotency_key on a second submit after cancelling the first', async () => {
    const rows = [ledger('a')]
    listBudgetsMock.mockResolvedValue({ ledgers: rows, has_more: false })
    bulkActionBudgetsMock.mockResolvedValue({
      action: 'CREDIT', total_matched: 1,
      succeeded: [{ id: 'a' }], failed: [], skipped: [],
      idempotency_key: 'kk',
    })

    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises()

    await selectTenant(w, 'acme')

    // First submit.
    await openBulkSetup(w)
    await w.find<HTMLInputElement>('input#bulk-amount').setValue('100')
    await clickPreview(w)
    await w.findAll('button').find(b => b.text().includes('Credit 1 budgets'))!.trigger('click')
    await flushPromises()

    // Second submit — fresh setup, fresh preview, fresh submit.
    await openBulkSetup(w)
    await w.find<HTMLInputElement>('input#bulk-amount').setValue('200')
    await clickPreview(w)
    await w.findAll('button').find(b => b.text().includes('Credit 1 budgets'))!.trigger('click')
    await flushPromises()

    expect(bulkActionBudgetsMock).toHaveBeenCalledTimes(2)
    const k1 = bulkActionBudgetsMock.mock.calls[0][0].idempotency_key
    const k2 = bulkActionBudgetsMock.mock.calls[1][0].idempotency_key
    expect(typeof k1).toBe('string')
    expect(typeof k2).toBe('string')
    expect(k1).not.toBe(k2)
  })

  it('omits expected_count when the preview walk hits maxPages (partial count)', async () => {
    // Return has_more=true forever so the walker hits maxPages (20) without
    // ever hitting maxMatches (501) or exhausting. listBudgets mock returns
    // 10 ACTIVE rows per page → 200 matches in 20 pages → capped-at-pages.
    let callCount = 0
    listBudgetsMock.mockImplementation(async () => {
      callCount++
      return {
        ledgers: Array.from({ length: 10 }, (_, i) => ledger(`p${callCount}-${i}`)),
        has_more: true,
        next_cursor: `c${callCount}`,
      }
    })
    bulkActionBudgetsMock.mockResolvedValue({
      action: 'CREDIT', total_matched: 200,
      succeeded: [], failed: [], skipped: [],
      idempotency_key: 'kk',
    })

    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, { global: stdMounts() })
    await flushPromises()

    await selectTenant(w, 'acme')
    await openBulkSetup(w)
    await w.find<HTMLInputElement>('input#bulk-amount').setValue('5')
    await clickPreview(w)

    // Confirm with partial count.
    await w.findAll('button').find(b => b.text().includes('Credit 200 budgets'))!.trigger('click')
    await flushPromises()

    const body = bulkActionBudgetsMock.mock.calls[0][0]
    expect('expected_count' in body).toBe(false)
  })
})

// O1 (UI/UX P0): integration test for the filter-apply preview flow.
// Pre-fix, the dashboard sent a single POST to /v1/admin/tenants/bulk-
// action with a filter and the operator never saw which rows would be
// hit. A mistyped filter could suspend hundreds. This test pins:
//
//   1. With a search filter and no row-select, the "Suspend all" /
//      "Reactivate all" buttons render in the toolbar.
//   2. Clicking "Suspend all" opens the preview dialog and walks
//      listTenants.
//   3. The preview shows the count of *matching* rows (server-side
//      `search` returns a superset; the client predicate prunes by
//      action-derived status + parent_tenant_id).
//   4. Confirm sends bulkActionTenants with the matching action body
//      AND `expected_count` taken from the preview total so the
//      server's COUNT_MISMATCH gate engages.
//   5. When the walk hits the maxMatches cap (>500), the dialog
//      disables Confirm and the preview never sends a doomed POST.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

const listTenantsMock = vi.fn()
const bulkActionTenantsMock = vi.fn()
const updateTenantStatusMock = vi.fn()
const createTenantMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listTenants: (...args: unknown[]) => listTenantsMock(...args),
    bulkActionTenants: (...args: unknown[]) => bulkActionTenantsMock(...args),
    updateTenantStatus: (...args: unknown[]) => updateTenantStatusMock(...args),
    createTenant: (...args: unknown[]) => createTenantMock(...args),
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
      lastUpdated: { value: null },
    }
  },
}))

// Bypass debounce so search input drives the toolbar visibility synchronously.
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

function tenant(id: string, status = 'ACTIVE', name = `Name ${id}`) {
  return { tenant_id: id, name, status, created_at: '2026-01-01T00:00:00Z' }
}

function stdMounts() {
  return { stubs: { RouterLink: { template: '<a><slot /></a>' }, Teleport: true } }
}

describe('TenantsView — bulk-action preview (O1)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listTenantsMock.mockReset()
    bulkActionTenantsMock.mockReset()
    updateTenantStatusMock.mockReset()
    createTenantMock.mockReset()
    routeRef.query = {}
    document.body.innerHTML = ''
  })

  it('renders "Suspend all" / "Reactivate all" buttons when a search filter is set', async () => {
    listTenantsMock.mockResolvedValue({ tenants: [tenant('a'), tenant('b', 'SUSPENDED')], has_more: false })
    const { default: TenantsView } = await import('../views/TenantsView.vue')
    const w = mount(TenantsView, { global: stdMounts() })
    await flushPromises()

    // Type a search filter.
    const search = w.find<HTMLInputElement>('input[placeholder*="Search"]')
    expect(search.exists()).toBe(true)
    await search.setValue('acme')
    await flushPromises()

    const buttonTexts = w.findAll('button').map(b => b.text())
    expect(buttonTexts).toContain('Suspend all')
    expect(buttonTexts).toContain('Reactivate all')
  })

  it('opens the preview dialog and walks listTenants when "Suspend all" is clicked', async () => {
    // Every listTenants call (initial load + debouncedSearch watcher refreshes
    // + preview walk) returns the same page: 3 ACTIVE + 1 SUSPENDED.
    listTenantsMock.mockResolvedValue({
      tenants: [tenant('a'), tenant('b'), tenant('c'), tenant('d', 'SUSPENDED')],
      has_more: false,
    })

    const { default: TenantsView } = await import('../views/TenantsView.vue')
    const w = mount(TenantsView, { global: stdMounts() })
    await flushPromises()

    const search = w.find<HTMLInputElement>('input[placeholder*="Search"]')
    await search.setValue('a')
    await flushPromises()

    const suspendAllBtn = w.findAll('button').find(b => b.text() === 'Suspend all')!
    await suspendAllBtn.trigger('click')
    await flushPromises()

    // Dialog open: title contains "Suspend tenants matching filter"
    expect(w.text()).toContain('Suspend tenants matching filter')
    // Walk completed → count of ACTIVE = 3 (a, b, c). d is SUSPENDED.
    expect(w.text()).toContain('3 tenants will be affected')
    // Sample list shows the tenant_ids.
    expect(w.text()).toContain('a')
    expect(w.text()).toContain('b')
    expect(w.text()).toContain('c')

    // The Confirm button label encodes the count.
    const confirmBtn = w.findAll('button').find(b => b.text().includes('Suspend 3 tenants'))
    expect(confirmBtn).toBeDefined()
    expect(confirmBtn!.attributes('disabled')).toBeUndefined()
  })

  it('Confirm sends bulkActionTenants with action + filter + expected_count', async () => {
    const tenants = [tenant('a'), tenant('b'), tenant('c')]
    listTenantsMock.mockResolvedValue({ tenants, has_more: false })
    bulkActionTenantsMock.mockResolvedValue({
      action: 'SUSPEND',
      total_matched: 3,
      succeeded: tenants.map(t => ({ id: t.tenant_id })),
      failed: [],
      skipped: [],
      idempotency_key: 'kk',
    })

    const { default: TenantsView } = await import('../views/TenantsView.vue')
    const w = mount(TenantsView, { global: stdMounts() })
    await flushPromises()

    const search = w.find<HTMLInputElement>('input[placeholder*="Search"]')
    await search.setValue('a')
    await flushPromises()

    await w.findAll('button').find(b => b.text() === 'Suspend all')!.trigger('click')
    await flushPromises()

    const confirmBtn = w.findAll('button').find(b => b.text().includes('Suspend 3 tenants'))!
    await confirmBtn.trigger('click')
    await flushPromises()

    expect(bulkActionTenantsMock).toHaveBeenCalledTimes(1)
    const body = bulkActionTenantsMock.mock.calls[0][0]
    expect(body.action).toBe('SUSPEND')
    expect(body.filter.status).toBe('ACTIVE')
    expect(body.filter.search).toBe('a')
    // expected_count was set from the preview's exact count.
    expect(body.expected_count).toBe(3)
    // idempotency_key is a UUID v4 — just verify it's present.
    expect(typeof body.idempotency_key).toBe('string')
    expect(body.idempotency_key.length).toBeGreaterThan(0)
  })

  it('disables Confirm and skips the POST when the walk hits the maxMatches cap', async () => {
    // Build a "too many" page: 600 tenants, ACTIVE, has_more=false. The
    // composable defaults to maxMatches=501 so this hits cap on page 1.
    const big = Array.from({ length: 600 }, (_, i) => tenant(`big-${i}`))
    // Every call returns the full 600-row page so the preview walk hits the
    // maxMatches=501 cap on page 1 regardless of mock ordering.
    listTenantsMock.mockResolvedValue({ tenants: big, has_more: false })

    const { default: TenantsView } = await import('../views/TenantsView.vue')
    const w = mount(TenantsView, { global: stdMounts() })
    await flushPromises()

    const search = w.find<HTMLInputElement>('input[placeholder*="Search"]')
    await search.setValue('big')
    await flushPromises()

    await w.findAll('button').find(b => b.text() === 'Suspend all')!.trigger('click')
    await flushPromises()

    // Cap warning is rendered.
    expect(w.text()).toContain('500+')
    expect(w.text()).toContain('maximum of 500')

    // Confirm reads "Too many matches" and is disabled.
    const confirmBtn = w.findAll('button').find(b => b.text().includes('Too many matches'))
    expect(confirmBtn).toBeDefined()
    expect(confirmBtn!.attributes('disabled')).toBeDefined()

    // Click should be a no-op — bulkActionTenants must NOT fire.
    await confirmBtn!.trigger('click')
    await flushPromises()
    expect(bulkActionTenantsMock).not.toHaveBeenCalled()
  })

  it('Cancel button closes the preview without sending any POST', async () => {
    listTenantsMock.mockResolvedValue({ tenants: [tenant('x')], has_more: false })

    const { default: TenantsView } = await import('../views/TenantsView.vue')
    const w = mount(TenantsView, { global: stdMounts() })
    await flushPromises()

    const search = w.find<HTMLInputElement>('input[placeholder*="Search"]')
    await search.setValue('x')
    await flushPromises()

    await w.findAll('button').find(b => b.text() === 'Suspend all')!.trigger('click')
    await flushPromises()

    expect(w.text()).toContain('Suspend tenants matching filter')

    // Click Cancel.
    const cancelBtn = w.findAll('button').find(b => b.text() === 'Cancel')!
    await cancelBtn.trigger('click')
    await flushPromises()

    expect(w.text()).not.toContain('Suspend tenants matching filter')
    expect(bulkActionTenantsMock).not.toHaveBeenCalled()
  })
})

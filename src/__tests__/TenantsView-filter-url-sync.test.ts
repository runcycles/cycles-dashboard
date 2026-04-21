// Regression test for the filter-state lost on return flow:
//
//   1. operator sets filter on /tenants (e.g. status=ACTIVE)
//   2. operator clicks a row → navigates to /tenants/:id (detail)
//   3. operator clicks the back crumb
//   4. /tenants re-mounts with empty query → filter reset
//
// BudgetsView doesn't have this problem because its detail renders
// in-view (same component, same refs). TenantsView's detail is a
// separate route, so on return the component remounts and reads
// route.query to hydrate — which means the filters MUST be in the
// URL, not just in a ref.
//
// The fix pushes filter-ref changes to the URL via router.replace
// (replace, not push — filter fiddling shouldn't clutter history).
// Combined with router.back() in TenantDetailView.goBack, the
// drill-in → back flow restores filter state.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

const listTenantsMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listTenants: (...args: unknown[]) => listTenantsMock(...args),
  }
})

const routeRef: { query: Record<string, string> } = { query: {} }
const pushMock = vi.fn()
const replaceMock = vi.fn()

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: pushMock, replace: replaceMock }),
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

function tenant(id: string, status = 'ACTIVE') {
  return { tenant_id: id, name: `Name ${id}`, status, created_at: '2026-01-01T00:00:00Z' }
}

function stdMount() {
  return { global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, Teleport: true } } }
}

describe('TenantsView — filter-ref changes mirror into URL query', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listTenantsMock.mockReset()
    listTenantsMock.mockResolvedValue({
      tenants: [tenant('a', 'ACTIVE'), tenant('b', 'SUSPENDED'), tenant('c', 'CLOSED')],
      has_more: false,
    })
    routeRef.query = {}
    pushMock.mockReset()
    replaceMock.mockReset()
  })

  it('pushes router.replace with ?status=ACTIVE when the operator picks a status', async () => {
    const { default: TenantsView } = await import('../views/TenantsView.vue')
    const w = mount(TenantsView, stdMount())
    await flushPromises()
    // Pre-condition: no replace calls from a mount-time URL-ref roundtrip.
    expect(replaceMock).not.toHaveBeenCalled()

    const statusSelect = w.findAll<HTMLSelectElement>('select').find(s => {
      const opts = Array.from(s.element.options).map(o => o.value)
      return opts.includes('ACTIVE') && opts.includes('SUSPENDED') && opts.includes('CLOSED')
    })
    expect(statusSelect).toBeDefined()
    await statusSelect!.setValue('ACTIVE')
    await flushPromises()

    expect(replaceMock).toHaveBeenCalledTimes(1)
    const replaceArgs = replaceMock.mock.calls[0][0] as { query: Record<string, string | undefined> }
    expect(replaceArgs.query.status).toBe('ACTIVE')
  })

  it('pushes router.replace with ?parent=__root__ when the operator filters to root-level only', async () => {
    const { default: TenantsView } = await import('../views/TenantsView.vue')
    const w = mount(TenantsView, stdMount())
    await flushPromises()

    const parentSelect = w.findAll<HTMLSelectElement>('select').find(s =>
      s.element.getAttribute('aria-label')?.toLowerCase().includes('parent')
    )
    expect(parentSelect).toBeDefined()
    // '__root__' is the always-present pseudo-option — doesn't depend on
    // the tenant list having actual parent rows.
    await parentSelect!.setValue('__root__')
    await flushPromises()

    expect(replaceMock).toHaveBeenCalledTimes(1)
    const replaceArgs = replaceMock.mock.calls[0][0] as { query: Record<string, string | undefined> }
    expect(replaceArgs.query.parent).toBe('__root__')
  })

  it('clears ?status from the URL when the operator resets the filter to "any"', async () => {
    routeRef.query = { status: 'ACTIVE' }
    const { default: TenantsView } = await import('../views/TenantsView.vue')
    const w = mount(TenantsView, stdMount())
    await flushPromises()
    replaceMock.mockReset()

    const statusSelect = w.findAll<HTMLSelectElement>('select').find(s => {
      const opts = Array.from(s.element.options).map(o => o.value)
      return opts.includes('ACTIVE') && opts.includes('SUSPENDED') && opts.includes('CLOSED')
    })
    // Empty string = "any" option.
    await statusSelect!.setValue('')
    await flushPromises()

    expect(replaceMock).toHaveBeenCalledTimes(1)
    const replaceArgs = replaceMock.mock.calls[0][0] as { query: Record<string, string | undefined> }
    expect(replaceArgs.query.status).toBeUndefined()
  })

  it('does not loop: a URL-driven ref update does not re-push the same URL', async () => {
    // Deep-link mounts with ?status=ACTIVE — the existing
    // readStatusFromQuery() sets the ref synchronously on setup. The new
    // filter→URL watcher must recognize the URL already matches and skip.
    routeRef.query = { status: 'ACTIVE' }
    const { default: TenantsView } = await import('../views/TenantsView.vue')
    mount(TenantsView, stdMount())
    await flushPromises()
    // No router.replace calls — nothing to change, watcher guard skips.
    expect(replaceMock).not.toHaveBeenCalled()
  })
})

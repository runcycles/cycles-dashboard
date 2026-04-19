// Regression test for the blank-page bug where clicking the "N active"
// or "N suspended" chip on the Overview tenants tile navigated to
// /tenants?status=ACTIVE (or SUSPENDED) and the page rendered blank —
// then every subsequent navigation also rendered blank because the
// router was left in a thrown-handler state.
//
// Root cause: `watch(statusFromQuery, cb, { immediate: true })` ran the
// callback synchronously during setup. The callback touched `statusFilter`,
// which was a `const` declared several lines below the watch. When the
// URL carried a valid status on first mount, that access hit the
// temporal-dead-zone and threw ReferenceError.
//
// Tests BEFORE the fix would not have caught this because none of them
// exercised an initial-mount `?status=ACTIVE` deep-link — the bulk-preview
// test set routeRef.query = {} in beforeEach.

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

describe('TenantsView — URL status deep-link (Overview tile drill-down)', () => {
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
  })

  it('mounts without throwing when ?status=ACTIVE is on the URL at initial render', async () => {
    routeRef.query = { status: 'ACTIVE' }
    const { default: TenantsView } = await import('../views/TenantsView.vue')
    // The bug would manifest as a ReferenceError thrown from setup() on
    // the first access of the TDZ-bound ref — mount() would reject.
    const w = mount(TenantsView, stdMount())
    await flushPromises()
    // Page renders — header + filter toolbar are present.
    expect(w.find('h1').exists()).toBe(true)
  })

  it('pre-populates the status dropdown from ?status=SUSPENDED', async () => {
    routeRef.query = { status: 'SUSPENDED' }
    const { default: TenantsView } = await import('../views/TenantsView.vue')
    const w = mount(TenantsView, stdMount())
    await flushPromises()

    const statusSelect = w.find<HTMLSelectElement>('select[name="status"], [aria-label*="status" i]')
    if (statusSelect.exists()) {
      expect(statusSelect.element.value).toBe('SUSPENDED')
    } else {
      // Fallback: any <select> whose options include the three tenant statuses.
      const selects = w.findAll<HTMLSelectElement>('select')
      const target = selects.find(s => {
        const opts = Array.from(s.element.options).map(o => o.value)
        return opts.includes('ACTIVE') && opts.includes('SUSPENDED') && opts.includes('CLOSED')
      })
      expect(target).toBeDefined()
      expect(target!.element.value).toBe('SUSPENDED')
    }
  })

  it('ignores unknown ?status= values instead of breaking', async () => {
    routeRef.query = { status: 'BOGUS' }
    const { default: TenantsView } = await import('../views/TenantsView.vue')
    const w = mount(TenantsView, stdMount())
    await flushPromises()
    expect(w.find('h1').exists()).toBe(true)
  })

  it('mounts cleanly with ?parent=foo deep-link (same TDZ pattern risk)', async () => {
    routeRef.query = { parent: 'root-tenant' }
    const { default: TenantsView } = await import('../views/TenantsView.vue')
    const w = mount(TenantsView, stdMount())
    await flushPromises()
    expect(w.find('h1').exists()).toBe(true)
  })
})

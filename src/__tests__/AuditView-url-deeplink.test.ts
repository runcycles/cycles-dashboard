// Deep-link smoke test for AuditView.
//
// Catches the class of bug where initial-mount URL params hit a TDZ
// ReferenceError, a null-deref, or any other crash during setup — the
// kind of failure that renders blank pages and leaves the router in
// a broken state (see TenantsView ?status=ACTIVE regression).
//
// Covers every URL query applyQueryParams() reads:
//   /audit?tenant_id=acme
//   /audit?key_id=key_xxx
//   /audit?operation=createTenant
//   /audit?resource_type=tenant
//   /audit?resource_id=acme
//   /audit?search=budget
//   /audit?error_code=BUDGET_EXCEEDED
//   /audit?status_band=errors|success|4xx|5xx
//
// Plus combos and an invalid status_band (must not promote to the ref).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

const listAuditLogsMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listAuditLogs: (...args: unknown[]) => listAuditLogsMock(...args),
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
  ['?tenant_id=acme', { tenant_id: 'acme' }],
  ['?key_id=key_xxx', { key_id: 'key_xxx' }],
  ['?operation=createTenant', { operation: 'createTenant' }],
  ['?resource_type=tenant', { resource_type: 'tenant' }],
  ['?resource_id=acme', { resource_id: 'acme' }],
  ['?search=budget', { search: 'budget' }],
  ['?error_code=BUDGET_EXCEEDED', { error_code: 'BUDGET_EXCEEDED' }],
  ['?error_code_exclude=INTERNAL_ERROR,TIMEOUT', { error_code_exclude: 'INTERNAL_ERROR,TIMEOUT' }],
  ['?operation=createBudget,updatePolicy (v0.1.25.24 array)', { operation: 'createBudget,updatePolicy' }],
  ['?resource_type=tenant,budget (v0.1.25.24 array)', { resource_type: 'tenant,budget' }],
  ['?status_band=errors', { status_band: 'errors' }],
  ['?status_band=success', { status_band: 'success' }],
  ['?status_band=4xx', { status_band: '4xx' }],
  ['?status_band=5xx', { status_band: '5xx' }],
  ['?status_band=BOGUS (unknown value ignored)', { status_band: 'BOGUS' }],
  ['?tenant_id=acme&resource_type=tenant&status_band=errors (combo)', { tenant_id: 'acme', resource_type: 'tenant', status_band: 'errors' }],
]

describe('AuditView — URL deep-link smoke', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listAuditLogsMock.mockReset()
    listAuditLogsMock.mockResolvedValue({ logs: [], has_more: false })
    routeRef.query = {}
    routeRef.params = {}
  })

  for (const [label, query] of QUERIES) {
    it(`mounts without throwing when URL is ${label}`, async () => {
      routeRef.query = query
      const { default: AuditView } = await import('../views/AuditView.vue')
      const w = mount(AuditView, stdMount())
      await flushPromises()
      expect(w.find('h1').exists()).toBe(true)
    })
  }
})

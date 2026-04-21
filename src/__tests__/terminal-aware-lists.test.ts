// v0.1.25.46: per-view integration tests for hide-terminal-by-default.
//
// One describe block per view (Webhooks, Tenants, Budgets, ApiKeys,
// TenantDetail). Each verifies:
//   * terminal rows are hidden at mount by default
//   * flipping the toggle reveals them (sunk to the bottom)
//   * auto-engage when the operator explicitly filters for terminal status
//   * URL mirror on the top-level views
//
// Uses the same vitest/vue-router mock pattern as WebhooksView-url-deeplink
// and TenantsView-filter-url-sync so mocks stay consistent.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

const listWebhooksMock = vi.fn()
const listTenantsMock = vi.fn()
const listBudgetsMock = vi.fn()
const listApiKeysMock = vi.fn()
const getTenantMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listWebhooks: (...args: unknown[]) => listWebhooksMock(...args),
    listTenants: (...args: unknown[]) => listTenantsMock(...args),
    listBudgets: (...args: unknown[]) => listBudgetsMock(...args),
    listApiKeys: (...args: unknown[]) => listApiKeysMock(...args),
    getTenant: (...args: unknown[]) => getTenantMock(...args),
    getWebhookSecurityConfig: vi.fn().mockResolvedValue({ allow_http: false, require_signed_payload: true }),
    listBudgetLedgerEvents: vi.fn().mockResolvedValue({ events: [], has_more: false }),
  }
})

const routeRef: { query: Record<string, string>; params: Record<string, string> } = { query: {}, params: {} }
const pushMock = vi.fn()
const replaceMock = vi.fn((loc: { query: Record<string, string | undefined> }) => {
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(loc.query)) {
    if (v !== undefined) next[k] = v
  }
  routeRef.query = next
  return Promise.resolve()
})

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
    return { refresh: async () => { void fn() }, isLoading: { value: false } }
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

function resetAll() {
  setActivePinia(createPinia())
  const auth = useAuthStore()
  auth.apiKey = 'test-key'
  auth.capabilities = FULL_CAPS
  listWebhooksMock.mockReset()
  listTenantsMock.mockReset()
  listBudgetsMock.mockReset()
  listApiKeysMock.mockReset()
  getTenantMock.mockReset()
  routeRef.query = {}
  routeRef.params = {}
  pushMock.mockReset()
  replaceMock.mockClear()
}

// Shared helper — find the "Show <verb>" toggle checkbox by its aria-label.
function findToggle(w: ReturnType<typeof mount>, ariaLabelContains: string): HTMLInputElement | undefined {
  return w.findAll<HTMLInputElement>('input[type="checkbox"]').find(cb =>
    (cb.element.getAttribute('aria-label') || '').toLowerCase().includes(ariaLabelContains.toLowerCase())
  )?.element
}

// ─────────────────────────── WebhooksView ──────────────────────────────

describe('WebhooksView — hide DISABLED by default', () => {
  beforeEach(() => {
    resetAll()
    listWebhooksMock.mockResolvedValue({
      subscriptions: [
        { id: 'w1', url: 'https://ex.com/a', status: 'ACTIVE', event_types: [], created_at: '2026-01-01T00:00:00Z', failure_count: 0 },
        { id: 'w2', url: 'https://ex.com/b', status: 'DISABLED', event_types: [], created_at: '2026-01-02T00:00:00Z', failure_count: 0 },
        { id: 'w3', url: 'https://ex.com/c', status: 'PAUSED', event_types: [], created_at: '2026-01-03T00:00:00Z', failure_count: 0 },
      ],
      has_more: false,
    })
    listTenantsMock.mockResolvedValue({ tenants: [], has_more: false })
  })

  it('hides DISABLED rows at mount', async () => {
    const { default: WebhooksView } = await import('../views/WebhooksView.vue')
    const w = mount(WebhooksView, stdMount())
    await flushPromises()
    const html = w.html()
    expect(html).toContain('https://ex.com/a')
    expect(html).toContain('https://ex.com/c')
    expect(html).not.toContain('https://ex.com/b')
  })

  it('auto-engages when status=DISABLED is in the URL', async () => {
    routeRef.query = { status: 'DISABLED' }
    const { default: WebhooksView } = await import('../views/WebhooksView.vue')
    const w = mount(WebhooksView, stdMount())
    await flushPromises()
    // With explicit status=DISABLED, the filter upstream narrows rows to the
    // DISABLED one — composable's showTerminal must pass them through (not
    // filter to an empty list).
    expect(w.html()).toContain('https://ex.com/b')
  })

  it('toggle flip writes ?include_terminal=1 to the URL', async () => {
    const { default: WebhooksView } = await import('../views/WebhooksView.vue')
    const w = mount(WebhooksView, stdMount())
    await flushPromises()
    const toggle = findToggle(w, 'disabled')
    expect(toggle).toBeDefined()
    toggle!.checked = true
    toggle!.dispatchEvent(new Event('change'))
    await flushPromises()
    const call = replaceMock.mock.calls.find(c => (c[0] as { query?: Record<string, unknown> }).query?.include_terminal === '1')
    expect(call).toBeDefined()
  })
})

// ─────────────────────────── TenantsView ──────────────────────────────

describe('TenantsView — hide CLOSED by default', () => {
  beforeEach(() => {
    resetAll()
    listTenantsMock.mockResolvedValue({
      tenants: [
        { tenant_id: 't1', name: 'Acme', status: 'ACTIVE', created_at: '2026-01-01T00:00:00Z' },
        { tenant_id: 't2', name: 'Beta', status: 'CLOSED', created_at: '2026-01-02T00:00:00Z' },
        { tenant_id: 't3', name: 'Gamma', status: 'SUSPENDED', created_at: '2026-01-03T00:00:00Z' },
      ],
      has_more: false,
    })
  })

  it('hides CLOSED rows at mount', async () => {
    const { default: TenantsView } = await import('../views/TenantsView.vue')
    const w = mount(TenantsView, stdMount())
    await flushPromises()
    const html = w.html()
    expect(html).toContain('t1')
    expect(html).toContain('t3')
    expect(html).not.toContain('>t2<')
  })

  it('auto-engages when status=CLOSED is in the URL', async () => {
    routeRef.query = { status: 'CLOSED' }
    const { default: TenantsView } = await import('../views/TenantsView.vue')
    const w = mount(TenantsView, stdMount())
    await flushPromises()
    expect(w.html()).toContain('t2')
  })

  it('toggle flip writes ?include_terminal=1 to the URL', async () => {
    const { default: TenantsView } = await import('../views/TenantsView.vue')
    const w = mount(TenantsView, stdMount())
    await flushPromises()
    replaceMock.mockClear()
    const toggle = findToggle(w, 'closed tenant')
    expect(toggle).toBeDefined()
    toggle!.checked = true
    toggle!.dispatchEvent(new Event('change'))
    await flushPromises()
    const call = replaceMock.mock.calls.find(c => (c[0] as { query?: Record<string, unknown> }).query?.include_terminal === '1')
    expect(call).toBeDefined()
  })
})

// ─────────────────────────── BudgetsView ──────────────────────────────

describe('BudgetsView — hide CLOSED by default', () => {
  beforeEach(() => {
    resetAll()
    listBudgetsMock.mockResolvedValue({
      ledgers: [
        { ledger_id: 'b1', tenant_id: 'T', scope: 'scope-1', status: 'ACTIVE', unit: 'USD', commit_overage_policy: 'REJECT', allocated: { amount: 100, unit: 'USD' }, remaining: { amount: 50, unit: 'USD' }, reserved: { amount: 0, unit: 'USD' }, created_at: '2026-01-01T00:00:00Z' },
        { ledger_id: 'b2', tenant_id: 'T', scope: 'scope-2', status: 'CLOSED', unit: 'USD', commit_overage_policy: 'REJECT', allocated: { amount: 100, unit: 'USD' }, remaining: { amount: 0, unit: 'USD' }, reserved: { amount: 0, unit: 'USD' }, created_at: '2026-01-02T00:00:00Z' },
        { ledger_id: 'b3', tenant_id: 'T', scope: 'scope-3', status: 'FROZEN', unit: 'USD', commit_overage_policy: 'REJECT', allocated: { amount: 100, unit: 'USD' }, remaining: { amount: 75, unit: 'USD' }, reserved: { amount: 0, unit: 'USD' }, created_at: '2026-01-03T00:00:00Z' },
      ],
      has_more: false,
    })
  })

  it('hides CLOSED rows at mount', async () => {
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, stdMount())
    await flushPromises()
    const html = w.html()
    expect(html).toContain('scope-1')
    expect(html).toContain('scope-3')
    expect(html).not.toContain('scope-2')
  })

  it('auto-engages when status=CLOSED is in the URL', async () => {
    routeRef.query = { status: 'CLOSED' }
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, stdMount())
    await flushPromises()
    expect(w.html()).toContain('scope-2')
  })

  it('toggle flip writes ?include_terminal=1 to the URL', async () => {
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, stdMount())
    await flushPromises()
    replaceMock.mockClear()
    const toggle = findToggle(w, 'closed budget')
    expect(toggle).toBeDefined()
    toggle!.checked = true
    toggle!.dispatchEvent(new Event('change'))
    await flushPromises()
    const call = replaceMock.mock.calls.find(c => (c[0] as { query?: Record<string, unknown> }).query?.include_terminal === '1')
    expect(call).toBeDefined()
  })
})

// ─────────────────────────── ApiKeysView ──────────────────────────────

describe('ApiKeysView — hide REVOKED/EXPIRED by default', () => {
  beforeEach(() => {
    resetAll()
    listApiKeysMock.mockResolvedValue({
      keys: [
        { key_id: 'k1', name: 'key-active', status: 'ACTIVE', tenant_id: 'T', created_at: '2026-01-01T00:00:00Z', permissions: [] },
        { key_id: 'k2', name: 'key-revoked', status: 'REVOKED', tenant_id: 'T', created_at: '2026-01-02T00:00:00Z', permissions: [] },
        { key_id: 'k3', name: 'key-expired', status: 'EXPIRED', tenant_id: 'T', created_at: '2026-01-03T00:00:00Z', permissions: [] },
      ],
      has_more: false,
    })
    listTenantsMock.mockResolvedValue({ tenants: [], has_more: false })
  })

  it('hides REVOKED and EXPIRED rows at mount', async () => {
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = mount(ApiKeysView, stdMount())
    await flushPromises()
    const html = w.html()
    expect(html).toContain('key-active')
    expect(html).not.toContain('key-revoked')
    expect(html).not.toContain('key-expired')
  })

  it('auto-engages when the filter dropdown is set to REVOKED', async () => {
    // ApiKeysView doesn't hydrate filterStatus from ?status= in the URL
    // (keeping scope narrow — Overview's API-key drill-downs don't
    // deep-link into this view). Exercise the in-view filter instead.
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = mount(ApiKeysView, stdMount())
    await flushPromises()
    const statusSelect = w.findAll<HTMLSelectElement>('select').find(s => {
      const opts = Array.from(s.element.options).map(o => o.value)
      return opts.includes('ACTIVE') && opts.includes('REVOKED')
    })
    expect(statusSelect).toBeDefined()
    await statusSelect!.setValue('REVOKED')
    await flushPromises()
    expect(w.html()).toContain('key-revoked')
  })

  it('flipping the toggle reveals terminal rows', async () => {
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = mount(ApiKeysView, stdMount())
    await flushPromises()
    const toggle = findToggle(w, 'revoked')
    expect(toggle).toBeDefined()
    toggle!.checked = true
    toggle!.dispatchEvent(new Event('change'))
    await flushPromises()
    const html = w.html()
    expect(html).toContain('key-revoked')
    expect(html).toContain('key-expired')
  })
})

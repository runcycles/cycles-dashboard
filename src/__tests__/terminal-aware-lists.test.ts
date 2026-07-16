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

// `name` is set per-describe to the mounted view's route — the views'
// URL → ref watchers are route-identity-guarded (F3), and WebhooksView's
// `immediate` hydration run checks it at setup.
const routeRef: { query: Record<string, string>; params: Record<string, string>; name: string } =
  { query: {}, params: {}, name: '' }
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

vi.mock('../composables/usePolling', async () => {
  const { ref } = await import('vue')
  return {
    usePolling: (fn: () => Promise<void> | void) => {
      void fn()
      // Real ref — ApiKeysView edge-watches isLoading (round-5 F2).
      return { refresh: async () => { void fn() }, isLoading: ref(false) }
    },
  }
})

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

async function readBlob(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

async function exportJson(w: ReturnType<typeof mount>): Promise<unknown[]> {
  const trigger = w.findAll('button').find(button => button.text().trim() === 'Export JSON')
  expect(trigger).toBeDefined()
  await trigger!.trigger('click')
  await flushPromises()

  const dialog = w.find('[role="dialog"]')
  expect(dialog.exists()).toBe(true)
  const confirm = dialog.findAll('button').find(button => button.text().trim() === 'Export JSON')
  expect(confirm).toBeDefined()

  const createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  let downloaded: Blob | undefined
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      downloaded = blob
      return 'blob:terminal-aware-export-test'
    }),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

  try {
    await confirm!.trigger('click')
    await flushPromises()
    expect(downloaded).toBeDefined()
    return JSON.parse(await readBlob(downloaded!)) as unknown[]
  } finally {
    clickSpy.mockRestore()
    if (createDescriptor) Object.defineProperty(URL, 'createObjectURL', createDescriptor)
    else delete (URL as Partial<typeof URL>).createObjectURL
    if (revokeDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor)
    else delete (URL as Partial<typeof URL>).revokeObjectURL
  }
}

// ─────────────────────────── WebhooksView ──────────────────────────────

describe('WebhooksView — hide DISABLED by default', () => {
  beforeEach(() => {
    resetAll()
    routeRef.name = 'webhooks'
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

  it('keeps later export pages aligned with the visible status and terminal filters', async () => {
    routeRef.query = { status: 'ACTIVE' }
    listWebhooksMock.mockImplementation((params: Record<string, string> = {}) => Promise.resolve(
      params.cursor
        ? {
            subscriptions: [
              { subscription_id: 'w-paused', url: 'https://ex.com/paused', status: 'PAUSED', event_types: [], created_at: '2026-01-02T00:00:00Z', consecutive_failures: 0 },
              { subscription_id: 'w-disabled', url: 'https://ex.com/disabled', status: 'DISABLED', event_types: [], created_at: '2026-01-03T00:00:00Z', consecutive_failures: 2 },
            ],
            has_more: false,
          }
        : {
            subscriptions: [
              { subscription_id: 'w-active', url: 'https://ex.com/active', status: 'ACTIVE', event_types: [], created_at: '2026-01-01T00:00:00Z', consecutive_failures: 0 },
            ],
            has_more: true,
            next_cursor: 'page-2',
          },
    ))
    const { default: WebhooksView } = await import('../views/WebhooksView.vue')
    const w = mount(WebhooksView, stdMount())
    await flushPromises()

    const rows = await exportJson(w) as Array<{ subscription_id: string }>
    expect(rows.map(row => row.subscription_id)).toEqual(['w-active'])
  })
})

// ─────────────────────────── TenantsView ──────────────────────────────

describe('TenantsView — hide CLOSED by default', () => {
  beforeEach(() => {
    resetAll()
    routeRef.name = 'tenants'
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

  it('PageHeader counter + aria-rowcount match the visible (post-terminal-filter) list', async () => {
    // Review-round regression guard: counter, aria-rowcount, and the
    // select-all toggle must read from the terminal-filtered list, not
    // the pre-filter list. Otherwise the counter inflates and
    // select-all silently grabs the hidden CLOSED row for bulk actions.
    const { default: TenantsView } = await import('../views/TenantsView.vue')
    const w = mount(TenantsView, stdMount())
    await flushPromises()
    // 3 tenants in the fixture, 1 CLOSED → counter reads 2, not 3.
    expect(w.text()).toContain('2 tenants')
    const table = w.find('[role="table"]')
    expect(table.attributes('aria-rowcount')).toBe('3') // 2 rows + header
  })

  it('keeps later export pages aligned with the visible status and terminal filters', async () => {
    routeRef.query = { status: 'ACTIVE' }
    listTenantsMock.mockImplementation((params: Record<string, string> = {}) => Promise.resolve(
      params.cursor
        ? {
            tenants: [
              { tenant_id: 't-suspended', name: 'Suspended', status: 'SUSPENDED', created_at: '2026-01-02T00:00:00Z' },
              { tenant_id: 't-closed', name: 'Closed', status: 'CLOSED', created_at: '2026-01-03T00:00:00Z' },
            ],
            has_more: false,
          }
        : {
            tenants: [{ tenant_id: 't-active', name: 'Active', status: 'ACTIVE', created_at: '2026-01-01T00:00:00Z' }],
            has_more: true,
            next_cursor: 'page-2',
          },
    ))
    const { default: TenantsView } = await import('../views/TenantsView.vue')
    const w = mount(TenantsView, stdMount())
    await flushPromises()

    const rows = await exportJson(w) as Array<{ tenant_id: string }>
    expect(rows.map(row => row.tenant_id)).toEqual(['t-active'])
  })
})

// ─────────────────────────── BudgetsView ──────────────────────────────

describe('BudgetsView — hide CLOSED by default', () => {
  beforeEach(() => {
    resetAll()
    routeRef.name = 'budgets'
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

  it('keeps CLOSED budgets from later export pages when terminal rows are hidden', async () => {
    listBudgetsMock.mockImplementation((params: Record<string, string> = {}) => Promise.resolve(
      params.cursor
        ? {
            ledgers: [{ ledger_id: 'b-closed', tenant_id: 'T', scope: 'scope-closed', status: 'CLOSED', unit: 'USD', commit_overage_policy: 'REJECT', allocated: { amount: 100, unit: 'USD' }, remaining: { amount: 0, unit: 'USD' }, reserved: { amount: 0, unit: 'USD' }, created_at: '2026-01-02T00:00:00Z' }],
            has_more: false,
          }
        : {
            ledgers: [{ ledger_id: 'b-active', tenant_id: 'T', scope: 'scope-active', status: 'ACTIVE', unit: 'USD', commit_overage_policy: 'REJECT', allocated: { amount: 100, unit: 'USD' }, remaining: { amount: 50, unit: 'USD' }, reserved: { amount: 0, unit: 'USD' }, created_at: '2026-01-01T00:00:00Z' }],
            has_more: true,
            next_cursor: 'page-2',
          },
    ))
    const { default: BudgetsView } = await import('../views/BudgetsView.vue')
    const w = mount(BudgetsView, stdMount())
    await flushPromises()

    const rows = await exportJson(w) as Array<{ ledger_id: string }>
    expect(rows.map(row => row.ledger_id)).toEqual(['b-active'])
  })
})

// ─────────────────────────── ApiKeysView ──────────────────────────────

describe('ApiKeysView — hide REVOKED/EXPIRED by default', () => {
  beforeEach(() => {
    resetAll()
    routeRef.name = 'api-keys'
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

  it('keeps later export pages aligned with the visible status and terminal filters', async () => {
    listApiKeysMock.mockImplementation((params: Record<string, string> = {}) => Promise.resolve(
      params.cursor
        ? {
            keys: [
              { key_id: 'k-revoked', name: 'key-revoked', status: 'REVOKED', tenant_id: 'T', created_at: '2026-01-02T00:00:00Z', permissions: [] },
              { key_id: 'k-expired', name: 'key-expired', status: 'EXPIRED', tenant_id: 'T', created_at: '2026-01-03T00:00:00Z', permissions: [] },
            ],
            has_more: false,
          }
        : {
            keys: [{ key_id: 'k-active', name: 'key-active', status: 'ACTIVE', tenant_id: 'T', created_at: '2026-01-01T00:00:00Z', permissions: [] }],
            has_more: true,
            next_cursor: 'page-2',
          },
    ))
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = mount(ApiKeysView, stdMount())
    await flushPromises()
    const statusSelect = w.findAll<HTMLSelectElement>('select').find(select =>
      Array.from(select.element.options).some(option => option.value === 'REVOKED'),
    )
    expect(statusSelect).toBeDefined()
    await statusSelect!.setValue('ACTIVE')
    await flushPromises()
    const pageOneAfterStatusChange = listApiKeysMock.mock.calls.at(-1)?.[0]
    expect(pageOneAfterStatusChange).toMatchObject({ status: 'ACTIVE' })
    expect(pageOneAfterStatusChange?.cursor).toBeUndefined()

    const rows = await exportJson(w) as Array<{ key_id: string }>
    expect(rows.map(row => row.key_id)).toEqual(['k-active'])
    expect(listApiKeysMock.mock.calls.some(([params]) => params?.status === 'ACTIVE')).toBe(true)
  })
})

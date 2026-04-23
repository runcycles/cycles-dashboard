// P0-C2: TenantDetailView + WebhookDetailView render a dedicated
// "not found" card for 404 responses and a LoadingSkeleton before the
// first successful fetch, instead of leaving the page blank below the
// header. Distinct from transient-error handling — a 404 is a terminal
// "this URL is wrong" state and retry doesn't help.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { h as actualH, defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import { ApiError } from '../api/client'
import type { Capabilities } from '../types'

const getTenantMock = vi.fn()
const listTenantsMock = vi.fn()
const listBudgetsMock = vi.fn()
const listApiKeysMock = vi.fn()
const listPoliciesMock = vi.fn()
const listWebhooksMock = vi.fn()
const getWebhookMock = vi.fn()
const listDeliveriesMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    getTenant: (...args: unknown[]) => getTenantMock(...args),
    listTenants: (...args: unknown[]) => listTenantsMock(...args),
    listBudgets: (...args: unknown[]) => listBudgetsMock(...args),
    listApiKeys: (...args: unknown[]) => listApiKeysMock(...args),
    listPolicies: (...args: unknown[]) => listPoliciesMock(...args),
    listWebhooks: (...args: unknown[]) => listWebhooksMock(...args),
    getWebhook: (...args: unknown[]) => getWebhookMock(...args),
    listDeliveries: (...args: unknown[]) => listDeliveriesMock(...args),
  }
})

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
    useRoute: () => ({ query: {}, params: { id: 'acme' } }),
    RouterLink: { props: ['to'], template: '<a><slot /></a>' },
  }
})

// Return a controllable usePolling so we can hold the first call in-flight.
let pollCallback: (() => Promise<void> | void) | null = null
vi.mock('../composables/usePolling', async () => {
  const vue = await vi.importActual<typeof import('vue')>('vue')
  return {
    usePolling: (fn: () => Promise<void> | void) => {
      pollCallback = fn
      // Don't auto-invoke — each test drives the cold-load explicitly.
      return {
        refresh: async () => { await fn() },
        isLoading: vue.ref(false),
      }
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

async function mountTenantDetail() {
  const { default: TenantDetailView } = await import('../views/TenantDetailView.vue')
  const w = mount(TenantDetailView, {
    global: {
      stubs: {
        RouterLink: defineComponent({
          props: { to: { type: null, required: false, default: null } },
          inheritAttrs: false,
          setup(_p, { slots, attrs }) { return () => actualH('a', { ...attrs }, slots.default?.()) },
        }),
      },
    },
  })
  await flushPromises()
  return w
}

async function mountWebhookDetail() {
  const { default: WebhookDetailView } = await import('../views/WebhookDetailView.vue')
  const w = mount(WebhookDetailView, {
    global: {
      stubs: {
        RouterLink: defineComponent({
          props: { to: { type: null, required: false, default: null } },
          inheritAttrs: false,
          setup(_p, { slots, attrs }) { return () => actualH('a', { ...attrs }, slots.default?.()) },
        }),
      },
    },
  })
  await flushPromises()
  return w
}

describe('TenantDetailView — P0-C2 not-found + loading states', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'k'
    auth.capabilities = FULL_CAPS
    getTenantMock.mockReset()
    listTenantsMock.mockReset().mockResolvedValue({ tenants: [], has_more: false })
    listBudgetsMock.mockReset().mockResolvedValue({ ledgers: [], has_more: false })
    listApiKeysMock.mockReset().mockResolvedValue({ keys: [], has_more: false })
    listPoliciesMock.mockReset().mockResolvedValue({ policies: [], has_more: false })
    listWebhooksMock.mockReset().mockResolvedValue({ subscriptions: [], has_more: false })
    pollCallback = null
  })

  it('renders LoadingSkeleton before the first fetch resolves', async () => {
    // Hold the fetch in flight — never resolved — so initialLoadDone stays false.
    getTenantMock.mockImplementation(() => new Promise(() => {}))
    const w = await mountTenantDetail()
    // Fire the poll tick but DON'T await — the fetch is intentionally
    // held forever so initialLoadDone stays false.
    void pollCallback?.()
    await flushPromises()
    expect(w.find('[data-testid="tenant-initial-loading"]').exists()).toBe(true)
    expect(w.find('[data-testid="tenant-not-found"]').exists()).toBe(false)
  })

  it('renders not-found card on 404 and suppresses the error banner', async () => {
    getTenantMock.mockRejectedValue(new ApiError(404, 'Tenant not found'))
    const w = await mountTenantDetail()
    await pollCallback?.()
    await flushPromises()
    expect(w.find('[data-testid="tenant-not-found"]').exists()).toBe(true)
    expect(w.text()).toContain('Tenant not found')
    expect(w.text()).toContain('acme')
    // Generic error banner suppressed (not-found is the only signal).
    expect(w.find('.bg-red-50').exists()).toBe(false)
  })

  it('renders the error banner for non-404 failures', async () => {
    getTenantMock.mockRejectedValue(new ApiError(500, 'boom'))
    const w = await mountTenantDetail()
    await pollCallback?.()
    await flushPromises()
    expect(w.find('[data-testid="tenant-not-found"]').exists()).toBe(false)
    expect(w.find('.bg-red-50').exists()).toBe(true)
  })
})

describe('WebhookDetailView — P0-C2 not-found + loading states', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'k'
    auth.capabilities = FULL_CAPS
    getWebhookMock.mockReset()
    listDeliveriesMock.mockReset().mockResolvedValue({ deliveries: [], has_more: false })
    pollCallback = null
  })

  it('renders LoadingSkeleton before the first fetch resolves', async () => {
    getWebhookMock.mockImplementation(() => new Promise(() => {}))
    const w = await mountWebhookDetail()
    void pollCallback?.()
    await flushPromises()
    expect(w.find('[data-testid="webhook-initial-loading"]').exists()).toBe(true)
    expect(w.find('[data-testid="webhook-not-found"]').exists()).toBe(false)
  })

  it('renders not-found card on 404 and suppresses the error banner', async () => {
    getWebhookMock.mockRejectedValue(new ApiError(404, 'Webhook not found'))
    const w = await mountWebhookDetail()
    await pollCallback?.()
    await flushPromises()
    expect(w.find('[data-testid="webhook-not-found"]').exists()).toBe(true)
    expect(w.text()).toContain('Webhook not found')
    expect(w.find('.bg-red-50').exists()).toBe(false)
  })
})

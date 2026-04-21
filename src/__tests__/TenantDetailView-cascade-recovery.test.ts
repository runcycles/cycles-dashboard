// v0.1.25.44 CASCADE-RECOVERY BANNER — integration tests for the
// `TenantDetailView` affordance that surfaces when a tenant is CLOSED
// but at least one owned child is non-terminal. Covers the visibility
// matrix (ACTIVE → no banner, CLOSED-clean → no banner, CLOSED-with-
// pending → banner), the click→confirm→PATCH→refetch flow, and error
// surfacing on server failure. Pinned because the banner is the only
// dashboard affordance for spec v0.1.25.31 Rule 1(c) convergence
// (operator-issued re-close) and regressions here mean historical-
// closed tenants go back to looking permanent.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { h as actualH, defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type {
  Capabilities,
  Tenant,
  BudgetLedger,
  ApiKey,
  WebhookSubscription,
  Policy,
} from '../types'

const getTenantMock = vi.fn()
const listTenantsMock = vi.fn()
const listBudgetsMock = vi.fn()
const listApiKeysMock = vi.fn()
const listPoliciesMock = vi.fn()
const listWebhooksMock = vi.fn()
const updateTenantStatusMock = vi.fn()

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
    updateTenantStatus: (...args: unknown[]) => updateTenantStatusMock(...args),
  }
})

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useRoute: () => ({ query: {}, params: { id: 'acme' } }),
    RouterLink: { props: ['to'], template: '<a><slot /></a>' },
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

const FULL_CAPS: Capabilities = {
  view_overview: true, view_budgets: true, view_events: true,
  view_webhooks: true, view_audit: true, view_tenants: true,
  view_api_keys: true, view_policies: true,
  manage_budgets: true, manage_tenants: true, manage_api_keys: true,
  manage_webhooks: true, manage_policies: true, manage_reservations: true,
}

function tenant(status: string): Tenant {
  return { tenant_id: 'acme', name: 'Acme Corp', status, created_at: '2026-01-01T00:00:00Z' }
}

function budget(status: string): BudgetLedger {
  return {
    ledger_id: `ldg_${status.toLowerCase()}`,
    scope: 'acme/main',
    unit: 'tokens',
    allocated: { unit: 'tokens', amount: 1000 },
    remaining: { unit: 'tokens', amount: 500 },
    status,
    created_at: '2026-01-01T00:00:00Z',
  }
}

function webhook(status: string): WebhookSubscription {
  return {
    subscription_id: `wh_${status.toLowerCase()}`,
    tenant_id: 'acme',
    url: 'https://a.example/hook',
    name: 'w',
    event_types: ['budget.reserved'],
    status,
    created_at: '2026-01-01T00:00:00Z',
  }
}

function apiKey(status: string): ApiKey {
  return {
    key_id: `key_${status.toLowerCase()}`,
    tenant_id: 'acme',
    status,
    permissions: [],
    created_at: '2026-01-01T00:00:00Z',
  }
}

async function mountView() {
  const { default: TenantDetailView } = await import('../views/TenantDetailView.vue')
  const w = mount(TenantDetailView, {
    global: {
      stubs: {
        RouterLink: defineComponent({
          props: { to: { type: null, required: false, default: null } },
          inheritAttrs: false,
          setup(props, { slots, attrs }) {
            return () => {
              const to = props.to as { name?: string } | string | null | undefined
              const href = typeof to === 'string' ? to : (to?.name ?? '')
              return actualH('a', { ...attrs, href }, slots.default?.())
            }
          },
        }),
      },
    },
  })
  await flushPromises()
  return w
}

describe('TenantDetailView — cascade-recovery banner (v0.1.25.44)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS

    getTenantMock.mockReset()
    listTenantsMock.mockReset()
    listBudgetsMock.mockReset()
    listApiKeysMock.mockReset()
    listPoliciesMock.mockReset()
    listWebhooksMock.mockReset()
    updateTenantStatusMock.mockReset()

    listTenantsMock.mockResolvedValue({ tenants: [], has_more: false })
    listBudgetsMock.mockResolvedValue({ ledgers: [], has_more: false })
    listApiKeysMock.mockResolvedValue({ keys: [], has_more: false })
    listPoliciesMock.mockResolvedValue({ policies: [] as Policy[], has_more: false })
    listWebhooksMock.mockResolvedValue({ subscriptions: [], has_more: false })
  })

  describe('banner visibility', () => {
    it('does NOT render on an ACTIVE tenant, even with non-terminal children', async () => {
      getTenantMock.mockResolvedValue(tenant('ACTIVE'))
      listBudgetsMock.mockResolvedValue({ ledgers: [budget('FROZEN')], has_more: false })
      listWebhooksMock.mockResolvedValue({ subscriptions: [webhook('ACTIVE')], has_more: false })
      const w = await mountView()
      expect(w.find('[data-testid="cascade-recovery-banner"]').exists()).toBe(false)
    })

    it('does NOT render on a CLOSED tenant when all children are terminal', async () => {
      getTenantMock.mockResolvedValue(tenant('CLOSED'))
      listBudgetsMock.mockResolvedValue({ ledgers: [budget('CLOSED')], has_more: false })
      listWebhooksMock.mockResolvedValue({ subscriptions: [webhook('DISABLED')], has_more: false })
      listApiKeysMock.mockResolvedValue({ keys: [apiKey('REVOKED')], has_more: false })
      const w = await mountView()
      expect(w.find('[data-testid="cascade-recovery-banner"]').exists()).toBe(false)
    })

    it('renders on a CLOSED tenant with a non-terminal budget', async () => {
      getTenantMock.mockResolvedValue(tenant('CLOSED'))
      listBudgetsMock.mockResolvedValue({ ledgers: [budget('FROZEN')], has_more: false })
      const w = await mountView()
      const banner = w.find('[data-testid="cascade-recovery-banner"]')
      expect(banner.exists()).toBe(true)
      expect(banner.text()).toContain('Cascade incomplete')
      expect(banner.text()).toContain('1')
      expect(banner.text()).toContain('budget')
    })

    it('renders on a CLOSED tenant with a non-terminal webhook', async () => {
      getTenantMock.mockResolvedValue(tenant('CLOSED'))
      listWebhooksMock.mockResolvedValue({ subscriptions: [webhook('ACTIVE')], has_more: false })
      const w = await mountView()
      const banner = w.find('[data-testid="cascade-recovery-banner"]')
      expect(banner.exists()).toBe(true)
      expect(banner.text()).toContain('webhook')
    })

    it('renders on a CLOSED tenant with a non-terminal API key', async () => {
      getTenantMock.mockResolvedValue(tenant('CLOSED'))
      listApiKeysMock.mockResolvedValue({ keys: [apiKey('ACTIVE')], has_more: false })
      const w = await mountView()
      const banner = w.find('[data-testid="cascade-recovery-banner"]')
      expect(banner.exists()).toBe(true)
      expect(banner.text()).toContain('API key')
    })

    it('hides the banner when the operator lacks manage_tenants capability', async () => {
      const auth = useAuthStore()
      auth.capabilities = { ...FULL_CAPS, manage_tenants: false }
      getTenantMock.mockResolvedValue(tenant('CLOSED'))
      listBudgetsMock.mockResolvedValue({ ledgers: [budget('ACTIVE')], has_more: false })
      const w = await mountView()
      expect(w.find('[data-testid="cascade-recovery-banner"]').exists()).toBe(false)
    })
  })

  describe('rerun cascade flow', () => {
    it('clicking "Re-run cascade" opens the confirm dialog', async () => {
      getTenantMock.mockResolvedValue(tenant('CLOSED'))
      listBudgetsMock.mockResolvedValue({ ledgers: [budget('ACTIVE')], has_more: false })
      const w = await mountView()
      await w.find('[data-testid="cascade-recovery-button"]').trigger('click')
      await flushPromises()
      // ConfirmAction renders a modal with the action copy
      expect(w.text()).toContain('Re-run cascade on this closed tenant')
    })

    it('PATCHes tenant status to CLOSED on confirm + refetches children', async () => {
      getTenantMock.mockResolvedValue(tenant('CLOSED'))
      listBudgetsMock.mockResolvedValue({ ledgers: [budget('ACTIVE')], has_more: false })
      updateTenantStatusMock.mockResolvedValue(tenant('CLOSED'))

      const w = await mountView()
      await w.find('[data-testid="cascade-recovery-button"]').trigger('click')
      await flushPromises()

      // After the dialog opens, the confirm button lives in ConfirmAction.
      // Find it by its label text.
      const buttons = w.findAll('button')
      const confirmBtn = buttons.find(b => b.text() === 'Re-run Cascade')
      expect(confirmBtn).toBeDefined()
      await confirmBtn!.trigger('click')
      await flushPromises()

      expect(updateTenantStatusMock).toHaveBeenCalledWith('acme', 'CLOSED')
      // Refetch hit all four endpoints after the PATCH
      expect(getTenantMock).toHaveBeenCalled()
      expect(listBudgetsMock).toHaveBeenCalled()
      expect(listWebhooksMock).toHaveBeenCalled()
      expect(listApiKeysMock).toHaveBeenCalled()
    })

    it('hides the banner after a successful re-run clears pending children', async () => {
      getTenantMock.mockResolvedValue(tenant('CLOSED'))
      listBudgetsMock.mockResolvedValueOnce({ ledgers: [budget('ACTIVE')], has_more: false })
      updateTenantStatusMock.mockResolvedValue(tenant('CLOSED'))
      // On refetch after the PATCH, cascade converged:
      listBudgetsMock.mockResolvedValue({ ledgers: [budget('CLOSED')], has_more: false })
      listWebhooksMock.mockResolvedValue({ subscriptions: [], has_more: false })
      listApiKeysMock.mockResolvedValue({ keys: [], has_more: false })

      const w = await mountView()
      expect(w.find('[data-testid="cascade-recovery-banner"]').exists()).toBe(true)

      await w.find('[data-testid="cascade-recovery-button"]').trigger('click')
      await flushPromises()
      const confirmBtn = w.findAll('button').find(b => b.text() === 'Re-run Cascade')
      await confirmBtn!.trigger('click')
      await flushPromises()

      expect(w.find('[data-testid="cascade-recovery-banner"]').exists()).toBe(false)
    })

    it('surfaces server error inline when re-run fails', async () => {
      getTenantMock.mockResolvedValue(tenant('CLOSED'))
      listBudgetsMock.mockResolvedValue({ ledgers: [budget('ACTIVE')], has_more: false })
      updateTenantStatusMock.mockRejectedValue(new Error('503 Service Unavailable'))

      const w = await mountView()
      await w.find('[data-testid="cascade-recovery-button"]').trigger('click')
      await flushPromises()
      const confirmBtn = w.findAll('button').find(b => b.text() === 'Re-run Cascade')
      await confirmBtn!.trigger('click')
      await flushPromises()

      const banner = w.find('[data-testid="cascade-recovery-banner"]')
      expect(banner.exists()).toBe(true)
      expect(banner.text()).toContain('503 Service Unavailable')
    })
  })
})

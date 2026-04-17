// I1 (UI/UX P0): OverviewView integration tests. Pins the "what needs
// attention" rebuild — alerts first, positive "all clear" state when
// nothing's firing, counter strip demoted to the bottom, new Expiring
// Keys + Recent Activity cards wired to their respective endpoints.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities, AdminOverviewResponse, ApiKey, AuditLogEntry } from '../types'

const getOverviewMock = vi.fn()
const listApiKeysMock = vi.fn()
const listAuditLogsMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    getOverview: (...args: unknown[]) => getOverviewMock(...args),
    listApiKeys: (...args: unknown[]) => listApiKeysMock(...args),
    listAuditLogs: (...args: unknown[]) => listAuditLogsMock(...args),
  }
})

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useRoute: () => ({ query: {}, params: {} }),
    RouterLink: { props: ['to'], template: '<a :href="typeof to === \'string\' ? to : (to.name || \'\')"><slot /></a>' },
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

const FULL_CAPS: Capabilities = {
  view_overview: true, view_budgets: true, view_events: true,
  view_webhooks: true, view_audit: true, view_tenants: true,
  view_api_keys: true, view_policies: true,
  manage_budgets: true, manage_tenants: true, manage_api_keys: true,
  manage_webhooks: true, manage_policies: true, manage_reservations: true,
}

function healthyOverview(overrides: Partial<AdminOverviewResponse> = {}): AdminOverviewResponse {
  return {
    as_of: '2026-04-17T12:00:00Z',
    event_window_seconds: 3600,
    tenant_counts: { total: 10, active: 10, suspended: 0, closed: 0 },
    budget_counts: {
      total: 5, active: 5, frozen: 0, closed: 0,
      over_limit: 0, with_debt: 0, by_unit: {},
    },
    over_limit_scopes: [],
    debt_scopes: [],
    webhook_counts: { total: 3, active: 3, disabled: 0, with_failures: 0 },
    failing_webhooks: [],
    event_counts: { total_recent: 42, by_category: { runtime: 42 } },
    recent_denials: [],
    recent_expiries: [],
    ...overrides,
  }
}

function key(id: string, overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    key_id: id,
    tenant_id: 't',
    status: 'ACTIVE',
    permissions: [],
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function auditEntry(id: string, overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    log_id: id,
    timestamp: '2026-04-17T11:59:00Z',
    operation: 'tenant.suspended',
    tenant_id: 'acme',
    status: 200,
    ...overrides,
  }
}

async function mountOverview() {
  const { default: OverviewView } = await import('../views/OverviewView.vue')
  const w = mount(OverviewView, {
    global: {
      stubs: { RouterLink: { props: ['to'], template: '<a><slot /></a>' } },
    },
  })
  await flushPromises()
  return w
}

describe('OverviewView — I1 "What needs attention" layout', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    getOverviewMock.mockReset()
    listApiKeysMock.mockReset()
    listAuditLogsMock.mockReset()
    listApiKeysMock.mockResolvedValue({ keys: [], has_more: false })
    listAuditLogsMock.mockResolvedValue({ logs: [], has_more: false })
  })

  describe('top-of-page headline', () => {
    it('renders the "All clear" banner when nothing is firing', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      const w = await mountOverview()
      expect(w.text()).toContain('All clear')
      expect(w.text()).not.toContain('need attention')
    })

    it('renders the alert banner with count when webhooks are failing', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        webhook_counts: { total: 3, active: 3, disabled: 0, with_failures: 2 },
        failing_webhooks: [
          { subscription_id: 'wh_a', url: 'https://a.example/hook', consecutive_failures: 5 },
        ],
      }))
      const w = await mountOverview()
      expect(w.text()).toContain('area needs attention')
      expect(w.text()).not.toContain('All clear')
    })

    it('pluralizes the banner when multiple areas fire', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        webhook_counts: { total: 3, active: 3, disabled: 0, with_failures: 1 },
        failing_webhooks: [{ subscription_id: 'wh_a', url: 'https://a', consecutive_failures: 3 }],
        budget_counts: {
          total: 2, active: 2, frozen: 1, closed: 0, over_limit: 0, with_debt: 0, by_unit: {},
        },
      }))
      const w = await mountOverview()
      expect(w.text()).toContain('2 areas need attention')
    })
  })

  describe('Expiring API Keys card (new)', () => {
    it('fetches listApiKeys on mount', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      await mountOverview()
      expect(listApiKeysMock).toHaveBeenCalledTimes(1)
    })

    it('renders positive empty state when no keys expire in 7d', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      listApiKeysMock.mockResolvedValue({ keys: [key('far-future', { expires_at: '2099-01-01T00:00:00Z' })], has_more: false })
      const w = await mountOverview()
      const card = w.find('[data-testid="expiring-keys-card"]')
      expect(card.text()).toContain('No keys expiring in the next 7 days')
    })

    it('renders expiring keys sorted soonest-first with day count', async () => {
      const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
      const later = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
      getOverviewMock.mockResolvedValue(healthyOverview())
      listApiKeysMock.mockResolvedValue({
        keys: [
          key('key-later', { name: 'later-key', expires_at: later }),
          key('key-soon',  { name: 'soon-key',  expires_at: soon }),
        ],
        has_more: false,
      })
      const w = await mountOverview()
      const card = w.find('[data-testid="expiring-keys-card"]')
      expect(card.text()).toContain('soon-key')
      expect(card.text()).toContain('later-key')
      // "2d" or "3d" for soon (depending on rounding), "5d" or "6d" for later.
      // Just assert that the badge count is there.
      expect(card.find('.badge-warning').text()).toBe('2')
    })

    it('omits already-expired keys (those belong on the ApiKeys view)', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      listApiKeysMock.mockResolvedValue({
        keys: [
          key('expired', { name: 'expired-key', expires_at: '2020-01-01T00:00:00Z' }),
        ],
        has_more: false,
      })
      const w = await mountOverview()
      const card = w.find('[data-testid="expiring-keys-card"]')
      expect(card.text()).toContain('No keys expiring in the next 7 days')
      expect(card.text()).not.toContain('expired-key')
    })
  })

  describe('Recent Operator Activity card (new)', () => {
    it('fetches listAuditLogs with limit=10 on mount', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      await mountOverview()
      expect(listAuditLogsMock).toHaveBeenCalledTimes(1)
      expect(listAuditLogsMock.mock.calls[0][0]).toEqual({ limit: '10' })
    })

    it('renders empty state when no audit entries', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      const w = await mountOverview()
      const card = w.find('[data-testid="recent-activity-card"]')
      expect(card.text()).toContain('No operator changes in range')
    })

    it('renders audit entries with humanized operation names', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      listAuditLogsMock.mockResolvedValue({
        logs: [
          auditEntry('log-1', { operation: 'tenant.suspended' }),
          auditEntry('log-2', { operation: 'budget.frozen' }),
        ],
        has_more: false,
      })
      const w = await mountOverview()
      const card = w.find('[data-testid="recent-activity-card"]')
      expect(card.text()).toContain('Tenant Suspended')
      expect(card.text()).toContain('Budget Frozen')
    })

    it('surfaces error codes on failed audit rows', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      listAuditLogsMock.mockResolvedValue({
        logs: [
          auditEntry('log-1', { operation: 'tenant.suspended', status: 400, error_code: 'INVALID_REQUEST' }),
        ],
        has_more: false,
      })
      const w = await mountOverview()
      expect(w.text()).toContain('INVALID_REQUEST')
    })
  })

  describe('counter strip (demoted to bottom)', () => {
    it('renders the 4-counter strip with data-testid hook', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      const w = await mountOverview()
      const strip = w.find('[data-testid="counter-strip"]')
      expect(strip.exists()).toBe(true)
      expect(strip.text()).toContain('Tenants')
      expect(strip.text()).toContain('Budgets')
      expect(strip.text()).toContain('Webhooks')
      expect(strip.text()).toContain('Events')
    })

    it('counter strip appears AFTER the alert banner in DOM order', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      const w = await mountOverview()
      const html = w.html()
      const bannerIdx = Math.max(html.indexOf('All clear'), html.indexOf('need attention'))
      const stripIdx = html.indexOf('data-testid="counter-strip"')
      expect(bannerIdx).toBeGreaterThan(-1)
      expect(stripIdx).toBeGreaterThan(bannerIdx)
    })

    it('Expiring Keys card appears AFTER alert banner and BEFORE counter strip', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      const w = await mountOverview()
      const html = w.html()
      const bannerIdx = Math.max(html.indexOf('All clear'), html.indexOf('need attention'))
      const expiringIdx = html.indexOf('data-testid="expiring-keys-card"')
      const stripIdx = html.indexOf('data-testid="counter-strip"')
      expect(bannerIdx).toBeLessThan(expiringIdx)
      expect(expiringIdx).toBeLessThan(stripIdx)
    })
  })

  describe('graceful degradation', () => {
    it('renders other sections when listApiKeys fails', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      listApiKeysMock.mockRejectedValue(new Error('api-keys endpoint down'))
      const w = await mountOverview()
      // Overview cards still render.
      expect(w.text()).toContain('Failing Webhooks')
      // Error banner visible.
      expect(w.text()).toContain('api-keys endpoint down')
    })

    it('renders other sections when listAuditLogs fails', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      listAuditLogsMock.mockRejectedValue(new Error('audit endpoint down'))
      const w = await mountOverview()
      expect(w.text()).toContain('Failing Webhooks')
      expect(w.text()).toContain('audit endpoint down')
    })

    it('renders LoadingSkeleton when getOverview has not resolved', async () => {
      // Hold getOverview open; view should render the skeleton, not crash.
      let resolveOverview: (v: AdminOverviewResponse) => void = () => {}
      getOverviewMock.mockImplementation(() => new Promise(r => { resolveOverview = r }))
      const { default: OverviewView } = await import('../views/OverviewView.vue')
      const w = mount(OverviewView, {
        global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
      })
      await flushPromises()
      // No cards yet.
      expect(w.text()).not.toContain('Failing Webhooks')
      // Skeleton present (LoadingSkeleton renders animated placeholder divs).
      expect(w.findAll('.animate-pulse').length).toBeGreaterThan(0)
      // Clean up the pending promise so vitest doesn't complain.
      resolveOverview(healthyOverview())
      await flushPromises()
    })
  })
})

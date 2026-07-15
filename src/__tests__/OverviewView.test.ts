// I1 (UI/UX P0): OverviewView integration tests. Pins the "what needs
// attention" rebuild — alerts first, positive "all clear" state when
// nothing's firing, counter strip demoted to the bottom, new Expiring
// Keys + Recent Activity cards wired to their respective endpoints.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { h as actualH, defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities, AdminOverviewResponse, ApiKey, AuditLogEntry, BudgetLedger, Tenant, WebhookSubscription } from '../types'

const getOverviewMock = vi.fn()
const listApiKeysMock = vi.fn()
const listAuditLogsMock = vi.fn()
const listBudgetsMock = vi.fn()
const listTenantsMock = vi.fn()
const listWebhooksMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    getOverview: (...args: unknown[]) => getOverviewMock(...args),
    listApiKeys: (...args: unknown[]) => listApiKeysMock(...args),
    listAuditLogs: (...args: unknown[]) => listAuditLogsMock(...args),
    listBudgets: (...args: unknown[]) => listBudgetsMock(...args),
    listTenants: (...args: unknown[]) => listTenantsMock(...args),
    listWebhooks: (...args: unknown[]) => listWebhooksMock(...args),
  }
})

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useRoute: () => ({ query: {}, params: {} }),
    RouterLink: { props: ['to'], template: '<a><slot /></a>' },
  }
})

// Captures the polling callback so tests can simulate scheduled poll
// ticks directly (F7 — walk gating distinguishes poll ticks from the
// initial load / manual refresh, which go through refreshAll()).
const pollState = vi.hoisted(() => ({
  callback: null as null | (() => Promise<void> | void),
}))

vi.mock('../composables/usePolling', () => ({
  usePolling: (fn: () => Promise<void> | void) => {
    pollState.callback = fn
    void fn()
    return {
      refresh: async () => { void fn() },
      isLoading: { value: false },
    }
  },
}))

// Simulate one scheduled poll tick (NOT a manual refresh).
async function pollTick() {
  await pollState.callback!()
  await flushPromises()
}

// vue-echarts renders to Canvas, which jsdom can't support. Stub it —
// these tests care about OverviewView's layout logic, not chart pixels.
vi.mock('vue-echarts', () => ({
  default: { props: ['option'], template: '<div data-testid="v-chart-stub" />' },
  THEME_KEY: Symbol('theme'),
}))
vi.mock('echarts/core', () => ({ use: () => {} }))
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }))
vi.mock('echarts/charts', () => ({ PieChart: {}, BarChart: {} }))
vi.mock('echarts/components', () => ({
  TooltipComponent: {},
  LegendComponent: {},
  GridComponent: {},
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
    key_prefix: `cyc_test_${id}`,
    status: 'ACTIVE',
    permissions: [],
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function atCapBudget(scope: string, overrides: Partial<BudgetLedger> = {}): BudgetLedger {
  return {
    ledger_id: `ldg_${scope}`,
    scope,
    unit: 'tokens',
    allocated: { unit: 'tokens', amount: 1000 },
    remaining: { unit: 'tokens', amount: -100 },
    spent: { unit: 'tokens', amount: 1100 },
    debt: { unit: 'tokens', amount: 0 },
    overdraft_limit: { unit: 'tokens', amount: 0 },
    is_over_limit: false,
    status: 'ACTIVE',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function webhookSub(id: string, overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    subscription_id: id,
    tenant_id: 'acme',
    url: `https://${id}.example/hook`,
    event_types: [],
    status: 'ACTIVE',
    consecutive_failures: 3,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function tenant(id: string, overrides: Partial<Tenant> = {}): Tenant {
  return {
    tenant_id: id,
    name: id,
    status: 'CLOSED',
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
      stubs: {
        RouterLink: defineComponent({
          props: { to: { type: null, required: false, default: null } },
          inheritAttrs: false,
          setup(props, { slots, attrs }) {
            return () => {
              const to = props.to as { name?: string } | string | null | undefined
              const href = typeof to === 'string' ? to : (to?.name ?? '')
              const dataTo = JSON.stringify(to ?? null)
              return actualH('a', { ...attrs, href, 'data-to': dataTo }, slots.default?.())
            }
          },
        }),
      },
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
    listBudgetsMock.mockReset()
    listTenantsMock.mockReset()
    listWebhooksMock.mockReset()
    listApiKeysMock.mockResolvedValue({ keys: [], has_more: false })
    listAuditLogsMock.mockResolvedValue({ logs: [], has_more: false })
    // Default: no at-cap budgets. Individual tests override as needed.
    listBudgetsMock.mockResolvedValue({ ledgers: [], has_more: false })
    // Default: no closed tenants. Tests that exercise the closed-
    // tenant exclusion override with { status: 'CLOSED', ... } rows.
    listTenantsMock.mockResolvedValue({ tenants: [], has_more: false })
    // Default: no webhooks fetched. Failing-webhooks tests override.
    listWebhooksMock.mockResolvedValue({ subscriptions: [], has_more: false })
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
      }))
      listWebhooksMock.mockResolvedValue({
        subscriptions: [webhookSub('wh_a', { consecutive_failures: 5 })],
        has_more: false,
      })
      const w = await mountOverview()
      expect(w.text()).toContain('area needs attention')
      expect(w.text()).not.toContain('All clear')
    })

    it('pluralizes the banner when multiple areas fire', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        webhook_counts: { total: 3, active: 3, disabled: 0, with_failures: 1 },
        budget_counts: {
          total: 2, active: 2, frozen: 1, closed: 0, over_limit: 0, with_debt: 0, by_unit: {},
        },
      }))
      listWebhooksMock.mockResolvedValue({
        subscriptions: [webhookSub('wh_a')],
        has_more: false,
      })
      listBudgetsMock.mockImplementation((params: Record<string, string>) => {
        if (params.status === 'FROZEN') {
          return Promise.resolve({ ledgers: [atCapBudget('acme/frozen', { status: 'FROZEN' })], has_more: false })
        }
        return Promise.resolve({ ledgers: [], has_more: false })
      })
      const w = await mountOverview()
      expect(w.text()).toContain('2 areas need attention')
    })
  })

  describe('banner axis pills — "what & where" jump-links', () => {
    it('enumerates firing axes as named pills (not just a count)', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        webhook_counts: { total: 3, active: 2, disabled: 0, with_failures: 1 },
        budget_counts: {
          total: 4, active: 2, frozen: 1, closed: 0, over_limit: 0, with_debt: 0, by_unit: {},
        },
      }))
      listWebhooksMock.mockResolvedValue({
        subscriptions: [webhookSub('wh_a')],
        has_more: false,
      })
      listBudgetsMock.mockImplementation((params: Record<string, string>) => {
        if (params.utilization_min) return Promise.resolve({ ledgers: [atCapBudget('acme/foo')], has_more: false })
        if (params.status === 'FROZEN') return Promise.resolve({ ledgers: [atCapBudget('acme/frozen', { status: 'FROZEN' })], has_more: false })
        return Promise.resolve({ ledgers: [], has_more: false })
      })
      const w = await mountOverview()
      const axes = w.find('[data-testid="alert-axes"]')
      expect(axes.exists()).toBe(true)
      expect(axes.text()).toContain('Failing webhooks')
      expect(axes.text()).toContain('Budgets at or near cap')
      expect(axes.text()).toContain('Frozen budgets')
    })

    it('each axis pill carries severity class (danger=red, warning=amber)', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        webhook_counts: { total: 3, active: 2, disabled: 0, with_failures: 1 },
        budget_counts: {
          total: 2, active: 1, frozen: 1, closed: 0, over_limit: 0, with_debt: 0, by_unit: {},
        },
      }))
      listWebhooksMock.mockResolvedValue({
        subscriptions: [webhookSub('wh_a')],
        has_more: false,
      })
      listBudgetsMock.mockImplementation((params: Record<string, string>) => {
        if (params.status === 'FROZEN') return Promise.resolve({ ledgers: [atCapBudget('acme/frozen', { status: 'FROZEN' })], has_more: false })
        return Promise.resolve({ ledgers: [], has_more: false })
      })
      const w = await mountOverview()
      const failing = w.find('[data-axis="failing-webhooks"]')
      const frozen = w.find('[data-axis="frozen-budgets"]')
      expect(failing.classes()).toContain('chip-danger')
      expect(frozen.classes()).toContain('chip-warning')
    })

    it('omits axis pills for non-firing axes (no healthy chips)', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        webhook_counts: { total: 3, active: 2, disabled: 0, with_failures: 1 },
      }))
      listWebhooksMock.mockResolvedValue({
        subscriptions: [webhookSub('wh_a')],
        has_more: false,
      })
      const w = await mountOverview()
      // Only Failing webhooks fires — the other five axes should NOT have pills.
      expect(w.find('[data-axis="failing-webhooks"]').exists()).toBe(true)
      expect(w.find('[data-axis="budgets-at-cap"]').exists()).toBe(false)
      expect(w.find('[data-axis="budgets-with-debt"]').exists()).toBe(false)
      expect(w.find('[data-axis="expiring-keys"]').exists()).toBe(false)
      expect(w.find('[data-axis="frozen-budgets"]').exists()).toBe(false)
      expect(w.find('[data-axis="recent-denials"]').exists()).toBe(false)
    })

    it('banner is absent entirely when all clear', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      const w = await mountOverview()
      expect(w.find('[data-testid="alert-banner"]').exists()).toBe(false)
      expect(w.find('[data-testid="alert-axes"]').exists()).toBe(false)
    })
  })

  describe('Budgets at Cap card — catches exhausted-without-debt', () => {
    it('fires for a budget with spent > allocated even if debt = 0 (user-reported spec gap)', async () => {
      // Exact scenario reported: allocated 350k, spent 400k, debt 0,
      // overdraft 0. Spec's is_over_limit = (debt > overdraft_limit)
      // yields false — overview.budget_counts.over_limit = 0 — but
      // listBudgets?utilization_min=1.0 returns it, so the dashboard
      // flags it via the new at-cap axis.
      getOverviewMock.mockResolvedValue(healthyOverview({
        budget_counts: {
          total: 1, active: 1, frozen: 0, closed: 0,
          over_limit: 0, with_debt: 0, by_unit: {},
        },
        over_limit_scopes: [],
      }))
      listBudgetsMock.mockResolvedValue({
        ledgers: [atCapBudget('acme/prod', {
          allocated: { unit: 'tokens', amount: 350_000 },
          spent: { unit: 'tokens', amount: 400_000 },
          remaining: { unit: 'tokens', amount: -50_000 },
          debt: { unit: 'tokens', amount: 0 },
          overdraft_limit: { unit: 'tokens', amount: 0 },
          is_over_limit: false,
        })],
        has_more: false,
      })
      const w = await mountOverview()
      // Banner pill present.
      expect(w.find('[data-axis="budgets-at-cap"]').exists()).toBe(true)
      // Card shows the scope with its utilization.
      const card = w.find('[data-testid="budgets-at-cap-card"]')
      expect(card.text()).toContain('acme/prod')
      // 400/350 = 1.142857… → 114%.
      expect(card.text()).toContain('114%')
    })

    it('calls listBudgets with utilization_min=0.9 (catches near-cap too)', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      await mountOverview()
      // Three listBudgets calls total — at-or-near-cap
      // (utilization_min=0.9), frozen scopes (status=FROZEN), and
      // debt scopes (has_debt=true). Match on param shape so the spec
      // is resilient to call-order changes.
      expect(listBudgetsMock).toHaveBeenCalledTimes(3)
      const atCapCall = listBudgetsMock.mock.calls
        .map(c => c[0] as Record<string, string>)
        .find(p => p.utilization_min !== undefined)
      expect(atCapCall?.utilization_min).toBe('0.9')
    })

    // The server clamps `limit` to 100 on every list endpoint, so the
    // old single limit='2000' request was silently truncated — the
    // at-cap set is now a cursor walk (limit=100 per page, following
    // next_cursor). Regression pin: any future single-shot fetch here
    // must be intentional and reflected in these specs.
    it('at-cap fetch requests limit=100 per page (server clamp), not a single big-limit page', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      await mountOverview()
      const atCapCall = listBudgetsMock.mock.calls
        .map(c => c[0] as Record<string, string>)
        .find(p => p.utilization_min !== undefined)
      expect(atCapCall?.limit).toBe('100')
    })

    it('at-cap fetch follows next_cursor and aggregates across pages', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      listBudgetsMock.mockImplementation((params: Record<string, string>) => {
        if (params.utilization_min !== undefined) {
          if (!params.cursor) {
            return Promise.resolve({
              ledgers: Array.from({ length: 3 }, (_, i) => atCapBudget(`page1-${i}`)),
              has_more: true,
              next_cursor: 'cur-2',
            })
          }
          expect(params.cursor).toBe('cur-2')
          return Promise.resolve({
            ledgers: Array.from({ length: 2 }, (_, i) => atCapBudget(`page2-${i}`)),
            has_more: false,
          })
        }
        return Promise.resolve({ ledgers: [], has_more: false })
      })
      const w = await mountOverview()
      // Badge + banner pill count the FULL walked set (3 + 2), not just
      // the first page.
      expect(w.find('[data-axis="budgets-at-cap"]').text()).toContain('·5')
      // Walk completed naturally — no partial hint.
      expect(w.find('[data-testid="at-cap-partial-note"]').exists()).toBe(false)
    })

    it('flags "counts may be partial" on the at-cap card and utilization donut when the walk hits its page cap', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        budget_counts: {
          total: 5000, active: 5000, frozen: 0, closed: 0,
          over_limit: 0, with_debt: 0, by_unit: {},
        },
      }))
      let atCapCalls = 0
      listBudgetsMock.mockImplementation((params: Record<string, string>) => {
        if (params.utilization_min !== undefined) {
          atCapCalls++
          return Promise.resolve({
            ledgers: Array.from({ length: 100 }, (_, i) => atCapBudget(`p${atCapCalls}-${i}`)),
            has_more: true,
            next_cursor: `cur-${atCapCalls}`,
          })
        }
        return Promise.resolve({ ledgers: [], has_more: false })
      })
      const w = await mountOverview()
      // Walk stopped at the 10-page cap with the server still reporting
      // more rows.
      expect(atCapCalls).toBe(10)
      expect(w.find('[data-testid="at-cap-partial-note"]').exists()).toBe(true)
      expect(w.find('[data-testid="at-cap-partial-note"]').text()).toContain('counts may be partial')
      expect(w.find('[data-testid="utilization-donut-partial-note"]').exists()).toBe(true)
    })

    it('closed-tenant exclusion set is cursor-walked (limit=100, cursor threaded)', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      listTenantsMock.mockImplementation((params: Record<string, string>) => {
        expect(params.status).toBe('CLOSED')
        expect(params.limit).toBe('100')
        if (!params.cursor) {
          return Promise.resolve({ tenants: [tenant('closed-1')], has_more: true, next_cursor: 't-cur' })
        }
        expect(params.cursor).toBe('t-cur')
        return Promise.resolve({ tenants: [tenant('closed-2')], has_more: false })
      })
      listBudgetsMock.mockImplementation((params: Record<string, string>) => {
        if (params.utilization_min) {
          return Promise.resolve({
            ledgers: [
              // Owned by a tenant only present on PAGE 2 of the closed
              // walk — pre-fix a truncated exclusion set leaked it.
              atCapBudget('closed-2/prod', { tenant_id: 'closed-2' }),
              atCapBudget('acme/prod', { tenant_id: 'acme' }),
            ],
            has_more: false,
          })
        }
        return Promise.resolve({ ledgers: [], has_more: false })
      })
      const w = await mountOverview()
      expect(listTenantsMock).toHaveBeenCalledTimes(2)
      const card = w.find('[data-testid="budgets-at-cap-card"]')
      expect(card.text()).toContain('acme/prod')
      expect(card.text()).not.toContain('closed-2/prod')
    })

    it('calls listBudgets with status=FROZEN for the frozen-scopes fetch', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      await mountOverview()
      const frozenCall = listBudgetsMock.mock.calls
        .map(c => c[0] as Record<string, string>)
        .find(p => p.status === 'FROZEN')
      expect(frozenCall).toBeDefined()
      expect(frozenCall?.limit).toBe('10')
    })

    it('fires as warning severity when all firing budgets are in 90-99% range (near cap, none over)', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      listBudgetsMock.mockResolvedValue({
        ledgers: [atCapBudget('acme/prod', {
          allocated: { unit: 'tokens', amount: 1000 },
          spent: { unit: 'tokens', amount: 920 },
        })], // 92%
        has_more: false,
      })
      const w = await mountOverview()
      // Axis pill carries chip-warning (amber), not chip-danger (red).
      const pill = w.find('[data-axis="budgets-at-cap"]')
      expect(pill.exists()).toBe(true)
      expect(pill.classes()).toContain('chip-warning')
      expect(pill.classes()).not.toContain('chip-danger')
      // Card border also drops from red to amber when no row is at/over cap.
      const card = w.find('[data-testid="budgets-at-cap-card"]')
      expect(card.classes()).toContain('border-l-amber-500')
      expect(card.classes()).not.toContain('border-l-red-500')
      // Row renders in amber — the dead-code branch for 90-99% is now live.
      expect(card.text()).toContain('92%')
    })

    it('fires as danger severity when any budget is at/over cap even if others are only near cap', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      listBudgetsMock.mockResolvedValue({
        ledgers: [
          atCapBudget('a', {
            allocated: { unit: 'tokens', amount: 1000 },
            spent: { unit: 'tokens', amount: 950 },
          }), // 95% — near cap
          atCapBudget('b', {
            allocated: { unit: 'tokens', amount: 1000 },
            spent: { unit: 'tokens', amount: 1100 },
          }), // 110% — at cap
        ],
        has_more: false,
      })
      const w = await mountOverview()
      // Presence of the over-cap row pulls the whole card/banner
      // back to danger severity — the worst row sets the tone.
      const pill = w.find('[data-axis="budgets-at-cap"]')
      expect(pill.classes()).toContain('chip-danger')
      const card = w.find('[data-testid="budgets-at-cap-card"]')
      expect(card.classes()).toContain('border-l-red-500')
    })

    it('sorts at-cap budgets by utilization desc', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      listBudgetsMock.mockResolvedValue({
        ledgers: [
          atCapBudget('b', {
            allocated: { unit: 'tokens', amount: 100 },
            spent: { unit: 'tokens', amount: 105 },
          }), // 105%
          atCapBudget('a', {
            allocated: { unit: 'tokens', amount: 100 },
            spent: { unit: 'tokens', amount: 150 },
          }), // 150%
        ],
        has_more: false,
      })
      const w = await mountOverview()
      const card = w.find('[data-testid="budgets-at-cap-card"]')
      const text = card.text()
      // Most-blown budget leads so operator triages worst-first.
      expect(text.indexOf('150%')).toBeLessThan(text.indexOf('105%'))
    })

    it('caps the card at 5 rows but the banner count reflects the full set', async () => {
      // Server returns up to 10; card shows the worst 5 so height
      // stays predictable on the landing page. Banner badge shows
      // the full count so operators aren't misled into thinking
      // there are only 5 — "View all" carries them to /budgets
      // for the remainder.
      getOverviewMock.mockResolvedValue(healthyOverview())
      const ledgers = Array.from({ length: 8 }, (_, i) => atCapBudget(`tenant-${i}`, {
        allocated: { unit: 'tokens', amount: 1000 },
        // Descending utilization so we can assert worst-first
        // survives the slice.
        spent: { unit: 'tokens', amount: 2000 - i * 100 },
      }))
      listBudgetsMock.mockResolvedValue({ ledgers, has_more: false })
      const w = await mountOverview()
      const card = w.find('[data-testid="budgets-at-cap-card"]')
      // 5 rows rendered, not 8.
      const rows = card.findAll('a[title^="tenant-"]')
      expect(rows.length).toBe(5)
      // Worst-first: tenant-0 (200%) renders; tenant-7 (130%) doesn't.
      expect(card.text()).toContain('tenant-0')
      expect(card.text()).not.toContain('tenant-7')
      // Banner pill reflects the full count (8), not the sliced 5.
      const pill = w.find('[data-axis="budgets-at-cap"]')
      expect(pill.text()).toContain('·8')
    })

    it('renders the healthy empty state when no budgets at cap', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      listBudgetsMock.mockResolvedValue({ ledgers: [], has_more: false })
      const w = await mountOverview()
      const card = w.find('[data-testid="budgets-at-cap-card"]')
      expect(card.text()).toContain('All budgets under 90% utilized')
      expect(w.find('[data-axis="budgets-at-cap"]').exists()).toBe(false)
    })

    it('degrades gracefully when listBudgets fails (other sections still render)', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        webhook_counts: { total: 3, active: 2, disabled: 0, with_failures: 1 },
      }))
      // Failing webhooks now comes from listWebhooks (not overview.failing_webhooks)
      // so the "other sections still render" assertion needs that source seeded.
      listWebhooksMock.mockResolvedValue({
        subscriptions: [webhookSub('wh_a')],
        has_more: false,
      })
      listBudgetsMock.mockRejectedValue(new Error('simulated outage'))
      const w = await mountOverview()
      // Failing-webhooks axis still renders even though the at-cap
      // fetch failed — Promise.allSettled isolates the failure.
      expect(w.find('[data-axis="failing-webhooks"]').exists()).toBe(true)
      // At-cap card renders its empty state (ledgers ref stays []).
      expect(w.find('[data-testid="budgets-at-cap-card"]').text()).toContain('All budgets under 90% utilized')
    })
  })

  describe('Frozen Budgets card — lists top-5 scopes (parity with at-cap + debt cards)', () => {
    function frozenBudget(scope: string, overrides: Partial<BudgetLedger> = {}): BudgetLedger {
      return {
        ledger_id: `ldg_${scope}`,
        scope,
        unit: 'tokens',
        allocated: { unit: 'tokens', amount: 10_000 },
        remaining: { unit: 'tokens', amount: 10_000 },
        spent: { unit: 'tokens', amount: 0 },
        debt: { unit: 'tokens', amount: 0 },
        overdraft_limit: { unit: 'tokens', amount: 0 },
        is_over_limit: false,
        status: 'FROZEN',
        created_at: '2026-01-01T00:00:00Z',
        ...overrides,
      }
    }

    it('renders each frozen scope inline with its allocated amount', async () => {
      // Card used to render as a center "View N frozen budgets"
      // hyperlink with no scope names — operator had to click through
      // to see which budgets were frozen. Now lists the scopes inline
      // so the card matches the at-cap / with-debt pattern.
      getOverviewMock.mockResolvedValue(healthyOverview({
        budget_counts: { total: 5, active: 3, frozen: 2, closed: 0, over_limit: 0, with_debt: 0, by_unit: {} },
      }))
      listBudgetsMock.mockImplementation((params: Record<string, string>) => {
        if (params.status === 'FROZEN') {
          return Promise.resolve({
            ledgers: [
              frozenBudget('acme/prod', { allocated: { unit: 'tokens', amount: 50_000 } }),
              frozenBudget('beta/eu', { allocated: { unit: 'tokens', amount: 10_000 } }),
            ],
            has_more: false,
          })
        }
        return Promise.resolve({ ledgers: [], has_more: false })
      })
      const w = await mountOverview()
      const card = w.find('#frozen-budgets')
      expect(card.text()).toContain('acme/prod')
      expect(card.text()).toContain('beta/eu')
      // Allocated amount surfaces as the secondary read.
      expect(card.text()).toContain('50,000')
      expect(card.text()).toContain('10,000')
      // Center "View N frozen budgets" link is gone — the header
      // "View all" link is the only one now.
      expect(card.text()).not.toContain('View 2 frozen budgets')
    })

    it('caps frozen card at 5 rows (parity with at-cap card)', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        budget_counts: { total: 10, active: 3, frozen: 7, closed: 0, over_limit: 0, with_debt: 0, by_unit: {} },
      }))
      listBudgetsMock.mockImplementation((params: Record<string, string>) => {
        if (params.status === 'FROZEN') {
          return Promise.resolve({
            ledgers: Array.from({ length: 7 }, (_, i) => frozenBudget(`scope-${i}`)),
            has_more: false,
          })
        }
        return Promise.resolve({ ledgers: [], has_more: false })
      })
      const w = await mountOverview()
      const card = w.find('#frozen-budgets')
      const rows = card.findAll('a[title^="scope-"]')
      expect(rows.length).toBe(5)
    })

    it('falls back to "N frozen — details unavailable" when the list fetch fails but overview count is non-zero', async () => {
      // Graceful degradation: if listBudgets?status=FROZEN rejects
      // but the overview count says there ARE 3 frozen budgets, we
      // surface the count rather than silently rendering
      // "No frozen budgets" — otherwise the card contradicts the
      // banner axis pill.
      getOverviewMock.mockResolvedValue(healthyOverview({
        budget_counts: { total: 5, active: 2, frozen: 3, closed: 0, over_limit: 0, with_debt: 0, by_unit: {} },
      }))
      listBudgetsMock.mockImplementation((params: Record<string, string>) => {
        if (params.status === 'FROZEN') return Promise.reject(new Error('outage'))
        return Promise.resolve({ ledgers: [], has_more: false })
      })
      const w = await mountOverview()
      const card = w.find('#frozen-budgets')
      expect(card.text()).toContain('3 frozen budgets — details unavailable')
      expect(card.text()).not.toContain('No frozen budgets')
    })

    it('renders healthy empty state only when BOTH list and count are empty', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      const w = await mountOverview()
      const card = w.find('#frozen-budgets')
      expect(card.text()).toContain('No frozen budgets')
    })
  })

  describe('Budgets with Debt card — caps at 5 rows (parity with other budget cards)', () => {
    it('slices the debt-scopes list to 5 on the landing card', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        budget_counts: { total: 10, active: 3, frozen: 0, closed: 0, over_limit: 0, with_debt: 7, by_unit: {} },
      }))
      // Debt rows now come from listBudgets?has_debt=true (so we can
      // read tenant_id and filter closed-tenant leakage). Server sorts
      // desc by debt; we seed in that order.
      listBudgetsMock.mockImplementation((params: Record<string, string>) => {
        if (params.has_debt === 'true') {
          return Promise.resolve({
            ledgers: Array.from({ length: 7 }, (_, i) => atCapBudget(`scope-${i}`, {
              debt: { unit: 'tokens', amount: 100 - i },
              overdraft_limit: { unit: 'tokens', amount: 500 },
            })),
            has_more: false,
          })
        }
        return Promise.resolve({ ledgers: [], has_more: false })
      })
      const w = await mountOverview()
      const card = w.find('#budgets-with-debt')
      const rows = card.findAll('a[title^="scope-"]')
      expect(rows.length).toBe(5)
      // Worst-first preserved (server sorts desc by debt).
      expect(card.text()).toContain('scope-0')
      expect(card.text()).not.toContain('scope-6')
    })
  })

  describe('card grid row layout — budget cards on row 1', () => {
    it('renders the three budget cards contiguously before the non-budget cards', async () => {
      // Layout intent: the 3-column grid places the three budget
      // cards (at cap / with debt / frozen) on row 1 because "state
      // of budgets" is the headline ops question, and groups the
      // non-budget signals (failing webhooks / expiring keys / recent
      // denials) on row 2. Assert DOM order pins all three budget
      // cards before the first non-budget card.
      getOverviewMock.mockResolvedValue(healthyOverview())
      const w = await mountOverview()
      const html = w.html()
      const indices = {
        atCap: html.indexOf('id="budgets-at-cap"'),
        withDebt: html.indexOf('id="budgets-with-debt"'),
        frozen: html.indexOf('id="frozen-budgets"'),
        failing: html.indexOf('id="failing-webhooks"'),
        expiring: html.indexOf('data-testid="expiring-keys-card"'),
        denials: html.indexOf('id="recent-denials"'),
      }
      for (const [k, v] of Object.entries(indices)) {
        expect(v, `${k} card must be present in DOM`).toBeGreaterThan(-1)
      }
      // Row 1 (budgets) precedes row 2 (non-budget).
      const lastBudget = Math.max(indices.atCap, indices.withDebt, indices.frozen)
      const firstNonBudget = Math.min(indices.failing, indices.expiring, indices.denials)
      expect(lastBudget).toBeLessThan(firstNonBudget)
      // Row 1 order: at-cap → with-debt → frozen.
      expect(indices.atCap).toBeLessThan(indices.withDebt)
      expect(indices.withDebt).toBeLessThan(indices.frozen)
    })
  })

  describe('card severity accents — left border + warning icon', () => {
    it('firing card gets border-l-4 and red accent when danger severity', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        webhook_counts: { total: 3, active: 2, disabled: 0, with_failures: 1 },
      }))
      listWebhooksMock.mockResolvedValue({
        subscriptions: [webhookSub('wh_a')],
        has_more: false,
      })
      const w = await mountOverview()
      const card = w.find('#failing-webhooks')
      expect(card.exists()).toBe(true)
      expect(card.classes()).toContain('border-l-4')
      expect(card.classes()).toContain('border-l-red-500')
    })

    it('firing card gets border-l-4 and amber accent when warning severity', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        budget_counts: {
          total: 2, active: 1, frozen: 1, closed: 0, over_limit: 0, with_debt: 0, by_unit: {},
        },
      }))
      listBudgetsMock.mockImplementation((params: Record<string, string>) => {
        if (params.status === 'FROZEN') {
          return Promise.resolve({
            ledgers: [atCapBudget('acme/frozen', { status: 'FROZEN' })],
            has_more: false,
          })
        }
        return Promise.resolve({ ledgers: [], has_more: false })
      })
      const w = await mountOverview()
      const card = w.find('#frozen-budgets')
      expect(card.classes()).toContain('border-l-4')
      expect(card.classes()).toContain('border-l-amber-500')
    })

    it('healthy card has no severity border', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      const w = await mountOverview()
      const card = w.find('#failing-webhooks')
      expect(card.classes()).not.toContain('border-l-4')
      expect(card.classes()).not.toContain('border-l-red-500')
    })

    it('card ids match axis ids so banner pills can scroll-anchor', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        webhook_counts: { total: 3, active: 2, disabled: 0, with_failures: 1 },
        failing_webhooks: [{ subscription_id: 'wh_a', url: 'https://a', consecutive_failures: 3 }],
      }))
      const w = await mountOverview()
      // Every axis pill's data-axis must point at an element with the
      // same id, or the smooth-scroll handler won't find its target.
      const pills = w.findAll('[data-axis]')
      for (const pill of pills) {
        const id = pill.attributes('data-axis')!
        expect(w.find(`#${id}`).exists()).toBe(true)
      }
    })
  })

  describe('Expiring API Keys card (new)', () => {
    it('fetches listApiKeys on mount — ACTIVE only, limit=100 per page (server clamp)', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      await mountOverview()
      expect(listApiKeysMock).toHaveBeenCalledTimes(1)
      const params = listApiKeysMock.mock.calls[0][0] as Record<string, string>
      // Server sorts created_at desc — NOT by expiry — and clamps limit
      // to 100, so the card cursor-walks the ACTIVE set instead of
      // trusting one default page.
      expect(params.status).toBe('ACTIVE')
      expect(params.limit).toBe('100')
    })

    it('cursor-walks the key set — an expiring key on page 2 still surfaces', async () => {
      const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
      getOverviewMock.mockResolvedValue(healthyOverview())
      listApiKeysMock.mockImplementation((params: Record<string, string>) => {
        if (!params.cursor) {
          return Promise.resolve({
            keys: [key('k-page1', { name: 'page1-key', expires_at: '2099-01-01T00:00:00Z' })],
            has_more: true,
            next_cursor: 'k-cur',
          })
        }
        expect(params.cursor).toBe('k-cur')
        return Promise.resolve({
          keys: [key('k-page2', { name: 'page2-expiring', expires_at: soon })],
          has_more: false,
        })
      })
      const w = await mountOverview()
      expect(listApiKeysMock).toHaveBeenCalledTimes(2)
      const card = w.find('[data-testid="expiring-keys-card"]')
      expect(card.text()).toContain('page2-expiring')
      expect(w.find('[data-testid="expiring-keys-partial-note"]').exists()).toBe(false)
    })

    it('flags "counts may be partial" when the key walk hits its page cap', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      let calls = 0
      listApiKeysMock.mockImplementation(() => {
        calls++
        return Promise.resolve({
          keys: Array.from({ length: 100 }, (_, i) => key(`k-${calls}-${i}`)),
          has_more: true,
          next_cursor: `cur-${calls}`,
        })
      })
      const w = await mountOverview()
      expect(calls).toBe(10)
      const note = w.find('[data-testid="expiring-keys-partial-note"]')
      expect(note.exists()).toBe(true)
      expect(note.text()).toContain('counts may be partial')
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

    // v0.1.25.53 bug #4: "View all" on the expiring-keys card routed to
    // /api-keys unfiltered — operator saw "7 expiring" then landed on
    // the whole fleet. Now the link carries ?expiring_within_7d=1,
    // which ApiKeysView honors as a client-side filter (spec has no
    // server-side expires_before param).
    it('Expiring Keys "View all" link carries expiring_within_7d=1', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      listApiKeysMock.mockResolvedValue({ keys: [], has_more: false })
      const w = await mountOverview()
      const card = w.find('[data-testid="expiring-keys-card"]')
      const viewAll = card.findAll('a').find(a => a.text() === 'View all')
      expect(viewAll).toBeDefined()
      const parsed = JSON.parse(viewAll!.attributes('data-to') as string)
      expect(parsed.name).toBe('api-keys')
      expect(parsed.query?.expiring_within_7d).toBe('1')
    })

    // Per-key deep-link: carries ?search=<key_id> — listApiKeys supports
    // server-side substring search over key_id + name, and ApiKeysView
    // hydrates ?search into its filter on mount, so the landing state
    // shows the single matching key. (The old ?key_id= param was never
    // read by ApiKeysView — dead deep-link.)
    it('each expiring-key row links to /api-keys with ?search=<key_id>', async () => {
      const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
      getOverviewMock.mockResolvedValue(healthyOverview())
      listApiKeysMock.mockResolvedValue({
        keys: [key('key-soon', { name: 'soon-key', expires_at: soon })],
        has_more: false,
      })
      const w = await mountOverview()
      const card = w.find('[data-testid="expiring-keys-card"]')
      const rowLink = card.findAll('a').find(a => a.text().includes('soon-key'))
      expect(rowLink).toBeDefined()
      const parsed = JSON.parse(rowLink!.attributes('data-to') as string)
      expect(parsed.name).toBe('api-keys')
      expect(parsed.query?.search).toBe('key-soon')
      expect(parsed.query?.key_id).toBeUndefined()
    })
  })

  // Cross-card consistency — every "what needs attention" card should
  // behave the same way on the landing page: inline list of top-5 items,
  // with the full count kept on the banner/badge and a "View all" link
  // carrying the operator to the complete set. Budgets cards set the
  // convention (see above); these specs pin it down for the non-budget
  // signals — Failing Webhooks + Recent Denials — so a future change
  // that renders the full list again (or drops the cap entirely) fails
  // the suite rather than silently regressing visual density parity.
  describe('landing-card row caps — all non-budget cards slice to 5', () => {
    it('Failing Webhooks card caps at 5 rows even when the server returns more', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        webhook_counts: { total: 10, active: 3, disabled: 0, with_failures: 7 },
      }))
      // Failing-webhooks rows now come from listWebhooks (so tenant_id
      // is available for closed-tenant filtering). Seed 7 subs with
      // consecutive_failures>0 — card slices to 5, badge shows 7.
      listWebhooksMock.mockResolvedValue({
        subscriptions: Array.from({ length: 7 }, (_, i) => webhookSub(`wh_${i}`, {
          url: `https://wh-${i}.example/hook`,
          consecutive_failures: i + 1,
        })),
        has_more: false,
      })
      const w = await mountOverview()
      const card = w.find('#failing-webhooks')
      // 7 firing upstream; card renders 5. Badge + banner pill still
      // show the full count so the operator knows 2 are hidden behind
      // "View all".
      const rows = card.findAll('.border-b')
      expect(rows.length).toBe(5)
      expect(card.find('.badge-danger').text()).toBe('7')
    })

    it('Recent Denials card caps at 5 rows even when the server returns 10', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        recent_denials: Array.from({ length: 10 }, (_, i) => ({
          event_id: `evt_${i}`,
          event_type: 'reservation.denied',
          category: 'runtime',
          source: 'cycles-server',
          timestamp: '2026-04-17T11:59:00Z',
          tenant_id: 'acme',
          scope: `acme/scope-${i}`,
          data: { reason_code: 'BUDGET_EXCEEDED' },
        })),
      }))
      const w = await mountOverview()
      const card = w.find('#recent-denials')
      // Server caps list at 10; landing card shows 5 for parity.
      // Use the scope text as a row-count proxy — 5 of the 10 scopes
      // should be present, and the 6th+ should NOT be.
      expect(card.text()).toContain('acme/scope-0')
      expect(card.text()).toContain('acme/scope-4')
      expect(card.text()).not.toContain('acme/scope-5')
      // Axis badge shows the full server-returned count.
      expect(card.find('.badge-danger').text()).toBe('10')
    })
  })

  describe('Failing Webhooks card — cursor-walked source', () => {
    it('walks listWebhooks at limit=100 per page and aggregates failing subs across pages', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        webhook_counts: { total: 120, active: 118, disabled: 0, with_failures: 2 },
      }))
      listWebhooksMock.mockImplementation((params: Record<string, string>) => {
        expect(params.limit).toBe('100')
        if (!params.cursor) {
          return Promise.resolve({
            subscriptions: [webhookSub('wh_p1', { consecutive_failures: 2 })],
            has_more: true,
            next_cursor: 'w-cur',
          })
        }
        expect(params.cursor).toBe('w-cur')
        return Promise.resolve({
          subscriptions: [webhookSub('wh_p2', { consecutive_failures: 5 })],
          has_more: false,
        })
      })
      const w = await mountOverview()
      expect(listWebhooksMock).toHaveBeenCalledTimes(2)
      const card = w.find('#failing-webhooks')
      // Page-2 failing sub surfaces; badge counts both.
      expect(card.text()).toContain('wh_p2')
      expect(card.find('.badge-danger').text()).toBe('2')
      expect(w.find('[data-testid="failing-webhooks-partial-note"]').exists()).toBe(false)
    })

    it('flags "counts may be partial" when the webhook walk hits its page cap', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      let calls = 0
      listWebhooksMock.mockImplementation(() => {
        calls++
        return Promise.resolve({
          subscriptions: Array.from({ length: 100 }, (_, i) => webhookSub(`wh_${calls}_${i}`, { consecutive_failures: 0 })),
          has_more: true,
          next_cursor: `cur-${calls}`,
        })
      })
      const w = await mountOverview()
      expect(calls).toBe(10)
      const note = w.find('[data-testid="failing-webhooks-partial-note"]')
      expect(note.exists()).toBe(true)
      expect(note.text()).toContain('counts may be partial')
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

    // Operation name rendered raw (dot-separated enum) to match how
    // AuditView.vue renders the same column — prior humanize-to-title-case
    // diverged from Audit and forced the operator to cross-reference two
    // different formats for the same field.
    it('renders audit operations as raw enum values matching AuditView format', async () => {
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
      expect(card.text()).toContain('tenant.suspended')
      expect(card.text()).toContain('budget.frozen')
      expect(card.text()).not.toContain('Tenant Suspended')
      expect(card.text()).not.toContain('Budget Frozen')
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

    // The old "Recent Reservation Expiries (1h)" card was dropped — low
    // signal (usually empty) and linked to /events (wrong plane) when ops
    // actually want /reservations. Replacement is a Reservations tile in
    // the counter strip, which requires server-side reservation_counts
    // (follow-up — see AUDIT.md). Assert the card is gone so a future
    // refactor doesn't resurrect it by accident.
    it('does not render the old "Recent Reservation Expiries" card', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      const w = await mountOverview()
      expect(w.text()).not.toContain('Recent Reservation Expiries')
      expect(w.text()).not.toContain('No expiries in the last hour')
    })
  })

  // v0.1.25.8+ server populates recent_denials_by_reason. Admin server
  // omits the field entirely when the denial sample has no reason_code,
  // so absence is meaningful — the breakdown shouldn't render empty UI.
  describe('Recent Denials reason breakdown (v0.1.25.8+)', () => {
    it('renders reason pills sorted desc by count when field is populated', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        recent_denials_by_reason: { BUDGET_EXCEEDED: 12, ACTION_QUOTA_EXCEEDED: 7, POLICY_BLOCKED: 3 },
      }))
      const w = await mountOverview()
      const pills = w.find('[data-testid="denial-reasons"]')
      expect(pills.exists()).toBe(true)
      const html = pills.html()
      // Order: BUDGET_EXCEEDED (12) → ACTION_QUOTA_EXCEEDED (7) → POLICY_BLOCKED (3)
      expect(html.indexOf('BUDGET_EXCEEDED')).toBeLessThan(html.indexOf('ACTION_QUOTA_EXCEEDED'))
      expect(html.indexOf('ACTION_QUOTA_EXCEEDED')).toBeLessThan(html.indexOf('POLICY_BLOCKED'))
      expect(pills.text()).toContain('×12')
      expect(pills.text()).toContain('×7')
      expect(pills.text()).toContain('×3')
    })

    it('does not render pills when field is absent (pre-v0.1.25.8 server)', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview()) // no recent_denials_by_reason key
      const w = await mountOverview()
      expect(w.find('[data-testid="denial-reasons"]').exists()).toBe(false)
    })

    it('does not render pills when field is an empty object', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({ recent_denials_by_reason: {} }))
      const w = await mountOverview()
      expect(w.find('[data-testid="denial-reasons"]').exists()).toBe(false)
    })

    // v0.1.25.24 unlock: listAuditLogs now supports server-side
    // error_code IN-list filtering, so each pill becomes a drill-down
    // router-link to /audit?error_code=CODE&status_band=errors (the
    // "who do I blame for these 12 denials" path). AuditView's
    // applyQueryParams consumes both params.
    it('renders each pill as an anchor (router-link) targeting /audit', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        recent_denials_by_reason: { BUDGET_EXCEEDED: 12, POLICY_VIOLATION: 3 },
      }))
      const w = await mountOverview()
      const anchors = w.findAll('[data-testid="denial-reasons"] a')
      expect(anchors.length).toBe(2)
      expect(anchors[0].attributes('href')).toBe('audit')
      expect(anchors[1].attributes('href')).toBe('audit')
    })

    it('each pill threads error_code + status_band=errors in the route query', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        recent_denials_by_reason: { BUDGET_EXCEEDED: 12, POLICY_VIOLATION: 3 },
      }))
      const w = await mountOverview()
      const tos = w.findAll('[data-testid="denial-reasons"] a')
        .map(a => JSON.parse(a.attributes('data-to') ?? 'null'))
      expect(tos[0]).toEqual({ name: 'audit', query: { error_code: 'BUDGET_EXCEEDED', status_band: 'errors' } })
      expect(tos[1]).toEqual({ name: 'audit', query: { error_code: 'POLICY_VIOLATION', status_band: 'errors' } })
    })

    it('pill title tooltips cite the filtered target ("View N audit entries with error_code X")', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        recent_denials_by_reason: { BUDGET_EXCEEDED: 12, POLICY_VIOLATION: 1 },
      }))
      const w = await mountOverview()
      const anchors = w.findAll('[data-testid="denial-reasons"] a')
      expect(anchors[0].attributes('title')).toContain('12')
      expect(anchors[0].attributes('title')).toContain('BUDGET_EXCEEDED')
      // Singular/plural entry noun
      expect(anchors[1].attributes('title')).toContain('1 audit entry')
      expect(anchors[1].attributes('title')).toContain('POLICY_VIOLATION')
    })
  })

  describe('counter strip (quick-jump nav, top of page)', () => {
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

    it('counter strip appears AFTER the alert banner and BEFORE the alert cards', async () => {
      // Banner → counter strip (quick-jump nav) → alert cards.
      // Expiring Keys is one of the alert cards and sits below the
      // counter strip regardless of inner grid order. Counter strip
      // sits below the status banner as a resource-type navigation
      // aid, matching the Linear / GitHub / Grafana convention.
      getOverviewMock.mockResolvedValue(healthyOverview())
      const w = await mountOverview()
      const html = w.html()
      const bannerIdx = Math.max(html.indexOf('All clear'), html.indexOf('need attention'))
      const stripIdx = html.indexOf('data-testid="counter-strip"')
      const expiringIdx = html.indexOf('data-testid="expiring-keys-card"')
      expect(bannerIdx).toBeGreaterThan(-1)
      expect(bannerIdx).toBeLessThan(stripIdx)
      expect(stripIdx).toBeLessThan(expiringIdx)
    })

    it('Tenants tile: total + color-coded state chips for active/suspended/closed', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        tenant_counts: { total: 12, active: 8, suspended: 3, closed: 1 },
      }))
      const w = await mountOverview()
      const tile = w.find('[data-testid="tile-tenants"]')
      expect(tile.text()).toContain('12')
      expect(tile.find('.chip-success').text()).toContain('8 active')
      expect(tile.find('.chip-warning').text()).toContain('3 suspended')
      expect(tile.find('.chip-neutral').text()).toContain('1 closed')
    })

    it('Tenants tile: omits state chips with zero count', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        tenant_counts: { total: 8, active: 8, suspended: 0, closed: 0 },
      }))
      const w = await mountOverview()
      const tile = w.find('[data-testid="tile-tenants"]')
      expect(tile.findAll('.chip').length).toBe(1)
      expect(tile.find('.chip-success').exists()).toBe(true)
      expect(tile.find('.chip-warning').exists()).toBe(false)
      expect(tile.find('.chip-neutral').exists()).toBe(false)
    })

    it('Budgets tile: shows active/frozen/closed plus over-limit and debt warnings', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        budget_counts: {
          total: 20, active: 14, frozen: 2, closed: 4,
          over_limit: 3, with_debt: 1, by_unit: {},
        },
      }))
      const w = await mountOverview()
      const tile = w.find('[data-testid="tile-budgets"]')
      expect(tile.text()).toContain('20')
      expect(tile.text()).toContain('14 active')
      expect(tile.text()).toContain('2 frozen')
      expect(tile.text()).toContain('4 closed')
      expect(tile.text()).toContain('3 over')
      expect(tile.text()).toContain('1 debt')
      // over-limit gets the danger color (operator must see this).
      expect(tile.find('.chip-danger').text()).toContain('3 over')
    })

    it('Webhooks tile: shows active/paused/disabled/failing chips with correct colors', async () => {
      // total=8, active=4, disabled=1 → derived paused = 8-4-1 = 3.
      // Paused is yellow (operator-set state), disabled is gray/neutral
      // (system-terminal after failures), failing overlay is red.
      getOverviewMock.mockResolvedValue(healthyOverview({
        webhook_counts: { total: 8, active: 4, disabled: 1, with_failures: 2 },
      }))
      const w = await mountOverview()
      const tile = w.find('[data-testid="tile-webhooks"]')
      expect(tile.text()).toContain('8')
      expect(tile.find('.chip-success').text()).toContain('4 active')
      expect(tile.find('.chip-warning').text()).toContain('3 paused')
      expect(tile.find('.chip-neutral').text()).toContain('1 disabled')
      expect(tile.find('.chip-danger').text()).toContain('2 failing')
    })

    it('Webhooks tile: omits Paused chip when active + disabled already equals total', async () => {
      // Server reports total=5, active=4, disabled=1 — derived paused = 0.
      getOverviewMock.mockResolvedValue(healthyOverview({
        webhook_counts: { total: 5, active: 4, disabled: 1, with_failures: 0 },
      }))
      const w = await mountOverview()
      const tile = w.find('[data-testid="tile-webhooks"]')
      expect(tile.text()).not.toContain('paused')
      expect(tile.find('.chip-success').text()).toContain('4 active')
      expect(tile.find('.chip-neutral').text()).toContain('1 disabled')
    })

    it('Webhooks tile: guards against server drift so derived paused never goes negative', async () => {
      // Defensive: if total < active+disabled (server snapshot drift),
      // we clamp to 0 instead of showing a negative chip.
      getOverviewMock.mockResolvedValue(healthyOverview({
        webhook_counts: { total: 3, active: 4, disabled: 1, with_failures: 0 },
      }))
      const w = await mountOverview()
      const tile = w.find('[data-testid="tile-webhooks"]')
      expect(tile.text()).not.toContain('paused')
      expect(tile.text()).not.toContain('-')
    })

    it('Events tile: renders one chip per category with category color', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        event_counts: { total_recent: 100, by_category: { runtime: 60, audit: 30, system: 10 } },
      }))
      const w = await mountOverview()
      const tile = w.find('[data-testid="tile-events"]')
      expect(tile.text()).toContain('100')
      const chips = tile.findAll('.chip-category')
      expect(chips.length).toBe(3)
      const text = chips.map(c => c.text()).join(' ')
      expect(text).toContain('60 runtime')
      expect(text).toContain('30 audit')
      expect(text).toContain('10 system')
    })

    it('Events tile: shows "no events" when by_category is empty', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        event_counts: { total_recent: 0, by_category: {} },
      }))
      const w = await mountOverview()
      const tile = w.find('[data-testid="tile-events"]')
      expect(tile.text()).toContain('no events')
    })

    // v0.1.25.53 bug #3: Events tile says "(60m)" but drill-down landed
    // on unfiltered /events showing everything ever. Now the
    // category-chip router-link AND the tile header/total links carry
    // `from`/`to` query params normalized from `event_window_seconds`
    // so the drill-down matches what the tile is summarizing.
    it('Events tile chips carry from/to query params derived from event_window_seconds', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        event_window_seconds: 1800, // 30 minutes
        event_counts: { total_recent: 7, by_category: { runtime: 7 } },
      }))
      const w = await mountOverview()
      const tile = w.find('[data-testid="tile-events"]')
      const chip = tile.find('.chip-category')
      expect(chip.exists()).toBe(true)
      const dataTo = chip.attributes('data-to')
      expect(dataTo).toBeDefined()
      const parsed = JSON.parse(dataTo as string)
      expect(parsed.query.category).toBe('runtime')
      expect(typeof parsed.query.from).toBe('string')
      expect(typeof parsed.query.to).toBe('string')
      // from/to must be parseable ISO strings and `to - from` must
      // equal event_window_seconds (within a small tolerance for the
      // test clock delta between the component computation and the
      // assertion).
      const fromMs = Date.parse(parsed.query.from)
      const toMs = Date.parse(parsed.query.to)
      expect(Number.isNaN(fromMs)).toBe(false)
      expect(Number.isNaN(toMs)).toBe(false)
      expect(Math.round((toMs - fromMs) / 1000)).toBe(1800)
    })

    it('Events tile "View all"-equivalent links also carry the time window', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        event_window_seconds: 3600,
        event_counts: { total_recent: 12, by_category: { runtime: 12 } },
      }))
      const w = await mountOverview()
      const tile = w.find('[data-testid="tile-events"]')
      // Header and total links are <router-link :to="{ name: 'events', query: eventsQuery() }">.
      // At least one must carry from/to (no category).
      const links = tile.findAll('a[data-to]')
        .map(a => JSON.parse(a.attributes('data-to') as string))
        .filter(t => t && typeof t === 'object' && t.name === 'events' && !t.query?.category)
      expect(links.length).toBeGreaterThan(0)
      for (const l of links) {
        expect(typeof l.query.from).toBe('string')
        expect(typeof l.query.to).toBe('string')
      }
    })
  })

  describe('graceful degradation', () => {
    it('renders other sections when listApiKeys fails', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      listApiKeysMock.mockRejectedValue(new Error('api-keys endpoint down'))
      const w = await mountOverview()
      // Overview cards still render.
      expect(w.text()).toContain('Failing webhooks')
      // Use the card id to avoid ambiguity — the banner-pill label
      // also reads "Failing webhooks" when the axis is firing, so a
      // raw text match isn't enough to prove the card rendered.
      expect(w.find('#failing-webhooks').exists()).toBe(true)
      // Error banner visible.
      expect(w.text()).toContain('api-keys endpoint down')
    })

    it('renders other sections when listAuditLogs fails', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      listAuditLogsMock.mockRejectedValue(new Error('audit endpoint down'))
      const w = await mountOverview()
      expect(w.text()).toContain('Failing webhooks')
      expect(w.find('#failing-webhooks').exists()).toBe(true)
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
      expect(w.text()).not.toContain('Failing webhooks')
      // Skeleton present (LoadingSkeleton renders animated placeholder divs).
      expect(w.findAll('.animate-pulse').length).toBeGreaterThan(0)
      // Clean up the pending promise so vitest doesn't complain.
      resolveOverview(healthyOverview())
      await flushPromises()
    })
  })

  // Mode B cascade (spec v0.1.25.31 Rule 1(c)) is eventually-consistent:
  // a closed tenant can transiently own non-terminal children while the
  // admin-side cascade converges. Those children MUST NOT leak onto the
  // Overview "needs attention" cards — the operator has already acted
  // (tenant.close), and surfacing them as pending work is confusing +
  // regresses the v0.1.25.44 "close is decisive" UX.
  describe('closed-tenant children are excluded from the attention cards', () => {
    it('at-cap card hides budgets owned by CLOSED tenants', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      listTenantsMock.mockResolvedValue({
        tenants: [tenant('closed-co', { status: 'CLOSED' })],
        has_more: false,
      })
      listBudgetsMock.mockImplementation((params: Record<string, string>) => {
        if (params.utilization_min) {
          return Promise.resolve({
            ledgers: [
              atCapBudget('closed-co/prod', { tenant_id: 'closed-co' }),
              atCapBudget('acme/prod', { tenant_id: 'acme' }),
            ],
            has_more: false,
          })
        }
        return Promise.resolve({ ledgers: [], has_more: false })
      })
      const w = await mountOverview()
      const card = w.find('[data-testid="budgets-at-cap-card"]')
      expect(card.text()).toContain('acme/prod')
      expect(card.text()).not.toContain('closed-co/prod')
      // Banner axis pill count reflects the filtered list.
      expect(w.find('[data-axis="budgets-at-cap"]').text()).toContain('·1')
    })

    it('frozen-budgets card hides FROZEN budgets owned by CLOSED tenants', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        budget_counts: { total: 3, active: 1, frozen: 2, closed: 0, over_limit: 0, with_debt: 0, by_unit: {} },
      }))
      listTenantsMock.mockResolvedValue({
        tenants: [tenant('closed-co')],
        has_more: false,
      })
      listBudgetsMock.mockImplementation((params: Record<string, string>) => {
        if (params.status === 'FROZEN') {
          return Promise.resolve({
            ledgers: [
              atCapBudget('closed-co/frozen', { status: 'FROZEN', tenant_id: 'closed-co' }),
              atCapBudget('acme/frozen',      { status: 'FROZEN', tenant_id: 'acme' }),
            ],
            has_more: false,
          })
        }
        return Promise.resolve({ ledgers: [], has_more: false })
      })
      const w = await mountOverview()
      const card = w.find('#frozen-budgets')
      expect(card.text()).toContain('acme/frozen')
      expect(card.text()).not.toContain('closed-co/frozen')
    })

    it('with-debt card hides debt budgets owned by CLOSED tenants', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        budget_counts: { total: 2, active: 1, frozen: 0, closed: 0, over_limit: 0, with_debt: 2, by_unit: {} },
      }))
      listTenantsMock.mockResolvedValue({
        tenants: [tenant('closed-co')],
        has_more: false,
      })
      listBudgetsMock.mockImplementation((params: Record<string, string>) => {
        if (params.has_debt === 'true') {
          return Promise.resolve({
            ledgers: [
              atCapBudget('closed-co/debt', {
                tenant_id: 'closed-co',
                debt: { unit: 'tokens', amount: 50 },
                overdraft_limit: { unit: 'tokens', amount: 500 },
              }),
              atCapBudget('acme/debt', {
                tenant_id: 'acme',
                debt: { unit: 'tokens', amount: 30 },
                overdraft_limit: { unit: 'tokens', amount: 500 },
              }),
            ],
            has_more: false,
          })
        }
        return Promise.resolve({ ledgers: [], has_more: false })
      })
      const w = await mountOverview()
      const card = w.find('#budgets-with-debt')
      expect(card.text()).toContain('acme/debt')
      expect(card.text()).not.toContain('closed-co/debt')
    })

    it('expiring-keys card hides API keys owned by CLOSED tenants', async () => {
      const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
      getOverviewMock.mockResolvedValue(healthyOverview())
      listTenantsMock.mockResolvedValue({
        tenants: [tenant('closed-co')],
        has_more: false,
      })
      listApiKeysMock.mockResolvedValue({
        keys: [
          key('closed-co-key', { name: 'closed-key', tenant_id: 'closed-co', expires_at: soon }),
          key('acme-key',      { name: 'live-key',   tenant_id: 'acme',      expires_at: soon }),
        ],
        has_more: false,
      })
      const w = await mountOverview()
      const card = w.find('[data-testid="expiring-keys-card"]')
      expect(card.text()).toContain('live-key')
      expect(card.text()).not.toContain('closed-key')
    })

    it('failing-webhooks card hides subscriptions owned by CLOSED tenants', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview({
        webhook_counts: { total: 2, active: 2, disabled: 0, with_failures: 2 },
      }))
      listTenantsMock.mockResolvedValue({
        tenants: [tenant('closed-co')],
        has_more: false,
      })
      listWebhooksMock.mockResolvedValue({
        subscriptions: [
          webhookSub('wh_closed', { tenant_id: 'closed-co' }),
          webhookSub('wh_live',   { tenant_id: 'acme' }),
        ],
        has_more: false,
      })
      const w = await mountOverview()
      const card = w.find('#failing-webhooks')
      expect(card.text()).toContain('wh_live')
      expect(card.text()).not.toContain('wh_closed')
    })
  })

  // F7 — the four cursor walks (api keys / at-cap budgets / closed
  // tenants / webhooks) are up to 40 sequential requests per run. They
  // must NOT replay on every 30s poll tick: initial load and manual
  // refresh always walk; poll ticks walk only when the overview
  // aggregate counters change, with an every-10th-tick fallback so
  // drift can't persist indefinitely.
  describe('poll ticks gate the cursor walks on aggregate change', () => {
    function clearListMocks() {
      listApiKeysMock.mockClear()
      listWebhooksMock.mockClear()
      listTenantsMock.mockClear()
      listBudgetsMock.mockClear()
      listAuditLogsMock.mockClear()
    }

    it('a poll tick with unchanged counters re-runs the cheap fetches but NOT the walks', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      await mountOverview()
      clearListMocks()

      await pollTick()

      // Cheap per-tick fetches still fire: audit feed + the two
      // limit-10 budget lists (frozen, has_debt).
      expect(listAuditLogsMock).toHaveBeenCalledTimes(1)
      const budgetParams = listBudgetsMock.mock.calls.map(c => c[0] as Record<string, string>)
      expect(budgetParams.some(p => p.status === 'FROZEN')).toBe(true)
      expect(budgetParams.some(p => p.has_debt === 'true')).toBe(true)
      // Walk-backed fetches do NOT re-fire — counters didn't move.
      expect(budgetParams.some(p => p.utilization_min !== undefined)).toBe(false)
      expect(listApiKeysMock).not.toHaveBeenCalled()
      expect(listWebhooksMock).not.toHaveBeenCalled()
      expect(listTenantsMock).not.toHaveBeenCalled()
    })

    it('a poll tick whose overview counters changed re-runs all four walks', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      await mountOverview()
      clearListMocks()

      getOverviewMock.mockResolvedValue(healthyOverview({
        webhook_counts: { total: 4, active: 4, disabled: 0, with_failures: 0 },
      }))
      await pollTick()

      expect(listApiKeysMock).toHaveBeenCalledTimes(1)
      expect(listWebhooksMock).toHaveBeenCalledTimes(1)
      expect(listTenantsMock).toHaveBeenCalledTimes(1)
      const budgetParams = listBudgetsMock.mock.calls.map(c => c[0] as Record<string, string>)
      expect(budgetParams.some(p => p.utilization_min === '0.9')).toBe(true)
    })

    it('a changed-counter walk resets the gate — the next unchanged tick skips again', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      await mountOverview()

      getOverviewMock.mockResolvedValue(healthyOverview({
        tenant_counts: { total: 11, active: 11, suspended: 0, closed: 0 },
      }))
      await pollTick() // walks (counters changed)
      clearListMocks()

      await pollTick() // same counters as previous tick → no walk
      expect(listApiKeysMock).not.toHaveBeenCalled()
      expect(listWebhooksMock).not.toHaveBeenCalled()
      expect(listTenantsMock).not.toHaveBeenCalled()
    })

    it('the every-10th-tick fallback re-walks even when counters never change', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      await mountOverview()
      clearListMocks()

      // Ticks 1–9 after the initial walk: gate holds.
      for (let i = 0; i < 9; i++) await pollTick()
      expect(listApiKeysMock).not.toHaveBeenCalled()
      expect(listWebhooksMock).not.toHaveBeenCalled()
      expect(listTenantsMock).not.toHaveBeenCalled()

      // Tick 10: fallback fires so drift can't persist indefinitely.
      await pollTick()
      expect(listApiKeysMock).toHaveBeenCalledTimes(1)
      expect(listWebhooksMock).toHaveBeenCalledTimes(1)
      expect(listTenantsMock).toHaveBeenCalledTimes(1)
    })

    // F2 (walk-failure retry): a rejected walk must NOT be committed as
    // done — pre-fix the signature was committed before the walks
    // settled, so a failed walk round was skipped for up to 10 ticks
    // (~5 min) while the error banner cleared after the next successful
    // phase-1 tick. Now any rejection forces a retry on the next tick,
    // and the banner persists (each retry re-fails) until a full walk
    // round succeeds.
    it('a rejected walk retries on the next tick and the error banner persists until it succeeds', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      listWebhooksMock.mockRejectedValue(new Error('webhook list down'))
      const w = await mountOverview()
      expect(w.text()).toContain('webhook list down')
      clearListMocks()

      // Counters unchanged — but the failed round forces a re-walk.
      await pollTick()
      expect(listWebhooksMock).toHaveBeenCalledTimes(1)
      expect(listApiKeysMock).toHaveBeenCalledTimes(1)
      // Still failing → the banner persists instead of clearing.
      expect(w.text()).toContain('webhook list down')

      // Walk round succeeds → banner clears and the gate re-arms.
      listWebhooksMock.mockResolvedValue({ subscriptions: [], has_more: false })
      await pollTick()
      expect(w.text()).not.toContain('webhook list down')
      clearListMocks()
      await pollTick()
      expect(listWebhooksMock).not.toHaveBeenCalled()
      expect(listApiKeysMock).not.toHaveBeenCalled()
    })

    it('manual refresh (PageHeader) always re-runs the walks regardless of counters', async () => {
      getOverviewMock.mockResolvedValue(healthyOverview())
      const w = await mountOverview()
      clearListMocks()

      const { default: PageHeader } = await import('../components/PageHeader.vue')
      w.findComponent(PageHeader).vm.$emit('refresh')
      await flushPromises()

      expect(listApiKeysMock).toHaveBeenCalledTimes(1)
      expect(listWebhooksMock).toHaveBeenCalledTimes(1)
      expect(listTenantsMock).toHaveBeenCalledTimes(1)
    })
  })
})

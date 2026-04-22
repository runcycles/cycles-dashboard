// PR 1 trial slice (v0.1.25.47): covers the BaseChart wrapper + the
// budget-status donut on OverviewView. Keeps the wire-up changes
// regression-pinned so future refactors don't silently break chart
// mount, aria-label, or the visibility guard (skip render when all
// slices are zero).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { h as actualH, defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import BaseChart from '../components/BaseChart.vue'
import type { Capabilities, AdminOverviewResponse } from '../types'

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

const pushMock = vi.fn()
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: pushMock, replace: vi.fn() }),
    useRoute: () => ({ query: {}, params: {} }),
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

// vue-echarts uses a Canvas renderer which jsdom can't support. Stub
// the component to a minimal div — we're validating the wrapper's
// contract (props forwarded, aria-label present), not ECharts' render.
vi.mock('vue-echarts', () => ({
  default: defineComponent({
    props: ['option'],
    template: '<div data-testid="v-chart-stub" />',
  }),
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

describe('BaseChart — shared wrapper', () => {
  it('forwards option prop and renders an aria-labelled region', () => {
    const w = mount(BaseChart, {
      props: {
        option: { series: [{ type: 'pie', data: [] }] },
        label: 'Sample chart',
      },
    })
    const region = w.find('[role="img"]')
    expect(region.exists()).toBe(true)
    expect(region.attributes('aria-label')).toBe('Sample chart')
    expect(w.find('[data-testid="v-chart-stub"]').exists()).toBe(true)
  })

  it('applies the custom height prop when provided', () => {
    const w = mount(BaseChart, {
      props: {
        option: { series: [] },
        label: 'Tall chart',
        height: '400px',
      },
    })
    const region = w.find('[role="img"]')
    expect(region.attributes('style')).toContain('height: 400px')
  })
})

describe('OverviewView — budget-status donut (v0.1.25.47 trial chart)', () => {
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
    listBudgetsMock.mockResolvedValue({ ledgers: [], has_more: false })
    listTenantsMock.mockResolvedValue({ tenants: [], has_more: false })
    listWebhooksMock.mockResolvedValue({ subscriptions: [], has_more: false })
  })

  it('renders the donut when budget_counts has non-zero slices', async () => {
    getOverviewMock.mockResolvedValue(healthyOverview({
      budget_counts: { total: 8, active: 5, frozen: 2, closed: 1, over_limit: 0, with_debt: 0, by_unit: {} },
    }))
    const w = await mountOverview()
    const donut = w.find('[data-testid="budget-status-donut"]')
    expect(donut.exists()).toBe(true)
    expect(donut.find('[role="img"]').attributes('aria-label')).toBe('Budget status distribution donut chart — clickable')
  })

  it('hides the donut when every slice is zero (empty fleet)', async () => {
    getOverviewMock.mockResolvedValue(healthyOverview({
      budget_counts: { total: 0, active: 0, frozen: 0, closed: 0, over_limit: 0, with_debt: 0, by_unit: {} },
    }))
    const w = await mountOverview()
    expect(w.find('[data-testid="budget-status-donut"]').exists()).toBe(false)
  })

  it('renders the donut when only over-limit is non-zero', async () => {
    getOverviewMock.mockResolvedValue(healthyOverview({
      budget_counts: { total: 1, active: 0, frozen: 0, closed: 0, over_limit: 1, with_debt: 0, by_unit: {} },
    }))
    const w = await mountOverview()
    expect(w.find('[data-testid="budget-status-donut"]').exists()).toBe(true)
  })
})

describe('OverviewView — budget utilization bar (v0.1.25.48)', () => {
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
    listBudgetsMock.mockResolvedValue({ ledgers: [], has_more: false })
    listTenantsMock.mockResolvedValue({ tenants: [], has_more: false })
    listWebhooksMock.mockResolvedValue({ subscriptions: [], has_more: false })
  })

  it('renders utilization bar when the fleet has at least one budget', async () => {
    getOverviewMock.mockResolvedValue(healthyOverview({
      budget_counts: { total: 5, active: 5, frozen: 0, closed: 0, over_limit: 1, with_debt: 2, by_unit: {} },
    }))
    const w = await mountOverview()
    expect(w.find('[data-testid="budget-utilization-bar"]').exists()).toBe(true)
  })

  it('hides utilization bar on an empty fleet (total = 0)', async () => {
    getOverviewMock.mockResolvedValue(healthyOverview({
      budget_counts: { total: 0, active: 0, frozen: 0, closed: 0, over_limit: 0, with_debt: 0, by_unit: {} },
    }))
    const w = await mountOverview()
    expect(w.find('[data-testid="budget-utilization-bar"]').exists()).toBe(false)
  })
})

describe('OverviewView — events-by-category donut (v0.1.25.48)', () => {
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
    listBudgetsMock.mockResolvedValue({ ledgers: [], has_more: false })
    listTenantsMock.mockResolvedValue({ tenants: [], has_more: false })
    listWebhooksMock.mockResolvedValue({ subscriptions: [], has_more: false })
  })

  it('renders when event_counts.by_category has non-zero entries', async () => {
    getOverviewMock.mockResolvedValue(healthyOverview({
      event_counts: { total_recent: 10, by_category: { policy: 3, reservation: 7 } },
    }))
    const w = await mountOverview()
    expect(w.find('[data-testid="events-by-category-donut"]').exists()).toBe(true)
  })

  it('still renders the card with an empty-state message when total_recent is 0', async () => {
    // Layout stability: the 3-up grid must not collapse to 2 columns on
    // an idle environment. The card renders with a "No recent events"
    // message instead of the chart.
    getOverviewMock.mockResolvedValue(healthyOverview({
      event_counts: { total_recent: 0, by_category: {} },
    }))
    const w = await mountOverview()
    const card = w.find('[data-testid="events-by-category-donut"]')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('No recent events')
  })

  it('still renders a single uncategorized slice when by_category is empty but total_recent > 0', async () => {
    // Fallback path: older admin versions or a runtime that has not yet
    // categorized its events would otherwise hide the chart entirely.
    getOverviewMock.mockResolvedValue(healthyOverview({
      event_counts: { total_recent: 42, by_category: {} },
    }))
    const w = await mountOverview()
    expect(w.find('[data-testid="events-by-category-donut"]').exists()).toBe(true)
  })
})

describe('OverviewView — chart drill-down (v0.1.25.49)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    pushMock.mockReset()
    getOverviewMock.mockReset()
    listApiKeysMock.mockReset()
    listAuditLogsMock.mockReset()
    listBudgetsMock.mockReset()
    listTenantsMock.mockReset()
    listWebhooksMock.mockReset()
    listApiKeysMock.mockResolvedValue({ keys: [], has_more: false })
    listAuditLogsMock.mockResolvedValue({ logs: [], has_more: false })
    listBudgetsMock.mockResolvedValue({ ledgers: [], has_more: false })
    listTenantsMock.mockResolvedValue({ tenants: [], has_more: false })
    listWebhooksMock.mockResolvedValue({ subscriptions: [], has_more: false })
    getOverviewMock.mockResolvedValue(healthyOverview({
      budget_counts: { total: 10, active: 5, frozen: 2, closed: 1, over_limit: 2, with_debt: 3, by_unit: {} },
      event_counts: { total_recent: 10, by_category: { policy: 4, reservation: 6 } },
    }))
  })

  it('donut Frozen slice pushes to budgets?status=FROZEN', async () => {
    const w = await mountOverview()
    w.findComponent({ name: 'BaseChart' }).vm.$emit('slice-click', { name: 'Frozen' })
    await flushPromises()
    expect(pushMock).toHaveBeenCalledWith({ name: 'budgets', query: { status: 'FROZEN' } })
  })

  it('donut Over-limit slice pushes to budgets?filter=over_limit', async () => {
    const w = await mountOverview()
    w.findComponent({ name: 'BaseChart' }).vm.$emit('slice-click', { name: 'Over-limit' })
    await flushPromises()
    expect(pushMock).toHaveBeenCalledWith({ name: 'budgets', query: { filter: 'over_limit' } })
  })

  it('utilization With-debt segment pushes to budgets?filter=has_debt', async () => {
    const w = await mountOverview()
    const charts = w.findAllComponents({ name: 'BaseChart' })
    charts[1].vm.$emit('slice-click', { seriesName: 'With debt' })
    await flushPromises()
    expect(pushMock).toHaveBeenCalledWith({ name: 'budgets', query: { filter: 'has_debt' } })
  })

  it('events donut category slice pushes to events?category=policy', async () => {
    const w = await mountOverview()
    const charts = w.findAllComponents({ name: 'BaseChart' })
    charts[2].vm.$emit('slice-click', { name: 'policy' })
    await flushPromises()
    expect(pushMock).toHaveBeenCalledWith({ name: 'events', query: { category: 'policy' } })
  })
})

describe('OverviewView — events donut color uniqueness (v0.1.25.49)', () => {
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
    listBudgetsMock.mockResolvedValue({ ledgers: [], has_more: false })
    listTenantsMock.mockResolvedValue({ tenants: [], has_more: false })
    listWebhooksMock.mockResolvedValue({ subscriptions: [], has_more: false })
  })

  it('assigns a distinct color to tenant, api_key, audit, budget (operator-reported collision)', async () => {
    // Regression pin for the operator report: "tenant, api_key both
    // grey, budget orange — why is the color the same for 2
    // categories?" Every known category must get a unique slice color.
    getOverviewMock.mockResolvedValue(healthyOverview({
      event_counts: {
        total_recent: 40,
        by_category: { tenant: 10, api_key: 10, audit: 10, budget: 10 },
      },
    }))
    const w = await mountOverview()
    const vm = w.vm as unknown as {
      eventsByCategoryOption: {
        series: Array<{ data: Array<{ name: string; itemStyle: { color: string } }> }>
      }
    }
    const slices = vm.eventsByCategoryOption.series[0].data
    const colors = slices.map((s) => s.itemStyle.color)
    expect(new Set(colors).size).toBe(colors.length)
  })
})

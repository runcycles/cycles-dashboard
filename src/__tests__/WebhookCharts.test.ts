// v0.1.25.52 — Webhook visualization slice.
//
// Pins:
//   1. OverviewView webhook fleet-health donut renders the correct
//      slice distribution from the webhooks page already in-flight.
//      (Relocated from WebhooksView in v0.1.25.52 — glance layer
//      belongs on Overview, not on the list.)
//   2. Clicking a slice drills to the right /webhooks?status=... or
//      ?failing=1 URL (the same contract Overview's counter-strip
//      tiles already use — keep the two in sync).
//   3. WebhookDetailView per-subscription stat row computes
//      outcomes / attempts / response-time stats / last-success band
//      from the already-loaded deliveries page.
//   4. Clicking a slice in the delivery-outcome donut sets the local
//      status filter (stays on page — not a route push).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h as actualH } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type {
  Capabilities,
  WebhookSubscription,
  WebhookDelivery,
  AdminOverviewResponse,
} from '../types'

const getOverviewMock = vi.fn()
const listApiKeysMock = vi.fn()
const listAuditLogsMock = vi.fn()
const listBudgetsMock = vi.fn()
const listWebhooksMock = vi.fn()
const listTenantsMock = vi.fn()
const getWebhookMock = vi.fn()
const listDeliveriesMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    getOverview: (...args: unknown[]) => getOverviewMock(...args),
    listApiKeys: (...args: unknown[]) => listApiKeysMock(...args),
    listAuditLogs: (...args: unknown[]) => listAuditLogsMock(...args),
    listBudgets: (...args: unknown[]) => listBudgetsMock(...args),
    listWebhooks: (...args: unknown[]) => listWebhooksMock(...args),
    listTenants: (...args: unknown[]) => listTenantsMock(...args),
    getWebhook: (...args: unknown[]) => getWebhookMock(...args),
    listDeliveries: (...args: unknown[]) => listDeliveriesMock(...args),
    getWebhookSecurityConfig: vi.fn().mockResolvedValue({ allow_http: false, require_signed_payload: true }),
  }
})

const routeRef: { query: Record<string, string>; params: Record<string, string> } = { query: {}, params: {} }
const pushMock = vi.fn()

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: pushMock, replace: vi.fn() }),
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

// Stub the ECharts wire-up that BaseChart pulls in. The real
// vue-echarts needs Canvas (jsdom can't). We don't stub BaseChart
// itself because `defineAsyncComponent(() => import('./BaseChart.vue'))`
// can't be intercepted by `vi.mock` cleanly (the mock module is
// missing the Vue component flags `__isTeleport` etc. that Vue
// queries during patch). Instead, stub BaseChart via mount's
// global.stubs so it never has to render the real chart renderer.
vi.mock('vue-echarts', () => ({
  default: defineComponent({ props: ['option'], template: '<div />' }),
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

// Wrapper mount helper — same as other chart tests. Stub RouterLink
// + Teleport. BaseChart is stubbed locally so `findComponent({ name:
// 'BaseChart' })` returns the stub and we can read `option` + emit
// synthetic `slice-click` events off it.
const BaseChartStub = defineComponent({
  name: 'BaseChart',
  props: ['option', 'label', 'height'],
  emits: ['slice-click'],
  template: '<div data-testid="base-chart-stub" :aria-label="label" />',
})

const FULL_CAPS: Capabilities = {
  view_overview: true, view_budgets: true, view_events: true,
  view_webhooks: true, view_audit: true, view_tenants: true,
  view_api_keys: true, view_policies: true,
  manage_budgets: true, manage_tenants: true, manage_api_keys: true,
  manage_webhooks: true, manage_policies: true, manage_reservations: true,
}

function stdMount() {
  return {
    global: {
      stubs: {
        RouterLink: { template: '<a><slot /></a>' },
        Teleport: true,
        BaseChart: BaseChartStub,
      },
    },
  }
}

function hook(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    subscription_id: 'sub_' + Math.random().toString(36).slice(2, 10),
    tenant_id: 'acme',
    url: 'https://example.com/hook',
    status: 'ACTIVE',
    event_types: ['policy.updated'],
    consecutive_failures: 0,
    created_at: '2026-04-01T00:00:00Z',
    ...overrides,
  } as WebhookSubscription
}

function delivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    delivery_id: 'del_' + Math.random().toString(36).slice(2, 10),
    event_id: 'evt_x',
    status: 'SUCCESS',
    attempts: 1,
    ...overrides,
  } as WebhookDelivery
}

function healthyOverview(overrides: Partial<AdminOverviewResponse> = {}): AdminOverviewResponse {
  return {
    as_of: '2026-04-22T12:00:00Z',
    event_window_seconds: 3600,
    tenant_counts: { total: 10, active: 10, suspended: 0, closed: 0 },
    budget_counts: { total: 5, active: 5, frozen: 0, closed: 0, over_limit: 0, with_debt: 0, by_unit: {} },
    over_limit_scopes: [],
    debt_scopes: [],
    webhook_counts: { total: 0, active: 0, disabled: 0, with_failures: 0 },
    failing_webhooks: [],
    event_counts: { total_recent: 0, by_category: {} },
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
        BaseChart: BaseChartStub,
      },
    },
  })
  await settleAsync()
  return w
}

// Resolve the async BaseChart wrapper for a given test id by
// finding the real (stubbed) BaseChart component instance inside it.
async function settleAsync(count = 3) {
  for (let i = 0; i < count; i++) await flushPromises()
}

describe('OverviewView — webhook fleet-health donut (relocated v0.1.25.52)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    getOverviewMock.mockReset()
    listApiKeysMock.mockReset()
    listAuditLogsMock.mockReset()
    listBudgetsMock.mockReset()
    listWebhooksMock.mockReset()
    listTenantsMock.mockReset()
    pushMock.mockReset()
    routeRef.query = {}
    routeRef.params = {}
    // Defaults — all cards empty so only the webhook slice under test varies.
    listApiKeysMock.mockResolvedValue({ keys: [], has_more: false })
    listAuditLogsMock.mockResolvedValue({ logs: [], has_more: false })
    listBudgetsMock.mockResolvedValue({ ledgers: [], has_more: false })
    listTenantsMock.mockResolvedValue({ tenants: [], has_more: false })
    getOverviewMock.mockResolvedValue(healthyOverview())
  })

  function findWebhookChart(w: ReturnType<typeof mount>) {
    const card = w.find('[data-testid="webhook-fleet-health-donut"]')
    return card.exists() ? card.findComponent({ name: 'BaseChart' }) : null
  }

  // v0.1.25.53: slices are now status-pure (Active / Paused / Disabled)
  // and sourced from the server's `webhook_counts` aggregate. Pre-fix the
  // donut partitioned mutually-exclusively with Failing taking precedence
  // over PAUSED — so a PAUSED-AND-FAILING webhook was counted in Failing,
  // not Paused, which disagreed with the counter-strip chip (status-only).
  // Failing remains a separate counter-strip chip; the donut is fleet-
  // status mix only, and reconciles with chip numbers by construction.
  it('buckets from webhook_counts into Active / Paused / Disabled', async () => {
    // total=6, active=3, disabled=1 → paused = max(0, 6-3-1) = 2.
    // Note: PAUSED-and-failing rows are still counted as Paused (status-only).
    getOverviewMock.mockResolvedValue(healthyOverview({
      webhook_counts: { total: 6, active: 3, disabled: 1, with_failures: 2 },
    }))
    listWebhooksMock.mockResolvedValue({
      subscriptions: [hook({ status: 'ACTIVE', consecutive_failures: 0 })],
      has_more: false,
    })
    const w = await mountOverview()

    const chart = findWebhookChart(w)
    expect(chart).toBeTruthy()
    const option = chart!.props('option') as { series: Array<{ data: Array<{ name: string; value: number }> }> }
    const byName = Object.fromEntries(option.series[0].data.map(s => [s.name, s.value]))
    expect(byName['Active']).toBe(3)
    expect(byName['Paused']).toBe(2)
    expect(byName['Disabled']).toBe(1)
    // No "Failing" slice — that signal lives on the counter-strip chip.
    expect(byName['Failing']).toBeUndefined()
    expect(byName['Healthy']).toBeUndefined()
  })

  it('hides the card when the fleet is empty', async () => {
    getOverviewMock.mockResolvedValue(healthyOverview({
      webhook_counts: { total: 0, active: 0, disabled: 0, with_failures: 0 },
    }))
    listWebhooksMock.mockResolvedValue({ subscriptions: [], has_more: false })
    const w = await mountOverview()
    expect(w.find('[data-testid="webhook-fleet-health-donut"]').exists()).toBe(false)
  })

  it('drills to /webhooks?status=ACTIVE when Active slice clicked', async () => {
    getOverviewMock.mockResolvedValue(healthyOverview({
      webhook_counts: { total: 1, active: 1, disabled: 0, with_failures: 0 },
    }))
    listWebhooksMock.mockResolvedValue({
      subscriptions: [hook({ status: 'ACTIVE', consecutive_failures: 0 })],
      has_more: false,
    })
    const w = await mountOverview()
    findWebhookChart(w)!.vm.$emit('slice-click', { name: 'Active' })
    await flushPromises()
    expect(pushMock).toHaveBeenCalledWith({ name: 'webhooks', query: { status: 'ACTIVE' } })
  })

  it('drills to /webhooks?status=DISABLED when Disabled slice clicked', async () => {
    getOverviewMock.mockResolvedValue(healthyOverview({
      webhook_counts: { total: 1, active: 0, disabled: 1, with_failures: 1 },
    }))
    listWebhooksMock.mockResolvedValue({
      subscriptions: [hook({ status: 'DISABLED', consecutive_failures: 10 })],
      has_more: false,
    })
    const w = await mountOverview()
    findWebhookChart(w)!.vm.$emit('slice-click', { name: 'Disabled' })
    await flushPromises()
    expect(pushMock).toHaveBeenCalledWith({ name: 'webhooks', query: { status: 'DISABLED' } })
  })

  it('drills to /webhooks?status=PAUSED when Paused slice clicked', async () => {
    getOverviewMock.mockResolvedValue(healthyOverview({
      webhook_counts: { total: 2, active: 1, disabled: 0, with_failures: 0 },
    }))
    listWebhooksMock.mockResolvedValue({
      subscriptions: [hook({ status: 'PAUSED', consecutive_failures: 0 })],
      has_more: false,
    })
    const w = await mountOverview()
    findWebhookChart(w)!.vm.$emit('slice-click', { name: 'Paused' })
    await flushPromises()
    expect(pushMock).toHaveBeenCalledWith({ name: 'webhooks', query: { status: 'PAUSED' } })
  })
})

describe('WebhookDetailView — per-subscription stats', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listWebhooksMock.mockReset()
    listTenantsMock.mockReset()
    getWebhookMock.mockReset()
    listDeliveriesMock.mockReset()
    pushMock.mockReset()
    routeRef.query = {}
    routeRef.params = { id: 'sub_test' }
  })

  it('computes delivery outcome, attempts, and response-time stats from loaded deliveries', async () => {
    getWebhookMock.mockResolvedValue(hook({
      subscription_id: 'sub_test',
      last_success_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago → green
      disable_after_failures: 10,
    }))
    listDeliveriesMock.mockResolvedValue({
      deliveries: [
        delivery({ status: 'SUCCESS', attempts: 1, response_time_ms: 100 }),
        delivery({ status: 'SUCCESS', attempts: 1, response_time_ms: 200 }),
        delivery({ status: 'SUCCESS', attempts: 1, response_time_ms: 300 }),
        delivery({ status: 'FAILED', attempts: 5, response_time_ms: 4000 }),
        delivery({ status: 'RETRYING', attempts: 3 }),
      ],
      has_more: false,
    })

    const { default: WebhookDetailView } = await import('../views/WebhookDetailView.vue')
    const w = mount(WebhookDetailView, stdMount())
    await settleAsync()

    expect(w.find('[data-testid="webhook-delivery-stats"]').exists()).toBe(true)
    expect(w.find('[data-testid="webhook-last-success-band"]').exists()).toBe(true)
    expect(w.find('[data-testid="webhook-delivery-outcome-donut"]').exists()).toBe(true)
    expect(w.find('[data-testid="webhook-attempts-histogram"]').exists()).toBe(true)
    expect(w.find('[data-testid="webhook-response-time-stats"]').exists()).toBe(true)

    // Response-time: sorted [100, 200, 300, 4000] → p50=200, p95=4000, max=4000
    const rtCard = w.find('[data-testid="webhook-response-time-stats"]')
    expect(rtCard.text()).toMatch(/200 ms/)
    expect(rtCard.text()).toMatch(/4000 ms/)
    expect(rtCard.text()).toMatch(/over 4 deliver/)

    // Last-success band — 30 min ago = green
    const band = w.find('[data-testid="webhook-last-success-band"]')
    expect(band.html()).toMatch(/bg-green-500/)
    expect(band.text()).toMatch(/Success/)

    // Delivery outcome donut: Success=3, Failed=1, Retrying=1
    const donutCard = w.find('[data-testid="webhook-delivery-outcome-donut"]')
    const donut = donutCard.findComponent({ name: 'BaseChart' })
    const donutOption = donut.props('option') as { series: Array<{ data: Array<{ name: string; value: number }> }> }
    const byName = Object.fromEntries(donutOption.series[0].data.map(s => [s.name, s.value]))
    expect(byName['Success']).toBe(3)
    expect(byName['Failed']).toBe(1)
    expect(byName['Retrying']).toBe(1)

    // Attempts histogram buckets: 1 (×3), 3 (×1), 5+ (×1)
    const histCard = w.find('[data-testid="webhook-attempts-histogram"]')
    const hist = histCard.findComponent({ name: 'BaseChart' })
    const histOption = hist.props('option') as {
      xAxis: { data: string[] }
      series: Array<{ data: Array<{ value: number }> }>
    }
    const axis = histOption.xAxis.data
    const vals = histOption.series[0].data.map(d => d.value)
    const histByLabel: Record<string, number> = {}
    axis.forEach((label, i) => { histByLabel[label] = vals[i] })
    expect(histByLabel['1']).toBe(3)
    expect(histByLabel['3']).toBe(1)
    expect(histByLabel['5+']).toBe(1)
  })

  it('marks last-success band red when the webhook has never succeeded but has failed', async () => {
    getWebhookMock.mockResolvedValue(hook({
      subscription_id: 'sub_test',
      last_success_at: undefined,
      last_failure_at: new Date().toISOString(),
    }))
    listDeliveriesMock.mockResolvedValue({
      deliveries: [delivery({ status: 'FAILED', attempts: 5 })],
      has_more: false,
    })
    const { default: WebhookDetailView } = await import('../views/WebhookDetailView.vue')
    const w = mount(WebhookDetailView, stdMount())
    await settleAsync()
    const band = w.find('[data-testid="webhook-last-success-band"]')
    expect(band.html()).toMatch(/bg-red-500/)
    expect(band.text()).toMatch(/No successful deliveries/)
  })

  it('marks last-success band amber between 1h and 24h since last success', async () => {
    getWebhookMock.mockResolvedValue(hook({
      subscription_id: 'sub_test',
      last_success_at: new Date(Date.now() - 6 * 3_600_000).toISOString(), // 6h ago
    }))
    listDeliveriesMock.mockResolvedValue({
      deliveries: [delivery({ status: 'SUCCESS', attempts: 1, response_time_ms: 100 })],
      has_more: false,
    })
    const { default: WebhookDetailView } = await import('../views/WebhookDetailView.vue')
    const w = mount(WebhookDetailView, stdMount())
    await settleAsync()
    const band = w.find('[data-testid="webhook-last-success-band"]')
    expect(band.html()).toMatch(/bg-yellow-500/)
  })

  it('hides the stat row when no deliveries have been loaded yet', async () => {
    getWebhookMock.mockResolvedValue(hook({ subscription_id: 'sub_test' }))
    listDeliveriesMock.mockResolvedValue({ deliveries: [], has_more: false })
    const { default: WebhookDetailView } = await import('../views/WebhookDetailView.vue')
    const w = mount(WebhookDetailView, stdMount())
    await settleAsync()
    expect(w.find('[data-testid="webhook-delivery-stats"]').exists()).toBe(false)
  })

  it('clicking the delivery-outcome donut sets the local status filter (no route push)', async () => {
    getWebhookMock.mockResolvedValue(hook({ subscription_id: 'sub_test' }))
    listDeliveriesMock.mockResolvedValue({
      deliveries: [
        delivery({ status: 'FAILED', attempts: 5 }),
        delivery({ status: 'SUCCESS', attempts: 1 }),
      ],
      has_more: false,
    })
    const { default: WebhookDetailView } = await import('../views/WebhookDetailView.vue')
    const w = mount(WebhookDetailView, stdMount())
    await settleAsync()

    const card = w.find('[data-testid="webhook-delivery-outcome-donut"]')
    const baseChart = card.findComponent({ name: 'BaseChart' })
    baseChart.vm.$emit('slice-click', { name: 'Failed' })
    await flushPromises()

    // Local status filter; no route push.
    expect(pushMock).not.toHaveBeenCalled()
    const select = w.find('select[aria-label="Filter deliveries by status"]')
    expect((select.element as HTMLSelectElement).value).toBe('FAILED')
  })
})

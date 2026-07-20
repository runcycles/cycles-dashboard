import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import WebhookDeliveryInsights from '../components/WebhookDeliveryInsights.vue'
import type { WebhookDelivery, WebhookSubscription } from '../types'

vi.mock('vue-echarts', () => ({
  default: defineComponent({ template: '<div />' }),
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

const BaseChartStub = defineComponent({
  name: 'BaseChart',
  props: ['option', 'label', 'height', 'srData'],
  emits: ['slice-click'],
  template: '<div data-testid="base-chart-stub" :aria-label="label" />',
})

function subscription(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    subscription_id: 'webhook-1',
    tenant_id: 'acme',
    url: 'https://example.test/hook',
    event_types: ['budget.updated'],
    status: 'ACTIVE',
    created_at: '2026-07-20T00:00:00Z',
    last_success_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    ...overrides,
  }
}

function delivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    delivery_id: 'delivery-1',
    event_id: 'event-1',
    status: 'SUCCESS',
    attempts: 1,
    ...overrides,
  }
}

async function mountInsights(deliveries: WebhookDelivery[]) {
  const wrapper = mount(WebhookDeliveryInsights, {
    props: { deliveries, webhook: subscription() },
    global: { stubs: { BaseChart: BaseChartStub } },
  })
  await flushPromises()
  await flushPromises()
  return wrapper
}

describe('WebhookDeliveryInsights', () => {
  it('keeps the lazy insights panel absent until a delivery page has rows', async () => {
    const wrapper = await mountInsights([])
    expect(wrapper.find('[data-testid="webhook-delivery-stats"]').exists()).toBe(false)
  })

  it('renders the loaded-page summary and supplies accessible histogram values', async () => {
    const wrapper = await mountInsights([
      delivery({ status: 'SUCCESS', attempts: 1, response_time_ms: 100 }),
      delivery({ status: 'FAILED', attempts: 5, response_time_ms: 900 }),
    ])

    expect(wrapper.find('[data-testid="webhook-delivery-stats"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="webhook-response-time-stats"]').text()).toContain('over 2 deliveries')
    const histogram = wrapper.get('[data-testid="webhook-attempts-histogram"]')
      .findComponent({ name: 'BaseChart' })
    expect(histogram.props('srData')).toEqual([
      { label: '1 attempt', value: 1 },
      { label: '5+ attempts', value: 1 },
    ])
  })

  it('emits valid donut drill-downs and ignores unknown slices', async () => {
    const wrapper = await mountInsights([
      delivery({ status: 'SUCCESS' }),
      delivery({ status: 'FAILED' }),
    ])
    const donut = wrapper.get('[data-testid="webhook-delivery-outcome-donut"]')
      .findComponent({ name: 'BaseChart' })

    donut.vm.$emit('slice-click', { name: 'Failed' })
    donut.vm.$emit('slice-click', { name: 'Paused' })

    expect(wrapper.emitted('filterStatus')).toEqual([['FAILED']])
  })
})

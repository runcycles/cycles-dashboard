import { effectScope, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { useWebhookDeliveryInsights } from '../composables/useWebhookDeliveryInsights'
import type { ChartPalette } from '../composables/useChartTheme'
import type { WebhookDelivery, WebhookSubscription } from '../types'

const palette: ChartPalette = {
  success: 'green',
  warning: 'amber',
  danger: 'red',
  info: 'blue',
  neutral: 'gray',
  axis: 'axis',
  grid: 'grid',
  textPrimary: 'primary',
  textMuted: 'muted',
  background: 'transparent',
  tooltipBg: 'tooltip',
  tooltipBorder: 'border',
  categorical: [],
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

function subscription(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    subscription_id: 'webhook-1',
    tenant_id: 'acme',
    url: 'https://example.test/hook',
    event_types: ['budget.updated'],
    status: 'ACTIVE',
    created_at: '2026-07-20T00:00:00Z',
    ...overrides,
  }
}

function setup(now = Date.parse('2026-07-20T12:00:00Z')) {
  const deliveries = ref<WebhookDelivery[]>([])
  const webhook = ref<WebhookSubscription | null>(subscription())
  const scope = effectScope()
  const insights = scope.run(() => useWebhookDeliveryInsights({
    deliveries,
    webhook,
    palette: ref(palette),
    now: () => now,
  }))!
  return { deliveries, webhook, insights, stop: () => scope.stop() }
}

describe('useWebhookDeliveryInsights', () => {
  it('reduces only known outcomes and omits empty donut slices', () => {
    const harness = setup()
    harness.deliveries.value = [
      delivery({ status: 'SUCCESS' }),
      delivery({ status: 'SUCCESS' }),
      delivery({ status: 'FAILED' }),
      delivery({ status: 'RETRYING' }),
      delivery({ status: 'UNKNOWN' }),
    ]

    expect(harness.insights.deliveryOutcomes.value).toEqual({
      success: 2,
      failed: 1,
      retrying: 1,
      pending: 0,
    })
    expect(harness.insights.deliveryOutcomeOption.value.series[0].data.map(slice => slice.name))
      .toEqual(['Success', 'Failed', 'Retrying'])
    harness.stop()
  })

  it('orders and caps attempt buckets while coloring sparse buckets by severity', () => {
    const harness = setup()
    harness.deliveries.value = [
      delivery({ attempts: 99 }),
      delivery({ attempts: 3 }),
      delivery({ attempts: 1 }),
      delivery({ attempts: 99 }),
    ]

    expect(harness.insights.attemptsBuckets.value).toEqual([
      { label: '1', count: 1 },
      { label: '3', count: 1 },
      { label: '5+', count: 2 },
    ])
    expect(harness.insights.attemptsChartOption.value.series[0].data.map(row => row.itemStyle.color))
      .toEqual(['green', 'amber', 'red'])
    expect(harness.insights.attemptsSrData.value).toEqual([
      { label: '1 attempt', value: 1 },
      { label: '3 attempts', value: 1 },
      { label: '5+ attempts', value: 2 },
    ])
    harness.stop()
  })

  it('uses nearest-rank response percentiles and ignores invalid timings', () => {
    const harness = setup()
    harness.deliveries.value = [100, 200, 300, 4000, -1, Number.NaN, Number.POSITIVE_INFINITY]
      .map(response_time_ms => delivery({ response_time_ms }))

    expect(harness.insights.responseStats.value).toEqual({
      count: 4,
      p50: 200,
      p95: 4000,
      max: 4000,
    })
    harness.stop()
  })

  it('covers fresh, aging, stale, and invalid last-success boundaries', () => {
    const harness = setup()

    harness.webhook.value = subscription({ last_success_at: '2026-07-20T11:00:00Z' })
    expect(harness.insights.lastSuccessBand.value.band).toBe('amber')

    harness.webhook.value = subscription({ last_success_at: '2026-07-19T12:00:00Z' })
    expect(harness.insights.lastSuccessBand.value.band).toBe('red')

    harness.webhook.value = subscription({ last_success_at: '2026-07-20T11:00:00.001Z' })
    expect(harness.insights.lastSuccessBand.value.band).toBe('green')

    harness.webhook.value = subscription({ last_success_at: 'not-a-date' })
    expect(harness.insights.lastSuccessBand.value).toEqual({ band: 'unknown', label: 'Unknown', detail: '' })
    harness.stop()
  })

  it('reports no-history states and failure-threshold health explicitly', () => {
    const harness = setup()

    harness.webhook.value = null
    expect(harness.insights.lastSuccessBand.value.label).toBe('No data')

    harness.webhook.value = subscription()
    expect(harness.insights.lastSuccessBand.value.label).toBe('No deliveries yet')

    harness.webhook.value = subscription({ last_failure_at: '2026-07-20T11:00:00Z' })
    expect(harness.insights.lastSuccessBand.value.label).toBe('No successful deliveries')

    harness.webhook.value = subscription({
      last_success_at: '2026-07-20T11:59:00Z',
      consecutive_failures: 5,
      disable_after_failures: 5,
    })
    expect(harness.insights.lastSuccessBand.value).toEqual({
      band: 'red',
      label: 'Failure threshold reached',
      detail: '5 of 5 consecutive failures',
    })
    harness.stop()
  })

  it('maps only valid outcome slices to filter statuses', () => {
    const harness = setup()
    expect(harness.insights.outcomeStatus('Failed')).toBe('FAILED')
    expect(harness.insights.outcomeStatus('pending')).toBe('PENDING')
    expect(harness.insights.outcomeStatus('Paused')).toBeNull()
    expect(harness.insights.outcomeStatus()).toBeNull()
    harness.stop()
  })
})

import { computed, type Ref } from 'vue'
import type { WebhookDelivery, WebhookSubscription } from '../types'
import type { ChartPalette } from './useChartTheme'

export const DELIVERY_INSIGHT_STATUSES = ['SUCCESS', 'FAILED', 'RETRYING', 'PENDING'] as const
export type DeliveryInsightStatus = typeof DELIVERY_INSIGHT_STATUSES[number]

export type DeliveryOutcomeBuckets = {
  success: number
  failed: number
  retrying: number
  pending: number
}

export type AttemptsBucket = { label: string; count: number }
export type ResponseStats = { count: number; p50: number; p95: number; max: number }
export type HealthBand = {
  band: 'green' | 'amber' | 'red' | 'unknown'
  label: string
  detail: string
}

export interface UseWebhookDeliveryInsightsOptions {
  deliveries: Readonly<Ref<readonly WebhookDelivery[]>>
  webhook: Readonly<Ref<WebhookSubscription | null>>
  palette: Readonly<Ref<ChartPalette>>
  now?: () => number
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  // Nearest-rank method (NIST): ceil((p/100) * n) -> 1-indexed rank.
  // For four samples this makes p50 the second sample, matching the
  // operator-facing convention used since the insights panel shipped.
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[Math.min(rank, sorted.length) - 1]
}

function formatElapsed(ms: number): string {
  if (ms < 60_000) return '< 1 min'
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} hr`
  return `${Math.round(ms / 86_400_000)} d`
}

function attemptColor(label: string, palette: ChartPalette): string {
  const attempts = label === '5+' ? 5 : Number(label)
  if (attempts <= 1) return palette.success
  if (attempts <= 3) return palette.warning
  return palette.danger
}

export function useWebhookDeliveryInsights(options: UseWebhookDeliveryInsightsOptions) {
  const now = options.now ?? Date.now

  // All metrics intentionally reduce the already-fetched delivery page.
  // They never issue their own request, so chart values and the rows below
  // always describe the same loaded-page snapshot even when more pages exist.
  const deliveryOutcomes = computed<DeliveryOutcomeBuckets>(() => {
    const out: DeliveryOutcomeBuckets = { success: 0, failed: 0, retrying: 0, pending: 0 }
    for (const delivery of options.deliveries.value) {
      if (delivery.status === 'SUCCESS') out.success++
      else if (delivery.status === 'FAILED') out.failed++
      else if (delivery.status === 'RETRYING') out.retrying++
      else if (delivery.status === 'PENDING') out.pending++
    }
    return out
  })

  const deliveryOutcomeOption = computed(() => {
    const outcome = deliveryOutcomes.value
    const palette = options.palette.value
    const slices = [
      { name: 'Success', value: outcome.success, itemStyle: { color: palette.success } },
      { name: 'Failed', value: outcome.failed, itemStyle: { color: palette.danger } },
      { name: 'Retrying', value: outcome.retrying, itemStyle: { color: palette.warning } },
      { name: 'Pending', value: outcome.pending, itemStyle: { color: palette.neutral } },
    ].filter(slice => slice.value > 0)
    return {
      tooltip: {
        trigger: 'item' as const,
        backgroundColor: palette.tooltipBg,
        borderColor: palette.tooltipBorder,
        textStyle: { color: palette.textPrimary },
      },
      legend: { bottom: 0, textStyle: { color: palette.textMuted, fontSize: 11 } },
      series: [{
        type: 'pie' as const,
        radius: ['55%', '78%'],
        center: ['50%', '45%'],
        avoidLabelOverlap: true,
        label: { show: false },
        labelLine: { show: false },
        data: slices,
      }],
    }
  })

  // The 5+ cap keeps pathological attempt counts from expanding the axis.
  const attemptsBuckets = computed<AttemptsBucket[]>(() => {
    const tallies = new Map<string, number>()
    for (const delivery of options.deliveries.value) {
      const attempts = delivery.attempts ?? 0
      const label = attempts >= 5 ? '5+' : String(attempts)
      tallies.set(label, (tallies.get(label) ?? 0) + 1)
    }
    return ['0', '1', '2', '3', '4', '5+']
      .filter(label => tallies.has(label))
      .map(label => ({ label, count: tallies.get(label) ?? 0 }))
  })

  const attemptsSrData = computed(() => attemptsBuckets.value.map(bucket => ({
    label: `${bucket.label} attempt${bucket.label === '1' ? '' : 's'}`,
    value: bucket.count,
  })))

  const attemptsChartOption = computed(() => {
    const buckets = attemptsBuckets.value
    const palette = options.palette.value
    return {
      tooltip: {
        trigger: 'axis' as const,
        backgroundColor: palette.tooltipBg,
        borderColor: palette.tooltipBorder,
        textStyle: { color: palette.textPrimary },
      },
      grid: { top: 16, right: 16, bottom: 24, left: 32 },
      xAxis: {
        type: 'category' as const,
        data: buckets.map(bucket => bucket.label),
        axisLabel: { color: palette.textMuted, fontSize: 11 },
        axisLine: { lineStyle: { color: palette.grid } },
      },
      yAxis: {
        type: 'value' as const,
        axisLabel: { color: palette.textMuted, fontSize: 11 },
        splitLine: { lineStyle: { color: palette.grid } },
      },
      series: [{
        type: 'bar' as const,
        data: buckets.map(bucket => ({
          value: bucket.count,
          // Color from the actual attempt count, not the sparse bucket's
          // array index. A lone 5+ bucket must remain danger-red.
          itemStyle: { color: attemptColor(bucket.label, palette) },
        })),
        barMaxWidth: 40,
      }],
    }
  })

  const responseStats = computed<ResponseStats>(() => {
    const times: number[] = []
    for (const delivery of options.deliveries.value) {
      const time = delivery.response_time_ms
      if (typeof time === 'number' && Number.isFinite(time) && time >= 0) times.push(time)
    }
    if (times.length === 0) return { count: 0, p50: 0, p95: 0, max: 0 }
    times.sort((a, b) => a - b)
    return {
      count: times.length,
      p50: percentile(times, 50),
      p95: percentile(times, 95),
      max: times[times.length - 1],
    }
  })

  // Traffic-light thresholds match the on-call convention used by the
  // surrounding dashboard: green <1h, amber 1-24h, red >=24h or once the
  // server-controlled consecutive-failure disable threshold is reached.
  const lastSuccessBand = computed<HealthBand>(() => {
    const webhook = options.webhook.value
    if (!webhook) return { band: 'unknown', label: 'No data', detail: '' }

    const failures = webhook.consecutive_failures ?? 0
    const threshold = webhook.disable_after_failures
    if (
      typeof threshold === 'number'
      && Number.isFinite(threshold)
      && threshold > 0
      && Number.isFinite(failures)
      && failures >= threshold
    ) {
      return {
        band: 'red',
        label: 'Failure threshold reached',
        detail: `${failures} of ${threshold} consecutive failures`,
      }
    }

    const timestamp = webhook.last_success_at
    if (!timestamp) {
      return webhook.last_failure_at
        ? { band: 'red', label: 'No successful deliveries', detail: 'Only failures recorded' }
        : { band: 'unknown', label: 'No deliveries yet', detail: 'Waiting for first event' }
    }
    const parsed = Date.parse(timestamp)
    if (!Number.isFinite(parsed)) return { band: 'unknown', label: 'Unknown', detail: '' }
    const elapsed = now() - parsed
    const elapsedLabel = formatElapsed(elapsed)
    if (elapsed < 3_600_000) return { band: 'green', label: `Success ${elapsedLabel} ago`, detail: timestamp }
    if (elapsed < 86_400_000) return { band: 'amber', label: `Success ${elapsedLabel} ago`, detail: timestamp }
    return { band: 'red', label: `Stale · ${elapsedLabel} since last success`, detail: timestamp }
  })

  function outcomeStatus(name?: string): DeliveryInsightStatus | null {
    const normalized = (name ?? '').toUpperCase()
    return DELIVERY_INSIGHT_STATUSES.find(status => status === normalized) ?? null
  }

  return {
    deliveryOutcomes,
    deliveryOutcomeOption,
    attemptsBuckets,
    attemptsSrData,
    attemptsChartOption,
    responseStats,
    lastSuccessBand,
    outcomeStatus,
  }
}

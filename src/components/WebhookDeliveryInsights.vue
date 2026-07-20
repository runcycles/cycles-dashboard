<script setup lang="ts">
import { defineAsyncComponent, toRef } from 'vue'
import { useChartTheme } from '../composables/useChartTheme'
import {
  useWebhookDeliveryInsights,
  type DeliveryInsightStatus,
} from '../composables/useWebhookDeliveryInsights'
import type { WebhookDelivery, WebhookSubscription } from '../types'

// Keep ECharts + vue-echarts out of the detail view's initial chunk. The
// insights panel is hidden before a delivery page exists, so the chart
// dependency is fetched only when it can render useful data.
const BaseChart = defineAsyncComponent(() => import('./BaseChart.vue'))

const props = defineProps<{
  deliveries: readonly WebhookDelivery[]
  webhook: WebhookSubscription | null
}>()
const emit = defineEmits<{ filterStatus: [status: DeliveryInsightStatus] }>()

const { palette } = useChartTheme()
const {
  deliveryOutcomeOption,
  attemptsBuckets,
  attemptsSrData,
  attemptsChartOption,
  responseStats,
  lastSuccessBand,
  outcomeStatus,
} = useWebhookDeliveryInsights({
  deliveries: toRef(props, 'deliveries'),
  webhook: toRef(props, 'webhook'),
  palette,
})

function onDeliveryOutcomeClick(params: { name?: string }) {
  const status = outcomeStatus(params?.name)
  if (status) emit('filterStatus', status)
}
</script>

<template>
  <!-- All metrics reduce the already-fetched page: no new requests and no
       mismatch between the charts and the delivery rows rendered below. -->
  <div
    v-if="deliveries.length > 0"
    class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4"
    data-testid="webhook-delivery-stats"
  >
    <div class="md:col-span-2 lg:col-span-4 flex flex-wrap items-baseline gap-x-2 -mb-1">
      <h3 class="text-sm font-medium text-gray-700 dark:text-gray-200">Delivery insights</h3>
      <span class="muted-sm">
        Based on {{ deliveries.length.toLocaleString() }} loaded
        {{ deliveries.length === 1 ? 'delivery' : 'deliveries' }}
      </span>
    </div>

    <div class="card p-3 flex flex-col justify-between" data-testid="webhook-last-success-band">
      <div class="text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Last successful delivery</div>
      <div class="inline-flex items-center gap-2 text-sm" :title="lastSuccessBand.detail">
        <span
          class="inline-block w-3 h-3 rounded-full shrink-0"
          :class="{
            'bg-green-500': lastSuccessBand.band === 'green',
            'bg-yellow-500': lastSuccessBand.band === 'amber',
            'bg-red-500': lastSuccessBand.band === 'red',
            'bg-gray-400': lastSuccessBand.band === 'unknown',
          }"
          aria-hidden="true"
        />
        <span
          :class="{
            'text-green-700 dark:text-green-400': lastSuccessBand.band === 'green',
            'text-yellow-700 dark:text-yellow-400': lastSuccessBand.band === 'amber',
            'text-red-700 dark:text-red-400': lastSuccessBand.band === 'red',
            'muted': lastSuccessBand.band === 'unknown',
          }"
        >{{ lastSuccessBand.label }}</span>
      </div>
    </div>

    <div
      v-if="deliveryOutcomeOption.series[0].data.length > 0"
      class="card p-3"
      data-testid="webhook-delivery-outcome-donut"
    >
      <div class="text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
        Delivery outcome
        <span class="muted text-xs font-normal">· click a slice</span>
      </div>
      <BaseChart
        :option="deliveryOutcomeOption"
        label="Delivery outcome donut chart — clickable"
        height="160px"
        @slice-click="onDeliveryOutcomeClick"
      />
    </div>

    <div
      v-if="attemptsBuckets.length > 0"
      class="card p-3"
      data-testid="webhook-attempts-histogram"
    >
      <div class="text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Attempts per delivery</div>
      <BaseChart
        :option="attemptsChartOption"
        :sr-data="attemptsSrData"
        label="Attempts histogram bar chart"
        height="160px"
      />
    </div>

    <div class="card p-3 flex flex-col" data-testid="webhook-response-time-stats">
      <div class="text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Response time</div>
      <div v-if="responseStats.count > 0" class="space-y-1 text-sm">
        <div class="flex justify-between"><span class="muted">p50</span><span class="tabular-nums font-medium">{{ responseStats.p50 }} ms</span></div>
        <div class="flex justify-between"><span class="muted">p95</span><span class="tabular-nums font-medium">{{ responseStats.p95 }} ms</span></div>
        <div class="flex justify-between"><span class="muted">max</span><span class="tabular-nums font-medium">{{ responseStats.max }} ms</span></div>
        <div class="muted-sm pt-1">over {{ responseStats.count }} {{ responseStats.count === 1 ? 'delivery' : 'deliveries' }}</div>
      </div>
      <div v-else class="text-sm muted">No timed responses yet</div>
    </div>
  </div>
</template>

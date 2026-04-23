<script setup lang="ts">
import { computed } from 'vue'
import VChart, { THEME_KEY } from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { PieChart, BarChart } from 'echarts/charts'
import {
  TooltipComponent,
  LegendComponent,
  GridComponent,
} from 'echarts/components'
import type { EChartsOption } from 'echarts/types/dist/shared'
import { provide } from 'vue'
import { useChartTheme } from '../composables/useChartTheme'

// v0.1.25.51: added BarChart + GridComponent back for
// WebhookDetailView's attempts histogram. Registering only what's
// actually used keeps tree-shaking honest — Overview's three donuts
// still don't pull in grid rendering until the detail view is
// loaded (BaseChart is lazy-loaded per view anyway).
use([CanvasRenderer, PieChart, BarChart, TooltipComponent, LegendComponent, GridComponent])

const props = defineProps<{
  option: EChartsOption
  label: string
  height?: string
  // M9 (a11y): screen-reader equivalent for chart data. Charts render
  // to <canvas>, which is opaque to assistive tech — the `role="img"`
  // + `aria-label` on the wrapper communicates *what* the chart is,
  // but not the underlying values. Pass a plain array of
  // { label, value } rows (same data that drives the chart) and we
  // render it inside an sr-only <table> so screen-reader users get
  // the same information sighted users see through visual scan.
  // Absence keeps the current behaviour (chart-level label only) —
  // backwards-compatible, opt-in per caller.
  srData?: ReadonlyArray<{ label: string; value: string | number }>
}>()

// ECharts click params carry enough to identify the slice/segment the
// operator clicked (seriesName / name / dataIndex / value). We forward
// the whole object so each caller can decide how to map a click to a
// drill-down route — the wrapper stays dumb about navigation.
export interface ChartClickParams {
  seriesName?: string
  name?: string
  dataIndex?: number
  value?: unknown
  componentType?: string
}
const emit = defineEmits<{ (e: 'slice-click', params: ChartClickParams): void }>()

const { isDark } = useChartTheme()
provide(THEME_KEY, computed(() => (isDark.value ? 'dark' : 'light')))

const style = computed(() => ({ height: props.height ?? '200px', width: '100%' }))

function onChartClick(params: unknown) {
  emit('slice-click', (params ?? {}) as ChartClickParams)
}

// M9 (a11y): auto-derive srData from the chart option when the caller
// didn't pass one explicitly. Works for pie charts and any other
// series that stores slice data in the common `{ name, value }` shape.
// Bar charts with bare-number `data: [1, 2, 3]` paired against an
// `xAxis.data` array are not auto-handled — callers for those should
// pass `srData` explicitly. Empty derive → no SR table rendered, so
// charts with unsupported shapes simply keep the pre-M9 behaviour
// (chart-level aria-label only).
type DerivedRow = { label: string; value: string | number }
const effectiveSrData = computed<ReadonlyArray<DerivedRow>>(() => {
  if (props.srData) return props.srData
  const series = props.option.series as unknown as
    Array<{ data?: Array<unknown> }> | undefined
  const data = series?.[0]?.data ?? []
  const rows: DerivedRow[] = []
  for (const item of data) {
    if (typeof item === 'object' && item !== null) {
      const obj = item as { name?: unknown; value?: unknown }
      if (typeof obj.name === 'string' && (typeof obj.value === 'number' || typeof obj.value === 'string')) {
        rows.push({ label: obj.name, value: obj.value })
      }
    }
  }
  return rows
})
</script>

<template>
  <div role="img" :aria-label="label" :style="style">
    <v-chart
      :option="option"
      autoresize
      style="height: 100%; width: 100%; cursor: pointer"
      @click="onChartClick"
    />
    <!-- M9 (a11y): screen-reader-only data table. Renders the same
         data the chart visualizes so SR users aren't stuck with the
         chart-level aria-label as the only information. Hidden from
         sighted users via sr-only; the <caption> anchors the table
         contextually ("Data for: Webhook fleet health"). Rows come
         from `effectiveSrData` — explicit `srData` prop takes
         precedence, otherwise auto-derived from option.series[0].data
         for pie-style charts. -->
    <table v-if="effectiveSrData.length > 0" class="sr-only" data-testid="chart-sr-table">
      <caption>Data for: {{ label }}</caption>
      <thead>
        <tr><th scope="col">Category</th><th scope="col">Value</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in effectiveSrData" :key="row.label">
          <th scope="row">{{ row.label }}</th>
          <td>{{ row.value }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

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
</script>

<template>
  <div role="img" :aria-label="label" :style="style">
    <v-chart
      :option="option"
      autoresize
      style="height: 100%; width: 100%; cursor: pointer"
      @click="onChartClick"
    />
  </div>
</template>

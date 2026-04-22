<script setup lang="ts">
import { computed } from 'vue'
import VChart, { THEME_KEY } from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { PieChart } from 'echarts/charts'
import {
  TooltipComponent,
  LegendComponent,
} from 'echarts/components'
import type { EChartsOption } from 'echarts/types/dist/shared'
import { provide } from 'vue'
import { useChartTheme } from '../composables/useChartTheme'

// v0.1.25.50: all three Overview charts are donuts, so only PieChart +
// Tooltip + Legend are registered. The utilization chart was reshaped
// from a debt-based stacked bar to a true-utilization donut; BarChart +
// GridComponent were removed in the process to keep the bundle small.
// Upcoming slices can extend this set (LineChart for sparklines, etc.)
// — register only what we use so tree-shaking stays honest.
use([CanvasRenderer, PieChart, TooltipComponent, LegendComponent])

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

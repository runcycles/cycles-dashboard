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

// v0.1.25.48 trio: PieChart covers the donuts (budget status, events by
// category). BarChart + GridComponent cover the horizontal utilization
// bar. Tooltip + Legend are shared. Upcoming slices can extend this set
// (LineChart for sparklines, etc.) — register only what we use so
// tree-shaking keeps the chart chunk small.
use([CanvasRenderer, PieChart, BarChart, TooltipComponent, LegendComponent, GridComponent])

const props = defineProps<{
  option: EChartsOption
  label: string
  height?: string
}>()

const { isDark } = useChartTheme()
provide(THEME_KEY, computed(() => (isDark.value ? 'dark' : 'light')))

const style = computed(() => ({ height: props.height ?? '200px', width: '100%' }))
</script>

<template>
  <div role="img" :aria-label="label" :style="style">
    <v-chart :option="option" autoresize style="height: 100%; width: 100%" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import VChart, { THEME_KEY } from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { PieChart } from 'echarts/charts'
import { TooltipComponent, LegendComponent } from 'echarts/components'
import type { EChartsOption } from 'echarts/types/dist/shared'
import { provide } from 'vue'
import { useChartTheme } from '../composables/useChartTheme'

// PR 1 (v0.1.25.47) ships only the pie chart. Upcoming slices will
// extend this list: BarChart + GridComponent for histograms (Cut 2–4),
// LineChart + TitleComponent for sparklines (post-roadmap). Register
// only what we use so tree-shaking keeps the chart chunk small.
use([CanvasRenderer, PieChart, TooltipComponent, LegendComponent])

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

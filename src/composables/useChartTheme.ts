import { computed } from 'vue'
import { isDark } from './useDarkMode'

export interface ChartPalette {
  success: string
  warning: string
  danger: string
  info: string
  neutral: string
  axis: string
  grid: string
  textPrimary: string
  textMuted: string
  background: string
  tooltipBg: string
  tooltipBorder: string
  // Qualitative palette for charts where the series are nominal
  // categories with no severity semantics (e.g. events-by-category).
  // Ten distinct hues, ordered so adjacent indices are far apart in
  // hue so the default assign-by-index read is discriminable.
  categorical: readonly string[]
}

const LIGHT: ChartPalette = {
  success: '#16a34a',
  warning: '#ca8a04',
  danger: '#dc2626',
  info: '#2563eb',
  neutral: '#6b7280',
  axis: '#6b7280',
  grid: '#e5e7eb',
  textPrimary: '#111827',
  textMuted: '#6b7280',
  background: 'transparent',
  tooltipBg: '#ffffff',
  tooltipBorder: '#e5e7eb',
  categorical: [
    '#2563eb', // blue
    '#16a34a', // green
    '#ca8a04', // amber
    '#dc2626', // red
    '#9333ea', // purple
    '#0d9488', // teal
    '#db2777', // pink
    '#4f46e5', // indigo
    '#65a30d', // lime
    '#6b7280', // neutral (fallback)
  ],
}

const DARK: ChartPalette = {
  success: '#4ade80',
  warning: '#facc15',
  danger: '#f87171',
  info: '#60a5fa',
  neutral: '#9ca3af',
  axis: '#9ca3af',
  grid: '#374151',
  textPrimary: '#f3f4f6',
  textMuted: '#9ca3af',
  background: 'transparent',
  tooltipBg: '#1f2937',
  tooltipBorder: '#374151',
  categorical: [
    '#60a5fa', // blue
    '#4ade80', // green
    '#facc15', // amber
    '#f87171', // red
    '#c084fc', // purple
    '#2dd4bf', // teal
    '#f472b6', // pink
    '#818cf8', // indigo
    '#a3e635', // lime
    '#9ca3af', // neutral (fallback)
  ],
}

export function useChartTheme() {
  const palette = computed<ChartPalette>(() => (isDark.value ? DARK : LIGHT))

  const statusColor = (key: 'success' | 'warning' | 'danger' | 'info' | 'neutral') =>
    computed(() => palette.value[key])

  return { palette, statusColor, isDark }
}

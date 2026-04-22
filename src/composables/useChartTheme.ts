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
}

export function useChartTheme() {
  const palette = computed<ChartPalette>(() => (isDark.value ? DARK : LIGHT))

  const statusColor = (key: 'success' | 'warning' | 'danger' | 'info' | 'neutral') =>
    computed(() => palette.value[key])

  return { palette, statusColor, isDark }
}

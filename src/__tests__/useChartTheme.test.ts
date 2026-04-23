// Coverage backfill for useChartTheme. The composable is small but
// load-bearing — every chart reads `palette.value` for series colors,
// backgrounds, axis/grid/tooltip chrome, and the categorical palette is
// indexed positionally by ECharts. Regression here silently changes
// chart colors, contrast, or dark-mode chrome.

import { describe, it, expect, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { useChartTheme } from '../composables/useChartTheme'
import { isDark } from '../composables/useDarkMode'

describe('useChartTheme', () => {
  beforeEach(() => {
    // Reset dark-mode ref so each test starts in light.
    isDark.value = false
  })

  it('returns the light palette when dark mode is off', () => {
    const { palette } = useChartTheme()
    expect(palette.value.success).toBe('#16a34a')
    expect(palette.value.danger).toBe('#dc2626')
    expect(palette.value.textPrimary).toBe('#111827')
    expect(palette.value.tooltipBg).toBe('#ffffff')
  })

  it('returns the dark palette when dark mode is on', async () => {
    isDark.value = true
    const { palette } = useChartTheme()
    await nextTick()
    expect(palette.value.success).toBe('#4ade80')
    expect(palette.value.danger).toBe('#f87171')
    expect(palette.value.textPrimary).toBe('#f3f4f6')
    expect(palette.value.tooltipBg).toBe('#1f2937')
  })

  it('flips palette reactively when isDark toggles', async () => {
    const { palette } = useChartTheme()
    expect(palette.value.axis).toBe('#6b7280') // light
    isDark.value = true
    await nextTick()
    expect(palette.value.axis).toBe('#9ca3af') // dark
  })

  it('statusColor() returns a computed that tracks palette changes', async () => {
    const { statusColor } = useChartTheme()
    const danger = statusColor('danger')
    expect(danger.value).toBe('#dc2626')
    isDark.value = true
    await nextTick()
    expect(danger.value).toBe('#f87171')
  })

  it('categorical palette has exactly 10 hues in both modes', async () => {
    const { palette } = useChartTheme()
    expect(palette.value.categorical).toHaveLength(10)
    isDark.value = true
    await nextTick()
    expect(palette.value.categorical).toHaveLength(10)
  })
})

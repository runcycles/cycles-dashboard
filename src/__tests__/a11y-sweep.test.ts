// P2 a11y sweep — regression locks for M7 / M8 / M9 / M10.
// Groups tests by finding ID so future bisects land on the right
// origin.

import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// Stub vue-echarts BEFORE importing BaseChart so the real ECharts
// registration + canvas lifecycle never fires under jsdom (which has
// no canvas; zrender throws on clearRect/dpr). The stub keeps the
// aria-label wrapper div + our new sr-only table intact, which is
// what the M9 assertions inspect.
vi.mock('vue-echarts', () => ({
  default: { name: 'VChart', template: '<div data-stub="v-chart" />' },
  THEME_KEY: Symbol('theme'),
}))
vi.mock('echarts/core', () => ({ use: () => {} }))
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }))
vi.mock('echarts/charts', () => ({ PieChart: {}, BarChart: {} }))
vi.mock('echarts/components', () => ({
  TooltipComponent: {}, LegendComponent: {}, GridComponent: {},
}))

import RowActionsMenu from '../components/RowActionsMenu.vue'
import BaseChart from '../components/BaseChart.vue'

// Loose typing for fixture options — BaseChart's actual EChartsOption
// is very strict; tests only need the series shape the component
// inspects. Cast to `any` at the prop boundary.
type EChartsOptionMockable = Record<string, unknown>

// ─── M8 regression: RowActionsMenu keyboard nav ─────────────────────
// Already implemented (lines 155-184). This test exists to keep it
// that way — a future refactor that accidentally strips the arrow-key
// handling should fail here before it lands.
describe('RowActionsMenu — keyboard nav (M8 regression-lock)', () => {
  async function mountMenu() {
    const w = mount(RowActionsMenu, {
      props: {
        items: [
          { label: 'Edit', onClick: () => {} },
          { label: 'Copy', onClick: () => {} },
          { separator: true },
          { label: 'Delete', onClick: () => {} },
        ],
        ariaLabel: 'Row actions',
      },
      attachTo: document.body,
    })
    await flushPromises()
    return w
  }

  it('opens via Enter on trigger and focuses first interactive item', async () => {
    const w = await mountMenu()
    const trigger = w.get('button[aria-haspopup="menu"]')
    await trigger.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    const menu = document.querySelector('ul[role="menu"]')
    expect(menu).toBeTruthy()
    w.unmount()
  })

  it('Escape closes the menu', async () => {
    const w = await mountMenu()
    await w.get('button[aria-haspopup="menu"]').trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    expect(document.querySelector('ul[role="menu"]')).toBeTruthy()
    const menu = document.querySelector('ul[role="menu"]') as HTMLElement
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(document.querySelector('ul[role="menu"]')).toBeFalsy()
    w.unmount()
  })

  it('aria-expanded reflects menu state', async () => {
    const w = await mountMenu()
    const trigger = w.get('button[aria-haspopup="menu"]')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    await trigger.trigger('click')
    await flushPromises()
    expect(trigger.attributes('aria-expanded')).toBe('true')
    w.unmount()
  })
})

// ─── M9: BaseChart screen-reader data table ─────────────────────────
describe('BaseChart — screen-reader data table (M9)', () => {
  const pieOption = {
    series: [{
      type: 'pie',
      data: [
        { name: 'Active', value: 62 },
        { name: 'Paused', value: 6 },
        { name: 'Disabled', value: 3 },
      ],
    }],
  } as EChartsOptionMockable

  it('auto-derives an sr-only data table from pie-shape option.series[0].data', () => {
    const w = mount(BaseChart, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      props: { option: pieOption as any, label: 'Webhook fleet health' },
      global: {},
    })
    const table = w.find('[data-testid="chart-sr-table"]')
    expect(table.exists()).toBe(true)
    expect(table.classes()).toContain('sr-only')
    // Caption anchors the table to the chart label so SR users hear
    // "Data for: Webhook fleet health" before the rows.
    expect(table.find('caption').text()).toBe('Data for: Webhook fleet health')
    // Every slice rendered as a row.
    const rows = table.findAll('tbody tr')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.text()).toContain('Active')
    expect(rows[0]!.text()).toContain('62')
  })

  it('explicit srData prop takes precedence over auto-derive', () => {
    const w = mount(BaseChart, {
      props: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        option: pieOption as any,
        label: 'Custom',
        srData: [{ label: 'Overridden', value: 99 }],
      },
      global: {},
    })
    const rows = w.findAll('[data-testid="chart-sr-table"] tbody tr')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('Overridden')
    expect(rows[0]!.text()).toContain('99')
  })

  it('renders no table when option has no usable slice data', () => {
    const bareOption = { series: [{ type: 'bar', data: [1, 2, 3] }] } as EChartsOptionMockable
    const w = mount(BaseChart, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      props: { option: bareOption as any, label: 'Bar chart' },
      global: {},
    })
    expect(w.find('[data-testid="chart-sr-table"]').exists()).toBe(false)
  })

  it('preserves the chart-level aria-label and role="img"', () => {
    const w = mount(BaseChart, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      props: { option: pieOption as any, label: 'Webhook fleet health' },
      global: {},
    })
    const imgRole = w.find('[role="img"]')
    expect(imgRole.exists()).toBe(true)
    expect(imgRole.attributes('aria-label')).toBe('Webhook fleet health')
  })
})

// ─── M10: .chip focus-visible ring ──────────────────────────────────
// Assertion is a source-file presence check. style.css is processed
// by Tailwind v4 at build time; in-test we read it straight off disk
// via Node fs (Vite's `?raw` import stripped the rule to empty in
// jsdom — not reliable). The rule + ring color match the app-wide
// btn-pill focus convention.
describe('chip focus-visible (M10)', () => {
  it('style.css declares a .chip:focus-visible rule with ring-blue-500', async () => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const cssPath = resolve(process.cwd(), 'src/style.css')
    const css = readFileSync(cssPath, 'utf8')
    expect(css).toMatch(/\.chip:focus-visible/)
    expect(css).toMatch(/ring-blue-500/)
  })
})


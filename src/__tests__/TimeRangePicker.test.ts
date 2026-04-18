// TimeRangePicker — single-control time picker replacing From + To +
// Quick-chip triads. Specs cover: label derivation (preset / custom
// range / all-time), popover open+close, preset emission semantics
// (hours → datetime-local pair, 'all' → empty strings), Custom mode
// draft-then-apply flow, external modelValue re-sync, and the two
// dismissal paths (Escape + click-outside).

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import TimeRangePicker from '../components/TimeRangePicker.vue'

describe('TimeRangePicker — trigger label', () => {
  it('renders "All time" when modelValue is empty', () => {
    const w = mount(TimeRangePicker, { props: { modelValue: { from: '', to: '' } } })
    expect(w.get('[data-testid="time-range-trigger"]').text()).toContain('All time')
  })

  it('renders the preset label after a preset click', async () => {
    const w = mount(TimeRangePicker, { props: { modelValue: { from: '', to: '' } } })
    await w.get('[data-testid="time-range-trigger"]').trigger('click')
    await w.get('[data-preset="24h"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="time-range-trigger"]').text()).toContain('Last 24 hours')
  })

  it('renders a formatted range when modelValue carries custom dates', () => {
    const w = mount(TimeRangePicker, { props: { modelValue: { from: '2026-04-10T14:30', to: '2026-04-17T09:00' } } })
    const label = w.get('[data-testid="time-range-trigger"]').text()
    // Don't assert exact hours (formatDisplay uses local time zone); assert month/day + arrow.
    expect(label).toContain('Apr 10')
    expect(label).toContain('Apr 17')
    expect(label).toContain('→')
  })
})

describe('TimeRangePicker — popover open/close', () => {
  it('is closed on mount', () => {
    const w = mount(TimeRangePicker, { props: { modelValue: { from: '', to: '' } } })
    expect(w.find('[data-testid="time-range-popover"]').exists()).toBe(false)
    expect(w.get('[data-testid="time-range-trigger"]').attributes('aria-expanded')).toBe('false')
  })

  it('opens on trigger click and sets aria-expanded', async () => {
    const w = mount(TimeRangePicker, { props: { modelValue: { from: '', to: '' } } })
    await w.get('[data-testid="time-range-trigger"]').trigger('click')
    expect(w.find('[data-testid="time-range-popover"]').exists()).toBe(true)
    expect(w.get('[data-testid="time-range-trigger"]').attributes('aria-expanded')).toBe('true')
  })

  it('closes on Escape', async () => {
    const w = mount(TimeRangePicker, {
      attachTo: document.body,
      props: { modelValue: { from: '', to: '' } },
    })
    await w.get('[data-testid="time-range-trigger"]').trigger('click')
    expect(w.find('[data-testid="time-range-popover"]').exists()).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(w.find('[data-testid="time-range-popover"]').exists()).toBe(false)
    w.unmount()
  })

  it('closes on click outside', async () => {
    const w = mount(TimeRangePicker, {
      attachTo: document.body,
      props: { modelValue: { from: '', to: '' } },
    })
    await w.get('[data-testid="time-range-trigger"]').trigger('click')
    expect(w.find('[data-testid="time-range-popover"]').exists()).toBe(true)
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(w.find('[data-testid="time-range-popover"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('TimeRangePicker — preset emission', () => {
  beforeEach(() => {
    // Pin "now" so the datetime-local strings emitted by preset
    // clicks are deterministic. 2026-04-17 12:00 local time.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 3, 17, 12, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('Last hour emits a 1-hour window ending at now', async () => {
    const w = mount(TimeRangePicker, { props: { modelValue: { from: '', to: '' } } })
    await w.get('[data-testid="time-range-trigger"]').trigger('click')
    await w.get('[data-preset="1h"]').trigger('click')
    const emitted = w.emitted('update:modelValue')
    expect(emitted).toHaveLength(1)
    const v = emitted![0][0] as { from: string; to: string }
    expect(v.from).toBe('2026-04-17T11:00')
    expect(v.to).toBe('2026-04-17T12:00')
  })

  it('Last 24 hours emits a 24-hour window', async () => {
    const w = mount(TimeRangePicker, { props: { modelValue: { from: '', to: '' } } })
    await w.get('[data-testid="time-range-trigger"]').trigger('click')
    await w.get('[data-preset="24h"]').trigger('click')
    const v = w.emitted('update:modelValue')![0][0] as { from: string; to: string }
    expect(v.from).toBe('2026-04-16T12:00')
    expect(v.to).toBe('2026-04-17T12:00')
  })

  it('All time emits empty strings (unbounded)', async () => {
    const w = mount(TimeRangePicker, { props: { modelValue: { from: '2026-04-01T00:00', to: '2026-04-17T00:00' } } })
    await w.get('[data-testid="time-range-trigger"]').trigger('click')
    await w.get('[data-preset="all"]').trigger('click')
    const v = w.emitted('update:modelValue')![0][0] as { from: string; to: string }
    expect(v).toEqual({ from: '', to: '' })
  })

  it('closes popover after preset click', async () => {
    const w = mount(TimeRangePicker, { props: { modelValue: { from: '', to: '' } } })
    await w.get('[data-testid="time-range-trigger"]').trigger('click')
    await w.get('[data-preset="6h"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="time-range-popover"]').exists()).toBe(false)
  })

  it('marks the active preset with aria-checked=true', async () => {
    const w = mount(TimeRangePicker, { props: { modelValue: { from: '', to: '' } } })
    await w.get('[data-testid="time-range-trigger"]').trigger('click')
    await w.get('[data-preset="24h"]').trigger('click')
    await w.get('[data-testid="time-range-trigger"]').trigger('click')
    expect(w.get('[data-preset="24h"]').attributes('aria-checked')).toBe('true')
    expect(w.get('[data-preset="1h"]').attributes('aria-checked')).toBe('false')
  })
})

describe('TimeRangePicker — Custom range flow', () => {
  it('reveals From/To inputs after clicking Custom', async () => {
    const w = mount(TimeRangePicker, { props: { modelValue: { from: '', to: '' } } })
    await w.get('[data-testid="time-range-trigger"]').trigger('click')
    expect(w.find('#time-range-custom-from').exists()).toBe(false)
    await w.get('[data-preset="custom"]').trigger('click')
    expect(w.find('#time-range-custom-from').exists()).toBe(true)
    expect(w.find('#time-range-custom-to').exists()).toBe(true)
  })

  it('Apply emits the draft values and closes popover', async () => {
    const w = mount(TimeRangePicker, { props: { modelValue: { from: '', to: '' } } })
    await w.get('[data-testid="time-range-trigger"]').trigger('click')
    await w.get('[data-preset="custom"]').trigger('click')
    await w.get('#time-range-custom-from').setValue('2026-04-10T09:00')
    await w.get('#time-range-custom-to').setValue('2026-04-17T17:00')
    await w.get('[data-testid="time-range-custom-apply"]').trigger('click')
    const v = w.emitted('update:modelValue')![0][0] as { from: string; to: string }
    expect(v).toEqual({ from: '2026-04-10T09:00', to: '2026-04-17T17:00' })
    await flushPromises()
    expect(w.find('[data-testid="time-range-popover"]').exists()).toBe(false)
  })

  it('typing in Custom inputs does not emit until Apply is clicked', async () => {
    const w = mount(TimeRangePicker, { props: { modelValue: { from: '', to: '' } } })
    await w.get('[data-testid="time-range-trigger"]').trigger('click')
    await w.get('[data-preset="custom"]').trigger('click')
    await w.get('#time-range-custom-from').setValue('2026-04-10T09:00')
    await w.get('#time-range-custom-to').setValue('2026-04-17T17:00')
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })
})

describe('TimeRangePicker — external modelValue sync', () => {
  it('re-syncs label when parent clears modelValue to empty', async () => {
    const w = mount(TimeRangePicker, { props: { modelValue: { from: '2026-04-10T00:00', to: '2026-04-17T00:00' } } })
    expect(w.get('[data-testid="time-range-trigger"]').text()).toContain('Apr 10')
    await w.setProps({ modelValue: { from: '', to: '' } })
    expect(w.get('[data-testid="time-range-trigger"]').text()).toContain('All time')
  })
})

describe('TimeRangePicker — allowCustom=false', () => {
  it('hides the Custom radio and its inputs', async () => {
    const w = mount(TimeRangePicker, { props: { modelValue: { from: '', to: '' }, allowCustom: false } })
    await w.get('[data-testid="time-range-trigger"]').trigger('click')
    expect(w.find('[data-preset="custom"]').exists()).toBe(false)
  })
})

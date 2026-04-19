// EventsView — time-range filter wire-up.
//
// cycles-governance-admin v0.1.25 listEvents accepts `from` + `to`
// RFC 3339 params. These specs verify that TimeRangePicker drives
// those params through buildFilterParams, that empty values are
// omitted, that ?from=/?to= URL params pre-fill on mount, and that
// Clear filters resets the range.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import EventsView from '../views/EventsView.vue'

const listEventsMock = vi.fn<(params: Record<string, string>) => Promise<unknown>>()

vi.mock('../api/client', () => ({
  listEvents: (params: Record<string, string>) => listEventsMock(params),
  ApiError: class ApiError extends Error {},
}))

const routeQuery: Record<string, string> = {}
const routerReplaceMock = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: routerReplaceMock, push: vi.fn() }),
  useRoute: () => ({ query: routeQuery }),
  RouterLink: { template: '<a><slot /></a>' },
}))

// Deterministic initial fetch — usePolling fires the callback once on
// mount. Keeps tests parallel to the EventsView-poll-merge harness so
// we can assert on the params shape without scheduling real timers.
vi.mock('../composables/usePolling', () => ({
  usePolling: (fn: (signal: AbortSignal) => Promise<void>) => {
    const ctrl = new AbortController()
    void fn(ctrl.signal)
    return {
      isPolling: { value: true },
      isLoading: { value: false },
      refresh: () => fn(ctrl.signal),
    }
  },
}))

beforeEach(() => {
  setActivePinia(createPinia())
  for (const k of Object.keys(routeQuery)) delete routeQuery[k]
  listEventsMock.mockReset()
  routerReplaceMock.mockReset()
  listEventsMock.mockResolvedValue({ events: [], has_more: false, next_cursor: undefined })
})

describe('EventsView — time range wire-up', () => {
  it('does not send from/to when the range is empty', async () => {
    const wrapper = mount(EventsView)
    await flushPromises()
    const firstCall = listEventsMock.mock.calls[0]?.[0] ?? {}
    expect(firstCall.from).toBeUndefined()
    expect(firstCall.to).toBeUndefined()
    wrapper.unmount()
  })

  it('renders a TimeRangePicker labeled "Time range"', () => {
    const wrapper = mount(EventsView)
    expect(wrapper.find('[data-testid="ev-time-range-trigger"]').exists()).toBe(true)
    expect(wrapper.find('label[for="ev-time-range"]').text()).toBe('Time range')
  })

  it('sends from/to as RFC 3339 ISO 8601 when a preset is selected', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 3, 17, 12, 0, 0))
    try {
      const wrapper = mount(EventsView)
      await flushPromises()
      listEventsMock.mockClear()
      await wrapper.get('[data-testid="ev-time-range-trigger"]').trigger('click')
      await wrapper.get('[data-preset="24h"]').trigger('click')
      await flushPromises()
      const call = listEventsMock.mock.calls.at(-1)?.[0] ?? {}
      // datetime-local ('YYYY-MM-DDTHH:MM', local tz) → ISO 8601 UTC.
      // Don't assert exact tz offset since the suite may run in any tz;
      // assert the shape: YYYY-MM-DDTHH:MM:SS.sssZ.
      expect(call.from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(call.to).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      // The window is 24h regardless of tz: to - from === 24h.
      const fromMs = new Date(call.from).getTime()
      const toMs = new Date(call.to).getTime()
      expect(toMs - fromMs).toBe(24 * 3600_000)
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends from/to as RFC 3339 ISO 8601 when a custom range is applied', async () => {
    const wrapper = mount(EventsView)
    await flushPromises()
    listEventsMock.mockClear()
    await wrapper.get('[data-testid="ev-time-range-trigger"]').trigger('click')
    await wrapper.get('[data-preset="custom"]').trigger('click')
    await wrapper.get('#ev-time-range-custom-from').setValue('2026-04-10T09:00')
    await wrapper.get('#ev-time-range-custom-to').setValue('2026-04-17T17:00')
    await wrapper.get('[data-testid="ev-time-range-custom-apply"]').trigger('click')
    await flushPromises()
    const call = listEventsMock.mock.calls.at(-1)?.[0] ?? {}
    // new Date(local-string).toISOString() round-trips — the UTC
    // instant parses back to the same local wall-clock.
    expect(new Date(call.from).toISOString()).toBe(new Date('2026-04-10T09:00').toISOString())
    expect(new Date(call.to).toISOString()).toBe(new Date('2026-04-17T17:00').toISOString())
    wrapper.unmount()
  })

  it('pre-fills from/to from ?from= and ?to= query params on mount', async () => {
    routeQuery.from = '2026-04-10T00:00'
    routeQuery.to = '2026-04-17T00:00'
    const wrapper = mount(EventsView)
    await flushPromises()
    const firstCall = listEventsMock.mock.calls[0]?.[0] ?? {}
    // URL carries local-time datetime-local strings (round-trips with
    // our own router.replace spread); buildFilterParams normalizes to
    // ISO 8601 on the wire.
    expect(new Date(firstCall.from).toISOString()).toBe(new Date('2026-04-10T00:00').toISOString())
    expect(new Date(firstCall.to).toISOString()).toBe(new Date('2026-04-17T00:00').toISOString())
    // Trigger label reflects the restored range.
    const label = wrapper.get('[data-testid="ev-time-range-trigger"]').text()
    expect(label).toContain('Apr 10')
    expect(label).toContain('Apr 17')
    wrapper.unmount()
  })

  it('persists from/to to the URL when the range changes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 3, 17, 12, 0, 0))
    try {
      const wrapper = mount(EventsView)
      await flushPromises()
      routerReplaceMock.mockClear()
      await wrapper.get('[data-testid="ev-time-range-trigger"]').trigger('click')
      await wrapper.get('[data-preset="1h"]').trigger('click')
      await flushPromises()
      const lastCall = routerReplaceMock.mock.calls.at(-1)?.[0] ?? {}
      expect(lastCall.query.from).toBe('2026-04-17T11:00')
      expect(lastCall.query.to).toBe('2026-04-17T12:00')
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Clear filters resets the range (no from/to in the next request)', async () => {
    routeQuery.from = '2026-04-10T00:00'
    routeQuery.to = '2026-04-17T00:00'
    const wrapper = mount(EventsView)
    await flushPromises()
    listEventsMock.mockClear()
    // Clear filters button only renders while hasActiveFilters; the
    // pre-filled range satisfies that.
    const clearBtn = wrapper.findAll('button').find(b => b.text() === 'Clear filters')
    expect(clearBtn).toBeDefined()
    await clearBtn!.trigger('click')
    await flushPromises()
    const call = listEventsMock.mock.calls.at(-1)?.[0] ?? {}
    expect(call.from).toBeUndefined()
    expect(call.to).toBeUndefined()
    wrapper.unmount()
  })
})

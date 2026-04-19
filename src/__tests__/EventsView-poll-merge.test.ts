// R7 (scale-hardening): EventsView polling preserves paginated tail.
//
// Pre-fix, the 15s poll called load() which overwrote events.value with
// the response of a no-cursor listEvents() call. Any pages the operator
// had accumulated via "Load more" were silently dropped — they'd watch
// the rows disappear every 15 seconds.
//
// Post-fix, once the operator clicks Load more at least once, subsequent
// polls merge new events from the head (dedup by event_id) and preserve
// the already-loaded tail. Filter changes reset the flag.
//
// These tests mount the real view, drive the load() / loadMore() /
// applyFilters() functions, and assert the tail is preserved across a
// poll when in extended mode.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import EventsView from '../views/EventsView.vue'
import type { Event } from '../types'

function ev(id: string, ts = '2026-04-16T00:00:00Z'): Event {
  return {
    event_id: id,
    event_type: 'budget.created',
    category: 'budget',
    scope: 'acme/projects/alpha',
    tenant_id: 't_1',
    timestamp: ts,
    source: 'test',
  } as Event
}

type Page = { events: Event[]; has_more: boolean; next_cursor?: string }
let scriptedPages: Page[] = []
const listEventsMock = vi.fn<(params: Record<string, string>) => Promise<Page>>()

vi.mock('../api/client', () => ({
  listEvents: (params: Record<string, string>) => listEventsMock(params),
  ApiError: class ApiError extends Error {},
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useRoute: () => ({ query: {} }),
  RouterLink: { template: '<a><slot /></a>' },
}))

// Neutralize the polling schedule — we drive load() explicitly. The view
// calls usePolling(load, 15000) and expects {refresh, isLoading}.
// Kick the callback once on mount (simulating the real composable's initial
// tick), then expose refresh() for tests to re-trigger.
vi.mock('../composables/usePolling', () => ({
  usePolling: (fn: (signal: AbortSignal) => Promise<void>) => {
    const ctrl = new AbortController()
    // Fire once immediately to mimic start() → tick() in the real composable.
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
  scriptedPages = []
  listEventsMock.mockReset()
  // Default: page-1 fetches read scriptedPages[0]; cursor=<N> fetches
  // read scriptedPages[N]. No match → empty page, has_more=false.
  listEventsMock.mockImplementation(async (params) => {
    const idx = params.cursor ? parseInt(params.cursor, 10) : 0
    const page = scriptedPages[idx]
    if (!page) return { events: [], has_more: false }
    return page
  })
})

afterEach(() => {
  listEventsMock.mockReset()
})

describe('EventsView — poll preserves paginated tail', () => {
  it('poll after loadMore merges new events from head and keeps the tail', async () => {
    // Initial: page 0 = [e1, e2]; page 1 (cursor=1) = [e3, e4]
    scriptedPages.push({ events: [ev('e1'), ev('e2')], has_more: true, next_cursor: '1' })
    scriptedPages.push({ events: [ev('e3'), ev('e4')], has_more: false })

    const wrapper = mount(EventsView, {
      global: {
        stubs: {
          PageHeader: true, TenantLink: true, SortHeader: true,
          EmptyState: true, RouterLink: true,
        },
      },
    })
    await flushPromises()
    // After mount: page 0 loaded.
    expect((wrapper.vm as unknown as { events: Event[] }).events.map(e => e.event_id)).toEqual(['e1', 'e2'])

    // User clicks Load more → appends page 1.
    const vm = wrapper.vm as unknown as {
      loadMore: () => Promise<void>
      refresh: () => void
      applyFilters: () => void
      events: Event[]
    }
    await vm.loadMore()
    await flushPromises()
    expect(vm.events.map(e => e.event_id)).toEqual(['e1', 'e2', 'e3', 'e4'])

    // Poll fires. The server now has a brand-new event `e0` at the head
    // (newer than e1) plus the same e1/e2 it returned before. Re-script
    // page 0 to reflect this. Page 1 unchanged (doesn't matter — we
    // won't re-fetch it).
    scriptedPages[0] = { events: [ev('e0', '2026-04-16T00:01:00Z'), ev('e1'), ev('e2')], has_more: true, next_cursor: '1' }
    // Calling refresh() invokes the usePolling callback (= load()).
    vm.refresh()
    await flushPromises()

    // The tail [e3, e4] MUST be preserved. e0 must appear at the head.
    // e1/e2 must not be duplicated.
    expect(vm.events.map(e => e.event_id)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4'])
    wrapper.unmount()
  })

  it('poll in non-extended mode overwrites as before (fast path unchanged)', async () => {
    scriptedPages.push({ events: [ev('a'), ev('b')], has_more: true, next_cursor: '1' })
    const wrapper = mount(EventsView, {
      global: {
        stubs: {
          PageHeader: true, TenantLink: true, SortHeader: true,
          EmptyState: true, RouterLink: true,
        },
      },
    })
    await flushPromises()
    const vm = wrapper.vm as unknown as {
      refresh: () => void
      events: Event[]
    }
    expect(vm.events.map(e => e.event_id)).toEqual(['a', 'b'])

    // Poll returns different rows (simulating page 1 shifting).
    scriptedPages[0] = { events: [ev('x'), ev('y'), ev('z')], has_more: false }
    vm.refresh()
    await flushPromises()

    // Not in extended mode — expect clean overwrite.
    expect(vm.events.map(e => e.event_id)).toEqual(['x', 'y', 'z'])
    wrapper.unmount()
  })

  it('filter change resets extended mode (tail dropped as expected)', async () => {
    scriptedPages.push({ events: [ev('a'), ev('b')], has_more: true, next_cursor: '1' })
    scriptedPages.push({ events: [ev('c'), ev('d')], has_more: false })

    const wrapper = mount(EventsView, {
      global: {
        stubs: {
          PageHeader: true, TenantLink: true, SortHeader: true,
          EmptyState: true, RouterLink: true,
        },
      },
    })
    await flushPromises()
    const vm = wrapper.vm as unknown as {
      loadMore: () => Promise<void>
      applyFilters: () => void
      events: Event[]
    }
    await vm.loadMore()
    await flushPromises()
    expect(vm.events).toHaveLength(4)

    // Filter change rewrites page 0 (simulating a new filter set
    // server-side) and calls applyFilters, which resets loadedMorePages
    // and calls load(). The tail should be dropped — it's stale relative
    // to the new filter.
    scriptedPages[0] = { events: [ev('new1'), ev('new2')], has_more: false }
    vm.applyFilters()
    await flushPromises()
    expect(vm.events.map(e => e.event_id)).toEqual(['new1', 'new2'])
    wrapper.unmount()
  })
})

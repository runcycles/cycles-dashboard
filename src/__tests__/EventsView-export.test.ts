// Exports for EventsView paginate the full result set.
//
// Same correctness guarantee as AuditView-export (audit item R3):
// compliance / forensics exports must follow `next_cursor` until
// exhausted rather than dumping only page 1. Without this test, a
// silent refactor that loses the pagination loop would let operators
// ship incomplete event captures during incident investigation.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import EventsView from '../views/EventsView.vue'
import type { Event } from '../types'

function ev(id: string): Event {
  return {
    event_id: id,
    event_type: 'budget.created',
    category: 'budget',
    scope: 'tenant:acme/app:api',
    tenant_id: 't_1',
    timestamp: '2026-04-16T00:00:00Z',
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

// Virtualizer mock — jsdom has no layout so real virtualizer renders
// zero rows; return all items with synthetic offsets.
vi.mock('@tanstack/vue-virtual', async () => {
  const { computed, isRef } = await import('vue')
  return {
    useVirtualizer: (optsRef: unknown) => {
      const read = () => (isRef(optsRef) ? optsRef.value : optsRef) as {
        count: number
        estimateSize: () => number
      }
      return computed(() => {
        const opts = read()
        const size = opts.estimateSize?.() ?? 52
        const items = Array.from({ length: opts.count }, (_, index) => ({
          index, key: index, start: index * size, size, end: (index + 1) * size, lane: 0,
        }))
        return {
          getVirtualItems: () => items,
          getTotalSize: () => opts.count * size,
          measureElement: () => {},
        }
      })
    },
  }
})

// Kick usePolling's callback once on mount, as the real composable does.
vi.mock('../composables/usePolling', () => ({
  usePolling: (fn: (signal: AbortSignal) => Promise<void>) => {
    const ctrl = new AbortController()
    void fn(ctrl.signal)
    return {
      isPolling: { value: true },
      isLoading: { value: false },
      lastUpdated: { value: null },
      refresh: () => fn(ctrl.signal),
    }
  },
}))

let lastBlob: Blob | null = null
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

beforeEach(() => {
  setActivePinia(createPinia())
  scriptedPages = []
  lastBlob = null
  listEventsMock.mockReset()
  listEventsMock.mockImplementation(async (params) => {
    const idx = params.cursor ? parseInt(params.cursor, 10) : 0
    const page = scriptedPages[idx]
    if (!page) return { events: [], has_more: false }
    return page
  })
  URL.createObjectURL = vi.fn((blob: Blob) => {
    lastBlob = blob
    return 'blob:mock'
  })
  URL.revokeObjectURL = vi.fn()
  HTMLAnchorElement.prototype.click = vi.fn()
})

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
})

async function readBlob(b: Blob): Promise<string> {
  if (typeof b.text === 'function') return b.text()
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsText(b)
  })
}

describe('EventsView export — pagination', () => {
  it('follows next_cursor through all pages before downloading', async () => {
    scriptedPages.push({ events: [ev('e1'), ev('e2')], has_more: true, next_cursor: '1' })
    scriptedPages.push({ events: [ev('e3'), ev('e4')], has_more: true, next_cursor: '2' })
    scriptedPages.push({ events: [ev('e5'), ev('e6')], has_more: false })

    const wrapper = mount(EventsView, {
      global: { stubs: { PageHeader: true, TenantLink: true, SortHeader: true, EmptyState: true } },
    })
    await flushPromises()
    // Initial mount fetch already ran (page 0). Clear so we only
    // count export-triggered fetches below.
    const initialCallCount = listEventsMock.mock.calls.length
    expect(initialCallCount).toBeGreaterThanOrEqual(1)

    const vm = wrapper.vm as unknown as {
      confirmExport: (f: 'csv' | 'json') => void
      executeExport: () => Promise<void>
    }
    vm.confirmExport('json')
    await vm.executeExport()
    await flushPromises()

    // Initial call + 2 more pages = 3 total (pages 1 + 2 triggered
    // during export cursor-follow). Initial call count might be 2
    // if the poll ran twice in test setup, so we check that we made
    // at least 2 more calls after the export started.
    const exportCallCount = listEventsMock.mock.calls.length - initialCallCount
    expect(exportCallCount).toBeGreaterThanOrEqual(2)

    expect(lastBlob).not.toBeNull()
    const text = await readBlob(lastBlob!)
    const parsed = JSON.parse(text) as Event[]
    expect(parsed.map((e) => e.event_id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6'])
    wrapper.unmount()
  })

  it('does NOT fetch more pages when has_more=false on the initial page', async () => {
    scriptedPages.push({ events: [ev('a'), ev('b'), ev('c')], has_more: false })

    const wrapper = mount(EventsView, {
      global: { stubs: { PageHeader: true, TenantLink: true, SortHeader: true, EmptyState: true } },
    })
    await flushPromises()
    const callsBeforeExport = listEventsMock.mock.calls.length

    const vm = wrapper.vm as unknown as {
      confirmExport: (f: 'csv' | 'json') => void
      executeExport: () => Promise<void>
    }
    vm.confirmExport('csv')
    await vm.executeExport()
    await flushPromises()

    // Fast path — export shouldn't trigger any additional fetches
    // because hasMore was false after the initial load.
    expect(listEventsMock.mock.calls.length).toBe(callsBeforeExport)
    expect(lastBlob).not.toBeNull()
    wrapper.unmount()
  })
})

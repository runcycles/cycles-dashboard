// Status + parent filters are server-side (spec listTenants `status`,
// `parent_tenant_id`). Pre-fix they were applied only to the loaded
// page, so on a fleet larger than one page an Overview drill-down such
// as "3 suspended" showed only the suspended tenants that happened to
// be in the newest 50 rows.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

enableAutoUnmount(afterEach)

const listTenantsMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listTenants: (...args: unknown[]) => listTenantsMock(...args),
  }
})

const routeRef: { name: string; query: Record<string, string> } = { name: 'tenants', query: {} }

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useRoute: () => routeRef,
    RouterLink: { template: '<a><slot /></a>' },
  }
})

// Controllable polling double: `isLoading` is driven by the test so the
// queued-refresh path (change made while a tick is in flight) can be
// exercised deterministically.
const polling = vi.hoisted(() => ({
  isLoading: null as null | { value: boolean },
  // When true, refresh() is a no-op — mirrors the real composable's
  // in-flight dedup.
  dropRefresh: false,
}))

vi.mock('../composables/usePolling', async () => {
  const { ref } = await import('vue')
  return {
    usePolling: (callback: () => unknown) => {
      const isLoading = ref(false)
      polling.isLoading = isLoading
      void callback()
      return {
        isPolling: ref(true),
        isLoading,
        lastSuccessAt: ref<Date | null>(null),
        refresh: () => (polling.dropRefresh ? undefined : callback()),
      }
    },
  }
})

vi.mock('../composables/useDebouncedRef', () => ({
  useDebouncedRef: <T>(source: { value: T }) => source,
}))

vi.mock('@tanstack/vue-virtual', async () => {
  const { computed, isRef } = await import('vue')
  return {
    useVirtualizer: (optsRef: unknown) => {
      const read = () => (isRef(optsRef) ? optsRef.value : optsRef) as { count: number; estimateSize: () => number }
      return computed(() => {
        const opts = read()
        const size = opts.estimateSize?.() ?? 52
        const items = Array.from({ length: opts.count }, (_, index) => ({
          index, key: index, start: index * size, size, end: (index + 1) * size, lane: 0,
        }))
        return { getVirtualItems: () => items, getTotalSize: () => opts.count * size }
      })
    },
  }
})

const FULL_CAPS: Capabilities = {
  view_overview: true, view_budgets: true, view_events: true,
  view_webhooks: true, view_audit: true, view_tenants: true,
  view_api_keys: true, view_policies: true,
  manage_budgets: true, manage_tenants: true, manage_api_keys: true,
  manage_webhooks: true, manage_policies: true, manage_reservations: true,
}

function tenant(id: string, status = 'ACTIVE', parent?: string) {
  return {
    tenant_id: id, name: `Name ${id}`, status, created_at: '2026-01-01T00:00:00Z',
    ...(parent ? { parent_tenant_id: parent } : {}),
  }
}

function stdMount() {
  return { global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, Teleport: true } } }
}

async function mountView() {
  const { default: TenantsView } = await import('../views/TenantsView.vue')
  const w = mount(TenantsView, stdMount())
  await flushPromises()
  return w
}

function lastParams(): Record<string, string> {
  return listTenantsMock.mock.calls[listTenantsMock.mock.calls.length - 1][0] as Record<string, string>
}

function selectByLabel(w: Awaited<ReturnType<typeof mountView>>, needle: string) {
  const el = w.findAll<HTMLSelectElement>('select').find(s =>
    s.element.getAttribute('aria-label')?.toLowerCase().includes(needle),
  )
  expect(el).toBeDefined()
  return el!
}

describe('TenantsView — server-side status / parent filters', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listTenantsMock.mockReset()
    listTenantsMock.mockResolvedValue({
      tenants: [tenant('root'), tenant('kid', 'ACTIVE', 'root'), tenant('susp', 'SUSPENDED')],
      has_more: false,
    })
    routeRef.query = {}
    polling.dropRefresh = false
  })

  it('sends neither filter on a bare mount', async () => {
    await mountView()
    const params = lastParams()
    expect(params.status).toBeUndefined()
    expect(params.parent_tenant_id).toBeUndefined()
  })

  it('?status=SUSPENDED deep-link is sent to the server on the first fetch', async () => {
    routeRef.query = { status: 'SUSPENDED' }
    await mountView()
    expect(listTenantsMock.mock.calls[0][0]).toMatchObject({ status: 'SUSPENDED' })
  })

  it('picking a status refetches page 1 with status=<value>', async () => {
    const w = await mountView()
    const before = listTenantsMock.mock.calls.length
    await selectByLabel(w, 'status').setValue('SUSPENDED')
    await flushPromises()
    expect(listTenantsMock.mock.calls.length).toBe(before + 1)
    expect(lastParams().status).toBe('SUSPENDED')
    expect(lastParams().cursor).toBeUndefined()
  })

  it('picking a parent sends parent_tenant_id; "(root-level only)" stays client-side', async () => {
    const w = await mountView()
    const parent = selectByLabel(w, 'parent')
    await parent.setValue('root')
    await flushPromises()
    expect(lastParams().parent_tenant_id).toBe('root')

    await parent.setValue('__root__')
    await flushPromises()
    // No null-parent filter exists server-side — the sentinel must
    // never reach the wire.
    expect(lastParams().parent_tenant_id).toBeUndefined()
  })

  it('keeps the selected parent in the dropdown when the filtered page holds only its children', async () => {
    const w = await mountView()
    // Server-filtered response: only the children, the parent row is gone.
    listTenantsMock.mockResolvedValue({ tenants: [tenant('kid', 'ACTIVE', 'root')], has_more: false })
    const parent = selectByLabel(w, 'parent')
    await parent.setValue('root')
    await flushPromises()
    const options = Array.from(parent.element.options).map(o => o.value)
    expect(options).toContain('root')
    expect(parent.element.value).toBe('root')
    // Parent NAME still resolves from the accumulated directory.
    const rootOption = Array.from(parent.element.options).find(o => o.value === 'root')!
    expect(rootOption.textContent).toContain('Name root')
  })

  it('offers a deep-linked parent that was never loaded (?parent=<id>)', async () => {
    routeRef.query = { parent: 'far-away' }
    listTenantsMock.mockResolvedValue({ tenants: [tenant('kid2', 'ACTIVE', 'far-away')], has_more: false })
    const w = await mountView()
    expect(listTenantsMock.mock.calls[0][0]).toMatchObject({ parent_tenant_id: 'far-away' })
    const parent = selectByLabel(w, 'parent')
    expect(parent.element.value).toBe('far-away')
  })

  it('queues a filter change made while a poll tick is in flight and replays it when the tick settles', async () => {
    const w = await mountView()
    const before = listTenantsMock.mock.calls.length
    // Tick in flight: the real refresh() would be dropped by the
    // in-flight dedup, leaving the old result on screen for up to 60s.
    polling.isLoading!.value = true
    polling.dropRefresh = true
    await selectByLabel(w, 'status').setValue('SUSPENDED')
    await flushPromises()
    expect(listTenantsMock.mock.calls.length).toBe(before)

    polling.dropRefresh = false
    polling.isLoading!.value = false
    await flushPromises()
    expect(listTenantsMock.mock.calls.length).toBe(before + 1)
    expect(lastParams().status).toBe('SUSPENDED')
  })

  it('Load more follows the applied tuple and drops a page superseded by a refetch', async () => {
    listTenantsMock.mockResolvedValue({
      tenants: [tenant('a'), tenant('b', 'SUSPENDED')], has_more: true, next_cursor: 'c1',
    })
    const w = await mountView()
    let resolveMore!: (v: unknown) => void
    listTenantsMock.mockImplementationOnce(() => new Promise((res) => { resolveMore = res }))
    const more = w.findAll('button').find(b => /load more/i.test(b.text()))
    expect(more).toBeDefined()
    await more!.trigger('click')
    expect(lastParams()).toMatchObject({ cursor: 'c1' })
    expect(lastParams().status).toBeUndefined()

    // Filter changes while page 2 is in flight → page-one refetch wins.
    listTenantsMock.mockResolvedValue({ tenants: [tenant('b', 'SUSPENDED')], has_more: false })
    await selectByLabel(w, 'status').setValue('SUSPENDED')
    await flushPromises()
    resolveMore({ tenants: [tenant('stale-row', 'SUSPENDED')], has_more: false })
    await flushPromises()
    expect(w.text()).not.toContain('stale-row')
  })
})

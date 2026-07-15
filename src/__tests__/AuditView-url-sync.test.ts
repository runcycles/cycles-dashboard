// F2 — AuditView route.query watcher guard.
//
// The old guard compared the incoming URL to the CURRENT (possibly
// unsubmitted) form state, which broke two ways:
//   (a) browser Back to /audit?tenant_id=A while the form happened to
//       read A skipped the refetch, leaving tenant B's results on
//       screen;
//   (b) a bare /audit navigation (sidebar click) reset-hydrated the
//       whole form and fired an unfiltered query, wiping the operator's
//       working filter set.
// The new guard remembers the exact query the view itself last wrote
// via router.replace: self-inflicted change → skip (one-shot); empty
// incoming query → skip entirely; anything else → reset-hydrate + query,
// even if the form already matches.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { reactive } from 'vue'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import AuditView from '../views/AuditView.vue'

// routeRef below is a shared reactive object — auto-unmount so a
// previous test's still-mounted view can't react to the next test's
// route mutations and pollute the shared fetch mock.
enableAutoUnmount(afterEach)

const listAuditLogsMock = vi.fn<(params: Record<string, string>) => Promise<unknown>>()

vi.mock('../api/client', () => ({
  listAuditLogs: (params: Record<string, string>) => listAuditLogsMock(params),
  ApiError: class ApiError extends Error {},
}))

const replaceMock = vi.fn()

// Reactive route so the view's `watch(() => route.query, …)` fires when
// tests reassign `routeRef.query` (simulating back/forward + same-route
// navigation without a remount).
const routeRef = reactive({ query: {} as Record<string, string> })

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: replaceMock }),
  useRoute: () => routeRef,
  RouterLink: { template: '<a><slot /></a>' },
}))

beforeEach(() => {
  setActivePinia(createPinia())
  routeRef.query = {}
  listAuditLogsMock.mockReset()
  listAuditLogsMock.mockResolvedValue({ logs: [], has_more: false, next_cursor: undefined })
  replaceMock.mockReset()
})

async function mountView() {
  const w = mount(AuditView)
  await flushPromises()
  return w
}

describe('AuditView — URL ↔ form sync guard (F2)', () => {
  it('back/forward to a parameterized URL refetches even when the form already matches', async () => {
    const w = await mountView()
    // Operator typed a tenant into the form but did NOT submit — the
    // on-screen results are still the unfiltered page-1 set.
    await w.find('#audit-tenant').setValue('acme')
    listAuditLogsMock.mockClear()

    // Browser Back lands on /audit?tenant_id=acme. The old
    // routeMatchesForm guard skipped this (form happens to match);
    // the results shown were for a different filter set.
    routeRef.query = { tenant_id: 'acme' }
    await flushPromises()

    expect(listAuditLogsMock).toHaveBeenCalledTimes(1)
    expect(listAuditLogsMock.mock.calls[0][0].tenant_id).toBe('acme')
  })

  it('a bare /audit navigation preserves the working filter state and does not fire an unfiltered query', async () => {
    routeRef.query = { tenant_id: 'acme' }
    const w = await mountView()
    listAuditLogsMock.mockClear()

    // Sidebar click → same route, empty query. Pre-change behavior:
    // filters preserved, no refetch.
    routeRef.query = {}
    await flushPromises()

    expect(listAuditLogsMock).not.toHaveBeenCalled()
    expect((w.find('#audit-tenant').element as HTMLInputElement).value).toBe('acme')
  })

  it('the view\'s own write-back (applyFilters replace) does not double-fetch', async () => {
    const w = await mountView()
    await w.find('#audit-tenant').setValue('acme')
    listAuditLogsMock.mockClear()

    await w.find('form').trigger('submit')
    await flushPromises()
    // applyFilters ran query() once and wrote the URL.
    expect(listAuditLogsMock).toHaveBeenCalledTimes(1)
    expect(replaceMock).toHaveBeenCalledWith({ query: { tenant_id: 'acme' } })

    // The router applies the replace → route.query changes → watcher
    // fires with the self-written query. Must skip (no second fetch,
    // no re-hydration).
    routeRef.query = { tenant_id: 'acme' }
    await flushPromises()
    expect(listAuditLogsMock).toHaveBeenCalledTimes(1)
  })

  it('the self-write skip is one-shot — returning to the same URL later still refetches', async () => {
    const w = await mountView()
    await w.find('#audit-tenant').setValue('acme')
    await w.find('form').trigger('submit')
    await flushPromises()
    routeRef.query = { tenant_id: 'acme' } // self write-back lands
    await flushPromises()
    listAuditLogsMock.mockClear()

    // Back to a different filter set → real navigation, refetch.
    routeRef.query = { tenant_id: 'beta' }
    await flushPromises()
    expect(listAuditLogsMock).toHaveBeenCalledTimes(1)
    expect(listAuditLogsMock.mock.calls[0][0].tenant_id).toBe('beta')

    // Forward to the previously self-written URL → the marker was
    // consumed; this is browser navigation and must refetch too.
    routeRef.query = { tenant_id: 'acme' }
    await flushPromises()
    expect(listAuditLogsMock).toHaveBeenCalledTimes(2)
    expect(listAuditLogsMock.mock.calls[1][0].tenant_id).toBe('acme')
  })

  it('a parameterized navigation reset-hydrates the form from the URL', async () => {
    routeRef.query = { tenant_id: 'acme', search: 'budget' }
    const w = await mountView()

    // Activity-link navigation to a key-scoped view: params not in the
    // new URL are cleared (reset-style hydration).
    routeRef.query = { key_id: 'key_1' }
    await flushPromises()

    expect((w.find('#audit-tenant').element as HTMLInputElement).value).toBe('')
    const lastCall = listAuditLogsMock.mock.calls.at(-1)![0]
    expect(lastCall.key_id).toBe('key_1')
    expect(lastCall.tenant_id).toBeUndefined()
  })
})

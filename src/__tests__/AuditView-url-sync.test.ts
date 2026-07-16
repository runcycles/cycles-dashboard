// AuditView route.query watcher guard — URL-authoritative semantics.
//
// The guard remembers the exact query the view itself last wrote via
// router.replace: a self-inflicted change → skip (one-shot, query()
// already ran in applyFilters); ANY other query change — parameterized
// or bare — is a real navigation that reset-hydrates the form from the
// URL and refetches, even when the form happens to match already.
//
// F6 (deliberate design decision — do not flip back): the URL is the
// single source of truth for the synced filters. Back/forward to a bare
// /audit entry, or a bare sidebar re-click, resets ALL filter fields to
// defaults and refetches unfiltered — params removed means filters
// cleared (GitHub/Linear convention). Submitted filter sets are always
// in the URL, so they stay recoverable one Back-press away; only
// unsubmitted form fiddling is discarded.

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
// navigation without a remount). Carries `name` because the watcher is
// route-identity-guarded (F3).
const routeRef = reactive({ query: {} as Record<string, string | (string | null)[] | null>, name: 'audit' })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function auditLog(logId: string) {
  return {
    log_id: logId,
    timestamp: '2026-07-15T12:00:00Z',
    operation: `operation-${logId}`,
    status: 200,
  }
}

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: replaceMock }),
  useRoute: () => routeRef,
  RouterLink: { template: '<a><slot /></a>' },
}))

beforeEach(() => {
  setActivePinia(createPinia())
  routeRef.query = {}
  routeRef.name = 'audit'
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
  it('normalizes a valueless-first duplicated param the same way as form hydration', async () => {
    routeRef.query = { tenant_id: [null, 'acme'] }
    const w = await mountView()
    expect((w.find('#audit-tenant').element as HTMLInputElement).value).toBe('acme')
    expect(listAuditLogsMock.mock.calls.at(-1)![0].tenant_id).toBe('acme')

    listAuditLogsMock.mockClear()
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(listAuditLogsMock).toHaveBeenCalledTimes(1)
  })

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

  it('navigation to a bare /audit resets all filters and refetches unfiltered (URL-authoritative)', async () => {
    // Land with a full filter set in the URL, including the time window
    // and status band.
    routeRef.query = {
      tenant_id: 'acme',
      from: '2026-04-01T00:00',
      to: '2026-04-02T00:00',
      status_band: 'errors',
    }
    const w = await mountView()
    const hydratedCall = listAuditLogsMock.mock.calls.at(-1)![0]
    expect(hydratedCall.tenant_id).toBe('acme')
    expect(hydratedCall.status_min).toBe('400')
    listAuditLogsMock.mockClear()

    // Back to a bare-/audit history entry (or a bare sidebar re-click).
    // Params removed → filters cleared → unfiltered refetch.
    routeRef.query = {}
    await flushPromises()

    expect(listAuditLogsMock).toHaveBeenCalledTimes(1)
    const call = listAuditLogsMock.mock.calls[0][0]
    expect(call.tenant_id).toBeUndefined()
    expect(call.from).toBeUndefined()
    expect(call.to).toBeUndefined()
    expect(call.status_min).toBeUndefined()
    expect(call.status_max).toBeUndefined()
    expect((w.find('#audit-tenant').element as HTMLInputElement).value).toBe('')
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

  // F6: when applyFilters' replace targets a query identical to the
  // current URL, vue-router dedupes it — the watcher never fires and a
  // marker armed anyway was never consumed. That stale marker wrongly
  // swallowed the NEXT real navigation to the same query (e.g. Run
  // Query on bare /audit, then a bare sidebar re-click kept stale
  // results). The marker is now armed only when the URL will change.
  it('Run Query with URL-identical filters does not leak the one-shot marker', async () => {
    const w = await mountView()
    listAuditLogsMock.mockClear()

    // Run Query on bare /audit with an empty form — buildUrlQuery() is
    // {}, identical to the current URL, so router.replace dedupes and
    // no watcher event fires (routeRef.query is left untouched here).
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(listAuditLogsMock).toHaveBeenCalledTimes(1)

    // Operator fiddles with the form (unsubmitted), then a REAL
    // navigation to the same bare query lands (sidebar re-click).
    await w.find('#audit-tenant').setValue('acme')
    listAuditLogsMock.mockClear()
    routeRef.query = {}
    await flushPromises()

    // Pre-fix the stale marker matched ('' === '') and skipped this —
    // stale results stayed on screen. Now: reset-hydrate + refetch.
    expect(listAuditLogsMock).toHaveBeenCalledTimes(1)
    expect((w.find('#audit-tenant').element as HTMLInputElement).value).toBe('')
  })

  // F3 (route-identity guard): the route.query watcher fires during
  // navigation AWAY too — a destination route carrying same-named
  // params must not reset-hydrate this view or fire a fetch on the way
  // out.
  it('a navigation away to a route with same-named params does not refetch', async () => {
    const w = await mountView()
    await w.find('#audit-tenant').setValue('acme')
    await w.find('form').trigger('submit')
    await flushPromises()
    routeRef.query = { tenant_id: 'acme' } // self write-back lands
    await flushPromises()
    listAuditLogsMock.mockClear()

    // Router commits /reservations?tenant_id=beta while AuditView is
    // still mounted (watchers run before unmount).
    routeRef.name = 'reservations'
    routeRef.query = { tenant_id: 'beta' }
    await flushPromises()
    expect(listAuditLogsMock).not.toHaveBeenCalled()
    expect((w.find('#audit-tenant').element as HTMLInputElement).value).toBe('acme')
  })

  it('ignores an older page-one response that resolves after a newer navigation', async () => {
    const older = deferred<unknown>()
    const newer = deferred<unknown>()
    listAuditLogsMock
      .mockReset()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)

    const w = await mountView()
    routeRef.query = { tenant_id: 'newest' }
    await flushPromises()

    newer.resolve({ logs: [auditLog('new-1'), auditLog('new-2')], has_more: false })
    await flushPromises()
    expect(w.find('[role="table"]').attributes('aria-rowcount')).toBe('3')

    older.resolve({ logs: [auditLog('old')], has_more: false })
    await flushPromises()
    expect(w.find('[role="table"]').attributes('aria-rowcount')).toBe('3')
  })

  it('discards an in-flight load-more page after the filters change', async () => {
    const oldPage = deferred<unknown>()
    const newQuery = deferred<unknown>()
    listAuditLogsMock
      .mockReset()
      .mockResolvedValueOnce({ logs: [auditLog('initial')], has_more: true, next_cursor: 'old-cursor' })
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(newQuery.promise)

    const w = await mountView()
    const loadMore = w.findAll('button').find(b => b.text() === 'Load more')
    await loadMore!.trigger('click')
    routeRef.query = { tenant_id: 'newest' }
    await flushPromises()

    newQuery.resolve({ logs: [auditLog('new-1'), auditLog('new-2')], has_more: false })
    await flushPromises()
    oldPage.resolve({ logs: [auditLog('stale-page')], has_more: false })
    await flushPromises()

    expect(w.find('[role="table"]').attributes('aria-rowcount')).toBe('3')
    expect(listAuditLogsMock.mock.calls[1][0].cursor).toBe('old-cursor')
    expect(listAuditLogsMock.mock.calls[2][0].tenant_id).toBe('newest')
  })
})

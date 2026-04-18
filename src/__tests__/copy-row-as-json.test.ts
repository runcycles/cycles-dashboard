// Per-row "Copy JSON" button for Events + Audit views (v0.1.25.37).
//
// EventsView previously had a Copy button inside the Data sub-box that
// copied only e.data. Widened + promoted to a row-level action that
// copies the full Event object. AuditView had no copy button; a matching
// Copy JSON button is added to the expanded-row panel and copies the
// full AuditLogEntry (including metadata — where bulk-action per-row
// outcomes live and which isn't reachable via any search filter).
//
// These specs mount each view with a single row, expand it, click Copy
// JSON, and assert (a) navigator.clipboard.writeText was called with
// the full row serialized via safeJsonStringify, and (b) the button
// label toggles to "Copied!" for ~2s.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

const listEventsMock = vi.fn()
const listAuditLogsMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listEvents: (...args: unknown[]) => listEventsMock(...args),
    listAuditLogs: (...args: unknown[]) => listAuditLogsMock(...args),
  }
})

const routeRef: { query: Record<string, string>; params: Record<string, string> } = { query: {}, params: {} }

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useRoute: () => routeRef,
    RouterLink: { template: '<a><slot /></a>' },
  }
})

vi.mock('../composables/usePolling', () => ({
  usePolling: (fn: () => Promise<void> | void) => {
    void fn()
    return {
      refresh: async () => { void fn() },
      isLoading: { value: false },
      lastUpdated: { value: null },
    }
  },
}))

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
        return {
          getVirtualItems: () => items,
          getTotalSize: () => opts.count * size,
          measureElement: () => {},
        }
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

function stdMount() {
  return { global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, Teleport: true } } }
}

let writeTextMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  const auth = useAuthStore()
  auth.apiKey = 'test-key'
  auth.capabilities = FULL_CAPS
  listEventsMock.mockReset()
  listAuditLogsMock.mockReset()
  routeRef.query = {}
  routeRef.params = {}
  writeTextMock = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: writeTextMock },
    writable: true,
    configurable: true,
  })
  vi.useFakeTimers()
})

describe('EventsView — Copy JSON widens to full event object', () => {
  const sampleEvent = {
    event_id: 'evt_abc',
    event_type: 'reservation.denied',
    category: 'runtime',
    scope: 'tenant:acme/agent:reviewer',
    tenant_id: 'acme',
    source: 'cycles-server',
    timestamp: '2026-04-18T12:00:00Z',
    request_id: 'req_xyz',
    correlation_id: 'corr_xyz',
    actor: { type: 'ADMIN', key_id: 'admin-key' },
    data: { reason: 'INSUFFICIENT_BALANCE', amount: 500 },
  }

  it('copies the full Event object, not just e.data, and toggles label to Copied!', async () => {
    listEventsMock.mockResolvedValue({ events: [sampleEvent], has_more: false })
    const { default: EventsView } = await import('../views/EventsView.vue')
    const w = mount(EventsView, stdMount())
    await flushPromises()

    // Expand the row so the Copy JSON button renders.
    const expandBtn = w.find('button[aria-label="Expand event details"]')
    expect(expandBtn.exists()).toBe(true)
    await expandBtn.trigger('click')
    await flushPromises()

    const copyBtn = w.find(`button[aria-label="Copy full JSON for event ${sampleEvent.event_id}"]`)
    expect(copyBtn.exists()).toBe(true)
    expect(copyBtn.text()).toBe('Copy JSON')

    await copyBtn.trigger('click')
    await flushPromises()

    expect(writeTextMock).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(writeTextMock.mock.calls[0][0])
    // Full event, not just data — asserting multiple top-level fields.
    expect(payload.event_id).toBe('evt_abc')
    expect(payload.event_type).toBe('reservation.denied')
    expect(payload.tenant_id).toBe('acme')
    expect(payload.actor).toEqual({ type: 'ADMIN', key_id: 'admin-key' })
    expect(payload.data).toEqual({ reason: 'INSUFFICIENT_BALANCE', amount: 500 })

    // Label flips to Copied! and reverts after the timeout fires.
    await flushPromises()
    expect(w.find(`button[aria-label="Copy full JSON for event ${sampleEvent.event_id}"]`).text()).toBe('Copied!')
    vi.advanceTimersByTime(2100)
    await flushPromises()
    expect(w.find(`button[aria-label="Copy full JSON for event ${sampleEvent.event_id}"]`).text()).toBe('Copy JSON')
  })
})

describe('AuditView — Copy JSON copies full entry including metadata', () => {
  const sampleEntry = {
    log_id: 'log_abc',
    timestamp: '2026-04-18T12:00:00Z',
    operation: 'bulkActionBudgets',
    resource_type: 'BUDGET',
    resource_id: 'bulk-action',
    tenant_id: 'acme',
    key_id: 'admin-key',
    source_ip: '10.0.0.1',
    user_agent: 'gh-actions/1',
    status: 200,
    metadata: {
      succeeded: [{ id: 'led_1', scope: 'tenant:acme/agent:a' }],
      failed: [{ id: 'led_2', scope: 'tenant:acme/agent:b', error_code: 'INVALID_TRANSITION' }],
      skipped: [],
    },
  }

  it('renders Copy JSON in the expanded panel and copies the full entry with metadata', async () => {
    listAuditLogsMock.mockResolvedValue({ logs: [sampleEntry], has_more: false, next_cursor: undefined })
    const { default: AuditView } = await import('../views/AuditView.vue')
    const w = mount(AuditView, stdMount())
    await flushPromises()

    const expandBtn = w.find('button[aria-label="Expand audit details"]')
    expect(expandBtn.exists()).toBe(true)
    await expandBtn.trigger('click')
    await flushPromises()

    const copyBtn = w.find(`button[aria-label="Copy full JSON for audit log ${sampleEntry.log_id}"]`)
    expect(copyBtn.exists()).toBe(true)
    expect(copyBtn.text()).toBe('Copy JSON')

    await copyBtn.trigger('click')
    await flushPromises()

    expect(writeTextMock).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(writeTextMock.mock.calls[0][0])
    expect(payload.log_id).toBe('log_abc')
    expect(payload.operation).toBe('bulkActionBudgets')
    expect(payload.tenant_id).toBe('acme')
    // Critical: metadata must be in the payload — that's where per-row
    // bulk outcomes live and the whole reason this button exists.
    expect(payload.metadata.succeeded).toHaveLength(1)
    expect(payload.metadata.failed[0].error_code).toBe('INVALID_TRANSITION')

    expect(w.find(`button[aria-label="Copy full JSON for audit log ${sampleEntry.log_id}"]`).text()).toBe('Copied!')
    vi.advanceTimersByTime(2100)
    await flushPromises()
    expect(w.find(`button[aria-label="Copy full JSON for audit log ${sampleEntry.log_id}"]`).text()).toBe('Copy JSON')
  })

  it('silently swallows clipboard errors', async () => {
    writeTextMock.mockRejectedValueOnce(new Error('permission denied'))
    listAuditLogsMock.mockResolvedValue({ logs: [sampleEntry], has_more: false, next_cursor: undefined })
    const { default: AuditView } = await import('../views/AuditView.vue')
    const w = mount(AuditView, stdMount())
    await flushPromises()

    await w.find('button[aria-label="Expand audit details"]').trigger('click')
    await flushPromises()
    // Should not throw even though writeText rejects.
    await expect(
      w.find(`button[aria-label="Copy full JSON for audit log ${sampleEntry.log_id}"]`).trigger('click')
    ).resolves.not.toThrow()
  })
})

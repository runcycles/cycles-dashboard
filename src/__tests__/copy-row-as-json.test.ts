// Per-row "Copy JSON" button for triage surfaces (v0.1.25.37).
//
// Covers four surfaces:
//   - EventsView (list) — full-event Copy JSON replaces data-only Copy
//   - AuditView (list) — new Copy JSON on every expanded row
//   - EventTimeline (BudgetDetail + TenantDetail) — Copy JSON on
//     expanded rows (parity with EventsView)
//   - WebhookDetailView delivery history — inline trailing-column
//     Copy JSON button (flat rows, no expand)
//
// Every spec asserts (a) navigator.clipboard.writeText was called
// with the full row serialized via safeJsonStringify, and (b) the
// button label toggles to "Copied!" for ~2s.

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
    }
  },
}))

vi.mock('../composables/useDebouncedRef', () => ({
  useDebouncedRef: <T>(source: { value: T }) => source,
}))

// WebhookDetailView (v0.1.25.51+) mounts charts; vue-echarts drives
// a real canvas against jsdom and throws `Cannot set properties of
// null (setting 'dpr')`. Stub both vue-echarts and the echarts
// registrations so BaseChart mounts as an inert div — these tests
// care about Copy-as-JSON wiring on the delivery-history table, not
// chart pixels.
vi.mock('vue-echarts', () => ({
  default: { props: ['option'], template: '<div data-testid="v-chart-stub" />' },
  THEME_KEY: Symbol('theme'),
}))
vi.mock('echarts/core', () => ({ use: () => {} }))
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }))
vi.mock('echarts/charts', () => ({ PieChart: {}, BarChart: {} }))
vi.mock('echarts/components', () => ({
  TooltipComponent: {},
  LegendComponent: {},
  GridComponent: {},
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

describe('EventTimeline — Copy JSON copies full event from expanded row', () => {
  const sampleEvent = {
    event_id: 'evt_timeline',
    event_type: 'budget.funded',
    category: 'governance',
    scope: 'tenant:acme/agent:reviewer',
    tenant_id: 'acme',
    source: 'cycles-server-admin',
    timestamp: '2026-04-18T12:00:00Z',
    data: { delta: 500, unit: 'USD_MICROCENTS' },
  }

  it('renders Copy JSON in the expanded row and copies the full event', async () => {
    const { default: EventTimeline } = await import('../components/EventTimeline.vue')
    const w = mount(EventTimeline, {
      props: { events: [sampleEvent] },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    })
    await flushPromises()

    // Expand the row.
    const expandBtn = w.find('div[role="button"][aria-expanded]')
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
    expect(payload.event_id).toBe('evt_timeline')
    expect(payload.event_type).toBe('budget.funded')
    expect(payload.scope).toBe('tenant:acme/agent:reviewer')
    expect(payload.data).toEqual({ delta: 500, unit: 'USD_MICROCENTS' })

    expect(copyBtn.text()).toBe('Copied!')
    vi.advanceTimersByTime(2100)
    await flushPromises()
    expect(w.find(`button[aria-label="Copy full JSON for event ${sampleEvent.event_id}"]`).text()).toBe('Copy JSON')
  })
})

describe('WebhookDetailView — Copy actions on delivery rows (kebab, v0.1.25.40+)', () => {
  const listDeliveriesMock = vi.fn()
  const getWebhookMock = vi.fn()

  beforeEach(() => {
    listDeliveriesMock.mockReset()
    getWebhookMock.mockReset()
  })

  const sampleDelivery = {
    delivery_id: 'del_abc',
    subscription_id: 'sub_xyz',
    event_id: 'evt_xyz',
    event_type: 'reservation.denied',
    status: 'FAILED',
    response_status: 503,
    response_time_ms: 42,
    error_message: 'Receiver returned 503 Service Unavailable',
    attempts: 3,
    attempted_at: '2026-04-18T12:00:00Z',
    completed_at: '2026-04-18T12:00:02Z',
    created_at: '2026-04-18T11:55:00Z',
  }

  it('exposes Copy as JSON / Copy delivery ID / Copy event ID via the row kebab and copies the right payload for each', async () => {
    vi.doMock('../api/client', async () => {
      const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
      return {
        ...actual,
        listDeliveries: (...args: unknown[]) => listDeliveriesMock(...args),
        getWebhook: (...args: unknown[]) => getWebhookMock(...args),
      }
    })
    getWebhookMock.mockResolvedValue({
      id: 'sub_xyz',
      tenant_id: 'acme',
      url: 'https://example.test/hook',
      active: true,
      created_at: '2026-04-18T00:00:00Z',
      status: 'ACTIVE',
      event_types: ['*'],
    })
    listDeliveriesMock.mockResolvedValue({ deliveries: [sampleDelivery], has_more: false, next_cursor: undefined })
    routeRef.params = { id: 'sub_xyz' }

    const { default: WebhookDetailView } = await import('../views/WebhookDetailView.vue')
    const w = mount(WebhookDetailView, stdMount())
    await flushPromises()
    await flushPromises()

    // The per-delivery kebab is labeled with the delivery id so it's
    // distinguishable from any other kebabs on the page (e.g. the
    // subscription-level kebab in the header).
    const kebab = w.find(`button[aria-label="Actions for delivery ${sampleDelivery.delivery_id}"]`)
    expect(kebab.exists()).toBe(true)
    await kebab.trigger('click')
    await flushPromises()

    const menuItems = w.findAll('button[role="menuitem"]')
    const labels = menuItems.map(b => b.text())
    expect(labels).toEqual(['Copy as JSON', 'Copy delivery ID', 'Copy event ID'])

    // Copy as JSON → full delivery object.
    await menuItems[0].trigger('click')
    await flushPromises()
    expect(writeTextMock).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(writeTextMock.mock.calls[0][0])
    expect(payload.delivery_id).toBe('del_abc')
    expect(payload.event_id).toBe('evt_xyz')
    expect(payload.status).toBe('FAILED')
    expect(payload.response_status).toBe(503)
    expect(payload.error_message).toBe('Receiver returned 503 Service Unavailable')
    expect(payload.attempts).toBe(3)

    // Re-open kebab and click Copy delivery ID.
    await kebab.trigger('click')
    await flushPromises()
    const menu2 = w.findAll('button[role="menuitem"]')
    await menu2[1].trigger('click')
    await flushPromises()
    expect(writeTextMock).toHaveBeenCalledTimes(2)
    expect(writeTextMock.mock.calls[1][0]).toBe('del_abc')

    // Re-open kebab and click Copy event ID.
    await kebab.trigger('click')
    await flushPromises()
    const menu3 = w.findAll('button[role="menuitem"]')
    await menu3[2].trigger('click')
    await flushPromises()
    expect(writeTextMock).toHaveBeenCalledTimes(3)
    expect(writeTextMock.mock.calls[2][0]).toBe('evt_xyz')
  })

  // v0.1.25.39 field-name fix: dashboard types had `http_status` +
  // `delivered_at` but the governance spec emits `response_status` +
  // `completed_at`; `error_message` wasn't typed at all so the whole
  // failure-reason column was invisible. Guard the rendered output
  // against regressing back to the unaligned field names.
  it('renders spec-aligned delivery fields (response_status, error_message) and the SUCCESS filter option', async () => {
    vi.doMock('../api/client', async () => {
      const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
      return {
        ...actual,
        listDeliveries: (...args: unknown[]) => listDeliveriesMock(...args),
        getWebhook: (...args: unknown[]) => getWebhookMock(...args),
      }
    })
    getWebhookMock.mockResolvedValue({
      id: 'sub_xyz', tenant_id: 'acme', url: 'https://example.test/hook',
      active: true, created_at: '2026-04-18T00:00:00Z', status: 'ACTIVE', event_types: ['*'],
    })
    const failedDelivery = {
      delivery_id: 'del_failed',
      subscription_id: 'sub_xyz',
      event_id: 'evt_failed',
      event_type: 'tenant.created',
      status: 'FAILED',
      response_status: 405,
      response_time_ms: 13,
      error_message: 'Subscription not active: DISABLED',
      attempts: 5,
      attempted_at: '2026-04-18T12:00:00Z',
      completed_at: '2026-04-18T12:00:01Z',
    }
    listDeliveriesMock.mockResolvedValue({ deliveries: [failedDelivery], has_more: false, next_cursor: undefined })
    routeRef.params = { id: 'sub_xyz' }

    const { default: WebhookDetailView } = await import('../views/WebhookDetailView.vue')
    const w = mount(WebhookDetailView, stdMount())
    await flushPromises()
    await flushPromises()

    const html = w.html()
    // response_status (405) renders in the HTTP cell — pre-fix this
    // was always '-' because the view read `http_status`.
    expect(html).toContain('405')
    // error_message renders in the Error column — pre-fix the column
    // didn't exist and the field wasn't typed.
    expect(html).toContain('Subscription not active: DISABLED')
    // Status filter uses spec enum (SUCCESS), not the pre-fix DELIVERED.
    const filterSelect = w.find('select[aria-label="Filter deliveries by status"]')
    expect(filterSelect.exists()).toBe(true)
    const options = filterSelect.findAll('option').map(o => o.text())
    expect(options).toContain('SUCCESS')
    expect(options).not.toContain('DELIVERED')
  })
})

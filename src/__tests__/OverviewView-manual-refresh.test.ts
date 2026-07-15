// Round 4 (F5): manual Refresh queued during long walk rounds.
//
// usePolling's refresh() is a deliberate no-op while a tick is in
// flight (in-flight dedup), and Overview's walk rounds make ticks span
// seconds — so a mid-round click on Refresh previously did nothing
// until the next 30s tick. The fix keeps the composable semantics
// (other views rely on the dedup) and queues the click in the view:
// refreshAll() sets pendingManualRefresh while isLoading, and a watcher
// consumes the flag on the true→false edge, re-invoking refreshAll with
// forceWalks armed.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { type Ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities, AdminOverviewResponse } from '../types'
import PageHeader from '../components/PageHeader.vue'

const getOverviewMock = vi.fn()
const listApiKeysMock = vi.fn()
const listAuditLogsMock = vi.fn()
const listBudgetsMock = vi.fn()
const listTenantsMock = vi.fn()
const listWebhooksMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    getOverview: (...args: unknown[]) => getOverviewMock(...args),
    listApiKeys: (...args: unknown[]) => listApiKeysMock(...args),
    listAuditLogs: (...args: unknown[]) => listAuditLogsMock(...args),
    listBudgets: (...args: unknown[]) => listBudgetsMock(...args),
    listTenants: (...args: unknown[]) => listTenantsMock(...args),
    listWebhooks: (...args: unknown[]) => listWebhooksMock(...args),
  }
})

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useRoute: () => ({ query: {}, params: {} }),
    RouterLink: { props: ['to'], template: '<a><slot /></a>' },
  }
})

// usePolling mock that mirrors the real composable's contract precisely
// enough for F5: a controllable isLoading ref plus a refresh() that
// no-ops while isLoading is true (the in-flight dedup the view must
// work around).
const pollState = vi.hoisted(() => ({
  callback: null as null | (() => Promise<void> | void),
  isLoading: null as null | Ref<boolean>,
  refreshRuns: 0,
}))

vi.mock('../composables/usePolling', async () => {
  const { ref: vueRef } = await import('vue')
  return {
    usePolling: (fn: () => Promise<void> | void) => {
      pollState.callback = fn
      const isLoading = vueRef(false)
      pollState.isLoading = isLoading
      pollState.refreshRuns = 0
      void fn() // initial load
      return {
        refresh: () => {
          // In-flight dedup — same behavior as the real tick().
          if (isLoading.value) return
          pollState.refreshRuns++
          void fn()
        },
        isLoading,
        lastSuccessAt: vueRef<Date | null>(null),
      }
    },
  }
})

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

const FULL_CAPS: Capabilities = {
  view_overview: true, view_budgets: true, view_events: true,
  view_webhooks: true, view_audit: true, view_tenants: true,
  view_api_keys: true, view_policies: true,
  manage_budgets: true, manage_tenants: true, manage_api_keys: true,
  manage_webhooks: true, manage_policies: true, manage_reservations: true,
}

function healthyOverview(): AdminOverviewResponse {
  return {
    as_of: '2026-07-15T12:00:00Z',
    event_window_seconds: 3600,
    tenant_counts: { total: 10, active: 10, suspended: 0, closed: 0 },
    budget_counts: {
      total: 5, active: 5, frozen: 0, closed: 0,
      over_limit: 0, with_debt: 0, by_unit: {},
    },
    over_limit_scopes: [],
    debt_scopes: [],
    webhook_counts: { total: 3, active: 3, disabled: 0, with_failures: 0 },
    failing_webhooks: [],
    event_counts: { total_recent: 42, by_category: { runtime: 42 } },
    recent_denials: [],
    recent_expiries: [],
  }
}

describe('OverviewView — manual refresh during an in-flight tick (round 4 F5)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    for (const m of [getOverviewMock, listApiKeysMock, listAuditLogsMock, listBudgetsMock, listTenantsMock, listWebhooksMock]) m.mockReset()
    getOverviewMock.mockResolvedValue(healthyOverview())
    listApiKeysMock.mockResolvedValue({ keys: [], has_more: false })
    listAuditLogsMock.mockResolvedValue({ logs: [], has_more: false })
    listBudgetsMock.mockResolvedValue({ ledgers: [], has_more: false })
    listTenantsMock.mockResolvedValue({ tenants: [], has_more: false })
    listWebhooksMock.mockResolvedValue({ subscriptions: [], has_more: false })
  })

  async function mountView() {
    const { default: OverviewView } = await import('../views/OverviewView.vue')
    const w = mount(OverviewView, {
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, Teleport: true } },
    })
    await flushPromises()
    return w
  }

  it('queues a refresh clicked mid-tick and replays it (walks forced) when the tick settles', async () => {
    const w = await mountView()
    // Initial load consumed forceWalks and committed the walk signature.
    listApiKeysMock.mockClear()

    // A slow walk round is in flight.
    pollState.isLoading!.value = true
    await flushPromises()

    // Operator clicks Refresh — usePolling would drop it; the view must queue it.
    w.getComponent(PageHeader).vm.$emit('refresh')
    await flushPromises()
    expect(pollState.refreshRuns).toBe(0)
    expect(listApiKeysMock).not.toHaveBeenCalled()

    // Tick settles → the queued click replays automatically…
    pollState.isLoading!.value = false
    await flushPromises()
    expect(pollState.refreshRuns).toBe(1)
    // …with forceWalks armed: the walk-backed fetches re-ran even though
    // the overview counters (walk signature) did not change.
    expect(listApiKeysMock).toHaveBeenCalled()
  })

  it('a click while idle still refreshes immediately (regression guard)', async () => {
    const w = await mountView()
    listApiKeysMock.mockClear()

    w.getComponent(PageHeader).vm.$emit('refresh')
    await flushPromises()
    expect(pollState.refreshRuns).toBe(1)
    expect(listApiKeysMock).toHaveBeenCalled()
  })

  it('does not replay when no click happened during the tick (flag stays unarmed)', async () => {
    await mountView()
    listApiKeysMock.mockClear()

    pollState.isLoading!.value = true
    await flushPromises()
    pollState.isLoading!.value = false
    await flushPromises()
    expect(pollState.refreshRuns).toBe(0)
    expect(listApiKeysMock).not.toHaveBeenCalled()
  })
})

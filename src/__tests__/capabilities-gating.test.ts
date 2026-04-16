// Capability-gated UI visibility tests.
//
// Compliance-grade bug class: a user with `manage_X: false` must not *see*
// the write-action button — server-side rejection is insufficient. A
// v-if dropped during a refactor, negated accidentally, or typo'd to the
// wrong cap name would pass every other test and ship silently.
//
// These tests mount the real view component with a stubbed Pinia auth
// store, flip the capability true/false, and assert the gated buttons
// render iff the capability is granted (or absent — the views treat
// `undefined` as permitted, only explicit `false` blocks).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

// Stub the API client so view onMount data loads resolve without hitting
// the network. Returning empty arrays keeps the views in their
// "no-data" render path — the gated top-level buttons are outside the
// table body and still render.
// Response shapes match the real client: each list endpoint returns a
// typed envelope ({ tenants: [] }, { keys: [] }, etc). Returning bare
// arrays causes `res.<field>` to be undefined and triggers downstream
// reactive explosions in computed iterators.
vi.mock('../api/client', () => ({
  listTenants: vi.fn().mockResolvedValue({ tenants: [] }),
  listApiKeys: vi.fn().mockResolvedValue({ keys: [] }),
  listWebhooks: vi.fn().mockResolvedValue({ subscriptions: [] }),
  listBudgets: vi.fn().mockResolvedValue({ ledgers: [], has_more: false }),
  listReservations: vi.fn().mockResolvedValue({ reservations: [] }),
  getWebhookSecurityConfig: vi.fn().mockResolvedValue({}),
  ApiError: class ApiError extends Error {},
}))

// vue-router: views use useRouter() for navigation + <RouterLink> in
// templates. Stub both so mount() doesn't require a real router install.
vi.mock('vue-router', async () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useRoute: () => ({ query: {}, params: {} }),
  RouterLink: { template: '<a><slot /></a>' },
}))

// usePolling schedules intervals; we don't want them in unit tests.
vi.mock('../composables/usePolling', () => ({
  usePolling: (fn: () => Promise<void> | void) => {
    // Kick once so the view's initial data load runs; return the shape
    // the views destructure ({ refresh, isLoading, lastUpdated }).
    void fn()
    return {
      refresh: async () => { void fn() },
      isLoading: { value: false },
      lastUpdated: { value: null },
    }
  },
}))

const FULL_CAPS: Capabilities = {
  view_overview: true,
  view_budgets: true,
  view_events: true,
  view_webhooks: true,
  view_audit: true,
  view_tenants: true,
  view_api_keys: true,
  view_policies: true,
  manage_budgets: true,
  manage_tenants: true,
  manage_api_keys: true,
  manage_webhooks: true,
  manage_policies: true,
  manage_reservations: true,
}

function setCaps(overrides: Partial<Capabilities>) {
  const auth = useAuthStore()
  auth.apiKey = 'test-key'
  auth.capabilities = { ...FULL_CAPS, ...overrides }
}

const globalStubs = {
  RouterLink: { template: '<a><slot /></a>' },
  RouterView: { template: '<div><slot /></div>' },
}

async function mountView(Component: unknown) {
  const wrapper = mount(Component as never, { global: { stubs: globalStubs } })
  await flushPromises()
  return wrapper
}

describe('capability-gated UI visibility', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // ─── TenantsView: manage_tenants → Create Tenant button ──────────────
  describe('TenantsView + manage_tenants', () => {
    it('renders Create Tenant button when manage_tenants=true', async () => {
      setCaps({ manage_tenants: true })
      const { default: TenantsView } = await import('../views/TenantsView.vue')
      const w = await mountView(TenantsView)
      expect(w.text()).toContain('Create Tenant')
    })

    it('hides Create Tenant button when manage_tenants=false', async () => {
      setCaps({ manage_tenants: false })
      const { default: TenantsView } = await import('../views/TenantsView.vue')
      const w = await mountView(TenantsView)
      // "Create Tenant" appears only inside the gated button — if the
      // v-if drops, this assertion catches it.
      const createBtn = w.findAll('button').find(b => b.text() === 'Create Tenant')
      expect(createBtn).toBeUndefined()
    })
  })

  // ─── ApiKeysView: manage_api_keys → Create API Key button ────────────
  describe('ApiKeysView + manage_api_keys', () => {
    it('renders Create API Key button when manage_api_keys=true', async () => {
      setCaps({ manage_api_keys: true })
      const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
      const w = await mountView(ApiKeysView)
      expect(w.text()).toContain('Create API Key')
    })

    it('hides Create API Key button when manage_api_keys=false', async () => {
      setCaps({ manage_api_keys: false })
      const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
      const w = await mountView(ApiKeysView)
      const createBtn = w.findAll('button').find(b => b.text() === 'Create API Key')
      expect(createBtn).toBeUndefined()
    })
  })

  // ─── WebhooksView: manage_webhooks → Create Webhook + Security ───────
  describe('WebhooksView + manage_webhooks', () => {
    it('renders Create Webhook and Security Config when manage_webhooks=true', async () => {
      setCaps({ manage_webhooks: true })
      const { default: WebhooksView } = await import('../views/WebhooksView.vue')
      const w = await mountView(WebhooksView)
      expect(w.text()).toContain('Create Webhook')
      expect(w.text()).toContain('Security Config')
    })

    it('hides Create Webhook and Security Config when manage_webhooks=false', async () => {
      setCaps({ manage_webhooks: false })
      const { default: WebhooksView } = await import('../views/WebhooksView.vue')
      const w = await mountView(WebhooksView)
      expect(w.findAll('button').find(b => b.text() === 'Create Webhook')).toBeUndefined()
      expect(w.findAll('button').find(b => b.text() === 'Security Config')).toBeUndefined()
    })
  })

  // ─── ReservationsView: manage_reservations → action column header ────
  // The Force Release button lives inside a reservation row conditional
  // on data. With empty data we can't exercise the row — but the action
  // column header is also gated, so its presence is the proxy signal.
  // Post-V1 virtualization (phase 2b), this view renders as an ARIA grid
  // of <div>s rather than a <table>; the selector is data-column="action"
  // on the role="columnheader" div.
  describe('ReservationsView + manage_reservations', () => {
    it('renders action column header when manage_reservations=true', async () => {
      setCaps({ manage_reservations: true })
      const { default: ReservationsView } = await import('../views/ReservationsView.vue')
      const w = await mountView(ReservationsView)
      expect(w.find('[data-column="action"]').exists()).toBe(true)
    })

    it('hides action column header when manage_reservations=false', async () => {
      setCaps({ manage_reservations: false })
      const { default: ReservationsView } = await import('../views/ReservationsView.vue')
      const w = await mountView(ReservationsView)
      expect(w.find('[data-column="action"]').exists()).toBe(false)
    })
  })

  // ─── BudgetsView: manage_budgets → action column header ──────────────
  // Same rationale as ReservationsView — Freeze/Unfreeze/Edit live in
  // the detail panel which only renders after a scope is selected. The
  // action columnheader is the clean proxy for the gated UI surface.
  // Post-V1 virtualization (phase 2b), BudgetsView renders as an ARIA
  // grid like ReservationsView; data-column="action" replaces the
  // old `th.w-20` selector.
  describe('BudgetsView + manage_budgets', () => {
    it('renders action column header when manage_budgets=true', async () => {
      setCaps({ manage_budgets: true })
      const { default: BudgetsView } = await import('../views/BudgetsView.vue')
      const w = await mountView(BudgetsView)
      expect(w.find('[data-column="action"]').exists()).toBe(true)
    })

    it('hides action column header when manage_budgets=false', async () => {
      setCaps({ manage_budgets: false })
      const { default: BudgetsView } = await import('../views/BudgetsView.vue')
      const w = await mountView(BudgetsView)
      expect(w.find('[data-column="action"]').exists()).toBe(false)
    })
  })

  // ─── `undefined` capability is permissive by design ──────────────────
  // The `!== false` guard pattern means a capability the server doesn't
  // surface yet (e.g. a new flag during a rolling deploy) defaults to
  // "permitted". Locking this in prevents someone "fixing" the guard to
  // `=== true` and silently breaking deploys mid-rollout.
  it('treats undefined capability as permitted (not explicitly false)', async () => {
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = { ...FULL_CAPS, manage_tenants: undefined }
    const { default: TenantsView } = await import('../views/TenantsView.vue')
    const w = await mountView(TenantsView)
    expect(w.text()).toContain('Create Tenant')
  })
})

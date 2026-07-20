// Spec catch-up 0.1.25.39/.40/.41 — WebhookDetailView edit dialog:
//
// 1. SELECTOR CLEARING (rev .39, WebhookUpdateRequest lines 2781-2813):
//    an update MAY set event_types to [] to convert the subscription to
//    category-only, provided event_categories is non-empty. Pre-fix the
//    edit form rejected every save with empty event_types. Both-empty
//    is still rejected (SUBSCRIPTION SELECTOR INVARIANT) with the
//    updated copy. The PATCH must carry event_types: [] explicitly —
//    the spec distinguishes empty-array (clear) from omitted (keep).
//
// 2. TENANT-OWNED CATEGORY BOUNDARY (revs .38/.40/.41, update op lines
//    6560-6574): tenant-owned subscriptions (concrete tenant_id !=
//    "__system__") may only select budget.* / reservation.* / tenant.*
//    selectors. The edit pickers filter to the tenant-allowed sets and
//    legacy admin-only selections are stripped from both form snapshots
//    (no phantom diff on an untouched save). A deliberate selector edit
//    on a row where stripping hid anything sends BOTH cleaned arrays —
//    explicit [] clears included — so the hidden legacy selectors are
//    removed server-side (F1), not silently kept.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { h as actualH, defineComponent } from 'vue'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities, WebhookSubscription } from '../types'

const getWebhookMock = vi.fn()
const listDeliveriesMock = vi.fn()
const updateWebhookMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    getWebhook: (...args: unknown[]) => getWebhookMock(...args),
    listDeliveries: (...args: unknown[]) => listDeliveriesMock(...args),
    updateWebhook: (...args: unknown[]) => updateWebhookMock(...args),
  }
})

// ?action=edit auto-opens the edit dialog after the first successful
// fetch — saves clicking through the kebab menu in every test.
const routeRef: { query: Record<string, string>; params: Record<string, string> } = {
  query: { action: 'edit' },
  params: { id: 'wh-1' },
}

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
    useRoute: () => routeRef,
    RouterLink: { props: ['to'], template: '<a><slot /></a>' },
  }
})

vi.mock('../composables/usePolling', async () => {
  const vue = await vi.importActual<typeof import('vue')>('vue')
  return {
    usePolling: (fn: (signal: AbortSignal) => Promise<void> | void) => {
      const run = () => fn(new AbortController().signal)
      void run()
      return { refresh: async () => { void run() }, isLoading: vue.ref(false), lastSuccessAt: vue.ref(null) }
    },
  }
})

const FULL_CAPS: Capabilities = {
  view_overview: true, view_budgets: true, view_events: true,
  view_webhooks: true, view_audit: true, view_tenants: true,
  view_api_keys: true, view_policies: true,
  manage_webhooks: true,
}

function subscription(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    subscription_id: 'wh-1',
    tenant_id: '__system__',
    url: 'https://example/hook',
    name: 'Test Hook',
    event_types: ['budget.created'],
    event_categories: ['budget'],
    status: 'ACTIVE',
    created_at: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

async function mountView() {
  const { default: WebhookDetailView } = await import('../views/WebhookDetailView.vue')
  const w = mount(WebhookDetailView, {
    global: {
      stubs: {
        RouterLink: defineComponent({
          props: { to: { type: null, required: false, default: null } },
          inheritAttrs: false,
          setup(_p, { slots, attrs }) { return () => actualH('a', { ...attrs }, slots.default?.()) },
        }),
      },
    },
  })
  await flushPromises()
  return w
}

type Mounted = Awaited<ReturnType<typeof mountView>>

function eventTypeCheckbox(w: Mounted, value: string): DOMWrapper<Element> | undefined {
  return w.findAll('input[type="checkbox"]').find(
    i => (i.element as HTMLInputElement).value === value,
  )
}

async function submitEditForm(w: Mounted) {
  await w.find('form').trigger('submit')
  await flushPromises()
}

describe('WebhookDetailView — selector clearing (spec rev 0.1.25.39)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'k'
    auth.capabilities = FULL_CAPS
    getWebhookMock.mockReset()
    listDeliveriesMock.mockReset()
    updateWebhookMock.mockReset()
    listDeliveriesMock.mockResolvedValue({ deliveries: [], has_more: false })
    // PATCH returns the authoritative subscription. The editor publishes this
    // response directly instead of issuing a fallible settlement GET.
    updateWebhookMock.mockResolvedValue(subscription())
    routeRef.query = { action: 'edit' }
    document.body.innerHTML = ''
  })

  it('allows clearing event_types when event_categories is non-empty and sends event_types: [] explicitly', async () => {
    getWebhookMock.mockResolvedValue(subscription({ event_types: ['budget.created'], event_categories: ['budget'] }))
    const w = await mountView()

    const cb = eventTypeCheckbox(w, 'budget.created')
    expect(cb).toBeDefined()
    await cb!.setValue(false)
    await submitEditForm(w)

    expect(updateWebhookMock).toHaveBeenCalledTimes(1)
    const [id, body] = updateWebhookMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe('wh-1')
    // Empty array MUST be present (clear), not omitted (keep).
    expect(body.event_types).toEqual([])
    // Categories untouched → diff omits them (server keeps stored value).
    expect('event_categories' in body).toBe(false)
    // Initial acquisition only: the authoritative PATCH response settles the
    // editor without a second GET that could falsely fail after commit.
    expect(getWebhookMock).toHaveBeenCalledTimes(1)
    expect(w.text()).not.toContain('Select at least one event type')
  })

  it('rejects a save that would leave BOTH event_types and event_categories empty', async () => {
    getWebhookMock.mockResolvedValue(subscription({ event_types: ['budget.created'], event_categories: [] }))
    const w = await mountView()

    await eventTypeCheckbox(w, 'budget.created')!.setValue(false)
    await submitEditForm(w)

    expect(updateWebhookMock).not.toHaveBeenCalled()
    expect(w.text()).toContain('Select at least one event type or category.')
  })
})

describe('WebhookDetailView — tenant-owned selector gating (spec revs .38/.40/.41)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'k'
    auth.capabilities = FULL_CAPS
    getWebhookMock.mockReset()
    listDeliveriesMock.mockReset()
    updateWebhookMock.mockReset()
    listDeliveriesMock.mockResolvedValue({ deliveries: [], has_more: false })
    updateWebhookMock.mockResolvedValue(subscription())
    routeRef.query = { action: 'edit' }
    document.body.innerHTML = ''
  })

  it('tenant-owned subscription: edit pickers offer only tenant-scoped selectors + hint', async () => {
    getWebhookMock.mockResolvedValue(subscription({ tenant_id: 'acme' }))
    const w = await mountView()

    // Tenant-scoped type offered, admin-only types not.
    expect(eventTypeCheckbox(w, 'budget.created')).toBeDefined()
    expect(eventTypeCheckbox(w, 'reservation.expired')).toBeDefined()
    expect(eventTypeCheckbox(w, 'api_key.created')).toBeUndefined()
    expect(eventTypeCheckbox(w, 'webhook.created')).toBeUndefined()
    expect(eventTypeCheckbox(w, 'system.high_latency')).toBeUndefined()
    // Category picker: budget/reservation/tenant only.
    expect(eventTypeCheckbox(w, 'tenant')).toBeDefined()
    expect(eventTypeCheckbox(w, 'policy')).toBeUndefined()
    expect(eventTypeCheckbox(w, 'system')).toBeUndefined()
    expect(w.text()).toContain('Tenant-owned subscriptions can only receive tenant-scoped events')
  })

  it('system-owned subscription (__system__): full selector lists, no hint', async () => {
    getWebhookMock.mockResolvedValue(subscription({ tenant_id: '__system__' }))
    const w = await mountView()

    expect(eventTypeCheckbox(w, 'api_key.created')).toBeDefined()
    expect(eventTypeCheckbox(w, 'system.high_latency')).toBeDefined()
    expect(eventTypeCheckbox(w, 'policy')).toBeDefined()
    expect(w.text()).not.toContain('Tenant-owned subscriptions can only receive tenant-scoped events')
  })

  it('legacy admin-only selections on a tenant-owned row are stripped without a phantom diff', async () => {
    // Row persisted before servers enforced the boundary (.40).
    getWebhookMock.mockResolvedValue(subscription({
      tenant_id: 'acme',
      event_types: ['budget.created', 'api_key.created'],
      event_categories: ['budget', 'system'],
    }))
    const w = await mountView()

    // Untouched save → stripped values must NOT produce an event_types /
    // event_categories diff; the dialog reports no changes instead.
    await submitEditForm(w)
    expect(updateWebhookMock).not.toHaveBeenCalled()
    expect(w.text()).toContain('No changes to save')
  })

  it('a deliberate selector edit on a tenant-owned row sends the cleaned array (heals legacy rows)', async () => {
    getWebhookMock.mockResolvedValue(subscription({
      tenant_id: 'acme',
      event_types: ['budget.created', 'api_key.created'],
      event_categories: ['budget'],
    }))
    const w = await mountView()

    await eventTypeCheckbox(w, 'budget.updated')!.setValue(true)
    await submitEditForm(w)

    expect(updateWebhookMock).toHaveBeenCalledTimes(1)
    const body = updateWebhookMock.mock.calls[0][1] as Record<string, unknown>
    // api_key.created stripped; the checked type appended.
    expect(body.event_types).toEqual(['budget.created', 'budget.updated'])
  })

  // F1 — a legacy tenant-owned row whose ONLY selectors are admin-only
  // strips to an all-empty picker. The both-empty invariant must not
  // block a save that doesn't touch the selectors (the PATCH omits the
  // selector fields, so the server keeps the stored values) — pre-fix
  // EVERY save on such a row was rejected, making it un-editable.
  it('legacy row with only admin-only selectors: a rename-only edit saves without selector fields', async () => {
    getWebhookMock.mockResolvedValue(subscription({
      tenant_id: 'acme',
      event_types: ['api_key.created'],
      event_categories: ['system'],
    }))
    const w = await mountView()

    await w.find('#ew-name').setValue('renamed hook')
    await submitEditForm(w)

    expect(w.text()).not.toContain('Select at least one event type or category.')
    expect(updateWebhookMock).toHaveBeenCalledTimes(1)
    const body = updateWebhookMock.mock.calls[0][1] as Record<string, unknown>
    expect(body.name).toBe('renamed hook')
    // Selector fields omitted — the stored (legacy) selectors stay active.
    expect('event_types' in body).toBe(false)
    expect('event_categories' in body).toBe(false)
  })

  // F1 — the legacy-clear path. A category-only edit on a legacy row
  // used to omit event_types (stripped-empty diffed equal against the
  // stripped-empty baseline), so the hidden admin-only types survived
  // the "selector edit" and kept delivering admin telemetry to the
  // tenant endpoint. Any deliberate selector edit on a row with hidden
  // legacy selectors must now send BOTH cleaned arrays — including the
  // spec's explicit `event_types: []` clear for a stripped-empty field.
  it('category-only edit on a legacy row sends event_types: [] explicitly (clears hidden legacy types)', async () => {
    getWebhookMock.mockResolvedValue(subscription({
      tenant_id: 'acme',
      event_types: ['api_key.created'],   // admin-only → stripped to empty
      event_categories: ['budget'],
    }))
    const w = await mountView()

    // Operator only touches the CATEGORY picker.
    await eventTypeCheckbox(w, 'tenant')!.setValue(true)
    await submitEditForm(w)

    expect(updateWebhookMock).toHaveBeenCalledTimes(1)
    const body = updateWebhookMock.mock.calls[0][1] as Record<string, unknown>
    // The untouched (stripped-empty) types field is NOT omitted — the
    // spec distinguishes [] (clear) from omitted (keep), and only the
    // explicit [] removes the legacy types server-side.
    expect(body.event_types).toEqual([])
    expect(body.event_categories).toEqual(['budget', 'tenant'])
  })

  it('type-only edit on a legacy row also sends the cleaned categories explicitly', async () => {
    getWebhookMock.mockResolvedValue(subscription({
      tenant_id: 'acme',
      event_types: ['budget.created'],
      event_categories: ['system'],       // admin-only → stripped to empty
    }))
    const w = await mountView()

    await eventTypeCheckbox(w, 'budget.updated')!.setValue(true)
    await submitEditForm(w)

    expect(updateWebhookMock).toHaveBeenCalledTimes(1)
    const body = updateWebhookMock.mock.calls[0][1] as Record<string, unknown>
    expect(body.event_types).toEqual(['budget.created', 'budget.updated'])
    // Stripped-empty categories go out as the explicit clear.
    expect(body.event_categories).toEqual([])
  })

  it('legacy row: DELIBERATELY emptying the remaining selectors is still rejected', async () => {
    getWebhookMock.mockResolvedValue(subscription({
      tenant_id: 'acme',
      event_types: ['budget.created', 'api_key.created'],
      event_categories: [],
    }))
    const w = await mountView()

    // Stripping left only budget.created; unchecking it is a real
    // selector edit that would clear both selectors → invariant applies.
    await eventTypeCheckbox(w, 'budget.created')!.setValue(false)
    await submitEditForm(w)

    expect(updateWebhookMock).not.toHaveBeenCalled()
    expect(w.text()).toContain('Select at least one event type or category.')
  })

  it('edit dialog hints how many legacy admin-only selectors are hidden', async () => {
    getWebhookMock.mockResolvedValue(subscription({
      tenant_id: 'acme',
      event_types: ['api_key.created'],
      event_categories: ['system'],
    }))
    const w = await mountView()

    const hint = w.find('[data-testid="hidden-legacy-selectors-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('2 legacy admin-only selectors are hidden')
    // F1: the hint states the full contract — hidden legacy selectors
    // stay active until a selector edit, which clears them.
    expect(hint.text()).toContain('remain active until you edit the selectors, at which point they are cleared')
  })

  it('no hidden-selector hint when nothing was stripped', async () => {
    getWebhookMock.mockResolvedValue(subscription({
      tenant_id: 'acme',
      event_types: ['budget.created'],
      event_categories: ['budget'],
    }))
    const w = await mountView()

    expect(w.find('[data-testid="hidden-legacy-selectors-hint"]').exists()).toBe(false)
  })
})

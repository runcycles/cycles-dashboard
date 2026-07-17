// Spec catch-up 0.1.25.38/.40/.41 — WebhooksView create form:
// TENANT-OWNED CATEGORY BOUNDARY (createWebhookSubscription lines
// 6281-6318). When the create form targets a concrete tenant, servers at
// .40+ reject admin-only event types (api_key.* / policy.* / webhook.* /
// system.*) with 400 INVALID_REQUEST. The picker must filter to the
// tenant-allowed set (budget.* / reservation.* / tenant.*), deselect any
// already-checked now-disallowed types, and show a hint.
//
// Also covers WCAG 1.4.1 on the list's health dot: the color-only dot
// must carry an sr-only text label (healthLabel), not just a title.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities, WebhookSubscription } from '../types'

const listWebhooksMock = vi.fn()
const listTenantsMock = vi.fn()
const createWebhookMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listWebhooks: (...args: unknown[]) => listWebhooksMock(...args),
    listTenants: (...args: unknown[]) => listTenantsMock(...args),
    createWebhook: (...args: unknown[]) => createWebhookMock(...args),
  }
})

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useRoute: () => ({ query: {}, params: {} }),
    RouterLink: { template: '<a><slot /></a>' },
  }
})

vi.mock('../composables/usePolling', async () => {
  const { createPollingMock } = await import('./helpers/createPollingMock')
  return { usePolling: createPollingMock }
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

function subscription(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    subscription_id: 'wh-1',
    tenant_id: '__system__',
    url: 'https://example/hook',
    event_types: ['budget.created'],
    status: 'ACTIVE',
    created_at: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

async function mountView() {
  const { default: WebhooksView } = await import('../views/WebhooksView.vue')
  const w = mount(WebhooksView, {
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, Teleport: true } },
  })
  await flushPromises()
  return w
}

type Mounted = Awaited<ReturnType<typeof mountView>>

async function openCreateDialog(w: Mounted) {
  const btn = w.findAll('button').find(b => b.text() === 'Create Webhook')
  expect(btn).toBeDefined()
  await btn!.trigger('click')
  await flushPromises()
}

function eventTypeCheckbox(w: Mounted, value: string): DOMWrapper<Element> | undefined {
  return w.findAll('input[type="checkbox"]').find(
    i => (i.element as HTMLInputElement).value === value,
  )
}

const HINT = 'Tenant-owned subscriptions can only receive tenant-scoped events'

describe('WebhooksView — tenant-owned event-type gating (create form)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listWebhooksMock.mockReset()
    listTenantsMock.mockReset()
    createWebhookMock.mockReset()
    listWebhooksMock.mockResolvedValue({ subscriptions: [], has_more: false })
    listTenantsMock.mockResolvedValue({
      tenants: [{ tenant_id: 't1', name: 'Tenant One', status: 'ACTIVE', created_at: '2026-01-01T00:00:00Z' }],
      has_more: false,
    })
  })

  it('system-wide (no tenant): offers the full EVENT_TYPES list, no hint', async () => {
    const w = await mountView()
    await openCreateDialog(w)

    expect(eventTypeCheckbox(w, 'budget.created')).toBeDefined()
    expect(eventTypeCheckbox(w, 'api_key.created')).toBeDefined()
    expect(eventTypeCheckbox(w, 'system.high_latency')).toBeDefined()
    expect(w.text()).not.toContain(HINT)
  })

  it('selecting a tenant filters the picker to tenant-scoped types and shows the hint', async () => {
    const w = await mountView()
    await openCreateDialog(w)

    await w.get('#cw-tenant').setValue('t1')
    await flushPromises()

    expect(eventTypeCheckbox(w, 'budget.created')).toBeDefined()
    expect(eventTypeCheckbox(w, 'reservation.expired')).toBeDefined()
    expect(eventTypeCheckbox(w, 'tenant.closed')).toBeDefined()
    expect(eventTypeCheckbox(w, 'api_key.created')).toBeUndefined()
    expect(eventTypeCheckbox(w, 'policy.created')).toBeUndefined()
    expect(eventTypeCheckbox(w, 'webhook.created')).toBeUndefined()
    expect(eventTypeCheckbox(w, 'system.high_latency')).toBeUndefined()
    expect(w.text()).toContain(HINT)
  })

  it('deselects already-checked admin-only types when a tenant is picked', async () => {
    const w = await mountView()
    await openCreateDialog(w)

    await eventTypeCheckbox(w, 'api_key.created')!.setValue(true)
    await eventTypeCheckbox(w, 'budget.created')!.setValue(true)
    await w.get('#cw-tenant').setValue('t1')
    await flushPromises()

    // Back to system-wide: the full list re-appears, but the disallowed
    // selection must have been dropped (not silently retained while its
    // checkbox was hidden).
    await w.get('#cw-tenant').setValue('')
    await flushPromises()
    expect((eventTypeCheckbox(w, 'api_key.created')!.element as HTMLInputElement).checked).toBe(false)
    expect((eventTypeCheckbox(w, 'budget.created')!.element as HTMLInputElement).checked).toBe(true)
  })
})

describe('WebhooksView — health dot accessibility (WCAG 1.4.1)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listWebhooksMock.mockReset()
    listTenantsMock.mockReset()
    listTenantsMock.mockResolvedValue({ tenants: [], has_more: false })
  })

  it('pairs the color-only health dot with sr-only text carrying the health label', async () => {
    listWebhooksMock.mockResolvedValue({
      subscriptions: [
        subscription({ subscription_id: 'wh-ok', status: 'ACTIVE', consecutive_failures: 0 }),
        subscription({ subscription_id: 'wh-bad', url: 'https://example/bad', status: 'DISABLED', consecutive_failures: 12 }),
      ],
      has_more: false,
    })
    const w = await mountView()
    // DISABLED rows are hidden by default (terminal-aware list) — flip
    // the toggle so both rows render.
    const showToggle = w.findAll('input[type="checkbox"]').find(
      i => i.attributes('aria-label')?.startsWith('Show disabled'),
    )
    if (showToggle) await showToggle.setValue(true)
    await flushPromises()

    const srLabels = w.findAll('.sr-only').map(s => s.text())
    expect(srLabels).toContain('Healthy')
    expect(srLabels).toContain('Disabled')
    // The dot itself stays decorative.
    const dot = w.find('span[title="Healthy"]')
    expect(dot.exists()).toBe(true)
    expect(dot.attributes('aria-hidden')).toBe('true')
  })
})

// H6: replay-events form live validation + inline error placement.
// Pre-fix the max_events field shoved NaN / 0 / negative values at
// the server because the only check was a submit-time Record<any>
// that didn't narrow. Now: live `replayMaxEventsError` renders
// inline with the field, Submit is disabled while invalid, and the
// body is typed as `ReplayEventsRequest` end-to-end.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { h as actualH, defineComponent, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

const getWebhookMock = vi.fn()
const listDeliveriesMock = vi.fn()
const replayWebhookEventsMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    getWebhook: (...args: unknown[]) => getWebhookMock(...args),
    listDeliveries: (...args: unknown[]) => listDeliveriesMock(...args),
    replayWebhookEvents: (...args: unknown[]) => replayWebhookEventsMock(...args),
  }
})

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
    useRoute: () => ({ query: {}, params: { id: 'wh-1' } }),
    RouterLink: { props: ['to'], template: '<a><slot /></a>' },
  }
})

vi.mock('../composables/usePolling', async () => {
  const vue = await vi.importActual<typeof import('vue')>('vue')
  return {
    usePolling: (fn: () => Promise<void> | void) => {
      void fn()
      return { refresh: async () => { void fn() }, isLoading: vue.ref(false), lastSuccessAt: vue.ref(null) }
    },
  }
})

const FULL_CAPS: Capabilities = {
  view_overview: true, view_budgets: true, view_events: true,
  view_webhooks: true, view_audit: true, view_tenants: true,
  view_api_keys: true, view_policies: true,
  manage_webhooks: true,
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

async function openReplayDialog(w: Awaited<ReturnType<typeof mountView>>) {
  // Open the kebab menu, then click "Replay".
  const kebab = w.findAll('button').find(b => b.attributes('aria-haspopup') === 'menu')
  if (kebab) await kebab.trigger('click')
  await flushPromises()
  const replayItem = Array.from(document.querySelectorAll('[role="menuitem"]'))
    .find(el => el.textContent?.trim() === 'Replay') as HTMLElement | undefined
  if (replayItem) replayItem.click()
  await flushPromises()
  await nextTick()
}

describe('WebhookDetailView — replay form validation (H6)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'k'
    auth.capabilities = FULL_CAPS
    getWebhookMock.mockResolvedValue({
      subscription_id: 'wh-1',
      tenant_id: 'acme',
      url: 'https://example/hook',
      name: 'Test Hook',
      event_types: ['budget.reserved'],
      status: 'ACTIVE',
      created_at: '2026-04-01T00:00:00Z',
    })
    listDeliveriesMock.mockResolvedValue({ deliveries: [], has_more: false })
    replayWebhookEventsMock.mockReset()
    document.body.innerHTML = ''
  })

  it('renders no inline error when the field is at its default valid value', async () => {
    const w = await mountView()
    await openReplayDialog(w)
    expect(w.find('#rp-max-error').exists()).toBe(false)
  })

  it('renders inline error when max_events is 0', async () => {
    const w = await mountView()
    await openReplayDialog(w)
    await w.get('#rp-max').setValue('0')
    await flushPromises()
    const err = w.find('#rp-max-error')
    expect(err.exists()).toBe(true)
    expect(err.attributes('role')).toBe('alert')
    expect(err.text()).toMatch(/positive number/)
  })

  it('renders inline error for negative max_events', async () => {
    const w = await mountView()
    await openReplayDialog(w)
    await w.get('#rp-max').setValue('-5')
    await flushPromises()
    expect(w.find('#rp-max-error').text()).toMatch(/positive number/)
  })

  it('renders a different error when max_events exceeds 1000', async () => {
    const w = await mountView()
    await openReplayDialog(w)
    await w.get('#rp-max').setValue('1001')
    await flushPromises()
    expect(w.find('#rp-max-error').text()).toMatch(/1000 or fewer/)
  })

  it('disables Submit while invalid, re-enables when valid', async () => {
    const w = await mountView()
    await openReplayDialog(w)
    await w.get('#rp-max').setValue('0')
    await flushPromises()
    const submit = w.findAll('button[type="submit"]').find(b => b.text().includes('Start Replay'))
    expect(submit?.attributes('disabled')).toBeDefined()

    await w.get('#rp-max').setValue('50')
    await flushPromises()
    expect(submit?.attributes('disabled')).toBeUndefined()
  })

  it('does NOT call replayWebhookEvents when max_events is invalid on submit', async () => {
    const w = await mountView()
    await openReplayDialog(w)
    await w.get('#rp-max').setValue('0')
    await flushPromises()
    // Fire form submit via Enter on the input (keyboard path — bypasses
    // the disabled-Submit-button guard).
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(replayWebhookEventsMock).not.toHaveBeenCalled()
  })

  it('sets aria-invalid on the input while invalid', async () => {
    // Using '0' rather than 'abc' because <input type="number"> rejects
    // non-numeric input at the DOM level — setValue('abc') leaves the
    // v-model unchanged so the computed sees the default '100'.
    const w = await mountView()
    await openReplayDialog(w)
    await w.get('#rp-max').setValue('0')
    await flushPromises()
    expect(w.get('#rp-max').attributes('aria-invalid')).toBe('true')
  })
})

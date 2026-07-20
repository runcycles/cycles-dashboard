import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h as actualH, nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
    usePolling: (fn: (signal: AbortSignal) => Promise<void> | void) => {
      const run = () => fn(new AbortController().signal)
      void run()
      return {
        refresh: async () => { await run() },
        isLoading: vue.ref(false),
        lastSuccessAt: vue.ref(null),
      }
    },
  }
})

const FULL_CAPS: Capabilities = {
  view_overview: true,
  view_budgets: true,
  view_events: true,
  view_webhooks: true,
  view_audit: true,
  view_tenants: true,
  view_api_keys: true,
  view_policies: true,
  manage_webhooks: true,
}

function subscription(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    subscription_id: 'wh-1',
    tenant_id: 'acme',
    name: 'Payments hook',
    url: 'https://example.test/hook',
    event_types: ['budget.updated'],
    status: 'ACTIVE',
    created_at: '2026-07-20T00:00:00Z',
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

async function mountView() {
  const { default: WebhookDetailView } = await import('../views/WebhookDetailView.vue')
  const wrapper = mount(WebhookDetailView, {
    global: {
      stubs: {
        RouterLink: defineComponent({
          props: { to: { type: null, required: false, default: null } },
          inheritAttrs: false,
          setup(_props, { slots, attrs }) {
            return () => actualH('a', { ...attrs }, slots.default?.())
          },
        }),
      },
    },
  })
  await flushPromises()
  return wrapper
}

async function clickWebhookAction(
  wrapper: Awaited<ReturnType<typeof mountView>>,
  label: string,
) {
  const menu = wrapper.findAll('button').find(button => (
    button.attributes('aria-label') === 'More webhook actions'
  ))
  expect(menu).toBeDefined()
  await menu!.trigger('click')
  await nextTick()
  const item = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .find(element => element.textContent?.trim() === label)
  expect(item).toBeDefined()
  item!.click()
  await nextTick()
}

describe('WebhookDetailView — operation ownership', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'key'
    auth.capabilities = FULL_CAPS
    getWebhookMock.mockReset().mockResolvedValue(subscription())
    listDeliveriesMock.mockReset().mockResolvedValue({ deliveries: [], has_more: false })
    updateWebhookMock.mockReset()
    document.body.innerHTML = ''
  })

  it('keeps status confirmation busy through the PATCH and publishes its response directly', async () => {
    const patch = deferred<WebhookSubscription>()
    updateWebhookMock.mockImplementationOnce(() => patch.promise)
    const wrapper = await mountView()
    await clickWebhookAction(wrapper, 'Pause')

    const confirm = wrapper.findAll('button').find(button => button.text().includes('Pause Webhook'))
    const cancel = wrapper.findAll('button').find(button => button.text() === 'Cancel')
    expect(confirm).toBeDefined()
    await confirm!.trigger('click')
    await nextTick()

    expect(confirm!.attributes('disabled')).toBeDefined()
    expect(cancel?.attributes('disabled')).toBeDefined()
    expect(updateWebhookMock).toHaveBeenCalledTimes(1)
    expect(updateWebhookMock).toHaveBeenCalledWith('wh-1', { status: 'PAUSED' })

    patch.resolve(subscription({ status: 'PAUSED', updated_at: '2026-07-20T00:01:00Z' }))
    await flushPromises()

    expect(getWebhookMock).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('PAUSED')
    expect(wrapper.text()).not.toContain('Pause this webhook?')
  })
})

// Regression: max_reservation_extensions = 0 must be sendable on tenant
// create. The type=number v-model coerces an entered 0 to the number 0
// (falsy), so the old truthy guard dropped it — making "disable
// extensions" (0) impossible to set. The submit now uses an explicit
// blank check.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { h as actualH, defineComponent, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import { createTenant } from '../api/client'
import type { Capabilities } from '../types'

const listTenantsMock = vi.fn().mockResolvedValue({ tenants: [], has_more: false })

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listTenants: (...args: unknown[]) => listTenantsMock(...args),
    createTenant: vi.fn().mockResolvedValue({ tenant_id: 'acme-corp' }),
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
  view_api_keys: true, view_policies: true, manage_tenants: true,
}

async function mountTenants() {
  const { default: TenantsView } = await import('../views/TenantsView.vue')
  const w = mount(TenantsView, {
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

describe('TenantsView — reservation defaults on create', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'k'
    auth.capabilities = FULL_CAPS
    listTenantsMock.mockClear()
    vi.mocked(createTenant).mockClear()
  })

  it('sends max_reservation_extensions: 0 (not dropped as falsy)', async () => {
    const w = await mountTenants()
    const open = w.findAll('button').find(b => b.text().includes('Create Tenant'))
    await open!.trigger('click')
    await flushPromises()
    await nextTick()

    await w.get('input#ct-id').setValue('acme-corp')
    await w.get('input#ct-name').setValue('Acme Corp')
    await w.get('input#ct-max-ext').setValue('0')
    await flushPromises()

    await w.get('[aria-label="Create Tenant"] form').trigger('submit')
    await flushPromises()

    expect(createTenant).toHaveBeenCalledTimes(1)
    const body = vi.mocked(createTenant).mock.calls[0][0] as unknown as Record<string, unknown>
    expect(body.max_reservation_extensions).toBe(0)
  })

  it('omits max_reservation_extensions when left blank', async () => {
    const w = await mountTenants()
    const open = w.findAll('button').find(b => b.text().includes('Create Tenant'))
    await open!.trigger('click')
    await flushPromises()
    await nextTick()

    await w.get('input#ct-id').setValue('beta-corp')
    await w.get('input#ct-name').setValue('Beta Corp')
    await flushPromises()

    await w.get('[aria-label="Create Tenant"] form').trigger('submit')
    await flushPromises()

    const body = vi.mocked(createTenant).mock.calls[0][0] as unknown as Record<string, unknown>
    expect('max_reservation_extensions' in body).toBe(false)
  })
})

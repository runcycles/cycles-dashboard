// M7: TenantsView create form — live (not submit-time) validation of
// the tenant-id input. Pre-fix, operators who typed "Acme Corp" saw
// nothing wrong until they hit Submit. Now:
//   • Inline error text renders immediately for any invalid value
//   • Submit button is disabled when validation fails
//   • An empty field stays silent (no pre-typing scolding)

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { h as actualH, defineComponent, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

const listTenantsMock = vi.fn().mockResolvedValue({ tenants: [], has_more: false })

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listTenants: (...args: unknown[]) => listTenantsMock(...args),
    createTenant: vi.fn(),
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
  view_api_keys: true, view_policies: true,
  manage_tenants: true,
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

async function openCreateForm(w: Awaited<ReturnType<typeof mountTenants>>) {
  const btn = w.findAll('button').find(b => b.text().includes('Create Tenant'))
  expect(btn).toBeTruthy()
  await btn!.trigger('click')
  await flushPromises()
  await nextTick()
  const dialog = w.find('[role="dialog"][aria-label="Create Tenant"]')
  expect(dialog.exists()).toBe(true)
  return dialog
}

describe('TenantsView create-form validation (M7)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'k'
    auth.capabilities = FULL_CAPS
    listTenantsMock.mockClear()
  })

  it('shows no error text for an empty field (no pre-typing scolding)', async () => {
    const w = await mountTenants()
    await openCreateForm(w)
    expect(w.find('#ct-id-error').exists()).toBe(false)
    expect(w.find('#ct-id-hint').exists()).toBe(true)
  })

  it('shows an inline error the moment an invalid value is typed', async () => {
    const w = await mountTenants()
    await openCreateForm(w)
    const input = w.get('input#ct-id')
    await input.setValue('Acme Corp') // uppercase + space — invalid
    await flushPromises()
    const err = w.find('#ct-id-error')
    expect(err.exists()).toBe(true)
    expect(err.attributes('role')).toBe('alert')
    expect(err.text()).toMatch(/lowercase letters, numbers, and hyphens/)
    // Hint hidden while error is active.
    expect(w.find('#ct-id-hint').exists()).toBe(false)
  })

  it('flags too-short input separately from pattern violation', async () => {
    const w = await mountTenants()
    await openCreateForm(w)
    await w.get('input#ct-id').setValue('ab') // valid chars but < 3
    await flushPromises()
    expect(w.find('#ct-id-error').text()).toMatch(/at least 3 characters/)
  })

  it('disables Submit while the tenant-id is invalid', async () => {
    const w = await mountTenants()
    await openCreateForm(w)
    await w.get('input#ct-id').setValue('BAD')
    await w.get('input#ct-name').setValue('Some Name')
    await flushPromises()
    const submit = w.findAll('button[type="submit"]').find(b => b.text().includes('Create Tenant'))
    expect(submit?.attributes('disabled')).toBeDefined()
  })

  it('enables Submit once tenant-id + name are both valid', async () => {
    const w = await mountTenants()
    await openCreateForm(w)
    await w.get('input#ct-id').setValue('acme-corp')
    await w.get('input#ct-name').setValue('Acme Corp')
    await flushPromises()
    const submit = w.findAll('button[type="submit"]').find(b => b.text().includes('Create Tenant'))
    expect(submit?.attributes('disabled')).toBeUndefined()
    // And error is gone.
    expect(w.find('#ct-id-error').exists()).toBe(false)
  })

  it('aria-invalid is set on the input while the id is invalid', async () => {
    const w = await mountTenants()
    await openCreateForm(w)
    await w.get('input#ct-id').setValue('BAD')
    await flushPromises()
    expect(w.get('input#ct-id').attributes('aria-invalid')).toBe('true')
  })
})

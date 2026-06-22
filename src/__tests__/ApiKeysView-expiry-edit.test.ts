// Regression: a rename-only edit of an API key must NOT silently rewrite
// expires_at. The datetime-local picker is minute-precision, so prefilling
// a key expiring at 12:34:56Z and re-saving used to PATCH 12:34:00Z (seconds
// truncated). The submit now diffs the input against the prefilled value and
// only sends expires_at when the operator actually changed it.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import { updateApiKey } from '../api/client'
import type { Capabilities } from '../types'

const listApiKeysMock = vi.fn()
const listTenantsMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listTenants: (...a: unknown[]) => listTenantsMock(...a),
    listApiKeys: (...a: unknown[]) => listApiKeysMock(...a),
    revokeApiKey: vi.fn(),
    createApiKey: vi.fn(),
    updateApiKey: vi.fn().mockResolvedValue({}),
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

vi.mock('../composables/usePolling', () => ({
  usePolling: (fn: () => Promise<void> | void) => {
    void fn()
    return { refresh: async () => { void fn() }, isLoading: { value: false } }
  },
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

const KEY = {
  key_id: 'k1', tenant_id: 't-alpha', name: 'orig', status: 'ACTIVE',
  permissions: [] as string[], created_at: '2026-04-01T00:00:00Z',
  expires_at: '2027-01-01T12:34:56.000Z', // note the :56 seconds
}

function stdMount() {
  return { global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, Teleport: true } } }
}

async function openEditDialog(w: ReturnType<typeof mount>) {
  const kebab = w.findAll('button').find(b => (b.attributes('aria-label') || '').startsWith('Actions for API key'))
  expect(kebab, 'row kebab').toBeTruthy()
  await kebab!.trigger('click')
  const edit = w.findAll('button').find(b => b.text() === 'Edit')
  expect(edit, 'Edit menu item').toBeTruthy()
  await edit!.trigger('click')
  await flushPromises()
}

describe('ApiKeysView — edit does not silently rewrite expiry', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS
    listApiKeysMock.mockReset()
    listTenantsMock.mockReset()
    vi.mocked(updateApiKey).mockClear()
    listTenantsMock.mockResolvedValue({ tenants: [{ tenant_id: 't-alpha', name: 'Alpha', status: 'ACTIVE', created_at: '2026-04-01T00:00:00Z' }] })
    listApiKeysMock.mockResolvedValue({ keys: [KEY], has_more: false })
  })

  it('rename-only save omits expires_at (no second-truncation)', async () => {
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = mount(ApiKeysView, stdMount())
    await flushPromises(); await flushPromises()

    await openEditDialog(w)
    await w.find('#ek-name').setValue('renamed')
    await w.get('[aria-label="Edit API Key"] form').trigger('submit')
    await flushPromises()

    expect(updateApiKey).toHaveBeenCalledTimes(1)
    const body = vi.mocked(updateApiKey).mock.calls[0][1] as Record<string, unknown>
    expect(body.name).toBe('renamed')
    expect('expires_at' in body).toBe(false)
  })

  it('sends expires_at only when the picker is actually changed', async () => {
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = mount(ApiKeysView, stdMount())
    await flushPromises(); await flushPromises()

    await openEditDialog(w)
    await w.find('#ek-expires').setValue('2028-02-02T09:00')
    await w.get('[aria-label="Edit API Key"] form').trigger('submit')
    await flushPromises()

    const body = vi.mocked(updateApiKey).mock.calls[0][1] as Record<string, unknown>
    expect(body.expires_at).toBe(new Date('2028-02-02T09:00').toISOString())
  })
})

// Immutable-on-PATCH fields must not be editable (they were silent
// no-ops — the server's request DTOs have no such fields and Jackson
// dropped them with a 200):
//   - Tenant PATCH: reservation_expiry_policy is create-only per spec
//     (additionalProperties:false). The edit dialog now shows it
//     read-only with a "set at creation" hint and never sends it.
//   - API-key PATCH: expires_at is immutable ("revoke and recreate").
//     The tenant-detail key-edit dialog mirrors ApiKeysView: read-only
//     expiry + hint, never sent.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import type { Capabilities, Tenant, ApiKey, Policy } from '../types'

const getTenantMock = vi.fn()
const listTenantsMock = vi.fn()
const listBudgetsMock = vi.fn()
const listApiKeysMock = vi.fn()
const listPoliciesMock = vi.fn()
const listWebhooksMock = vi.fn()
const updateTenantMock = vi.fn()
const updateApiKeyMock = vi.fn()

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    getTenant: (...args: unknown[]) => getTenantMock(...args),
    listTenants: (...args: unknown[]) => listTenantsMock(...args),
    listBudgets: (...args: unknown[]) => listBudgetsMock(...args),
    listApiKeys: (...args: unknown[]) => listApiKeysMock(...args),
    listPolicies: (...args: unknown[]) => listPoliciesMock(...args),
    listWebhooks: (...args: unknown[]) => listWebhooksMock(...args),
    updateTenant: (...args: unknown[]) => updateTenantMock(...args),
    updateApiKey: (...args: unknown[]) => updateApiKeyMock(...args),
  }
})

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useRoute: () => ({ query: {}, params: { id: 'acme' } }),
    RouterLink: { props: ['to'], template: '<a><slot /></a>' },
  }
})

vi.mock('../composables/usePolling', async () => {
  const { createPollingMock } = await import('./helpers/createPollingMock')
  return { usePolling: createPollingMock }
})

const FULL_CAPS: Capabilities = {
  view_overview: true, view_budgets: true, view_events: true,
  view_webhooks: true, view_audit: true, view_tenants: true,
  view_api_keys: true, view_policies: true,
  manage_budgets: true, manage_tenants: true, manage_api_keys: true,
  manage_webhooks: true, manage_policies: true, manage_reservations: true,
}

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    tenant_id: 'acme',
    name: 'Acme Corp',
    status: 'ACTIVE',
    created_at: '2026-01-01T00:00:00Z',
    reservation_expiry_policy: 'RELEASE',
    ...overrides,
  }
}

function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    key_id: 'key_1',
    tenant_id: 'acme',
    key_prefix: 'cyc_test_key_1',
    name: 'svc-key',
    status: 'ACTIVE',
    permissions: [],
    created_at: '2026-01-01T00:00:00Z',
    expires_at: '2027-01-01T12:34:56.000Z',
    ...overrides,
  }
}

async function mountView() {
  const { default: TenantDetailView } = await import('../views/TenantDetailView.vue')
  const w = mount(TenantDetailView, {
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, Teleport: true } },
  })
  await flushPromises()
  return w
}

describe('TenantDetailView — immutable fields are read-only, never PATCHed', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'test-key'
    auth.capabilities = FULL_CAPS

    getTenantMock.mockReset()
    listTenantsMock.mockReset()
    listBudgetsMock.mockReset()
    listApiKeysMock.mockReset()
    listPoliciesMock.mockReset()
    listWebhooksMock.mockReset()
    updateTenantMock.mockReset()
    updateApiKeyMock.mockReset()

    getTenantMock.mockResolvedValue(tenant())
    listTenantsMock.mockResolvedValue({ tenants: [], has_more: false })
    listBudgetsMock.mockResolvedValue({ ledgers: [], has_more: false })
    listApiKeysMock.mockResolvedValue({ keys: [apiKey()], has_more: false })
    listPoliciesMock.mockResolvedValue({ policies: [] as Policy[], has_more: false })
    listWebhooksMock.mockResolvedValue({ subscriptions: [], has_more: false })
    updateTenantMock.mockResolvedValue(tenant())
    // PATCH returns the authoritative ApiKey representation; Tenant Detail
    // publishes it before the mutation-owned refresh settles.
    updateApiKeyMock.mockResolvedValue(apiKey({ name: 'renamed-key' }))
  })

  describe('tenant edit — reservation_expiry_policy is create-only', () => {
    async function openEditTenant(w: ReturnType<typeof mount>) {
      const edit = w.findAll('button').find(b => b.text() === 'Edit')!
      expect(edit).toBeDefined()
      await edit.trigger('click')
      await flushPromises()
    }

    it('renders no expiry-policy select; shows the policy read-only with a "set at creation" hint', async () => {
      const w = await mountView()
      await openEditTenant(w)
      // Old select gone.
      expect(w.find('#et-expiry').exists()).toBe(false)
      // Read-only display shows the current policy + hint.
      const readonly = w.find('[data-testid="tenant-expiry-policy-readonly"]')
      expect(readonly.exists()).toBe(true)
      expect(readonly.text()).toContain('RELEASE')
      expect(readonly.text()).toContain('Set at creation')
    })

    it('shows "Inherit" when the tenant has no explicit expiry policy', async () => {
      getTenantMock.mockResolvedValue(tenant({ reservation_expiry_policy: undefined }))
      const w = await mountView()
      await openEditTenant(w)
      expect(w.find('[data-testid="tenant-expiry-policy-readonly"]').text()).toContain('Inherit')
    })

    it('PATCH body never carries reservation_expiry_policy', async () => {
      const w = await mountView()
      await openEditTenant(w)
      await w.find('#et-name').setValue('Acme Renamed')
      await w.find('#et-ttl').setValue('60000')
      await w.find('form').trigger('submit')
      await flushPromises()

      expect(updateTenantMock).toHaveBeenCalledTimes(1)
      const body = updateTenantMock.mock.calls[0][1] as Record<string, unknown>
      expect(body.name).toBe('Acme Renamed')
      expect(body.default_reservation_ttl_ms).toBe(60000)
      expect('reservation_expiry_policy' in body).toBe(false)
    })
  })

  describe('API-key edit — expires_at is immutable (revoke and recreate)', () => {
    async function openEditKey(w: ReturnType<typeof mount>) {
      // Switch to the API Keys tab first.
      const keysTab = w.findAll('button').find(b => b.text().startsWith('API Keys'))!
      expect(keysTab).toBeDefined()
      await keysTab.trigger('click')
      await flushPromises()
      const kebab = w.findAll('button').find(b => (b.attributes('aria-label') || '').startsWith('Actions for API key'))
      expect(kebab, 'row kebab').toBeTruthy()
      await kebab!.trigger('click')
      // The tenant header also has an "Edit" pill — the kebab's menu item
      // renders after it, so take the LAST matching button.
      const edits = w.findAll('button').filter(b => b.text() === 'Edit')
      expect(edits.length, 'Edit menu item').toBeGreaterThan(1)
      await edits[edits.length - 1].trigger('click')
      await flushPromises()
    }

    it('renders no expiry input; shows expiry read-only with the immutability hint', async () => {
      const w = await mountView()
      await openEditKey(w)
      const dialog = w.get('[aria-label="Edit API Key"]')
      expect(dialog.find('#ek2-expires').exists()).toBe(false)
      expect(dialog.find('input[type="datetime-local"]').exists()).toBe(false)
      expect(dialog.text()).toContain('Expiry is immutable — revoke and recreate the key to change it.')
    })

    it('rename save never sends expires_at', async () => {
      const w = await mountView()
      await openEditKey(w)
      await w.find('#ek2-name').setValue('renamed-key')
      await w.get('[aria-label="Edit API Key"] form').trigger('submit')
      await flushPromises()

      expect(updateApiKeyMock).toHaveBeenCalledTimes(1)
      const body = updateApiKeyMock.mock.calls[0][1] as Record<string, unknown>
      expect(body.name).toBe('renamed-key')
      expect('expires_at' in body).toBe(false)
    })
  })

  it('visibly enforces reciprocal API-key and tenant-lifecycle arming', async () => {
    const w = await mountView()
    const keysTab = w.findAll('button').find(button => button.text().startsWith('API Keys'))!
    await keysTab.trigger('click')
    await flushPromises()

    const createButton = w.findAll('button').find(button => button.text() === 'Create API Key')!
    await createButton.trigger('click')
    for (const label of ['Suspend', 'Close']) {
      const button = w.findAll('button').find(item => item.text() === label)!
      expect(button.attributes('disabled'), `${label} should be blocked by the key owner`).toBeDefined()
    }

    const cancel = w.findAll('button').find(button => button.text() === 'Cancel')!
    await cancel.trigger('click')
    const suspend = w.findAll('button').find(button => button.text() === 'Suspend')!
    await suspend.trigger('click')

    expect(w.text()).toContain('Suspend this tenant?')
    expect(createButton.attributes('disabled')).toBeDefined()
  })

  it('disables API-key creation on a permanently closed tenant', async () => {
    getTenantMock.mockResolvedValue(tenant({ status: 'CLOSED' }))
    const w = await mountView()
    const keysTab = w.findAll('button').find(button => button.text().startsWith('API Keys'))!
    await keysTab.trigger('click')
    await flushPromises()

    const createButton = w.findAll('button').find(button => button.text() === 'Create API Key')!
    expect(createButton.attributes('disabled')).toBeDefined()
    expect(createButton.attributes('title')).toBe('Closed tenants are permanently read-only')
    await createButton.trigger('click')
    expect(w.find('[aria-label="Create API Key"]').exists()).toBe(false)
  })
})

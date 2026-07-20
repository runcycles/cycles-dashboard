import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TenantApiKeyDialogs from '../components/TenantApiKeyDialogs.vue'
import type {
  TenantApiKeyCreateForm,
  TenantApiKeyEditForm,
} from '../composables/useTenantApiKeys'
import type { ApiKey, ApiKeyCreateResponse } from '../types'

function key(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    key_id: 'key-1',
    tenant_id: 'acme',
    key_prefix: 'cyc_key-1',
    name: 'Worker',
    status: 'ACTIVE',
    permissions: ['budgets:read'],
    created_at: '2026-07-20T00:00:00Z',
    expires_at: '2026-08-20T00:00:00Z',
    ...overrides,
  }
}

function createForm(): TenantApiKeyCreateForm {
  return { name: '', permissions: [], scope_filter: '', expires_at: '' }
}

function editForm(): TenantApiKeyEditForm {
  return { name: 'Worker', permissions: ['budgets:read'], scope_filter: '' }
}

function mountDialogs(overrides: Record<string, unknown> = {}) {
  return mount(TenantApiKeyDialogs, {
    props: {
      pendingRevoke: null,
      revokeLoading: false,
      revokeError: '',
      showCreate: false,
      createLoading: false,
      createError: '',
      createForm: createForm(),
      createdSecret: null,
      editingKey: null,
      editLoading: false,
      editError: '',
      editForm: editForm(),
      pendingPermissionAdds: [],
      pendingPermissionRemoves: [],
      ...overrides,
    },
  })
}

describe('TenantApiKeyDialogs', () => {
  it('edits the shared create DTO and forwards submit/cancel', async () => {
    const shared = createForm()
    const wrapper = mountDialogs({ showCreate: true, createForm: shared })

    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('Create API Key')
    expect(wrapper.get('fieldset legend').text()).toBe('Permissions')
    expect(wrapper.get('#ck2-name').attributes('maxlength')).toBe('256')
    expect(wrapper.get('#ck2-expires').classes()).toContain('form-input')
    expect(wrapper.get('[data-testid="permission-picker"]').classes()).toContain('dark:border-gray-700')
    expect(wrapper.get('[data-testid="permission-picker"] > div > label').classes()).toContain('dark:bg-gray-800')
    await wrapper.get('#ck2-name').setValue('Background worker')
    await wrapper.get('#ck2-scope').setValue('tenant:acme/*')
    await wrapper.get('form').trigger('submit')
    const cancel = wrapper.findAll('button').find(button => button.text() === 'Cancel')
    await cancel!.trigger('click')

    expect(shared.name).toBe('Background worker')
    expect(shared.scope_filter).toBe('tenant:acme/*')
    expect(wrapper.emitted('submitCreate')).toHaveLength(1)
    expect(wrapper.emitted('cancelCreate')).toHaveLength(1)
  })

  it('renders revoke errors and locks both actions while the write is in flight', () => {
    const wrapper = mountDialogs({
      pendingRevoke: key(),
      revokeLoading: true,
      revokeError: 'revoke unavailable',
    })

    expect(wrapper.get('[role="alert"]').text()).toBe('revoke unavailable')
    expect(wrapper.text()).toContain("Revoking key 'Worker'")
    expect(wrapper.findAll('button').every(button => button.attributes('disabled') !== undefined)).toBe(true)
  })

  it('renders the edit diff, immutable expiry, and forwards edit events', async () => {
    const shared = editForm()
    const wrapper = mountDialogs({
      editingKey: key(),
      editForm: shared,
      pendingPermissionAdds: ['budgets:write'],
      pendingPermissionRemoves: ['budgets:read'],
    })

    expect(wrapper.text()).toContain('+budgets:write')
    expect(wrapper.text()).toContain('−budgets:read')
    expect(wrapper.get('fieldset legend').text()).toBe('Permissions')
    expect(wrapper.text()).toContain('Expiry is immutable')
    await wrapper.get('#ek2-name').setValue('Renamed worker')
    await wrapper.get('form').trigger('submit')
    const cancel = wrapper.findAll('button').find(button => button.text() === 'Cancel')
    await cancel!.trigger('click')

    expect(shared.name).toBe('Renamed worker')
    expect(wrapper.emitted('submitEdit')).toHaveLength(1)
    expect(wrapper.emitted('cancelEdit')).toHaveLength(1)
  })

  it('preserves the one-time-secret acknowledgement before forwarding close', async () => {
    const secret: ApiKeyCreateResponse = {
      key_id: 'key-2',
      key_secret: 'secret-once',
      key_prefix: 'cyc_key-2',
      tenant_id: 'acme',
      created_at: '2026-07-20T01:00:00Z',
    }
    const wrapper = mountDialogs({ createdSecret: secret })
    const close = wrapper.findAll('button').find(button => button.text() === 'Close')!

    expect(close.attributes('disabled')).toBeDefined()
    await wrapper.get('input[type="checkbox"]').setValue(true)
    await close.trigger('click')
    expect(wrapper.emitted('closeCreatedSecret')).toHaveLength(1)
  })
})

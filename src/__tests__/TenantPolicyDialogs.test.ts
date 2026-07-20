import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TenantPolicyDialogs from '../components/TenantPolicyDialogs.vue'
import type {
  TenantPolicyCreateForm,
  TenantPolicyForm,
} from '../composables/useTenantPolicies'
import type { Policy } from '../types'
import { emptyPolicyAdvancedForm } from '../utils/policyAdvanced'

function policy(): Policy {
  return {
    policy_id: 'policy-1',
    name: 'Engineering',
    description: 'Current description',
    scope_pattern: 'tenant:acme/workspace:eng/*',
    status: 'ACTIVE',
    priority: 10,
    commit_overage_policy: 'REJECT',
    caps: { max_tokens: 1000 },
    created_at: '2026-07-20T00:00:00Z',
  }
}

function createForm(): TenantPolicyCreateForm {
  return {
    name: '',
    description: '',
    scope_pattern: 'tenant:acme/*',
    priority: '',
    commit_overage_policy: '',
  }
}

function editForm(): TenantPolicyForm {
  return {
    name: 'Engineering',
    description: 'Current description',
    priority: 10,
    commit_overage_policy: 'REJECT',
  }
}

function mountDialogs(overrides: Record<string, unknown> = {}) {
  return mount(TenantPolicyDialogs, {
    props: {
      tenantId: 'acme',
      showCreate: false,
      createLoading: false,
      createError: '',
      createForm: createForm(),
      createAdvanced: emptyPolicyAdvancedForm(),
      editingPolicy: null,
      editLoading: false,
      editError: '',
      editForm: editForm(),
      editAdvanced: emptyPolicyAdvancedForm(),
      editHasAdvanced: false,
      ...overrides,
    },
  })
}

describe('TenantPolicyDialogs', () => {
  it('edits the shared create DTO and preserves the scope builder boundary', async () => {
    const shared = createForm()
    const wrapper = mountDialogs({ showCreate: true, createForm: shared })

    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('Create Policy')
    expect(wrapper.get('#cp-name').attributes('maxlength')).toBe('256')
    expect(wrapper.get('fieldset legend').text()).toBe('Scope pattern')
    expect(wrapper.text()).toContain('Will create as:')
    await wrapper.get('#cp-name').setValue('Background policy')
    await wrapper.get('#cp-desc').setValue('Worker limits')
    await wrapper.get('form').trigger('submit')
    const cancel = wrapper.findAll('button').find(button => button.text() === 'Cancel')
    await cancel!.trigger('click')

    expect(shared.name).toBe('Background policy')
    expect(shared.description).toBe('Worker limits')
    expect(wrapper.emitted('submitCreate')).toHaveLength(1)
    expect(wrapper.emitted('cancelCreate')).toHaveLength(1)
  })

  it('shows current editable values, immutable scope, and honest clear guidance', async () => {
    const target = policy()
    const shared = editForm()
    const advanced = emptyPolicyAdvancedForm()
    advanced.max_tokens = '1000'
    const wrapper = mountDialogs({
      editingPolicy: target,
      editForm: shared,
      editAdvanced: advanced,
      editHasAdvanced: true,
    })

    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('Edit Policy')
    expect(wrapper.get('#ep-desc').element).toHaveProperty('value', 'Current description')
    expect(wrapper.get('[data-testid="policy-scope-readonly"]').text()).toBe(target.scope_pattern)
    expect(wrapper.text()).toContain('immutable after policy creation')
    expect(wrapper.get('#ep-cop').element).toHaveProperty('value', 'REJECT')
    expect(wrapper.get('#ep-cop option[value=""]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('cannot clear it')
    expect(wrapper.text()).toContain('clearing fields removes them from that group')

    await wrapper.get('#ep-desc').setValue('')
    await wrapper.get('form').trigger('submit')
    const cancel = wrapper.findAll('button').find(button => button.text() === 'Cancel')
    await cancel!.trigger('click')
    expect(shared.description).toBe('')
    expect(wrapper.emitted('submitEdit')).toHaveLength(1)
    expect(wrapper.emitted('cancelEdit')).toHaveLength(1)
  })

  it('locks create actions while the write is in flight', () => {
    const wrapper = mountDialogs({ showCreate: true, createLoading: true })
    expect(wrapper.get('[role="dialog"]').attributes('aria-busy')).toBe('true')
    expect(wrapper.findAll('button').filter(button => button.text() === 'Cancel' || button.text() === 'Saving...')
      .every(button => button.attributes('disabled') !== undefined)).toBe(true)
  })

  it('renders an unknown current commit-overage value without dropping it', () => {
    const target = policy()
    target.commit_overage_policy = 'FUTURE_POLICY'
    const shared = editForm()
    shared.commit_overage_policy = 'FUTURE_POLICY'
    const wrapper = mountDialogs({ editingPolicy: target, editForm: shared })

    expect(wrapper.get('#ep-cop').element).toHaveProperty('value', 'FUTURE_POLICY')
    expect(wrapper.text()).toContain('FUTURE_POLICY (current server value)')
  })
})

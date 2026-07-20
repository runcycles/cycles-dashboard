import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import WebhookEditDialog from '../components/WebhookEditDialog.vue'
import type { WebhookEditForm } from '../composables/useWebhookEditor'
import type { WebhookSubscription } from '../types'
import { emptyWebhookAdvancedForm } from '../utils/webhookAdvanced'

function form(): WebhookEditForm {
  return {
    name: 'Payments hook',
    description: 'Payment lifecycle events',
    url: 'https://example.test/hook',
    event_types: ['budget.updated'],
    event_categories: ['budget'],
    scope_filter: 'tenant:acme/*',
    disable_after_failures: '10',
    metadata: '{"team":"payments"}',
  }
}

function webhook(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
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

function mountDialog(overrides: Record<string, unknown> = {}) {
  return mount(WebhookEditDialog, {
    props: {
      loading: false,
      error: '',
      metadataError: '',
      form: form(),
      advanced: emptyWebhookAdvancedForm(),
      advancedHasConfig: false,
      eventTypes: ['budget.updated', 'tenant.updated'],
      eventCategories: ['budget', 'tenant'],
      tenantOwned: true,
      hiddenLegacySelectorCount: 0,
      webhook: webhook(),
      ...overrides,
    },
  })
}

describe('WebhookEditDialog', () => {
  it('renders and updates the shared form DTO, then emits submit and cancel', async () => {
    const sharedForm = form()
    const wrapper = mountDialog({ form: sharedForm })

    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('Edit Webhook')
    await wrapper.get('#ew-name').setValue('Renamed hook')
    await wrapper.get('input[value="tenant.updated"]').setValue(true)
    await wrapper.get('form').trigger('submit')
    const cancel = wrapper.findAll('button').find(button => button.text() === 'Cancel')
    expect(cancel).toBeDefined()
    await cancel!.trigger('click')

    expect(sharedForm.name).toBe('Renamed hook')
    expect(sharedForm.event_types).toEqual(['budget.updated', 'tenant.updated'])
    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('exposes tenant legacy-selector and metadata validation guidance', () => {
    const wrapper = mountDialog({
      metadataError: 'Metadata must be a JSON object',
      hiddenLegacySelectorCount: 2,
    })

    expect(wrapper.text()).toContain('Tenant-owned subscriptions can only receive tenant-scoped events')
    expect(wrapper.get('[data-testid="hidden-legacy-selectors-hint"]').text()).toContain(
      '2 legacy admin-only selectors are hidden',
    )
    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toBe('Metadata must be a JSON object')
  })

  it('shows masked header names and opens existing advanced configuration', () => {
    const advanced = emptyWebhookAdvancedForm()
    advanced.max_retries = '5'
    const wrapper = mountDialog({
      tenantOwned: false,
      webhook: webhook({ headers: { Authorization: '********', 'X-Team': '********' } }),
      advanced,
      advancedHasConfig: true,
    })

    expect(wrapper.text()).toContain('Custom headers')
    expect(wrapper.text()).toContain('Authorization: ********')
    expect(wrapper.text()).toContain('X-Team: ********')
    expect(wrapper.get('[data-testid="ew-adv-toggle"]').attributes('aria-expanded')).toBe('true')
    expect((wrapper.get('#ew-adv-retries').element as HTMLInputElement).value).toBe('5')
  })
})

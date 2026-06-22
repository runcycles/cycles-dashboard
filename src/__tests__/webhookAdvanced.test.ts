import { describe, it, expect } from 'vitest'
import {
  emptyWebhookAdvancedForm,
  webhookAdvancedToRequest,
  webhookToAdvancedForm,
} from '../utils/webhookAdvanced'
import type { WebhookSubscription } from '../types'

describe('webhookAdvanced converters', () => {
  it('empty form produces an empty request', () => {
    expect(webhookAdvancedToRequest(emptyWebhookAdvancedForm())).toEqual({})
  })

  it('parses the budget_utilization number list', () => {
    const f = emptyWebhookAdvancedForm()
    f.budget_utilization = '0.8, 0.95, 1.0'
    expect(webhookAdvancedToRequest(f).thresholds).toEqual({ budget_utilization: [0.8, 0.95, 1.0] })
  })

  it('drops a utilization list containing a non-number', () => {
    const f = emptyWebhookAdvancedForm()
    f.budget_utilization = '0.8, oops'
    expect(webhookAdvancedToRequest(f).thresholds).toBeUndefined()
  })

  it('builds thresholds and retry_policy independently', () => {
    const f = emptyWebhookAdvancedForm()
    f.burn_rate_multiplier = '3.5'
    f.denial_rate_threshold = '0.2'
    f.max_retries = '7'
    f.backoff_multiplier = '2'
    const req = webhookAdvancedToRequest(f)
    expect(req.thresholds).toEqual({ burn_rate_multiplier: 3.5, denial_rate_threshold: 0.2 })
    expect(req.retry_policy).toEqual({ max_retries: 7, backoff_multiplier: 2 })
  })

  it('round-trips an existing subscription into the form', () => {
    const w: WebhookSubscription = {
      subscription_id: 's1', tenant_id: 't1', url: 'https://x', event_types: ['budget.created'],
      status: 'ACTIVE', created_at: '2026-01-01T00:00:00Z',
      thresholds: { budget_utilization: [0.5, 0.9], rate_window_seconds: 600 },
      retry_policy: { max_retries: 3, max_delay_ms: 30000 },
    }
    const f = webhookToAdvancedForm(w)
    expect(f.budget_utilization).toBe('0.5, 0.9')
    expect(f.rate_window_seconds).toBe('600')
    expect(f.max_retries).toBe('3')
    expect(f.max_delay_ms).toBe('30000')
    expect(webhookAdvancedToRequest(f).retry_policy?.max_retries).toBe(3)
  })

  it('round-trips a subscription with no advanced config to an empty form', () => {
    const w: WebhookSubscription = {
      subscription_id: 's2', tenant_id: 't1', url: 'https://x', event_types: ['budget.created'],
      status: 'ACTIVE', created_at: '2026-01-01T00:00:00Z',
    }
    expect(webhookToAdvancedForm(w)).toEqual(emptyWebhookAdvancedForm())
  })

  it('treats a blank utilization list as unset', () => {
    const f = emptyWebhookAdvancedForm()
    f.budget_utilization = '   '
    expect(webhookAdvancedToRequest(f).thresholds).toBeUndefined()
  })
})

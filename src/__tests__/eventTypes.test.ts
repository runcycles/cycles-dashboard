// Pins the EVENT_TYPES suggestion/picker list to the spec EventType enum
// (cycles-governance-admin-v0.1.25.yaml). This list drives the Events view
// type-filter datalist AND the webhook subscription event-type checkboxes —
// a missing value silently makes that event kind un-subscribable in the UI
// (the v0.1.25.35 cascade kinds were absent until the 2026-07-03 audit).
import { describe, it, expect } from 'vitest'
import { EVENT_TYPES, EVENT_CATEGORIES, TENANT_ALLOWED_EVENT_TYPES, TENANT_ALLOWED_EVENT_CATEGORIES } from '../types'

describe('EVENT_TYPES spec parity', () => {
  it('matches the spec v0.1.25.35 enum size (47 base + 4 cascade)', () => {
    expect(EVENT_TYPES).toHaveLength(51)
  })

  it('includes the four tenant-close cascade kinds (spec v0.1.25.35)', () => {
    expect(EVENT_TYPES).toContain('budget.closed_via_tenant_cascade')
    expect(EVENT_TYPES).toContain('reservation.released_via_tenant_cascade')
    expect(EVENT_TYPES).toContain('webhook.disabled_via_tenant_cascade')
    expect(EVENT_TYPES).toContain('api_key.revoked_via_tenant_cascade')
  })

  it('has no duplicates', () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length)
  })

  it('every type prefix maps to a known category', () => {
    const categories = new Set<string>(EVENT_CATEGORIES)
    for (const t of EVENT_TYPES) {
      expect(categories.has(t.split('.')[0])).toBe(true)
    }
  })
})

// Spec revisions 0.1.25.38/.40/.41 — TENANT-OWNED CATEGORY BOUNDARY
// (createWebhookSubscription lines 6281-6318, updateWebhookSubscription
// lines 6560-6574). Tenant-owned subscriptions may only select
// budget.* / reservation.* / tenant.* selectors; the webhook forms
// filter their pickers to these sets.
describe('TENANT_ALLOWED_* spec parity (tenant-owned category boundary)', () => {
  it('allowed categories are exactly budget / reservation / tenant', () => {
    expect([...TENANT_ALLOWED_EVENT_CATEGORIES].sort()).toEqual(['budget', 'reservation', 'tenant'])
  })

  it('allowed types are exactly the EVENT_TYPES with a tenant-scoped prefix', () => {
    const allowed = new Set<string>(TENANT_ALLOWED_EVENT_CATEGORIES)
    expect(TENANT_ALLOWED_EVENT_TYPES).toEqual(
      EVENT_TYPES.filter(t => allowed.has(t.split('.')[0])),
    )
    expect(TENANT_ALLOWED_EVENT_TYPES.length).toBeGreaterThan(0)
  })

  it('contains no admin-only selector (api_key / policy / webhook / system)', () => {
    for (const t of TENANT_ALLOWED_EVENT_TYPES) {
      expect(t).not.toMatch(/^(api_key|policy|webhook|system)\./)
    }
    for (const c of TENANT_ALLOWED_EVENT_CATEGORIES as readonly string[]) {
      expect(['api_key', 'policy', 'webhook', 'system']).not.toContain(c)
    }
  })
})

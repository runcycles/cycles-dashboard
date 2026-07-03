// Pins the EVENT_TYPES suggestion/picker list to the spec EventType enum
// (cycles-governance-admin-v0.1.25.yaml). This list drives the Events view
// type-filter datalist AND the webhook subscription event-type checkboxes —
// a missing value silently makes that event kind un-subscribable in the UI
// (the v0.1.25.35 cascade kinds were absent until the 2026-07-03 audit).
import { describe, it, expect } from 'vitest'
import { EVENT_TYPES, EVENT_CATEGORIES } from '../types'

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

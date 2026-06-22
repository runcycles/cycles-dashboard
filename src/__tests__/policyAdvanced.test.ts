import { describe, it, expect } from 'vitest'
import {
  emptyPolicyAdvancedForm,
  policyAdvancedToRequest,
  policyToAdvancedForm,
} from '../utils/policyAdvanced'
import type { Policy } from '../types'

describe('policyAdvanced converters', () => {
  it('empty form produces an empty request (no sub-objects)', () => {
    expect(policyAdvancedToRequest(emptyPolicyAdvancedForm())).toEqual({})
  })

  it('parses caps numbers and tool lists (newline + comma)', () => {
    const f = emptyPolicyAdvancedForm()
    f.max_tokens = '4096'
    f.max_steps_remaining = '10'
    f.cooldown_ms = '500'
    f.tool_allowlist = 'search\nfetch'
    f.tool_denylist = 'rm, sudo'
    const req = policyAdvancedToRequest(f)
    expect(req.caps).toEqual({
      max_tokens: 4096,
      max_steps_remaining: 10,
      cooldown_ms: 500,
      tool_allowlist: ['search', 'fetch'],
      tool_denylist: ['rm', 'sudo'],
    })
  })

  it('ignores non-numeric and blank numeric inputs', () => {
    const f = emptyPolicyAdvancedForm()
    f.max_tokens = 'abc'
    f.cooldown_ms = ''
    expect(policyAdvancedToRequest(f).caps).toBeUndefined()
  })

  it('builds rate_limits and reservation_ttl_override independently', () => {
    const f = emptyPolicyAdvancedForm()
    f.max_reservations_per_minute = '60'
    f.default_ttl_ms = '30000'
    f.max_extensions = '3'
    const req = policyAdvancedToRequest(f)
    expect(req.rate_limits).toEqual({ max_reservations_per_minute: 60 })
    expect(req.reservation_ttl_override).toEqual({ default_ttl_ms: 30000, max_extensions: 3 })
  })

  it('converts effective window datetime-local to ISO', () => {
    const f = emptyPolicyAdvancedForm()
    f.effective_from = '2026-06-01T00:00'
    const req = policyAdvancedToRequest(f)
    expect(req.effective_from).toMatch(/^2026-06-01T/)
    expect(req.effective_until).toBeUndefined()
  })

  it('round-trips an existing policy into the form', () => {
    const p: Policy = {
      policy_id: 'p1', name: 'x', scope_pattern: 'tenant:a/*', status: 'ACTIVE',
      created_at: '2026-01-01T00:00:00Z',
      caps: { max_tokens: 100, tool_allowlist: ['a', 'b'] },
      rate_limits: { max_commits_per_minute: 5 },
      reservation_ttl_override: { max_ttl_ms: 9000 },
      effective_from: '2026-06-01T12:00:00Z',
    }
    const f = policyToAdvancedForm(p)
    expect(f.max_tokens).toBe('100')
    expect(f.tool_allowlist).toBe('a\nb')
    expect(f.max_commits_per_minute).toBe('5')
    expect(f.max_ttl_ms).toBe('9000')
    expect(f.effective_from).toMatch(/^2026-06-01T/)
    // and back out again to a request
    expect(policyAdvancedToRequest(f).caps?.max_tokens).toBe(100)
  })

  it('round-trips a policy with no advanced config to an empty form', () => {
    const p: Policy = {
      policy_id: 'p2', name: 'bare', scope_pattern: 'tenant:a', status: 'ACTIVE',
      created_at: '2026-01-01T00:00:00Z',
    }
    expect(policyToAdvancedForm(p)).toEqual(emptyPolicyAdvancedForm())
  })

  it('treats an unparseable effective_from as blank', () => {
    const p: Policy = {
      policy_id: 'p3', name: 'bad', scope_pattern: 'tenant:a', status: 'ACTIVE',
      created_at: '2026-01-01T00:00:00Z', effective_until: 'not-a-date',
    }
    expect(policyToAdvancedForm(p).effective_until).toBe('')
  })
})

// I1 (UI/UX P0): unit tests for the Overview "Expiring Keys" filter.
// The helper is responsible for the signal the operator sees in the
// alert card — getting the date math wrong means either missing a key
// about to die (false negative = production outage) or spamming the
// card with already-expired keys that should be on the filtered list
// view instead. Pin both invariants.

import { describe, it, expect } from 'vitest'
import { filterExpiringKeys } from '../utils/expiringKeys'
import type { ApiKey } from '../types'

const NOW = new Date('2026-04-17T12:00:00Z')

function daysFromNow(days: number): string {
  return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString()
}

function key(id: string, overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    key_id: id,
    tenant_id: 't',
    status: 'ACTIVE',
    permissions: [],
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('filterExpiringKeys', () => {
  it('includes ACTIVE keys whose expires_at is within the window', () => {
    const out = filterExpiringKeys([
      key('a', { expires_at: daysFromNow(3) }),
      key('b', { expires_at: daysFromNow(6.5) }),
    ], { now: NOW })
    expect(out.map(e => e.key.key_id)).toEqual(['a', 'b'])
  })

  it('sorts ascending by expires_at (soonest first)', () => {
    const out = filterExpiringKeys([
      key('later',   { expires_at: daysFromNow(5) }),
      key('soonest', { expires_at: daysFromNow(1) }),
      key('middle',  { expires_at: daysFromNow(3) }),
    ], { now: NOW })
    expect(out.map(e => e.key.key_id)).toEqual(['soonest', 'middle', 'later'])
  })

  it('excludes keys that are already expired', () => {
    const out = filterExpiringKeys([
      key('past',    { expires_at: daysFromNow(-1) }),
      key('now',     { expires_at: NOW.toISOString() }),
      key('future',  { expires_at: daysFromNow(2) }),
    ], { now: NOW })
    expect(out.map(e => e.key.key_id)).toEqual(['future'])
  })

  it('excludes keys beyond the window boundary', () => {
    const out = filterExpiringKeys([
      key('inside',     { expires_at: daysFromNow(6.9) }),
      // 7.1 days out — just past the 7d default cutoff.
      key('past-window', { expires_at: daysFromNow(7.1) }),
      key('way-out',    { expires_at: daysFromNow(30) }),
    ], { now: NOW })
    expect(out.map(e => e.key.key_id)).toEqual(['inside'])
  })

  it('skips keys without an expires_at ("Never" expires)', () => {
    const out = filterExpiringKeys([
      key('never'),
      key('has',  { expires_at: daysFromNow(2) }),
    ], { now: NOW })
    expect(out.map(e => e.key.key_id)).toEqual(['has'])
  })

  it('skips non-ACTIVE keys (REVOKED / EXPIRED never carry "about to expire" signal)', () => {
    const out = filterExpiringKeys([
      key('revoked', { status: 'REVOKED', expires_at: daysFromNow(2) }),
      key('expired', { status: 'EXPIRED', expires_at: daysFromNow(2) }),
      key('active',  { status: 'ACTIVE',  expires_at: daysFromNow(2) }),
    ], { now: NOW })
    expect(out.map(e => e.key.key_id)).toEqual(['active'])
  })

  it('skips keys with unparseable expires_at strings', () => {
    const out = filterExpiringKeys([
      key('garbage', { expires_at: 'not-a-date' }),
      key('ok',      { expires_at: daysFromNow(2) }),
    ], { now: NOW })
    expect(out.map(e => e.key.key_id)).toEqual(['ok'])
  })

  it('returns daysUntilExpiry as a positive integer (ceil)', () => {
    const out = filterExpiringKeys([
      key('1.1d', { expires_at: daysFromNow(1.1) }),
      key('2.9d', { expires_at: daysFromNow(2.9) }),
    ], { now: NOW })
    expect(out[0].daysUntilExpiry).toBe(2)  // ceil(1.1)
    expect(out[1].daysUntilExpiry).toBe(3)  // ceil(2.9)
  })

  it('honors a custom windowDays override', () => {
    const out = filterExpiringKeys([
      key('in-3',  { expires_at: daysFromNow(3) }),
      key('in-14', { expires_at: daysFromNow(14) }),
      key('in-40', { expires_at: daysFromNow(40) }),
    ], { now: NOW, windowDays: 30 })
    expect(out.map(e => e.key.key_id)).toEqual(['in-3', 'in-14'])
  })

  it('returns an empty array when nothing matches', () => {
    const out = filterExpiringKeys([
      key('never'),
      key('past', { expires_at: daysFromNow(-5) }),
      key('far',  { expires_at: daysFromNow(90) }),
    ], { now: NOW })
    expect(out).toEqual([])
  })
})

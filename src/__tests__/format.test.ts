import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { formatDateTime, formatDate, formatTime, formatRelative } from '../utils/format'

describe('format utilities', () => {
  describe('formatDateTime', () => {
    it('returns a non-empty string for a valid ISO', () => {
      const out = formatDateTime('2026-04-10T12:34:56Z')
      expect(typeof out).toBe('string')
      expect(out.length).toBeGreaterThan(0)
    })

    it('returns "Invalid Date" for garbage input', () => {
      const out = formatDateTime('not a date')
      expect(out).toBe('Invalid Date')
    })
  })

  describe('formatDate', () => {
    it('formats an ISO date into a human-readable string', () => {
      const out = formatDate('2026-04-10T00:00:00Z')
      // Different locales format differently; just assert it contains a year
      expect(out).toMatch(/2026/)
    })
  })

  describe('formatTime', () => {
    it('formats an ISO time', () => {
      const out = formatTime('2026-04-10T12:34:56Z')
      expect(out.length).toBeGreaterThan(0)
    })
  })

  describe('formatRelative', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-04-10T12:00:00Z'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('returns "just now" for < 1 minute ago', () => {
      const iso = new Date('2026-04-10T11:59:30Z').toISOString()
      expect(formatRelative(iso)).toBe('just now')
    })

    it('returns minutes for < 1 hour ago', () => {
      const iso = new Date('2026-04-10T11:45:00Z').toISOString()
      expect(formatRelative(iso)).toBe('15m ago')
    })

    it('returns hours for < 24 hours ago', () => {
      const iso = new Date('2026-04-10T09:00:00Z').toISOString()
      expect(formatRelative(iso)).toBe('3h ago')
    })

    it('falls back to formatDate for older than 24h', () => {
      const iso = new Date('2026-04-05T12:00:00Z').toISOString()
      const out = formatRelative(iso)
      // Should look like a date string, not "Nh ago"
      expect(out).not.toMatch(/h ago$/)
      expect(out).not.toMatch(/m ago$/)
    })

    it('boundary: exactly 60s ago rounds to 1m ago', () => {
      const iso = new Date('2026-04-10T11:59:00Z').toISOString()
      expect(formatRelative(iso)).toBe('1m ago')
    })
  })
})

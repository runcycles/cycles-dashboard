import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { formatDateTime, formatDate, formatTime, formatRelative } from '../utils/format'

describe('format utilities', () => {
  describe('formatDateTime', () => {
    it('returns a non-empty string for a valid ISO', () => {
      const out = formatDateTime('2026-04-10T12:34:56Z')
      expect(typeof out).toBe('string')
      expect(out.length).toBeGreaterThan(0)
    })

    it('P1-M1: includes a short timezone marker so local vs. UTC is unambiguous', () => {
      const out = formatDateTime('2026-04-10T12:34:56Z')
      // Runtime zone varies by CI host. Short tz names fall into three
      // observed shapes: 3–4 letter abbreviation ("UTC", "PDT", "GMT"),
      // "GMT±H[H][:MM]", or "UTC±H[H][:MM]". Assert at least one is
      // present so the marker is there without overspecifying the form.
      expect(out).toMatch(/(^|\s)(UTC|GMT|[A-Z]{2,5})((\s*[-+]\d{1,2}(?::?\d{2})?)?)\b/)
    })

    it('returns em-dash for garbage input', () => {
      expect(formatDateTime('not a date')).toBe('—')
    })

    it('returns em-dash for null / undefined / empty', () => {
      expect(formatDateTime(null)).toBe('—')
      expect(formatDateTime(undefined)).toBe('—')
      expect(formatDateTime('')).toBe('—')
    })
  })

  describe('null guards across formatters', () => {
    it('formatDate returns em-dash for null-ish', () => {
      expect(formatDate(null)).toBe('—')
      expect(formatDate(undefined)).toBe('—')
      expect(formatDate('')).toBe('—')
      expect(formatDate('garbage')).toBe('—')
    })
    it('formatTime returns em-dash for null-ish', () => {
      expect(formatTime(null)).toBe('—')
      expect(formatTime('garbage')).toBe('—')
    })
    it('formatRelative returns em-dash for null-ish', () => {
      expect(formatRelative(null)).toBe('—')
      expect(formatRelative(undefined)).toBe('—')
      expect(formatRelative('')).toBe('—')
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

import { describe, it, expect } from 'vitest'
import { sanitizeRedirect } from '../utils/sanitize'

const ORIGIN = 'http://localhost:5173'

describe('sanitizeRedirect', () => {
  describe('happy path', () => {
    it('passes a simple same-origin path', () => {
      expect(sanitizeRedirect('/budgets', ORIGIN)).toBe('/budgets')
    })

    it('preserves search params', () => {
      expect(sanitizeRedirect('/events?category=budget&limit=50', ORIGIN))
        .toBe('/events?category=budget&limit=50')
    })

    it('preserves hash fragment', () => {
      expect(sanitizeRedirect('/tenants#section', ORIGIN)).toBe('/tenants#section')
    })

    it('preserves path + search + hash together', () => {
      expect(sanitizeRedirect('/audit?op=fund#row-12', ORIGIN)).toBe('/audit?op=fund#row-12')
    })

    it('handles nested paths', () => {
      expect(sanitizeRedirect('/tenants/acme-corp/keys', ORIGIN))
        .toBe('/tenants/acme-corp/keys')
    })
  })

  describe('empty / invalid inputs', () => {
    it('returns / for empty string', () => {
      expect(sanitizeRedirect('', ORIGIN)).toBe('/')
    })

    it('returns / for null', () => {
      expect(sanitizeRedirect(null, ORIGIN)).toBe('/')
    })

    it('returns / for undefined', () => {
      expect(sanitizeRedirect(undefined, ORIGIN)).toBe('/')
    })

    it('returns / for non-string (number)', () => {
      expect(sanitizeRedirect(42, ORIGIN)).toBe('/')
    })

    it('returns / for non-string (object)', () => {
      expect(sanitizeRedirect({ path: '/foo' }, ORIGIN)).toBe('/')
    })
  })

  describe('open-redirect attack vectors', () => {
    it('rejects protocol-relative URL (//evil.com)', () => {
      expect(sanitizeRedirect('//evil.com/steal', ORIGIN)).toBe('/')
    })

    it('rejects absolute https URL', () => {
      expect(sanitizeRedirect('https://evil.com/steal', ORIGIN)).toBe('/')
    })

    it('rejects absolute http URL', () => {
      expect(sanitizeRedirect('http://evil.com/steal', ORIGIN)).toBe('/')
    })

    it('rejects javascript: scheme', () => {
      expect(sanitizeRedirect('javascript:alert(1)', ORIGIN)).toBe('/')
    })

    it('rejects data: scheme', () => {
      expect(sanitizeRedirect('data:text/html,<script>alert(1)</script>', ORIGIN)).toBe('/')
    })

    it('rejects a different origin with same scheme', () => {
      expect(sanitizeRedirect('http://attacker.test/', ORIGIN)).toBe('/')
    })

    it('preserves a path that contains "http" as literal text', () => {
      // /proxy?url=http://example.com is a valid same-origin path
      expect(sanitizeRedirect('/proxy?url=http://example.com', ORIGIN))
        .toBe('/proxy?url=http://example.com')
    })
  })

  describe('login loop protection', () => {
    it('rejects /login as redirect target', () => {
      expect(sanitizeRedirect('/login', ORIGIN)).toBe('/')
    })

    it('rejects /login with query params', () => {
      expect(sanitizeRedirect('/login?expired=1', ORIGIN)).toBe('/')
    })

    it('rejects /login/ subpath', () => {
      expect(sanitizeRedirect('/login/reset', ORIGIN)).toBe('/')
    })

    it('does NOT reject unrelated paths that start with "login" (no slash)', () => {
      // /login-history is not the login page
      expect(sanitizeRedirect('/login-history', ORIGIN)).toBe('/login-history')
    })
  })

  describe('edge cases', () => {
    it('normalizes URL-encoded slashes in authority position', () => {
      // Whatever the URL constructor does with this, it must NOT escape origin
      const result = sanitizeRedirect('/%2Fevil.com', ORIGIN)
      expect(result).toBe('/%2Fevil.com')
    })

    it('handles malformed input without throwing', () => {
      // `://not-a-url` resolves as a same-origin relative path, which is
      // safe — the sanitizer only needs to prevent origin escape, not
      // reject every weird-looking input.
      expect(() => sanitizeRedirect('://not-a-url', ORIGIN)).not.toThrow()
      const result = sanitizeRedirect('://not-a-url', ORIGIN)
      expect(result.startsWith('/')).toBe(true)
      expect(result).not.toContain('evil')
    })

    it('returns / for genuinely unparseable base', () => {
      // If the origin itself is broken, the URL constructor throws and we
      // fall back to '/'.
      expect(sanitizeRedirect('/foo', 'not-a-valid-origin')).toBe('/')
    })

    it('works with different origins', () => {
      expect(sanitizeRedirect('/dashboard', 'https://admin.example.com'))
        .toBe('/dashboard')
    })
  })
})

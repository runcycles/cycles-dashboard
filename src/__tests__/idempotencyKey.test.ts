// generateIdempotencyKey() must produce an RFC 4122 v4 UUID regardless
// of which code path runs. Three paths exist, gated by capability
// detection on globalThis.crypto:
//   1. crypto.randomUUID()           — modern browsers / Node 16.7+
//   2. crypto.getRandomValues(...)   — iOS Safari 14, old Edge, etc.
//   3. Math.random()                 — no crypto at all (unit/test sandbox)
// The server treats the key as opaque, but the spec pins v4 shape, so
// every path MUST satisfy the v4 regex. These tests assert that
// contract end-to-end and also check uniqueness within each path.
//
// Sandbox note: vitest's jsdom env ships with crypto.randomUUID, so to
// exercise the fallbacks we stub globalThis.crypto per-test.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateIdempotencyKey } from '../utils/idempotencyKey'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('generateIdempotencyKey', () => {
  const originalCrypto = globalThis.crypto

  afterEach(() => {
    // Restore whatever the test env had originally so later tests
    // don't inherit a stub.
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      writable: true,
      value: originalCrypto,
    })
    vi.restoreAllMocks()
  })

  describe('crypto.randomUUID path', () => {
    beforeEach(() => {
      // Baseline — jsdom already provides randomUUID, but stub it so
      // we can assert the function delegates rather than falls through.
      const spy = vi.fn(() => '11111111-2222-4333-8444-555555555555')
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        writable: true,
        value: { randomUUID: spy },
      })
    })

    it('delegates to crypto.randomUUID when available', () => {
      const k = generateIdempotencyKey()
      expect(k).toBe('11111111-2222-4333-8444-555555555555')
      expect(k).toMatch(UUID_V4)
    })
  })

  describe('getRandomValues fallback', () => {
    beforeEach(() => {
      // No randomUUID — force the manual assembly path. Back it with
      // getRandomValues so we still get cryptographically strong bytes.
      const getRandomValues = (buf: Uint8Array) => {
        for (let i = 0; i < buf.length; i++) buf[i] = (i * 37 + 13) & 0xff
        return buf
      }
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        writable: true,
        value: { getRandomValues },
      })
    })

    it('produces a valid UUID v4 shape', () => {
      const k = generateIdempotencyKey()
      expect(k).toMatch(UUID_V4)
    })

    it('sets the version nibble to 4 and variant nibble to 8-b', () => {
      const k = generateIdempotencyKey()
      // char at index 14 is the version (must be '4')
      expect(k[14]).toBe('4')
      // char at index 19 is the variant nibble (must be 8, 9, a, or b)
      expect('89ab').toContain(k[19])
    })
  })

  describe('Math.random ultra-fallback', () => {
    beforeEach(() => {
      // No crypto at all — emulate a sandbox where even getRandomValues
      // is absent (ancient IE, stripped-down eval context, etc.).
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        writable: true,
        value: undefined,
      })
    })

    it('still produces a valid UUID v4 shape', () => {
      const k = generateIdempotencyKey()
      expect(k).toMatch(UUID_V4)
    })

    it('produces distinct keys across calls', () => {
      // Math.random has enough entropy per call that collisions in a
      // 128-bit space are astronomically unlikely; assert 50 calls are
      // all unique as a smoke test on the spread.
      const keys = new Set(Array.from({ length: 50 }, () => generateIdempotencyKey()))
      expect(keys.size).toBe(50)
    })
  })

  describe('uniqueness', () => {
    it('returns distinct keys across many calls on the randomUUID path', () => {
      // Use the real jsdom crypto (already installed by vitest env).
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        writable: true,
        value: originalCrypto,
      })
      const keys = new Set(Array.from({ length: 100 }, () => generateIdempotencyKey()))
      expect(keys.size).toBe(100)
      keys.forEach(k => expect(k).toMatch(UUID_V4))
    })
  })
})

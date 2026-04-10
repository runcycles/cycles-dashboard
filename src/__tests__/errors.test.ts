import { describe, it, expect } from 'vitest'
import { toMessage } from '../utils/errors'

describe('toMessage', () => {
  describe('Error instances', () => {
    it('returns e.message for a real Error', () => {
      expect(toMessage(new Error('boom'))).toBe('boom')
    })

    it('returns fallback when Error has empty message', () => {
      expect(toMessage(new Error(''))).toBe('Unknown error')
    })

    it('respects custom fallback for empty Error', () => {
      expect(toMessage(new Error(''), 'custom')).toBe('custom')
    })

    it('handles subclasses of Error', () => {
      expect(toMessage(new TypeError('bad arg'))).toBe('bad arg')
      expect(toMessage(new RangeError('out of range'))).toBe('out of range')
    })
  })

  describe('thrown strings', () => {
    it('returns the string itself', () => {
      expect(toMessage('something went wrong')).toBe('something went wrong')
    })

    it('returns fallback for empty string', () => {
      expect(toMessage('')).toBe('Unknown error')
    })
  })

  describe('plain objects with message', () => {
    it('extracts string message field', () => {
      expect(toMessage({ message: 'api failure' })).toBe('api failure')
    })

    it('ignores non-string message fields', () => {
      expect(toMessage({ message: 42 })).toBe('Unknown error')
      expect(toMessage({ message: { nested: 'x' } })).toBe('Unknown error')
    })

    it('ignores objects without a message field', () => {
      expect(toMessage({ code: 'ECONNREFUSED' })).toBe('Unknown error')
    })
  })

  describe('unknown / unusual values', () => {
    it('returns fallback for null', () => {
      expect(toMessage(null)).toBe('Unknown error')
    })

    it('returns fallback for undefined', () => {
      expect(toMessage(undefined)).toBe('Unknown error')
    })

    it('returns fallback for a number', () => {
      expect(toMessage(42)).toBe('Unknown error')
    })

    it('returns fallback for a boolean', () => {
      expect(toMessage(false)).toBe('Unknown error')
    })

    it('returns custom fallback', () => {
      expect(toMessage(null, 'Connection lost')).toBe('Connection lost')
    })
  })
})

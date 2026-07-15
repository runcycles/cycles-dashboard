// Query-param guards (src/utils/dateParam.ts).
//
// stringParam (round 5, F1): vue-router types every query value as
// LocationQueryValue | LocationQueryValue[] — a duplicated param
// (?search=a&search=b) arrives as an ARRAY and the views' bare
// `as string` casts crashed the first string method downstream
// (.toLowerCase() / .trim() → TypeError → blank view). Strings pass,
// arrays yield their first string element, anything else is ''.
import { describe, it, expect } from 'vitest'
import { dateParamOrEmpty, stringParam } from '../utils/dateParam'

describe('stringParam', () => {
  it('passes plain strings through unchanged', () => {
    expect(stringParam('abc')).toBe('abc')
    expect(stringParam('')).toBe('')
  })

  it('takes the first string element of a duplicated-param array', () => {
    expect(stringParam(['a', 'b'])).toBe('a')
  })

  it('skips non-string array entries (valueless duplicates arrive as null)', () => {
    expect(stringParam([null, 'b'])).toBe('b')
  })

  it('returns "" for an array with no string element', () => {
    expect(stringParam([null])).toBe('')
    expect(stringParam([])).toBe('')
  })

  it('returns "" for null (valueless param) and undefined (absent param)', () => {
    expect(stringParam(null)).toBe('')
    expect(stringParam(undefined)).toBe('')
  })
})

describe('dateParamOrEmpty', () => {
  it('passes parseable date strings through unchanged (datetime-local round-trip)', () => {
    expect(dateParamOrEmpty('2026-04-01T00:00')).toBe('2026-04-01T00:00')
    expect(dateParamOrEmpty('2026-04-01T00:00:00Z')).toBe('2026-04-01T00:00:00Z')
  })

  it('drops junk values instead of letting toISOString() throw later', () => {
    expect(dateParamOrEmpty('lastweek')).toBe('')
    expect(dateParamOrEmpty('')).toBe('')
  })

  it('takes the first string element of a duplicated-param array', () => {
    expect(dateParamOrEmpty(['2026-04-01T00:00', '2026-05-01T00:00'])).toBe('2026-04-01T00:00')
  })

  it('returns "" for null / undefined / non-string arrays', () => {
    expect(dateParamOrEmpty(null)).toBe('')
    expect(dateParamOrEmpty(undefined)).toBe('')
    expect(dateParamOrEmpty([null])).toBe('')
  })
})

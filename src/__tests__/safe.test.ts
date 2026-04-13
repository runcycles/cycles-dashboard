import { describe, it, expect } from 'vitest'
import { safeJsonStringify, csvEscape, tenantFromScope, parsePositiveAmount } from '../utils/safe'

describe('safeJsonStringify', () => {
  it('matches JSON.stringify for plain objects', () => {
    const v = { a: 1, b: 'x', c: [1, 2, 3] }
    expect(safeJsonStringify(v)).toBe(JSON.stringify(v, null, 2))
  })

  it('does not throw on a circular reference; replaces cycle with [Circular]', () => {
    const a: Record<string, unknown> = { name: 'a' }
    const b: Record<string, unknown> = { name: 'b', a }
    a.b = b // a → b → a
    const out = safeJsonStringify(a)
    expect(out).toContain('"[Circular]"')
    expect(out).toContain('"name": "a"')
    expect(out).toContain('"name": "b"')
  })

  it('serializes BigInt with an n suffix instead of throwing', () => {
    const out = safeJsonStringify({ big: 9007199254740993n })
    expect(out).toContain('"9007199254740993n"')
  })

  it('respects indent parameter', () => {
    expect(safeJsonStringify({ a: 1 }, 0)).toBe('{"a":1}')
    expect(safeJsonStringify({ a: 1 }, 4)).toBe('{\n    "a": 1\n}')
  })

  it('returns empty string for undefined (JSON.stringify returns undefined)', () => {
    expect(safeJsonStringify(undefined)).toBe('')
  })

  it('returns null literal for null input', () => {
    expect(safeJsonStringify(null)).toBe('null')
  })

  // Regression: a previous WeakSet implementation flagged shared sibling
  // references as "[Circular]". Vanilla JSON.stringify serializes them
  // twice, and so should we — only true cycles must be marked.
  it('does NOT mark shared sibling references as circular', () => {
    const shared = { id: 'x', n: 1 }
    const out = safeJsonStringify({ a: shared, b: shared, c: shared })
    expect(out).toBe(JSON.stringify({ a: shared, b: shared, c: shared }, null, 2))
    expect(out).not.toContain('[Circular]')
    // sanity: the shared object's fields appear three times
    expect(out.match(/"id": "x"/g)?.length).toBe(3)
  })

  it('handles deeply nested shared refs in arrays without false circular', () => {
    const leaf = { v: 42 }
    const out = safeJsonStringify({ items: [{ leaf }, { leaf }, { leaf }] })
    expect(out).not.toContain('[Circular]')
    expect(out.match(/"v": 42/g)?.length).toBe(3)
  })

  it('still marks self-referential cycles as [Circular]', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    const out = safeJsonStringify(a)
    expect(out).toContain('"[Circular]"')
  })

  it('still marks deep mutual cycles', () => {
    const a: Record<string, unknown> = { name: 'a' }
    const b: Record<string, unknown> = { name: 'b', child: { grand: a } }
    a.b = b // a → b → child → grand → a
    const out = safeJsonStringify(a)
    expect(out).toContain('"[Circular]"')
  })

  it('serializes the same shared array twice without truncation', () => {
    const list = [1, 2, 3]
    const out = safeJsonStringify({ x: list, y: list })
    expect(out).not.toContain('[Circular]')
    expect((out.match(/\[\s*1,\s*2,\s*3\s*\]/g) || []).length).toBe(2)
  })

  // Top-level array — exercises the synthetic { '': value } wrapper that
  // JSON.stringify uses internally. The ancestor-stack must not get
  // confused by the wrapper not being in `ancestors[]`.
  it('handles top-level array with shared element refs', () => {
    const x = { n: 1 }
    const out = safeJsonStringify([x, x, x])
    expect(out).not.toContain('[Circular]')
    expect((out.match(/"n": 1/g) || []).length).toBe(3)
  })

  // Nested-but-not-cyclic: same leaf appears as child of A AND grandchild
  // of A. Must not be marked Circular in the second slot.
  it('handles same leaf at different depths without false circular', () => {
    const leaf = { id: 'leaf' }
    const out = safeJsonStringify({ a: leaf, b: { nested: leaf } })
    expect(out).not.toContain('[Circular]')
    expect((out.match(/"id": "leaf"/g) || []).length).toBe(2)
  })
})

describe('csvEscape', () => {
  it('wraps plain strings in double quotes', () => {
    expect(csvEscape('hello')).toBe('"hello"')
  })

  it('doubles embedded quotes per RFC 4180', () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""')
  })

  it('preserves commas and newlines inside quoted cells', () => {
    expect(csvEscape('a,b\nc')).toBe('"a,b\nc"')
  })

  it('returns empty quoted cell for null / undefined', () => {
    expect(csvEscape(null)).toBe('""')
    expect(csvEscape(undefined)).toBe('""')
  })

  it('coerces numbers and booleans to strings', () => {
    expect(csvEscape(42)).toBe('"42"')
    expect(csvEscape(true)).toBe('"true"')
  })

  // CSV-injection (CWE-1236). Cells starting with these characters are
  // interpreted as formulas in Excel / Google Sheets / LibreOffice. We
  // prefix a single quote so the cell stays plain text.
  it.each([
    ['=cmd|"/c calc"!A0', "\"'=cmd|\"\"/c calc\"\"!A0\""],
    ['+1+1', "\"'+1+1\""],
    ['-2+3', "\"'-2+3\""],
    ['@SUM(A1)', "\"'@SUM(A1)\""],
    ['\tTAB', "\"'\tTAB\""],
    ['\rCR', "\"'\rCR\""],
  ])('neutralizes formula-injection prefix: %j', (input, expected) => {
    expect(csvEscape(input)).toBe(expected)
  })

  it('does NOT prefix safe strings that merely contain = elsewhere', () => {
    expect(csvEscape('a=b')).toBe('"a=b"')
  })
})

describe('tenantFromScope', () => {
  it('extracts tenant id from bare scope', () => {
    expect(tenantFromScope('tenant:acme')).toBe('acme')
  })

  it('extracts tenant id from compound scope', () => {
    expect(tenantFromScope('tenant:acme/workspace:prod')).toBe('acme')
    expect(tenantFromScope('tenant:acme-corp/workspace:prod/agent:bot')).toBe('acme-corp')
  })

  it('handles tenant ids containing dashes, dots, underscores', () => {
    expect(tenantFromScope('tenant:foo.bar_baz-qux')).toBe('foo.bar_baz-qux')
  })

  it('returns empty for non-tenant scopes', () => {
    expect(tenantFromScope('system:audit')).toBe('')
    expect(tenantFromScope('workspace:eng')).toBe('')
  })

  it('returns empty for null / undefined / empty', () => {
    expect(tenantFromScope(null)).toBe('')
    expect(tenantFromScope(undefined)).toBe('')
    expect(tenantFromScope('')).toBe('')
  })

  it('does not match tenant: prefix in the middle of a string', () => {
    expect(tenantFromScope('foo/tenant:acme')).toBe('')
  })
})

// Regression: v0.1.25.18 inlined `fundForm.value.amount.trim()` assuming
// Vue v-model preserved the empty-string initial value as a string. In
// practice Vue 3 v-model on `<input type="number">` coerces user input
// to a number, so .trim() threw `TypeError: trim is not a function` and
// killed the submit handler — user saw "Execute does nothing" with no
// toast or error banner. parsePositiveAmount must therefore accept BOTH
// runtime types the input can produce: the initial empty string, AND
// numbers after Vue's coercion kicks in.
describe('parsePositiveAmount', () => {
  it('accepts a positive number (post-coercion runtime type)', () => {
    expect(parsePositiveAmount(100)).toBe(100)
    expect(parsePositiveAmount(0.5)).toBe(0.5)
    expect(parsePositiveAmount(1e6)).toBe(1e6)
  })

  it('accepts a positive numeric string', () => {
    expect(parsePositiveAmount('100')).toBe(100)
    expect(parsePositiveAmount('0.5')).toBe(0.5)
  })

  it('returns null for empty string (initial form state)', () => {
    expect(parsePositiveAmount('')).toBeNull()
  })

  it('returns null for null / undefined', () => {
    expect(parsePositiveAmount(null)).toBeNull()
    expect(parsePositiveAmount(undefined)).toBeNull()
  })

  it('returns null for zero (must be strictly positive)', () => {
    expect(parsePositiveAmount(0)).toBeNull()
    expect(parsePositiveAmount('0')).toBeNull()
  })

  it('returns null for negative numbers / strings', () => {
    expect(parsePositiveAmount(-5)).toBeNull()
    expect(parsePositiveAmount('-5')).toBeNull()
  })

  it('returns null for NaN / Infinity / -Infinity', () => {
    expect(parsePositiveAmount(NaN)).toBeNull()
    expect(parsePositiveAmount(Infinity)).toBeNull()
    expect(parsePositiveAmount(-Infinity)).toBeNull()
  })

  it('returns null for non-numeric strings', () => {
    expect(parsePositiveAmount('abc')).toBeNull()
    expect(parsePositiveAmount('100abc')).toBeNull()
  })

  it('returns null for non-primitive types (objects, arrays)', () => {
    expect(parsePositiveAmount({})).toBeNull()
    expect(parsePositiveAmount([])).toBeNull() // Number([]) is 0
    expect(parsePositiveAmount([1, 2])).toBeNull() // Number([1,2]) is NaN
  })

  it('does NOT throw on inputs that lack .trim() (the original v0.1.25.18 bug)', () => {
    // Direct regression: any of these values would have crashed
    // submitFund with `TypeError: trim is not a function` in v0.1.25.18.
    // Whatever they evaluate to, parsePositiveAmount must return cleanly.
    expect(() => parsePositiveAmount(100)).not.toThrow()
    expect(() => parsePositiveAmount(0)).not.toThrow()
    expect(() => parsePositiveAmount(null)).not.toThrow()
  })
})

import { describe, it, expect } from 'vitest'
import { safeJsonStringify, csvEscape, tenantFromScope } from '../utils/safe'

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

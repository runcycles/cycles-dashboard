import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { useSort } from '../composables/useSort'

interface Row {
  id: string
  count: number
  name?: string | null
  debt?: number | null
}

describe('useSort', () => {
  const sampleRows: Row[] = [
    { id: 'c', count: 3, name: 'charlie', debt: 100 },
    { id: 'a', count: 1, name: 'alpha',   debt: null },
    { id: 'b', count: 2, name: null,      debt: 50 },
  ]

  it('returns items unchanged when no sortKey is set', () => {
    const items = ref<Row[]>([...sampleRows])
    const { sorted } = useSort(items)
    expect(sorted.value.map(r => r.id)).toEqual(['c', 'a', 'b'])
  })

  it('sorts by a string column ascending by default', () => {
    const items = ref<Row[]>([...sampleRows])
    const s = useSort<Row>(items)
    s.toggle('id')
    expect(s.sorted.value.map(r => r.id)).toEqual(['a', 'b', 'c'])
    expect(s.sortDir.value).toBe('asc')
  })

  it('toggles from asc to desc on second click', () => {
    const items = ref<Row[]>([...sampleRows])
    const s = useSort<Row>(items)
    s.toggle('id')
    s.toggle('id')
    expect(s.sortDir.value).toBe('desc')
    expect(s.sorted.value.map(r => r.id)).toEqual(['c', 'b', 'a'])
  })

  it('switching columns resets direction to asc', () => {
    const items = ref<Row[]>([...sampleRows])
    const s = useSort<Row>(items)
    s.toggle('id')
    s.toggle('id') // now desc
    s.toggle('count')
    expect(s.sortDir.value).toBe('asc')
    expect(s.sorted.value.map(r => r.count)).toEqual([1, 2, 3])
  })

  it('sorts numeric columns numerically (not lexicographically)', () => {
    const items = ref<Row[]>([
      { id: 'x', count: 2 },
      { id: 'y', count: 10 },
      { id: 'z', count: 1 },
    ])
    const s = useSort<Row>(items)
    s.toggle('count')
    // Lexicographic would give [1, 10, 2]; numeric gives [1, 2, 10]
    expect(s.sorted.value.map(r => r.count)).toEqual([1, 2, 10])
  })

  it('places null values at the end (asc)', () => {
    const items = ref<Row[]>([...sampleRows])
    const s = useSort<Row>(items)
    s.toggle('debt')
    expect(s.sorted.value.map(r => r.debt)).toEqual([50, 100, null])
  })

  it('places null values at the end (desc)', () => {
    const items = ref<Row[]>([...sampleRows])
    const s = useSort<Row>(items)
    s.toggle('debt')
    s.toggle('debt') // desc
    expect(s.sorted.value.map(r => r.debt)).toEqual([100, 50, null])
  })

  it('handles both values null', () => {
    const items = ref<Row[]>([
      { id: 'a', count: 1, debt: null },
      { id: 'b', count: 2, debt: null },
    ])
    const s = useSort<Row>(items)
    s.toggle('debt')
    // Stable: order unchanged
    expect(s.sorted.value.map(r => r.id)).toEqual(['a', 'b'])
  })

  it('uses a custom accessor when provided', () => {
    const items = ref<Row[]>([
      { id: 'a', count: 10 },
      { id: 'b', count: 5 },
      { id: 'c', count: 20 },
    ])
    // Sort by count / 10 via accessor
    const s = useSort<Row>(items, undefined, 'asc', {
      scaled: (r) => r.count / 10,
    })
    s.toggle('scaled')
    expect(s.sorted.value.map(r => r.id)).toEqual(['b', 'a', 'c'])
  })

  it('accepts a default sort key', () => {
    const items = ref<Row[]>([...sampleRows])
    const s = useSort<Row>(items, 'id')
    expect(s.sortKey.value).toBe('id')
    expect(s.sorted.value.map(r => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('respects default direction desc', () => {
    const items = ref<Row[]>([...sampleRows])
    const s = useSort<Row>(items, 'id', 'desc')
    expect(s.sorted.value.map(r => r.id)).toEqual(['c', 'b', 'a'])
  })

  it('does not mutate the source array', () => {
    const original = [...sampleRows]
    const items = ref<Row[]>([...sampleRows])
    const s = useSort<Row>(items, 'id')
    void s.sorted.value
    expect(items.value.map(r => r.id)).toEqual(original.map(r => r.id))
  })

  it('reacts to changes in the source items', () => {
    const items = ref<Row[]>([...sampleRows])
    const s = useSort<Row>(items, 'count')
    expect(s.sorted.value.map(r => r.count)).toEqual([1, 2, 3])

    items.value = [
      { id: 'x', count: 100 },
      { id: 'y', count: 50 },
    ]
    expect(s.sorted.value.map(r => r.count)).toEqual([50, 100])
  })

  // ─── Server-side sort mode (V4) ──────────────────────────────────

  describe('server-side mode', () => {
    it('does not re-sort items client-side when serverSide=true', () => {
      const items = ref<Row[]>([...sampleRows])
      const s = useSort<Row>(items, 'id', 'asc', undefined, { serverSide: true })
      // Backing ref is in [c, a, b] order — server-mode passes through
      // verbatim so the cursor tie-breaker the server chose isn't destroyed.
      expect(s.sorted.value.map(r => r.id)).toEqual(['c', 'a', 'b'])
    })

    it('fires onChange with (key, dir) on toggle', () => {
      const items = ref<Row[]>([...sampleRows])
      const calls: Array<[string, 'asc' | 'desc']> = []
      const s = useSort<Row>(items, undefined, 'asc', undefined, {
        serverSide: true,
        onChange: (key, dir) => { calls.push([key, dir]) },
      })
      s.toggle('count')
      expect(calls).toEqual([['count', 'asc']])
      s.toggle('count') // flip to desc
      expect(calls).toEqual([['count', 'asc'], ['count', 'desc']])
      s.toggle('id') // switch column → resets to asc
      expect(calls).toEqual([['count', 'asc'], ['count', 'desc'], ['id', 'asc']])
    })

    it('updates sortKey / sortDir reactively so SortHeader reflects state', () => {
      const items = ref<Row[]>([...sampleRows])
      const s = useSort<Row>(items, 'id', 'asc', undefined, { serverSide: true })
      expect(s.sortKey.value).toBe('id')
      s.toggle('count')
      expect(s.sortKey.value).toBe('count')
      expect(s.sortDir.value).toBe('asc')
      s.toggle('count')
      expect(s.sortDir.value).toBe('desc')
    })

    it('fires onChange in client-mode too when the callback is provided', () => {
      // Client-mode views can use onChange for analytics/telemetry even
      // if they're not re-fetching from the server.
      const items = ref<Row[]>([...sampleRows])
      let called = 0
      const s = useSort<Row>(items, undefined, 'asc', undefined, {
        onChange: () => { called++ },
      })
      s.toggle('id')
      expect(called).toBe(1)
    })
  })
})

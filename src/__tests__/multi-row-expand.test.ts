import { describe, it, expect } from 'vitest'
import { ref, watch, effect, nextTick } from 'vue'

// Pin down the behavior we rely on for the multi-row expansion
// pattern (EventTimeline / EventsView / AuditView): Vue 3's reactivity
// MUST track Set `.add` / `.delete` / `.has` mutations via its
// collection-proxy handlers. If Vue ever regressed this (or we moved
// to a Vue version that dropped collection support), these tests
// would fail and force a rewrite to reassignment-based updates.
describe('Vue 3 Set reactivity (multi-row expansion contract)', () => {
  it('re-runs effects when .add mutates the set', async () => {
    const s = ref(new Set<string>())
    let observed = false
    effect(() => { observed = s.value.has('row-a') })
    expect(observed).toBe(false)
    s.value.add('row-a')
    await nextTick()
    expect(observed).toBe(true)
  })

  it('re-runs effects when .delete mutates the set', async () => {
    const s = ref(new Set<string>(['row-a']))
    let observed: boolean | null = null
    effect(() => { observed = s.value.has('row-a') })
    expect(observed).toBe(true)
    s.value.delete('row-a')
    await nextTick()
    expect(observed).toBe(false)
  })

  it('tracks .size mutations', async () => {
    const s = ref(new Set<string>())
    let size = -1
    watch(() => s.value.size, (n) => { size = n }, { flush: 'sync' })
    s.value.add('a')
    expect(size).toBe(1)
    s.value.add('b')
    expect(size).toBe(2)
    s.value.delete('a')
    expect(size).toBe(1)
  })

  it('supports the toggle pattern used by the three views', () => {
    // Mirrors toggleExpanded(id) in EventsView / AuditView / EventTimeline.
    const expanded = ref(new Set<string>())
    function toggle(id: string) {
      if (expanded.value.has(id)) expanded.value.delete(id)
      else expanded.value.add(id)
    }
    toggle('a')
    toggle('b')
    expect(expanded.value.has('a')).toBe(true)
    expect(expanded.value.has('b')).toBe(true)
    toggle('a')
    expect(expanded.value.has('a')).toBe(false)
    expect(expanded.value.has('b')).toBe(true)
  })
})

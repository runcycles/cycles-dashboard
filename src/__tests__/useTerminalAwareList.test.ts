// v0.1.25.46: unit tests for the shared terminal-aware-list composable.
//
// Covers: hide-by-default, toggle-reveals, sink-terminal-to-bottom,
// URL mirror (both directions), auto-engage on explicit terminal filter,
// all four entity kinds, and the loop-safety guard.

import { describe, it, expect, vi } from 'vitest'
import { ref, nextTick, type Ref } from 'vue'
import { useTerminalAwareList, isTerminalStatus, TERMINAL_STATUSES, TERMINAL_VERB } from '../composables/useTerminalAwareList'

type Row = { id: string; status: string }

function makeRoute(query: Record<string, string> = {}) {
  return { query: { ...query } } as unknown as import('vue-router').RouteLocationNormalizedLoaded
}

function makeRouter(route: { query: Record<string, string> }) {
  const replace = vi.fn((loc: { query: Record<string, string | undefined> }) => {
    const next: Record<string, string> = {}
    for (const [k, v] of Object.entries(loc.query)) {
      if (v !== undefined) next[k] = v
    }
    route.query = next
    return Promise.resolve()
  })
  return { replace, push: vi.fn() } as unknown as import('vue-router').Router & { replace: ReturnType<typeof vi.fn> }
}

describe('useTerminalAwareList — shared composable', () => {
  describe('TERMINAL_STATUSES matches the governance-spec lifecycle terminals', () => {
    it('tenant terminal = CLOSED', () => {
      expect(TERMINAL_STATUSES.tenant).toEqual(['CLOSED'])
    })
    it('budget terminal = CLOSED', () => {
      expect(TERMINAL_STATUSES.budget).toEqual(['CLOSED'])
    })
    it('webhook terminal = DISABLED', () => {
      expect(TERMINAL_STATUSES.webhook).toEqual(['DISABLED'])
    })
    it('apiKey terminals = REVOKED + EXPIRED (both are effectively no-go)', () => {
      expect(TERMINAL_STATUSES.apiKey).toEqual(['REVOKED', 'EXPIRED'])
    })
  })

  describe('TERMINAL_VERB humanizes the enum for the UI toggle label', () => {
    it('uses participles, not enum literals', () => {
      expect(TERMINAL_VERB.tenant).toBe('closed')
      expect(TERMINAL_VERB.budget).toBe('closed')
      expect(TERMINAL_VERB.webhook).toBe('disabled')
      expect(TERMINAL_VERB.apiKey).toBe('revoked')
    })
  })

  describe('isTerminalStatus', () => {
    it('returns false for empty/null status regardless of kind', () => {
      expect(isTerminalStatus('tenant', null)).toBe(false)
      expect(isTerminalStatus('budget', '')).toBe(false)
    })
    it('catches both apiKey terminals', () => {
      expect(isTerminalStatus('apiKey', 'REVOKED')).toBe(true)
      expect(isTerminalStatus('apiKey', 'EXPIRED')).toBe(true)
      expect(isTerminalStatus('apiKey', 'ACTIVE')).toBe(false)
    })
  })

  describe('default behavior — hide terminals', () => {
    it('filters out terminal rows by default (no route/router wiring)', () => {
      const source: Ref<Row[]> = ref([
        { id: 'a', status: 'ACTIVE' },
        { id: 'b', status: 'CLOSED' },
        { id: 'c', status: 'ACTIVE' },
      ])
      const { visibleRows, terminalCount, includeTerminal } = useTerminalAwareList<Row>({
        kind: 'budget',
        source,
        statusOf: r => r.status,
      })
      expect(includeTerminal.value).toBe(false)
      expect(visibleRows.value.map(r => r.id)).toEqual(['a', 'c'])
      // terminalCount reflects source, not visibleRows — the UI uses it to
      // render "(1)" next to the toggle label.
      expect(terminalCount.value).toBe(1)
    })

    it('returns an empty array gracefully when all rows are terminal', () => {
      const source: Ref<Row[]> = ref([
        { id: 'a', status: 'CLOSED' },
        { id: 'b', status: 'CLOSED' },
      ])
      const { visibleRows } = useTerminalAwareList<Row>({
        kind: 'budget',
        source,
        statusOf: r => r.status,
      })
      expect(visibleRows.value).toEqual([])
    })

    it('passes through unchanged when there are no terminals', () => {
      const source: Ref<Row[]> = ref([
        { id: 'a', status: 'ACTIVE' },
        { id: 'b', status: 'ACTIVE' },
      ])
      const { visibleRows } = useTerminalAwareList<Row>({
        kind: 'budget',
        source,
        statusOf: r => r.status,
      })
      expect(visibleRows.value).toHaveLength(2)
    })
  })

  describe('toggle reveals — stable partition sinks terminals to bottom', () => {
    it('concats active-first, terminal-last, preserving upstream order within each group', () => {
      const source: Ref<Row[]> = ref([
        { id: 'x', status: 'CLOSED' },
        { id: 'a', status: 'ACTIVE' },
        { id: 'y', status: 'CLOSED' },
        { id: 'b', status: 'ACTIVE' },
      ])
      const { visibleRows, includeTerminal } = useTerminalAwareList<Row>({
        kind: 'budget',
        source,
        statusOf: r => r.status,
      })
      includeTerminal.value = true
      expect(visibleRows.value.map(r => r.id)).toEqual(['a', 'b', 'x', 'y'])
    })
  })

  describe('URL mirror — ref ↔ route.query[include_terminal]', () => {
    it('reads ?include_terminal=1 at init to set includeTerminal true', () => {
      const route = makeRoute({ include_terminal: '1' })
      const router = makeRouter(route as unknown as { query: Record<string, string> })
      const source: Ref<Row[]> = ref([{ id: 'a', status: 'CLOSED' }])
      const { includeTerminal } = useTerminalAwareList<Row>({
        kind: 'webhook',
        source,
        statusOf: r => r.status,
        route,
        router,
      })
      expect(includeTerminal.value).toBe(true)
    })

    it('writes ?include_terminal=1 on toggle flip', async () => {
      const route = makeRoute()
      const router = makeRouter(route as unknown as { query: Record<string, string> })
      const source: Ref<Row[]> = ref([{ id: 'a', status: 'CLOSED' }])
      const { includeTerminal } = useTerminalAwareList<Row>({
        kind: 'webhook',
        source,
        statusOf: r => r.status,
        route,
        router,
      })
      includeTerminal.value = true
      await nextTick()
      expect(router.replace).toHaveBeenCalledTimes(1)
      const call = (router.replace as ReturnType<typeof vi.fn>).mock.calls[0][0] as { query: Record<string, string | undefined> }
      expect(call.query.include_terminal).toBe('1')
    })

    it('clears the URL param on toggle off (value=undefined drops the key)', async () => {
      const route = makeRoute({ include_terminal: '1' })
      const router = makeRouter(route as unknown as { query: Record<string, string> })
      const source: Ref<Row[]> = ref([{ id: 'a', status: 'CLOSED' }])
      const { includeTerminal } = useTerminalAwareList<Row>({
        kind: 'webhook',
        source,
        statusOf: r => r.status,
        route,
        router,
      })
      expect(includeTerminal.value).toBe(true)
      includeTerminal.value = false
      await nextTick()
      expect(router.replace).toHaveBeenCalledTimes(1)
      const call = (router.replace as ReturnType<typeof vi.fn>).mock.calls[0][0] as { query: Record<string, string | undefined> }
      expect(call.query.include_terminal).toBeUndefined()
    })

    it('loop-safe: a URL-driven ref at mount-time does not re-push the same URL', async () => {
      const route = makeRoute({ include_terminal: '1' })
      const router = makeRouter(route as unknown as { query: Record<string, string> })
      const source: Ref<Row[]> = ref([{ id: 'a', status: 'CLOSED' }])
      useTerminalAwareList<Row>({
        kind: 'webhook',
        source,
        statusOf: r => r.status,
        route,
        router,
      })
      await nextTick()
      expect(router.replace).not.toHaveBeenCalled()
    })
  })

  describe('auto-engage on explicit terminal filter', () => {
    it('shows terminals when explicitStatus matches a terminal value, even with toggle off', () => {
      const source: Ref<Row[]> = ref([
        { id: 'a', status: 'ACTIVE' },
        { id: 'b', status: 'CLOSED' },
      ])
      const explicitStatus = ref('CLOSED')
      const { visibleRows, showTerminal } = useTerminalAwareList<Row>({
        kind: 'budget',
        source,
        statusOf: r => r.status,
        explicitStatus,
      })
      expect(showTerminal.value).toBe(true)
      expect(visibleRows.value.map(r => r.id)).toEqual(['a', 'b'])
    })

    it('leaves visibility alone when explicitStatus is a non-terminal value', () => {
      const source: Ref<Row[]> = ref([
        { id: 'a', status: 'ACTIVE' },
        { id: 'b', status: 'CLOSED' },
      ])
      const explicitStatus = ref('ACTIVE')
      const { visibleRows } = useTerminalAwareList<Row>({
        kind: 'budget',
        source,
        statusOf: r => r.status,
        explicitStatus,
      })
      expect(visibleRows.value.map(r => r.id)).toEqual(['a'])
    })
  })

  describe('custom queryParam', () => {
    it('writes to a custom key when queryParam is overridden', async () => {
      const route = makeRoute()
      const router = makeRouter(route as unknown as { query: Record<string, string> })
      const source: Ref<Row[]> = ref([{ id: 'a', status: 'CLOSED' }])
      const { includeTerminal } = useTerminalAwareList<Row>({
        kind: 'webhook',
        source,
        statusOf: r => r.status,
        route,
        router,
        queryParam: 'show_disabled',
      })
      includeTerminal.value = true
      await nextTick()
      const call = (router.replace as ReturnType<typeof vi.fn>).mock.calls[0][0] as { query: Record<string, string | undefined> }
      expect(call.query.show_disabled).toBe('1')
    })
  })
})

// Unit tests for the shared CorrelationIdChip — the single affordance
// used to render trace_id / request_id / correlation_id across
// AuditView, EventsView, EventTimeline, WebhookDetailView. Covers
// truncation, tooltip, copy-to-clipboard guard, pivot routing per
// `kind`, and display-only (non-pivoting) mode.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import CorrelationIdChip from '../components/CorrelationIdChip.vue'

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/audit', name: 'audit', component: { template: '<div />' } },
      { path: '/events', name: 'events', component: { template: '<div />' } },
    ],
  })
}

async function mountChip(props: {
  kind: 'trace' | 'request' | 'correlation'
  value: string
  pivot?: 'audit' | 'events' | null
}) {
  const router = makeRouter()
  router.push('/')
  await router.isReady()
  const w = mount(CorrelationIdChip, {
    props,
    global: { plugins: [router] },
  })
  return { w, router }
}

describe('CorrelationIdChip', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('renders trace_id truncated (first 8 … last 4) with full value in tooltip', async () => {
    const full = '0123456789abcdef0123456789abcdef'
    const { w } = await mountChip({ kind: 'trace', value: full, pivot: 'events' })
    expect(w.text()).toContain('01234567…cdef')
    expect(w.html()).toContain(`title="${full}"`)
  })

  it('renders short ids (≤16 chars) in full without truncation', async () => {
    const { w } = await mountChip({ kind: 'request', value: 'req_abc12345', pivot: 'audit' })
    expect(w.text()).toContain('req_abc12345')
    expect(w.text()).not.toContain('…')
  })

  it('renders as a button with pivot kind in the aria label', async () => {
    const { w } = await mountChip({ kind: 'trace', value: 'abc'.repeat(10) + 'de', pivot: 'events' })
    const btn = w.find('button[aria-label^="Filter by trace id"]')
    expect(btn.exists()).toBe(true)
  })

  it('renders as a span (no pivot button) when pivot is omitted', async () => {
    const { w } = await mountChip({ kind: 'correlation', value: 'corr_xyz' })
    expect(w.find('button[aria-label^="Filter by"]').exists()).toBe(false)
    // Copy button still available — the chip is always copyable even
    // when it's display-only.
    expect(w.find('button[aria-label^="Copy"]').exists()).toBe(true)
  })

  it('pushes the correct /events?trace_id=... on pivot click', async () => {
    const { w, router } = await mountChip({
      kind: 'trace',
      value: '0123456789abcdef0123456789abcdef',
      pivot: 'events',
    })
    await w.find('button[aria-label^="Filter by trace id"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/events')
    expect(router.currentRoute.value.query.trace_id).toBe('0123456789abcdef0123456789abcdef')
  })

  it('pushes /audit?request_id=... for kind=request with pivot=audit', async () => {
    const { w, router } = await mountChip({ kind: 'request', value: 'req_12345', pivot: 'audit' })
    await w.find('button[aria-label^="Filter by request id"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/audit')
    expect(router.currentRoute.value.query.request_id).toBe('req_12345')
  })

  it('pushes /events?correlation_id=... for kind=correlation with pivot=events', async () => {
    const { w, router } = await mountChip({ kind: 'correlation', value: 'corr_abc', pivot: 'events' })
    await w.find('button[aria-label^="Filter by correlation id"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/events')
    expect(router.currentRoute.value.query.correlation_id).toBe('corr_abc')
  })

  it('copies the full value (not the truncated display) when Copy is clicked', async () => {
    const full = 'abcd1234'.repeat(4) // 32 hex
    const { w } = await mountChip({ kind: 'trace', value: full, pivot: 'events' })
    await w.find('button[aria-label^="Copy trace id"]').trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(full)
  })

  it('stops click propagation on the pivot button so enclosing row click does not fire', async () => {
    const full = '0123456789abcdef0123456789abcdef'
    const { w } = await mountChip({ kind: 'trace', value: full, pivot: 'events' })
    const parentHandler = vi.fn()
    // Wrap the chip in an outer listener: without stopPropagation the
    // outer handler would receive the click too. The chip's pivot
    // click calls e.stopPropagation() explicitly.
    const outer = document.createElement('div')
    outer.addEventListener('click', parentHandler)
    outer.appendChild(w.element)
    await w.find('button[aria-label^="Filter by trace id"]').trigger('click')
    expect(parentHandler).not.toHaveBeenCalled()
  })

  it('silently no-ops when navigator.clipboard is missing (insecure context)', async () => {
    // Simulate clipboard unavailable (e.g. http:// dev preview).
    Object.assign(navigator, { clipboard: undefined })
    const { w } = await mountChip({ kind: 'trace', value: 'abc'.repeat(10) + 'de', pivot: 'events' })
    // Should not throw.
    await w.find('button[aria-label^="Copy trace id"]').trigger('click')
    // And the chip still pivots normally.
    await w.find('button[aria-label^="Filter by trace id"]').trigger('click')
  })
})

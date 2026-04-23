import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import PageHeader from '../components/PageHeader.vue'

describe('PageHeader count label', () => {
  it('omits the count line when loaded is not provided', () => {
    const wrapper = mount(PageHeader, { props: { title: 'Tenants' } })
    expect(wrapper.text()).not.toMatch(/Showing/)
  })

  it('pluralizes the noun naively by appending s', () => {
    const wrapper = mount(PageHeader, {
      props: { title: 'Webhooks', loaded: 3, total: 10, itemNoun: 'webhook' },
    })
    expect(wrapper.text()).toContain('Showing 3 of 10 webhooks')
  })

  it('uses the singular noun when loaded/total is 1', () => {
    const wrapper = mount(PageHeader, {
      props: { title: 'Webhooks', loaded: 1, total: 1, itemNoun: 'webhook' },
    })
    expect(wrapper.text()).toContain('Showing 1 of 1 webhook')
  })

  it('respects itemNounPlural override for irregular plurals', () => {
    // Naive "${noun}s" would produce "log entrys" — the override is
    // the whole reason this prop exists.
    const wrapper = mount(PageHeader, {
      props: {
        title: 'Audit Logs',
        loaded: 5,
        hasMore: true,
        itemNoun: 'log entry',
        itemNounPlural: 'log entries',
      },
    })
    const text = wrapper.text()
    expect(text).toContain('log entries loaded')
    expect(text).not.toMatch(/log entrys/)
  })

  it('still uses the singular noun when count is 1 even with a plural override', () => {
    const wrapper = mount(PageHeader, {
      props: {
        title: 'Audit Logs',
        loaded: 1,
        total: 1,
        itemNoun: 'log entry',
        itemNounPlural: 'log entries',
      },
    })
    expect(wrapper.text()).toContain('Showing 1 of 1 log entry')
  })

  it('renders the count inside a polite aria-live region for screen readers', () => {
    const wrapper = mount(PageHeader, {
      props: { title: 'Tenants', loaded: 42, itemNoun: 'tenant' },
    })
    const live = wrapper.find('[aria-live="polite"]')
    expect(live.exists()).toBe(true)
    expect(live.text()).toContain('42 tenants')
  })
})

// P1-M2 (revised) freshness pill. Stale-only signal — the pill is
// INVISIBLE during healthy polling and appears (in amber) only when a
// tick has been missed. Absence = fresh, presence = "trust this data
// less." Regression-lock the stale threshold, the copy, the amber
// styling, and the absolute-timestamp tooltip.
describe('PageHeader freshness pill (P1-M2 revised)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-23T12:00:00Z'))
  })
  afterEach(() => { vi.useRealTimers() })

  it('omits the pill when lastUpdatedAt is null', () => {
    const wrapper = mount(PageHeader, {
      props: { title: 'Overview', lastUpdatedAt: null },
    })
    expect(wrapper.find('[data-testid="page-header-last-updated"]').exists()).toBe(false)
  })

  it('hides the pill when data is fresh (age < 90s)', () => {
    // 30 seconds ago — healthy polling interval.
    const fresh = new Date(Date.now() - 30_000)
    const wrapper = mount(PageHeader, {
      props: { title: 'Overview', lastUpdatedAt: fresh },
    })
    expect(wrapper.find('[data-testid="page-header-last-updated"]').exists()).toBe(false)
  })

  it('shows the pill with amber styling when data is stale (age >= 90s)', () => {
    // 15 minutes ago — well past the 90s threshold.
    const stale = new Date('2026-04-23T11:45:00Z')
    const wrapper = mount(PageHeader, {
      props: { title: 'Overview', lastUpdatedAt: stale },
    })
    const pill = wrapper.find('[data-testid="page-header-last-updated"]')
    expect(pill.exists()).toBe(true)
    expect(pill.text()).toMatch(/Last updated .* ago/)
    // Amber styling is load-bearing — it's the "trust this less" cue.
    expect(pill.classes()).toContain('text-amber-700')
    // Tooltip carries the absolute timestamp so operators can correlate
    // with server-side audit entries.
    expect(pill.attributes('title')).toBe(stale.toString())
  })
})

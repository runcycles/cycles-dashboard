import { describe, it, expect } from 'vitest'
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

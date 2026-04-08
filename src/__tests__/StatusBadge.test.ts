import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StatusBadge from '../components/StatusBadge.vue'

describe('StatusBadge', () => {
  it('renders status text', () => {
    const wrapper = mount(StatusBadge, { props: { status: 'ACTIVE' } })
    expect(wrapper.text()).toBe('ACTIVE')
  })

  it('applies green for ACTIVE', () => {
    const wrapper = mount(StatusBadge, { props: { status: 'ACTIVE' } })
    expect(wrapper.find('span').classes()).toContain('bg-green-100')
  })

  it('applies yellow for FROZEN', () => {
    const wrapper = mount(StatusBadge, { props: { status: 'FROZEN' } })
    expect(wrapper.find('span').classes()).toContain('bg-yellow-100')
  })

  it('applies yellow for SUSPENDED', () => {
    const wrapper = mount(StatusBadge, { props: { status: 'SUSPENDED' } })
    expect(wrapper.find('span').classes()).toContain('bg-yellow-100')
  })

  it('applies red for CLOSED', () => {
    const wrapper = mount(StatusBadge, { props: { status: 'CLOSED' } })
    expect(wrapper.find('span').classes()).toContain('bg-red-100')
  })

  it('applies red for DISABLED', () => {
    const wrapper = mount(StatusBadge, { props: { status: 'DISABLED' } })
    expect(wrapper.find('span').classes()).toContain('bg-red-100')
  })

  it('applies gray for unknown status', () => {
    const wrapper = mount(StatusBadge, { props: { status: 'UNKNOWN' } })
    expect(wrapper.find('span').classes()).toContain('bg-gray-100')
  })
})

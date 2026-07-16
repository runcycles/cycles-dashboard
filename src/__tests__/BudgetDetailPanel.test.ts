import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import BudgetDetailPanel from '../components/BudgetDetailPanel.vue'
import type { BudgetLedger } from '../types'

function budget(status = 'ACTIVE'): BudgetLedger {
  return {
    ledger_id: 'ledger-1',
    scope: 'tenant:acme/workspace:prod',
    unit: 'USD_MICROCENTS',
    allocated: { unit: 'USD_MICROCENTS', amount: 1000 },
    remaining: { unit: 'USD_MICROCENTS', amount: 750 },
    reserved: { unit: 'USD_MICROCENTS', amount: 100 },
    spent: { unit: 'USD_MICROCENTS', amount: 150 },
    debt: { unit: 'USD_MICROCENTS', amount: 12 },
    overdraft_limit: { unit: 'USD_MICROCENTS', amount: 100 },
    status,
    created_at: '2026-07-16T00:00:00Z',
  }
}

describe('BudgetDetailPanel', () => {
  it('preserves metrics and ACTIVE management actions', async () => {
    const wrapper = mount(BudgetDetailPanel, {
      props: {
        budget: budget(), events: [], canManage: true,
        eventsHasMore: false, eventsLoadingMore: false, eventsCursor: '',
      },
      global: { stubs: { EventTimeline: true, StatusBadge: true, UtilizationBar: true } },
    })

    expect(wrapper.text()).toContain('tenant:acme/workspace:prod')
    expect(wrapper.text()).toContain('Allocated1,000')
    expect(wrapper.text()).toContain('Reserved100')
    expect(wrapper.text()).toContain('Debt12')

    await wrapper.get('button.btn-pill-primary').trigger('click')
    await wrapper.get('button.btn-pill-secondary').trigger('click')
    await wrapper.get('button.btn-pill-danger').trigger('click')
    expect(wrapper.emitted('fund')).toHaveLength(1)
    expect(wrapper.emitted('edit')).toHaveLength(1)
    expect(wrapper.emitted('freeze')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('Unfreeze')
  })

  it('shows FROZEN unfreeze and forwards timeline pagination', async () => {
    const wrapper = mount(BudgetDetailPanel, {
      props: {
        budget: budget('FROZEN'), events: [], canManage: true,
        eventsHasMore: true, eventsLoadingMore: false, eventsCursor: 'cursor-1',
      },
      global: { stubs: { EventTimeline: true, StatusBadge: true, UtilizationBar: true } },
    })

    expect(wrapper.text()).not.toContain('Fund Budget')
    await wrapper.get('button.btn-pill-success').trigger('click')
    await wrapper.get('button.text-xs').trigger('click')
    expect(wrapper.emitted('unfreeze')).toHaveLength(1)
    expect(wrapper.emitted('loadMoreEvents')).toHaveLength(1)
  })

  it('hides all mutation actions without manage capability', () => {
    const wrapper = mount(BudgetDetailPanel, {
      props: {
        budget: budget(), events: [], canManage: false,
        eventsHasMore: false, eventsLoadingMore: false, eventsCursor: '',
      },
      global: { stubs: { EventTimeline: true, StatusBadge: true, UtilizationBar: true } },
    })
    expect(wrapper.findAll('button')).toHaveLength(0)
  })
})

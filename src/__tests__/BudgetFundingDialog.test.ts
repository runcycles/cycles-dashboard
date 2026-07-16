import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import BudgetFundingDialog from '../components/BudgetFundingDialog.vue'
import type { BudgetFundingForm } from '../composables/useBudgetFunding'
import type { BudgetLedger } from '../types'

const target: BudgetLedger = {
  ledger_id: 'ledger-1',
  scope: 'tenant:acme/workspace:prod',
  unit: 'USD_MICROCENTS',
  allocated: { unit: 'USD_MICROCENTS', amount: 1000 },
  remaining: { unit: 'USD_MICROCENTS', amount: 750 },
  debt: { unit: 'USD_MICROCENTS', amount: 12 },
  status: 'ACTIVE',
  created_at: '2026-07-16T00:00:00Z',
}

function form(overrides: Partial<BudgetFundingForm> = {}): BudgetFundingForm {
  return { operation: 'CREDIT', amount: '', reason: '', spent: '', ...overrides }
}

describe('BudgetFundingDialog', () => {
  it('renders the target summary and all funding operations', () => {
    const wrapper = mount(BudgetFundingDialog, { props: { target, form: form() } })

    expect(wrapper.text()).toContain('tenant:acme/workspace:prod')
    expect(wrapper.text()).toContain('1,000')
    expect(wrapper.text()).toContain('750')
    expect(wrapper.findAll('#fund-op option').map(option => option.attributes('value'))).toEqual([
      'CREDIT', 'DEBIT', 'RESET', 'RESET_SPENT', 'REPAY_DEBT',
    ])
  })

  it('emits immutable form replacements and reveals rollover fields', async () => {
    const wrapper = mount(BudgetFundingDialog, { props: { target, form: form() } })
    await wrapper.get('#fund-op').setValue('RESET_SPENT')

    const update = wrapper.emitted('update:form')?.at(-1)?.[0] as BudgetFundingForm
    expect(update).toEqual({ operation: 'RESET_SPENT', amount: '', reason: '', spent: '' })
    expect(wrapper.props('form').operation).toBe('CREDIT')

    await wrapper.setProps({ form: update })
    expect(wrapper.find('#fund-spent').exists()).toBe(true)
    expect(wrapper.text()).toContain('sets allocated for the new period')
  })

  it('forwards submit and cancel through FormDialog', async () => {
    const wrapper = mount(BudgetFundingDialog, { props: { target, form: form({ amount: 10 }) } })
    await wrapper.get('form').trigger('submit')
    await wrapper.get('button[type="button"]').trigger('click')
    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })
})

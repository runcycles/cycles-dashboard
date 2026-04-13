import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ConfirmAction from '../components/ConfirmAction.vue'

const baseProps = {
  title: 'Rotate signing secret?',
  message: 'This invalidates the old secret immediately.',
  confirmLabel: 'Rotate Secret',
}

describe('ConfirmAction', () => {
  it('renders title, message, and the two buttons', () => {
    const w = mount(ConfirmAction, { props: baseProps })
    expect(w.text()).toContain('Rotate signing secret?')
    expect(w.text()).toContain('This invalidates')
    const buttons = w.findAll('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0].text()).toBe('Cancel')
    expect(buttons[1].text()).toContain('Rotate Secret')
  })

  it('emits confirm / cancel when respective buttons clicked', async () => {
    const w = mount(ConfirmAction, { props: baseProps })
    await w.findAll('button')[1].trigger('click')
    expect(w.emitted('confirm')).toHaveLength(1)
    await w.findAll('button')[0].trigger('click')
    expect(w.emitted('cancel')).toHaveLength(1)
  })

  // Regression: previously the consuming view would set
  // `pendingRotate.value = false` *before* awaiting the PATCH, so on a
  // 403/timeout the user saw nothing happen for seconds and then a
  // disconnected toast. The dialog must now stay open with a spinner
  // until the caller resolves the operation.
  describe('loading prop', () => {
    it('disables confirm button while loading', () => {
      const w = mount(ConfirmAction, { props: { ...baseProps, loading: true } })
      const confirmBtn = w.findAll('button')[1]
      expect(confirmBtn.attributes('disabled')).toBeDefined()
    })

    it('disables cancel button while loading (prevents abandoning an in-flight op)', () => {
      const w = mount(ConfirmAction, { props: { ...baseProps, loading: true } })
      const cancelBtn = w.findAll('button')[0]
      expect(cancelBtn.attributes('disabled')).toBeDefined()
    })

    it('renders a spinner inside the confirm button while loading', () => {
      const w = mount(ConfirmAction, { props: { ...baseProps, loading: true } })
      const confirmBtn = w.findAll('button')[1]
      expect(confirmBtn.find('svg.animate-spin').exists()).toBe(true)
    })

    it('does NOT emit cancel when backdrop is clicked while loading', async () => {
      const w = mount(ConfirmAction, { props: { ...baseProps, loading: true } })
      await w.find('.fixed.inset-0').trigger('click.self')
      expect(w.emitted('cancel')).toBeUndefined()
    })

    it('DOES emit cancel on backdrop click when not loading', async () => {
      const w = mount(ConfirmAction, { props: baseProps })
      await w.find('.fixed.inset-0').trigger('click.self')
      expect(w.emitted('cancel')).toHaveLength(1)
    })
  })

  describe('error prop', () => {
    it('renders an inline error block when error is set', () => {
      const w = mount(ConfirmAction, { props: { ...baseProps, error: 'Permission denied (FORBIDDEN)' } })
      const alert = w.find('[role="alert"]')
      expect(alert.exists()).toBe(true)
      expect(alert.text()).toContain('Permission denied')
    })

    it('does not render the error block when error is empty', () => {
      const w = mount(ConfirmAction, { props: { ...baseProps, error: '' } })
      expect(w.find('[role="alert"]').exists()).toBe(false)
    })

    it('keeps confirm enabled after error so the user can retry', () => {
      const w = mount(ConfirmAction, { props: { ...baseProps, error: 'something failed' } })
      const confirmBtn = w.findAll('button')[1]
      expect(confirmBtn.attributes('disabled')).toBeUndefined()
    })
  })
})

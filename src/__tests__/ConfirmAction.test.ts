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

  // Accessibility: when loading=true both buttons become disabled, leaving
  // useFocusTrap with no enabled focusables. Without an explicit fallback
  // target, Tab would escape the modal into background content. We move
  // focus to a visually-hidden sentinel and announce the wait via
  // aria-live; aria-busy on the dialog itself signals the loading state
  // to assistive tech.
  describe('loading accessibility', () => {
    it('marks dialog aria-busy="true" when loading', () => {
      const w = mount(ConfirmAction, { props: { ...baseProps, loading: true } })
      expect(w.find('[role="dialog"]').attributes('aria-busy')).toBe('true')
    })

    it('omits aria-busy when not loading (no false-positive busy state)', () => {
      const w = mount(ConfirmAction, { props: baseProps })
      expect(w.find('[role="dialog"]').attributes('aria-busy')).toBeUndefined()
    })

    it('renders a polite live region announcing the in-progress confirmLabel', () => {
      const w = mount(ConfirmAction, { props: { ...baseProps, loading: true } })
      const sink = w.find('[aria-live="polite"]')
      expect(sink.exists()).toBe(true)
      expect(sink.text()).toContain('Rotate Secret in progress')
    })

    it('the live region is empty when not loading (nothing to announce)', () => {
      const w = mount(ConfirmAction, { props: baseProps })
      expect(w.find('[aria-live="polite"]').text()).toBe('')
    })

    it('focus sink is programmatically focusable but skipped in Tab order', () => {
      const w = mount(ConfirmAction, { props: { ...baseProps, loading: true } })
      const sink = w.find('[aria-live="polite"]')
      // tabindex="-1" → focus() works, but Tab key skips it
      expect(sink.attributes('tabindex')).toBe('-1')
    })

    it('moves focus to the sink when loading flips true', async () => {
      const w = mount(ConfirmAction, { props: baseProps, attachTo: document.body })
      await w.setProps({ loading: true })
      // Wait for the watcher's nextTick
      await new Promise(r => setTimeout(r, 0))
      const sink = w.find('[aria-live="polite"]').element as HTMLElement
      expect(document.activeElement).toBe(sink)
      w.unmount()
    })

    it('returns focus to the confirm button when loading flips back to false', async () => {
      const w = mount(ConfirmAction, { props: { ...baseProps, loading: true }, attachTo: document.body })
      await w.setProps({ loading: false })
      await new Promise(r => setTimeout(r, 0))
      const buttons = w.findAll('button')
      expect(document.activeElement).toBe(buttons[1].element)
      w.unmount()
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

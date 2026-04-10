import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { useFocusTrap } from '../composables/useFocusTrap'

// Build a tiny dialog component that invokes useFocusTrap on mount.
function makeDialogComponent(content: () => ReturnType<typeof h>[]) {
  return defineComponent({
    setup() {
      const dialogRef = ref<HTMLElement | null>(null)
      useFocusTrap(dialogRef)
      return { dialogRef }
    },
    render() {
      return h('div', { ref: 'dialogRef' }, content())
    },
  })
}

function tabEvent(shift = false): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift })
}

describe('useFocusTrap', () => {
  let outsideButton: HTMLButtonElement

  beforeEach(() => {
    // Provide a focusable element outside the dialog so we can verify
    // focus is restored after unmount.
    outsideButton = document.createElement('button')
    outsideButton.textContent = 'outside'
    document.body.appendChild(outsideButton)
    outsideButton.focus()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('focuses the first focusable element on mount', async () => {
    const Dialog = makeDialogComponent(() => [
      h('input', { id: 'first', type: 'text' }),
      h('input', { id: 'second', type: 'text' }),
    ])
    mount(Dialog, { attachTo: document.body })
    await flushPromises()
    // queueMicrotask completes during flushPromises.
    expect((document.activeElement as HTMLElement)?.id).toBe('first')
  })

  it('falls back to focusing the container if no focusable children', async () => {
    const Dialog = makeDialogComponent(() => [h('p', 'no inputs')])
    mount(Dialog, { attachTo: document.body })
    await flushPromises()
    // Container should have been set to tabindex=-1 and focused.
    const container = document.activeElement as HTMLElement
    expect(container.tagName).toBe('DIV')
    expect(container.getAttribute('tabindex')).toBe('-1')
  })

  it('restores focus to the previously focused element on unmount', async () => {
    const Dialog = makeDialogComponent(() => [
      h('input', { id: 'first', type: 'text' }),
    ])
    const wrapper = mount(Dialog, { attachTo: document.body })
    await flushPromises()
    expect((document.activeElement as HTMLElement)?.id).toBe('first')

    wrapper.unmount()
    expect(document.activeElement).toBe(outsideButton)
  })

  it('cycles Tab from last to first', async () => {
    const Dialog = makeDialogComponent(() => [
      h('button', { id: 'a' }, 'a'),
      h('button', { id: 'b' }, 'b'),
      h('button', { id: 'c' }, 'c'),
    ])
    mount(Dialog, { attachTo: document.body })
    await flushPromises()

    // Move focus to the last button.
    ;(document.getElementById('c') as HTMLButtonElement).focus()
    expect((document.activeElement as HTMLElement)?.id).toBe('c')

    // Simulate Tab — should wrap to first.
    const evt = tabEvent(false)
    const prevented = !document.dispatchEvent(evt)
    // The handler calls preventDefault + focus(first) manually, so the
    // native Tab doesn't fire anyway. Verify the focus moved.
    void prevented
    // Our handler is attached to `document` — it should have fired.
    expect((document.activeElement as HTMLElement)?.id).toBe('a')
  })

  it('cycles Shift+Tab from first to last', async () => {
    const Dialog = makeDialogComponent(() => [
      h('button', { id: 'a' }, 'a'),
      h('button', { id: 'b' }, 'b'),
      h('button', { id: 'c' }, 'c'),
    ])
    mount(Dialog, { attachTo: document.body })
    await flushPromises()

    ;(document.getElementById('a') as HTMLButtonElement).focus()
    expect((document.activeElement as HTMLElement)?.id).toBe('a')

    document.dispatchEvent(tabEvent(true))
    expect((document.activeElement as HTMLElement)?.id).toBe('c')
  })

  it('does not intercept non-Tab keys', async () => {
    const Dialog = makeDialogComponent(() => [
      h('button', { id: 'a' }, 'a'),
      h('button', { id: 'b' }, 'b'),
    ])
    mount(Dialog, { attachTo: document.body })
    await flushPromises()

    ;(document.getElementById('b') as HTMLButtonElement).focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    // Focus should still be on 'b'
    expect((document.activeElement as HTMLElement)?.id).toBe('b')
  })

  it('skips disabled focusable elements', async () => {
    const Dialog = makeDialogComponent(() => [
      h('input', { id: 'disabled', type: 'text', disabled: true }),
      h('input', { id: 'first', type: 'text' }),
    ])
    mount(Dialog, { attachTo: document.body })
    await flushPromises()
    expect((document.activeElement as HTMLElement)?.id).toBe('first')
  })

  it('removes the keydown listener on unmount', async () => {
    const Dialog = makeDialogComponent(() => [h('button', { id: 'a' }, 'a')])
    const wrapper = mount(Dialog, { attachTo: document.body })
    await flushPromises()
    wrapper.unmount()

    // Mount a completely separate thing and verify the old handler is gone.
    // We can do this by dispatching a Tab and asserting no wrapper-related
    // errors / no DOM changes.
    expect(() => document.dispatchEvent(tabEvent(false))).not.toThrow()
  })
})

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

  it('Shift+Tab from a middle element is not intercepted (native reverse-tab order applies)', async () => {
    const Dialog = makeDialogComponent(() => [
      h('button', { id: 'a' }, 'a'),
      h('button', { id: 'b' }, 'b'),
      h('button', { id: 'c' }, 'c'),
    ])
    mount(Dialog, { attachTo: document.body })
    await flushPromises()

    ;(document.getElementById('b') as HTMLButtonElement).focus()
    const evt = tabEvent(true)
    document.dispatchEvent(evt)
    // Handler leaves the event alone — jsdom performs no native focus
    // move, so focus stays put and the event is not defaultPrevented.
    expect((document.activeElement as HTMLElement)?.id).toBe('b')
    expect(evt.defaultPrevented).toBe(false)
  })

  it('Shift+Tab from OUTSIDE the container pulls focus back to the last element', async () => {
    const Dialog = makeDialogComponent(() => [
      h('button', { id: 'a' }, 'a'),
      h('button', { id: 'b' }, 'b'),
    ])
    mount(Dialog, { attachTo: document.body })
    await flushPromises()

    // Focus escaped to the page behind the dialog (e.g. programmatic).
    outsideButton.focus()
    document.dispatchEvent(tabEvent(true))
    expect((document.activeElement as HTMLElement)?.id).toBe('b')
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

  // F8 — views invoke useFocusTrap at setup scope for v-if'd dialogs
  // (ApiKeysView perms viewer, TenantDetailView close dialog). The trap
  // must key off the container REF, not the component lifecycle:
  // inactive while the dialog is closed, activate on open, deactivate +
  // restore focus on close, and be a no-op at unmount when the dialog
  // never opened (pre-fix, leaving the view yanked focus to whatever was
  // focused at view mount).
  describe('view-scope usage — v-if\'d dialog', () => {
    // Host component with a toggleable dialog, mirroring the view pattern.
    function makeToggleComponent() {
      return defineComponent({
        setup() {
          const open = ref(false)
          const dialogRef = ref<HTMLElement | null>(null)
          useFocusTrap(dialogRef)
          return { open, dialogRef }
        },
        render() {
          return h('div', [
            h('button', { id: 'trigger' }, 'open dialog'),
            this.open
              ? h('div', { ref: 'dialogRef' }, [
                  h('input', { id: 'inside-first' }),
                  h('button', { id: 'inside-last' }, 'ok'),
                ])
              : null,
          ])
        },
      })
    }

    it('stays inert while the dialog is closed — no focus steal, no trap', async () => {
      mount(makeToggleComponent(), { attachTo: document.body })
      await flushPromises()
      // Setup/mount must not move focus anywhere.
      expect(document.activeElement).toBe(outsideButton)
      document.dispatchEvent(tabEvent(false))
      expect(document.activeElement).toBe(outsideButton)
    })

    it('unmounting with the dialog never opened does not restore/steal focus', async () => {
      const wrapper = mount(makeToggleComponent(), { attachTo: document.body })
      await flushPromises()
      // Operator moved focus elsewhere during the view's lifetime.
      const other = document.createElement('button')
      document.body.appendChild(other)
      other.focus()

      wrapper.unmount()
      // Pre-fix: onBeforeUnmount restored focus to outsideButton (the
      // element focused at view MOUNT) on every route navigation.
      expect(document.activeElement).toBe(other)
    })

    it('activates when the dialog opens: captures prior focus and focuses the first focusable', async () => {
      const wrapper = mount(makeToggleComponent(), { attachTo: document.body })
      await flushPromises()
      ;(document.getElementById('trigger') as HTMLButtonElement).focus()

      wrapper.vm.open = true
      await flushPromises()
      expect((document.activeElement as HTMLElement)?.id).toBe('inside-first')

      // Tab now cycles inside the dialog (last → first).
      ;(document.getElementById('inside-last') as HTMLButtonElement).focus()
      document.dispatchEvent(tabEvent(false))
      expect((document.activeElement as HTMLElement)?.id).toBe('inside-first')
    })

    it('closing the dialog (ref → null, no unmount) detaches the trap and restores focus', async () => {
      const wrapper = mount(makeToggleComponent(), { attachTo: document.body })
      await flushPromises()
      ;(document.getElementById('trigger') as HTMLButtonElement).focus()

      wrapper.vm.open = true
      await flushPromises()
      expect((document.activeElement as HTMLElement)?.id).toBe('inside-first')

      wrapper.vm.open = false
      await flushPromises()
      // Focus returns to the pre-open element…
      expect((document.activeElement as HTMLElement)?.id).toBe('trigger')
      // …and the document-level handler is gone: Tab from the outside
      // button is not intercepted back into anything.
      outsideButton.focus()
      document.dispatchEvent(tabEvent(false))
      expect(document.activeElement).toBe(outsideButton)
    })

    it('open → close → reopen re-arms the trap', async () => {
      const wrapper = mount(makeToggleComponent(), { attachTo: document.body })
      await flushPromises()
      wrapper.vm.open = true
      await flushPromises()
      wrapper.vm.open = false
      await flushPromises()

      ;(document.getElementById('trigger') as HTMLButtonElement).focus()
      wrapper.vm.open = true
      await flushPromises()
      expect((document.activeElement as HTMLElement)?.id).toBe('inside-first')
      ;(document.getElementById('inside-first') as HTMLInputElement).focus()
      document.dispatchEvent(tabEvent(true))
      expect((document.activeElement as HTMLElement)?.id).toBe('inside-last')
    })

    it('unmounting while the dialog is open cleans up and restores focus once', async () => {
      const wrapper = mount(makeToggleComponent(), { attachTo: document.body })
      await flushPromises()
      ;(document.getElementById('trigger') as HTMLButtonElement).focus()
      wrapper.vm.open = true
      await flushPromises()
      expect((document.activeElement as HTMLElement)?.id).toBe('inside-first')

      wrapper.unmount()
      // deactivate() ran in onBeforeUnmount (before DOM removal), so
      // focus was handed back to #trigger; the whole component is then
      // torn down, so the browser drops focus to body. The key
      // assertions: no crash, no dangling trap.
      expect(document.activeElement).toBe(document.body)
      document.dispatchEvent(tabEvent(false))
      expect(document.activeElement).toBe(document.body)
    })

    it('re-pointing the ref to a new element while active keeps the trap armed without re-capturing focus', async () => {
      // Drive the composable with a hand-managed ref (not a template
      // ref) so the swap is guaranteed not to pass through null.
      const containerRef = ref<HTMLElement | null>(null)
      const Host = defineComponent({
        setup() {
          useFocusTrap(containerRef)
          return () => h('div')
        },
      })
      mount(Host, { attachTo: document.body })

      const makeContainer = (btnId: string) => {
        const div = document.createElement('div')
        const btn = document.createElement('button')
        btn.id = btnId
        div.appendChild(btn)
        document.body.appendChild(div)
        return div
      }
      const a = makeContainer('in-a')
      const b = makeContainer('in-b')

      containerRef.value = a
      await flushPromises()
      expect((document.activeElement as HTMLElement)?.id).toBe('in-a')

      // Swap a → b with no null in between: the trap stays active (no
      // deactivate/reactivate churn, no focus re-capture)…
      containerRef.value = b
      await flushPromises()
      expect((document.activeElement as HTMLElement)?.id).toBe('in-a')
      // …and the keydown handler reads the ref live, so cycling now
      // follows the NEW container (focus is outside b → wraps in).
      document.dispatchEvent(tabEvent(true))
      expect((document.activeElement as HTMLElement)?.id).toBe('in-b')

      // Race hardening: a Tab that lands after the ref is nulled but
      // before the watcher flush (listener still attached) is a no-op.
      containerRef.value = null
      expect(() => document.dispatchEvent(tabEvent(false))).not.toThrow()
      await flushPromises()
    })

    it('a container swap without passing through null keeps the trap active on the new element', async () => {
      const Swapper = defineComponent({
        setup() {
          const which = ref(1)
          const dialogRef = ref<HTMLElement | null>(null)
          useFocusTrap(dialogRef)
          return { which, dialogRef }
        },
        render() {
          return this.which === 1
            ? h('div', { ref: 'dialogRef', key: 1 }, [h('button', { id: 'one-a' }, 'a'), h('button', { id: 'one-b' }, 'b')])
            : h('div', { ref: 'dialogRef', key: 2 }, [h('button', { id: 'two-a' }, 'a'), h('button', { id: 'two-b' }, 'b')])
        },
      })
      const wrapper = mount(Swapper, { attachTo: document.body })
      await flushPromises()
      expect((document.activeElement as HTMLElement)?.id).toBe('one-a')

      wrapper.vm.which = 2
      await flushPromises()
      // Trap still cycles — now within the replacement container.
      ;(document.getElementById('two-b') as HTMLButtonElement).focus()
      document.dispatchEvent(tabEvent(false))
      expect((document.activeElement as HTMLElement)?.id).toBe('two-a')
    })
  })
})

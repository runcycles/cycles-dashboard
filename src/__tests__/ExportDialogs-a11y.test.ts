import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ExportDialog from '../components/ExportDialog.vue'
import ExportProgressOverlay from '../components/ExportProgressOverlay.vue'

describe('export dialogs — modal keyboard contract', () => {
  beforeEach(() => { document.body.innerHTML = '' })
  afterEach(() => { document.body.innerHTML = '' })

  it('confirmation dialog has modal semantics, traps focus, handles Escape, and restores focus', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'Export CSV'
    document.body.appendChild(trigger)
    trigger.focus()

    const w = mount(ExportDialog, {
      attachTo: document.body,
      props: {
        format: 'csv', loadedCount: 10, hasMore: true,
        maxRows: 50_000, itemNounPlural: 'records',
      },
    })
    await nextTick()
    const dialog = w.get('[role="dialog"]')
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect((document.activeElement as HTMLElement)?.textContent).toContain('Cancel')

    // Shift+Tab from the first control wraps to the final confirmation.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect((document.activeElement as HTMLElement)?.textContent).toContain('Export CSV')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(w.emitted('cancel')).toHaveLength(1)
    await w.setProps({ format: null })
    await nextTick()
    expect(document.activeElement).toBe(trigger)
    w.unmount()
  })

  it('progress overlay is a focus-trapped busy dialog and Escape cancels when allowed', async () => {
    const w = mount(ExportProgressOverlay, {
      attachTo: document.body,
      props: { open: true, fetched: 250, itemNounPlural: 'records', cancellable: true },
    })
    await nextTick()
    const dialog = w.get('[role="dialog"]')
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect(dialog.attributes('aria-busy')).toBe('true')
    expect((document.activeElement as HTMLElement)?.textContent).toContain('Cancel export')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(w.emitted('cancel')).toHaveLength(1)
    w.unmount()
  })
})

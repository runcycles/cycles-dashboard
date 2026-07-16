// ToastContainer a11y + dismiss affordance.
//
// Every toast renders a keyboard-focusable dismiss (×) button; the
// each toast owns exactly one live-region role: polite status for
// success/warning and assertive alert for errors.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import ToastContainer from '../components/ToastContainer.vue'
import { useToast, toasts } from '../composables/useToast'

describe('ToastContainer', () => {
  beforeEach(() => { toasts.value = [] })
  afterEach(() => { toasts.value = [] })

  it('container is not a nested live region', () => {
    const w = mount(ToastContainer)
    expect(w.find('[aria-live="polite"]').exists()).toBe(false)
    expect(w.element.getAttribute('role')).toBeNull()
  })

  it('error toasts carry role="alert"; success toasts do not', async () => {
    const t = useToast()
    const w = mount(ToastContainer)
    t.success('all good')
    t.error('it broke')
    await w.vm.$nextTick()
    const alerts = w.findAll('[role="alert"]')
    expect(alerts).toHaveLength(1)
    expect(alerts[0].text()).toContain('it broke')
  })

  it('success and warning toasts each carry one polite status role', async () => {
    const t = useToast()
    const w = mount(ToastContainer)
    t.success('saved')
    t.warning('permissions will be removed on save')
    await w.vm.$nextTick()
    expect(w.findAll('[role="alert"]')).toHaveLength(0)
    const statuses = w.findAll('[role="status"]')
    expect(statuses.length).toBe(2)
    expect(statuses[0].text()).toContain('saved')
    expect(statuses[1].text()).toContain('permissions will be removed on save')
    expect(statuses.every(s => s.attributes('aria-atomic') === 'true')).toBe(true)
  })

  it('warning toasts use amber styling, distinct from success green and error red', async () => {
    const t = useToast()
    const w = mount(ToastContainer)
    t.success('ok')
    t.warning('careful')
    t.error('broke')
    await w.vm.$nextTick()
    expect(w.find('.bg-amber-600').text()).toContain('careful')
    expect(w.find('.bg-green-700').text()).toContain('ok')
    expect(w.find('.bg-red-700').text()).toContain('broke')
  })

  it('renders a dismiss button per toast that removes it on click', async () => {
    const t = useToast()
    const w = mount(ToastContainer)
    t.error('sticky failure')
    await w.vm.$nextTick()
    const dismiss = w.find('button[aria-label="Dismiss"]')
    expect(dismiss.exists()).toBe(true)
    await dismiss.trigger('click')
    expect(toasts.value).toHaveLength(0)
  })

  it('dismiss buttons are real <button> elements (keyboard focusable)', async () => {
    const t = useToast()
    const w = mount(ToastContainer)
    t.success('a')
    t.error('b')
    await w.vm.$nextTick()
    const buttons = w.findAll('button[aria-label="Dismiss"]')
    expect(buttons).toHaveLength(2)
    for (const b of buttons) {
      expect((b.element as HTMLButtonElement).tagName).toBe('BUTTON')
    }
  })

  it('bounds and wraps long messages on narrow viewports', async () => {
    const t = useToast()
    const w = mount(ToastContainer)
    t.error(`https://example.test/${'unbroken'.repeat(80)}`)
    await w.vm.$nextTick()

    const container = w.get('div.fixed')
    expect(container.attributes('class')).toContain('left-4')
    expect(container.attributes('class')).toContain('right-4')
    const toast = w.get('[role="alert"]')
    expect(toast.attributes('class')).toContain('max-w-[calc(100vw-2rem)]')
    const message = toast.get('span')
    expect(message.attributes('class')).toContain('min-w-0')
    expect(message.attributes('class')).toContain('[overflow-wrap:anywhere]')
  })
})

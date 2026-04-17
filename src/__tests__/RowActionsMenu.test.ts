import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

// Stub RouterLink so we don't need a full router setup. The component
// under test only uses `to` as a prop — it doesn't matter that the
// stub renders an <a> instead of navigating.
vi.mock('vue-router', () => ({
  RouterLink: defineComponent({
    name: 'RouterLink',
    props: ['to'],
    setup(props, { slots, attrs }) {
      return () => h('a', { ...attrs, href: '#', 'data-to': JSON.stringify(props.to) }, slots.default?.())
    },
  }),
}))

import RowActionsMenu, { type RowActionItem } from '../components/RowActionsMenu.vue'

function makeWrapper(items: RowActionItem[], extraProps: Record<string, unknown> = {}) {
  return mount(RowActionsMenu, {
    props: { items, ...extraProps },
    attachTo: document.body,
  })
}

async function openMenu(w: ReturnType<typeof makeWrapper>) {
  await w.get('button').trigger('click')
  await flushPromises()
}

function menuItems(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
}

describe('RowActionsMenu', () => {
  beforeEach(() => {
    // Each test owns a fresh body so Teleport targets don't leak.
    document.body.innerHTML = ''
  })

  describe('render + trigger visibility', () => {
    it('renders the kebab trigger when at least one non-separator item is visible', () => {
      const w = makeWrapper([{ label: 'Edit', onClick: () => {} }])
      expect(w.find('button').exists()).toBe(true)
      expect(w.find('button').attributes('aria-haspopup')).toBe('menu')
      expect(w.find('button').attributes('aria-expanded')).toBe('false')
    })

    it('renders nothing when every item is hidden (no ghost kebab)', () => {
      const w = makeWrapper([{ label: 'Edit', onClick: () => {}, hidden: true }])
      expect(w.find('button').exists()).toBe(false)
    })

    it('uses the labeled pill variant when triggerLabel is set', () => {
      const w = makeWrapper([{ label: 'Edit', onClick: () => {} }], { triggerLabel: 'More actions' })
      expect(w.find('button').text()).toContain('More actions')
    })
  })

  describe('click → menu open + item dispatch', () => {
    it('opens the menu on click and reports aria-expanded', async () => {
      const w = makeWrapper([{ label: 'Edit', onClick: () => {} }])
      await openMenu(w)
      expect(w.find('button').attributes('aria-expanded')).toBe('true')
      expect(document.body.querySelector('[role="menu"]')).toBeTruthy()
    })

    it('fires onClick for a normal item and closes the menu', async () => {
      const onEdit = vi.fn()
      const w = makeWrapper([{ label: 'Edit', onClick: onEdit }])
      await openMenu(w)
      menuItems()[0].click()
      await flushPromises()
      expect(onEdit).toHaveBeenCalledTimes(1)
      expect(document.body.querySelector('[role="menu"]')).toBeNull()
    })

    it('does NOT fire onClick for a disabled item', async () => {
      const onEdit = vi.fn()
      const w = makeWrapper([{ label: 'Edit', onClick: onEdit, disabled: true }])
      await openMenu(w)
      const btn = menuItems()[0] as HTMLButtonElement
      expect(btn.disabled).toBe(true)
      btn.click()
      await flushPromises()
      expect(onEdit).not.toHaveBeenCalled()
    })

    it('surfaces disabledReason as a title tooltip for keyboard + hover users', async () => {
      const w = makeWrapper([{ label: 'Edit', onClick: () => {}, disabled: true, disabledReason: 'Key already revoked' }])
      await openMenu(w)
      expect(menuItems()[0].getAttribute('title')).toBe('Key already revoked')
    })
  })

  describe('router-link items', () => {
    it('renders a RouterLink for items with `to`', async () => {
      const w = makeWrapper([{ label: 'Activity', to: { name: 'audit', query: { key_id: 'k-1' } } }])
      await openMenu(w)
      const link = menuItems()[0]
      expect(link.tagName.toLowerCase()).toBe('a')
      expect(link.getAttribute('data-to')).toContain('"name":"audit"')
    })
  })

  describe('separators', () => {
    it('renders separators and drops them when adjacent sections are all hidden', async () => {
      const w = makeWrapper([
        { label: 'A', onClick: () => {} },
        { separator: true },
        { label: 'B', onClick: () => {}, hidden: true },
      ])
      await openMenu(w)
      // Trailing separator (once B is hidden) must collapse, otherwise
      // we leave a floating divider at the bottom of the popover.
      expect(document.body.querySelectorAll('[role="separator"]').length).toBe(0)
    })

    it('keeps separators between two visible sections', async () => {
      const w = makeWrapper([
        { label: 'A', onClick: () => {} },
        { separator: true },
        { label: 'B', onClick: () => {}, danger: true },
      ])
      await openMenu(w)
      expect(document.body.querySelectorAll('[role="separator"]').length).toBe(1)
    })
  })

  describe('danger styling', () => {
    it('applies the danger class to destructive items', async () => {
      const w = makeWrapper([{ label: 'Revoke', onClick: () => {}, danger: true }])
      await openMenu(w)
      expect(menuItems()[0].className).toContain('row-actions-item-danger')
    })

    it('does NOT apply the danger class to a disabled danger item (hover still flashes red otherwise)', async () => {
      const w = makeWrapper([{ label: 'Revoke', onClick: () => {}, danger: true, disabled: true }])
      await openMenu(w)
      expect(menuItems()[0].className).not.toContain('row-actions-item-danger')
    })
  })

  describe('keyboard nav', () => {
    it('cycles items with ArrowDown, wrapping past the end', async () => {
      const w = makeWrapper([
        { label: 'A', onClick: () => {} },
        { label: 'B', onClick: () => {} },
      ])
      await openMenu(w)
      const menu = document.body.querySelector('[role="menu"]') as HTMLElement
      // Opened → first item is focused
      expect(document.activeElement).toBe(menuItems()[0])
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await flushPromises()
      expect(document.activeElement).toBe(menuItems()[1])
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await flushPromises()
      expect(document.activeElement).toBe(menuItems()[0])
    })

    it('Escape closes the menu and returns focus to the trigger', async () => {
      const w = makeWrapper([{ label: 'A', onClick: () => {} }])
      await openMenu(w)
      const menu = document.body.querySelector('[role="menu"]') as HTMLElement
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await flushPromises()
      expect(document.body.querySelector('[role="menu"]')).toBeNull()
      expect(document.activeElement).toBe(w.get('button').element)
    })
  })

  describe('click-outside dismiss', () => {
    it('closes when the user clicks outside the menu', async () => {
      const w = makeWrapper([{ label: 'A', onClick: () => {} }])
      await openMenu(w)
      // Simulate a mousedown on the body (outside trigger + menu).
      const outside = document.createElement('div')
      document.body.appendChild(outside)
      outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await flushPromises()
      expect(document.body.querySelector('[role="menu"]')).toBeNull()
    })
  })
})

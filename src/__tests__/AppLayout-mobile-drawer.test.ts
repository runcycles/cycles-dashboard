// v0.1.25.58: mobile-drawer behaviours. Escape closes, body scroll is
// locked while open, focus returns to the hamburger on close. Desktop
// viewports (md+) never show the drawer so these tests pin the mobile
// side of the responsive split.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import AppLayout from '../components/AppLayout.vue'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useRoute: () => ({ path: '/', query: {}, params: {} }),
    RouterLink: { props: ['to'], template: '<a><slot /></a>' },
    RouterView: { template: '<div data-testid="router-view" />' },
  }
})

vi.mock('../composables/useDarkMode', async () => {
  const vue = await vi.importActual<typeof import('vue')>('vue')
  return {
    useDarkMode: () => ({ isDark: vue.ref(false), toggle: vi.fn() }),
    isDark: vue.ref(false),
  }
})
vi.mock('../composables/useCommandPalette', async () => {
  const vue = await vi.importActual<typeof import('vue')>('vue')
  return {
    useCommandPalette: () => ({
      open: vi.fn(),
      toggle: vi.fn(),
      isOpen: vue.ref(false),
    }),
  }
})

const FULL_CAPS: Capabilities = {
  view_overview: true, view_budgets: true, view_events: true,
  view_webhooks: true, view_audit: true, view_tenants: true,
  view_api_keys: true, view_policies: true,
}

function mountLayout() {
  // Install `$route` as a global template property so the
  // `:key="$route.path"` on <router-view> inside AppLayout resolves
  // under the mocked vue-router. Stub router-view as a plain div so
  // Vue doesn't warn about unresolved components.
  return mount(AppLayout, {
    attachTo: document.body,
    global: {
      stubs: {
        RouterView: { template: '<div data-testid="router-view" />' },
      },
      config: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        globalProperties: { $route: { path: '/' } } as any,
      },
    },
  })
}

describe('AppLayout — mobile drawer (v0.1.25.58)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'k'
    auth.capabilities = FULL_CAPS
    document.body.style.overflow = ''
    document.body.innerHTML = ''
  })

  afterEach(() => {
    // Restore body scroll even if a test failed mid-open.
    document.body.style.overflow = ''
  })

  it('hamburger button meets 44×44 touch-target minimum', () => {
    const w = mountLayout()
    const hamburger = w.get('button[aria-label="Open menu"]')
    expect(hamburger.classes()).toContain('w-11')
    expect(hamburger.classes()).toContain('h-11')
    // aria-expanded reflects open state for SRs.
    expect(hamburger.attributes('aria-expanded')).toBe('false')
    expect(hamburger.attributes('aria-controls')).toBe('app-sidebar')
    w.unmount()
  })

  it('clicking hamburger opens the drawer and locks body scroll', async () => {
    const w = mountLayout()
    const hamburger = w.get('button[aria-label="Open menu"]')
    await hamburger.trigger('click')
    expect(hamburger.attributes('aria-expanded')).toBe('true')
    expect(document.body.style.overflow).toBe('hidden')
    w.unmount()
  })

  it('Escape closes the drawer and restores body scroll', async () => {
    const w = mountLayout()
    await w.get('button[aria-label="Open menu"]').trigger('click')
    expect(document.body.style.overflow).toBe('hidden')

    // Global keydown listener on window.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await w.vm.$nextTick()

    expect(w.get('button[aria-label="Open menu"]').attributes('aria-expanded')).toBe('false')
    expect(document.body.style.overflow).toBe('')
    w.unmount()
  })

  it('backdrop click closes the drawer', async () => {
    const w = mountLayout()
    await w.get('button[aria-label="Open menu"]').trigger('click')
    // Overlay is the only `.bg-black\\/40` at the AppLayout root level.
    const overlay = w.find('.bg-black\\/40')
    expect(overlay.exists()).toBe(true)
    await overlay.trigger('click')
    expect(w.get('button[aria-label="Open menu"]').attributes('aria-expanded')).toBe('false')
    expect(document.body.style.overflow).toBe('')
    w.unmount()
  })

  it('Escape with no drawer open does NOT steal the event', async () => {
    // Drawer closed by default. Escape should be a no-op at this level —
    // downstream modals / CommandPalette still own their Escape handling.
    const w = mountLayout()
    let defaultPrevented = false
    const handler = (e: KeyboardEvent) => { defaultPrevented = e.defaultPrevented }
    window.addEventListener('keydown', handler)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    window.removeEventListener('keydown', handler)
    expect(defaultPrevented).toBe(false)
    w.unmount()
  })

  it('body scroll is restored when the layout unmounts with drawer open', async () => {
    const w = mountLayout()
    await w.get('button[aria-label="Open menu"]').trigger('click')
    expect(document.body.style.overflow).toBe('hidden')
    w.unmount()
    // The onBeforeUnmount handler clears it so a post-unmount navigation
    // doesn't leave the host page in a frozen-scroll state.
    expect(document.body.style.overflow).toBe('')
  })

  it('uses h-dvh on the root so the visible viewport tracks mobile URL-bar collapse', () => {
    const w = mountLayout()
    // The root of AppLayout must use h-dvh (not h-screen) so the
    // layout tracks the visible viewport on mobile Safari. Check
    // class attributes specifically to avoid matching the comment
    // that explains the fix.
    const root = w.element as HTMLElement
    const classAttrs: string[] = [root.getAttribute('class') ?? '']
    root.querySelectorAll('*').forEach((el) => {
      classAttrs.push((el as HTMLElement).getAttribute('class') ?? '')
    })
    const hasDvh = classAttrs.some(c => /\bh-dvh\b/.test(c))
    const hasScreen = classAttrs.some(c => /\bh-screen\b/.test(c))
    expect(hasDvh).toBe(true)
    expect(hasScreen).toBe(false)
    w.unmount()
  })
})

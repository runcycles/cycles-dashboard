// Deferred from v0.1.25.54 — now unblocked after tightening jsdom's
// resource-loader behaviour (vitest.config.ts). Regression-locks the
// P1-H8 logout confirmation flow: click logout button → confirm dialog
// appears → Cancel leaves session intact / Confirm clears session and
// routes to the named login route.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { h as actualH, defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import Sidebar from '../components/Sidebar.vue'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

const pushMock = vi.fn()

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: pushMock, replace: vi.fn() }),
    useRoute: () => ({ path: '/', query: {}, params: {} }),
    RouterLink: defineComponent({
      props: { to: { type: null, required: false, default: null } },
      inheritAttrs: false,
      setup(_p, { slots, attrs }) { return () => actualH('a', { ...attrs }, slots.default?.()) },
    }),
  }
})

vi.mock('../composables/useDarkMode', () => ({
  useDarkMode: () => ({ isDark: { value: false }, toggle: vi.fn() }),
}))
vi.mock('../composables/useCommandPalette', () => ({
  useCommandPalette: () => ({ open: vi.fn(), toggle: vi.fn() }),
}))

const FULL_CAPS: Capabilities = {
  view_overview: true, view_budgets: true, view_events: true,
  view_webhooks: true, view_audit: true, view_tenants: true,
  view_api_keys: true, view_policies: true,
}

function mountSidebar() {
  return mount(Sidebar, { attachTo: document.body })
}

describe('Sidebar — logout confirmation (P1-H8)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.apiKey = 'k'
    auth.capabilities = FULL_CAPS
    pushMock.mockReset()
  })

  // ConfirmAction teleports the dialog to <body>. If a previous test's
  // wrapper.unmount() didn't fully detach the teleported fragment (edge
  // cases in VTU + Teleport), querySelector in the next test would see
  // a stale dialog. Wipe document.body between tests as a hard reset.
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('logout button click surfaces the confirm dialog and does NOT log out yet', async () => {
    const w = mountSidebar()
    const auth = useAuthStore()
    await w.get('button[aria-label="Logout"]').trigger('click')
    await flushPromises()

    // Teleport lands the dialog on body. Query via the document root.
    const dialog = document.querySelector('[role="dialog"][aria-label="Log out?"]')
    expect(dialog).toBeTruthy()
    expect(auth.apiKey).toBe('k')
    expect(pushMock).not.toHaveBeenCalled()
    w.unmount()
  })

  it('cancel dismisses the dialog without touching the session', async () => {
    const w = mountSidebar()
    const auth = useAuthStore()
    await w.get('button[aria-label="Logout"]').trigger('click')
    await flushPromises()

    const cancelBtn = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent?.trim() === 'Cancel') as HTMLButtonElement | undefined
    expect(cancelBtn).toBeTruthy()
    cancelBtn!.click()
    await flushPromises()

    expect(document.querySelector('[role="dialog"][aria-label="Log out?"]')).toBeFalsy()
    expect(auth.apiKey).toBe('k')
    expect(pushMock).not.toHaveBeenCalled()
    w.unmount()
  })

  it('confirm clears session and routes to the named login route', async () => {
    const w = mountSidebar()
    const auth = useAuthStore()
    await w.get('button[aria-label="Logout"]').trigger('click')
    await flushPromises()

    const confirmBtn = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent?.trim() === 'Log out') as HTMLButtonElement | undefined
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()
    await flushPromises()

    expect(auth.apiKey).toBe('')
    expect(auth.capabilities).toBeNull()
    expect(pushMock).toHaveBeenCalledWith({ name: 'login' })
    w.unmount()
  })
})

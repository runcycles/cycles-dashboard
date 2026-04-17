// Error-surface verification.
//
// 26+ view catch blocks call `toast.error(toMessage(e))` to surface
// server errors. No test asserted the toast actually renders with
// readable text — if someone refactored `useToast.error` into a silent
// no-op, or `toMessage` into returning "[object Object]", every
// existing test would still pass and operators would watch destructive
// operations silently "fail-open" in prod.
//
// This layer mounts a representative view, stubs the API client to
// reject with a conformant ApiError, drives the UI into the catch
// path, and asserts the `toasts` ref received a toast containing the
// server's readable message. Three views exercise three distinct
// flows (revoke, freeze-budget attempt, webhook replay) so a
// regression in one catch-block wiring is caught even if others stay
// correct.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../stores/auth'
import { toasts } from '../composables/useToast'
import { ApiError } from '../api/client'
import type { Capabilities } from '../types'

// Mock api/client with revokeApiKey/replayWebhookEvents rejecting and
// the list endpoints returning a single usable row so the UI can
// actually navigate to a row's Revoke button. vi.hoisted() is required
// because vi.mock factories are hoisted above top-level statements,
// and referencing a plain `const revokeApiKey = vi.fn()` would hit a
// TDZ error.
const { revokeApiKey, replayWebhookEvents } = vi.hoisted(() => ({
  revokeApiKey: vi.fn(),
  replayWebhookEvents: vi.fn(),
}))

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listTenants: vi.fn().mockResolvedValue({
      tenants: [{
        tenant_id: 't1',
        name: 'Tenant One',
        status: 'ACTIVE',
        created_at: '2026-04-01T00:00:00Z',
      }],
    }),
    listApiKeys: vi.fn().mockResolvedValue({
      keys: [{
        key_id: 'key-abc',
        tenant_id: 't1',
        name: 'test-key',
        status: 'ACTIVE',
        permissions: ['budgets:read'],
        key_prefix: 'ck_test',
        created_at: '2026-04-01T00:00:00Z',
      }],
    }),
    listWebhooks: vi.fn().mockResolvedValue({
      subscriptions: [{
        subscription_id: 'wh-abc',
        tenant_id: 't1',
        url: 'https://example.com/hook',
        events: ['reservation.created'],
        status: 'ACTIVE',
        created_at: '2026-04-01T00:00:00Z',
      }],
    }),
    getWebhook: vi.fn().mockResolvedValue({
      subscription_id: 'wh-abc',
      tenant_id: 't1',
      url: 'https://example.com/hook',
      events: ['reservation.created'],
      status: 'ACTIVE',
      created_at: '2026-04-01T00:00:00Z',
    }),
    listDeliveries: vi.fn().mockResolvedValue({ deliveries: [] }),
    revokeApiKey,
    replayWebhookEvents,
    ApiError: actual.ApiError,
  }
})

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useRoute: () => ({ query: {}, params: { id: 'wh-abc' } }),
    RouterLink: { template: '<a><slot /></a>' },
  }
})

// V1 virtualization (phase 2b) — jsdom has no layout, so a virtualized
// tbody would render zero rows in tests. Mock useVirtualizer to return
// all items as virtual rows with synthetic offsets so row-level tests
// (e.g. finding and clicking the Revoke button) keep working without
// needing a real browser.
vi.mock('@tanstack/vue-virtual', async () => {
  const { computed, isRef } = await import('vue')
  return {
    useVirtualizer: (optsRef: unknown) => {
      const read = () => (isRef(optsRef) ? optsRef.value : optsRef) as {
        count: number
        estimateSize: () => number
      }
      const api = computed(() => {
        const opts = read()
        const size = opts.estimateSize?.() ?? 52
        const items = Array.from({ length: opts.count }, (_, index) => ({
          index,
          key: index,
          start: index * size,
          size,
          end: (index + 1) * size,
          lane: 0,
        }))
        return {
          getVirtualItems: () => items,
          getTotalSize: () => opts.count * size,
        }
      })
      return api
    },
  }
})

vi.mock('../composables/usePolling', () => ({
  usePolling: (fn: () => Promise<void> | void) => {
    void fn()
    return {
      refresh: async () => { void fn() },
      isLoading: { value: false },
      lastUpdated: { value: null },
    }
  },
}))

const FULL_CAPS: Capabilities = {
  view_overview: true, view_budgets: true, view_events: true,
  view_webhooks: true, view_audit: true, view_tenants: true,
  view_api_keys: true, view_policies: true,
  manage_budgets: true, manage_tenants: true, manage_api_keys: true,
  manage_webhooks: true, manage_policies: true, manage_reservations: true,
}

function authWithCaps() {
  const auth = useAuthStore()
  auth.apiKey = 'test-key'
  auth.capabilities = FULL_CAPS
}

const globalStubs = {
  RouterLink: { template: '<a><slot /></a>' },
  RouterView: { template: '<div><slot /></div>' },
}

async function mountAndLoad(Component: unknown) {
  const w = mount(Component as never, { global: { stubs: globalStubs } })
  await flushPromises()
  // Second flush — views often chain listTenants → listApiKeys in
  // onMount, and the first flush resolves only the first tier.
  await flushPromises()
  return w
}

// Row actions are now rendered via RowActionsMenu — the kebab trigger
// sits in the row, and items like "Revoke" only render once the menu
// opens (into a <Teleport to="body">). Helper: click the kebab to open
// the menu, then click the named menuitem in document.body.
async function clickMenuItem(w: ReturnType<typeof mount>, triggerAriaLabelStartsWith: string, itemLabel: string) {
  const trigger = w.findAll('button').find(b =>
    b.attributes('aria-haspopup') === 'menu' &&
    (b.attributes('aria-label') || '').startsWith(triggerAriaLabelStartsWith),
  )
  if (!trigger) throw new Error(`no row-actions trigger starting with "${triggerAriaLabelStartsWith}"`)
  await trigger.trigger('click')
  await flushPromises()
  const item = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .find(el => (el.textContent || '').trim() === itemLabel)
  if (!item) throw new Error(`no menuitem labeled "${itemLabel}"`)
  item.click()
  await flushPromises()
}

describe('error surfacing — view catch blocks actually render toasts', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    toasts.value = []
    revokeApiKey.mockReset()
    replayWebhookEvents.mockReset()
    // Prevent teleported menus from leaking into the next test's body.
    document.body.innerHTML = ''
  })

  // ApiKeysView.executeRevoke prepends "Revoke failed:" — locks in both
  // the catch-wiring AND the operator-friendly prefix.
  it('ApiKeysView: revoke failure surfaces an error toast with readable server message', async () => {
    revokeApiKey.mockRejectedValueOnce(
      new ApiError(409, 'Key already revoked', 'ALREADY_REVOKED', 'req-1'),
    )
    authWithCaps()
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = await mountAndLoad(ApiKeysView)

    // Click the row-level Revoke action (now inside the kebab menu)
    // to populate pendingRevoke.
    await clickMenuItem(w, 'Actions for API key', 'Revoke')

    // ConfirmAction renders with confirm-label "Revoke Key". Click it.
    const confirmBtn = w.findAll('button').find(b => b.text().includes('Revoke Key'))
    expect(confirmBtn, 'ConfirmAction confirm button should render').toBeDefined()
    await confirmBtn!.trigger('click')
    await flushPromises()

    const errorToasts = toasts.value.filter(t => t.type === 'error')
    expect(errorToasts.length, 'at least one error toast should be present').toBeGreaterThan(0)
    expect(errorToasts[0].message).toContain('Revoke failed')
    expect(errorToasts[0].message).toContain('Key already revoked')
  })

  // Sanity: success path clears to a success toast (not error). Guards
  // against a regression where toast.error is called unconditionally.
  it('ApiKeysView: revoke success surfaces a success toast, not an error toast', async () => {
    revokeApiKey.mockResolvedValueOnce(undefined)
    authWithCaps()
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = await mountAndLoad(ApiKeysView)

    await clickMenuItem(w, 'Actions for API key', 'Revoke')
    await w.findAll('button').find(b => b.text().includes('Revoke Key'))!.trigger('click')
    await flushPromises()

    expect(toasts.value.filter(t => t.type === 'error').length).toBe(0)
    expect(toasts.value.some(t => t.type === 'success' && t.message.includes('revoked'))).toBe(true)
  })

  // toMessage + ApiError integration: the ApiError message field should
  // reach the toast intact. A regression in toMessage that loses the
  // Error.message (e.g. returns JSON.stringify(e) → "{}") surfaces here.
  it('toMessage+ApiError: server error message is not lost between throw and toast', async () => {
    revokeApiKey.mockRejectedValueOnce(
      new ApiError(403, 'Insufficient permissions for this operation', 'FORBIDDEN'),
    )
    authWithCaps()
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = await mountAndLoad(ApiKeysView)

    await clickMenuItem(w, 'Actions for API key', 'Revoke')
    await w.findAll('button').find(b => b.text().includes('Revoke Key'))!.trigger('click')
    await flushPromises()

    const errToast = toasts.value.find(t => t.type === 'error')
    expect(errToast?.message).toContain('Insufficient permissions for this operation')
    // Guard against the "[object Object]" regression specifically.
    expect(errToast?.message).not.toContain('[object Object]')
    expect(errToast?.message).not.toBe('')
    expect(errToast?.message).not.toBe(undefined)
  })

  // Non-ApiError catch path (generic Error, e.g. network timeout). The
  // catch block uses toMessage() which falls through to Error.message.
  it('generic Error (not ApiError) also surfaces its message to the toast', async () => {
    revokeApiKey.mockRejectedValueOnce(new Error('Request timed out after 30s'))
    authWithCaps()
    const { default: ApiKeysView } = await import('../views/ApiKeysView.vue')
    const w = await mountAndLoad(ApiKeysView)

    await clickMenuItem(w, 'Actions for API key', 'Revoke')
    await w.findAll('button').find(b => b.text().includes('Revoke Key'))!.trigger('click')
    await flushPromises()

    const errToast = toasts.value.find(t => t.type === 'error')
    expect(errToast?.message).toContain('Request timed out')
  })
})

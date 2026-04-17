import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'

const listTenantsMock = vi.fn()
const routerPushMock = vi.fn()

vi.mock('../api/client', () => ({
  listTenants: (...args: unknown[]) => listTenantsMock(...args),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPushMock }),
}))

import CommandPalette from '../components/CommandPalette.vue'
import { useCommandPalette, __resetCommandPaletteCacheForTests } from '../composables/useCommandPalette'

const sampleTenants = [
  { tenant_id: 'acme-corp', name: 'Acme Corp', status: 'ACTIVE', created_at: '2026-01-01T00:00:00Z' },
  { tenant_id: 'globex-inc', name: 'Globex Inc', status: 'ACTIVE', created_at: '2026-01-02T00:00:00Z' },
  { tenant_id: 'initech-llc', name: 'Initech LLC', status: 'SUSPENDED', created_at: '2026-01-03T00:00:00Z' },
  { tenant_id: 'umbrella', name: 'Umbrella Labs', status: 'ACTIVE', created_at: '2026-01-04T00:00:00Z' },
]

async function mountPaletteOpen() {
  const { open } = useCommandPalette()
  const w = mount(CommandPalette, { attachTo: document.body })
  open()
  await flushPromises()
  // debounce delay for query ref (150ms) — advance timers so the
  // initial empty query flows through and the listbox renders.
  await nextTick()
  return w
}

describe('CommandPalette', () => {
  beforeEach(() => {
    listTenantsMock.mockReset()
    routerPushMock.mockReset()
    __resetCommandPaletteCacheForTests()
    listTenantsMock.mockResolvedValue({ tenants: sampleTenants, has_more: false })
    // Each test owns a fresh body so Teleport targets don't leak
    document.body.innerHTML = ''
  })

  it('loads the tenant list when opened and renders results', async () => {
    const w = await mountPaletteOpen()
    expect(listTenantsMock).toHaveBeenCalled()
    const options = document.body.querySelectorAll('[role="option"]')
    expect(options.length).toBe(4)
    expect(options[0].textContent).toContain('Acme Corp')
    w.unmount()
  })

  it('filters by name substring (case-insensitive)', async () => {
    const w = await mountPaletteOpen()
    const input = document.body.querySelector<HTMLInputElement>('#command-palette-input')!
    input.value = 'GLOB'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    // Wait past the 150ms debounce window.
    await new Promise((r) => setTimeout(r, 200))
    const options = document.body.querySelectorAll('[role="option"]')
    expect(options.length).toBe(1)
    expect(options[0].textContent).toContain('Globex Inc')
    w.unmount()
  })

  it('filters by tenant_id substring', async () => {
    const w = await mountPaletteOpen()
    const input = document.body.querySelector<HTMLInputElement>('#command-palette-input')!
    input.value = 'initech'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    const options = document.body.querySelectorAll('[role="option"]')
    expect(options.length).toBe(1)
    expect(options[0].textContent).toContain('initech-llc')
    w.unmount()
  })

  it('ArrowDown + Enter selects and routes to tenant-detail', async () => {
    const w = await mountPaletteOpen()
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const inner = dialog.querySelector<HTMLElement>('[class*="max-w-xl"]')!
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(routerPushMock).toHaveBeenCalledWith({
      name: 'tenant-detail',
      params: { id: 'globex-inc' },
    })
    w.unmount()
  })

  it('Escape closes the palette', async () => {
    const { isOpen } = useCommandPalette()
    const w = await mountPaletteOpen()
    expect(isOpen.value).toBe(true)
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const inner = dialog.querySelector<HTMLElement>('[class*="max-w-xl"]')!
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(isOpen.value).toBe(false)
    w.unmount()
  })

  it('shows an empty-state message when no tenant matches the query', async () => {
    const w = await mountPaletteOpen()
    const input = document.body.querySelector<HTMLInputElement>('#command-palette-input')!
    input.value = 'zzz-no-match'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    expect(document.body.textContent).toContain('No tenants match')
    w.unmount()
  })

  it('renders a "Load more" control when the server reports has_more', async () => {
    listTenantsMock.mockReset()
    // First 3 pages all return has_more=true so the composable stops at
    // the MAX_PREFETCH_PAGES cap and surfaces the Load more affordance.
    listTenantsMock.mockResolvedValue({
      tenants: sampleTenants,
      has_more: true,
      next_cursor: 'cursor-abc',
    })
    const w = await mountPaletteOpen()
    expect(document.body.textContent).toContain('Load more')
    w.unmount()
  })

  it('surfaces an error message when the initial fetch fails', async () => {
    listTenantsMock.mockRejectedValueOnce(new Error('network down'))
    const w = await mountPaletteOpen()
    const alert = document.body.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('network down')
    w.unmount()
  })

  // ── O2: slash-command scoping ────────────────────────────────
  // Default tenant search stays untouched; slash commands open
  // direct routes for non-tenant resources. Tests cover the
  // five flows that the user-facing component calls out:
  //   1. typing `/` lists every command (discovery)
  //   2. partial slash (`/w`) filters the command list by prefix
  //   3. clicking a command-help row pre-fills `/<name> ` (completion)
  //   4. complete `/<cmd> <arg>` + Enter executes the route
  //   5. unknown command surfaces a helpful inline message

  it('typing / shows the command list', async () => {
    const w = await mountPaletteOpen()
    const input = document.body.querySelector<HTMLInputElement>('#command-palette-input')!
    input.value = '/'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    const options = document.body.querySelectorAll('[role="option"]')
    expect(options.length).toBeGreaterThanOrEqual(5)
    const text = document.body.textContent || ''
    expect(text).toContain('/wh')
    expect(text).toContain('/key')
    expect(text).toContain('/audit')
    expect(text).toContain('/event')
    expect(text).toContain('/tenant')
    w.unmount()
  })

  it('typing /w filters the command list by prefix', async () => {
    const w = await mountPaletteOpen()
    const input = document.body.querySelector<HTMLInputElement>('#command-palette-input')!
    input.value = '/w'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    // /wh + /webhook alias for the same command — visible commands
    // is filtered to one entry (the canonical /wh).
    const options = document.body.querySelectorAll('[role="option"]')
    expect(options.length).toBe(1)
    expect(options[0].textContent).toContain('Open webhook')
    w.unmount()
  })

  it('/wh <id> + Enter routes to webhook-detail', async () => {
    const w = await mountPaletteOpen()
    const input = document.body.querySelector<HTMLInputElement>('#command-palette-input')!
    input.value = '/wh sub-abc-123'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const inner = dialog.querySelector<HTMLElement>('[class*="max-w-xl"]')!
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(routerPushMock).toHaveBeenCalledWith({
      name: 'webhook-detail',
      params: { id: 'sub-abc-123' },
    })
    w.unmount()
  })

  it('/key <id> routes to audit pre-filtered by key_id', async () => {
    const w = await mountPaletteOpen()
    const input = document.body.querySelector<HTMLInputElement>('#command-palette-input')!
    input.value = '/key k_xyz'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const inner = dialog.querySelector<HTMLElement>('[class*="max-w-xl"]')!
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(routerPushMock).toHaveBeenCalledWith({
      name: 'audit',
      query: { key_id: 'k_xyz' },
    })
    w.unmount()
  })

  it('/audit <id> routes to audit search', async () => {
    const w = await mountPaletteOpen()
    const input = document.body.querySelector<HTMLInputElement>('#command-palette-input')!
    input.value = '/audit log_xyz'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const inner = dialog.querySelector<HTMLElement>('[class*="max-w-xl"]')!
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(routerPushMock).toHaveBeenCalledWith({
      name: 'audit',
      query: { search: 'log_xyz' },
    })
    w.unmount()
  })

  it('/tenant <id> routes to tenant-detail (exact ID, skips fuzzy search)', async () => {
    const w = await mountPaletteOpen()
    const input = document.body.querySelector<HTMLInputElement>('#command-palette-input')!
    input.value = '/tenant some-id-not-in-cache'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const inner = dialog.querySelector<HTMLElement>('[class*="max-w-xl"]')!
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(routerPushMock).toHaveBeenCalledWith({
      name: 'tenant-detail',
      params: { id: 'some-id-not-in-cache' },
    })
    w.unmount()
  })

  it('/t alias also routes to tenant-detail', async () => {
    const w = await mountPaletteOpen()
    const input = document.body.querySelector<HTMLInputElement>('#command-palette-input')!
    input.value = '/t alpha'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const inner = dialog.querySelector<HTMLElement>('[class*="max-w-xl"]')!
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(routerPushMock).toHaveBeenCalledWith({
      name: 'tenant-detail',
      params: { id: 'alpha' },
    })
    w.unmount()
  })

  it('unknown command (post-space) shows an inline help message', async () => {
    const w = await mountPaletteOpen()
    const input = document.body.querySelector<HTMLInputElement>('#command-palette-input')!
    // Trailing space tells the parser the command name is finished.
    input.value = '/foo bar'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    expect(document.body.textContent).toContain('Unknown command')
    expect(document.body.textContent).toContain('/foo')
    // Enter must NOT route anywhere when the command is unknown.
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const inner = dialog.querySelector<HTMLElement>('[class*="max-w-xl"]')!
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(routerPushMock).not.toHaveBeenCalled()
    w.unmount()
  })

  it('command needing arg (e.g. just "/wh") shows an "enter <arg>" hint and Enter does nothing', async () => {
    const w = await mountPaletteOpen()
    const input = document.body.querySelector<HTMLInputElement>('#command-palette-input')!
    input.value = '/wh '
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    expect(document.body.textContent).toContain('Open webhook')
    expect(document.body.textContent).toContain('subscription_id')
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const inner = dialog.querySelector<HTMLElement>('[class*="max-w-xl"]')!
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(routerPushMock).not.toHaveBeenCalled()
    w.unmount()
  })
})

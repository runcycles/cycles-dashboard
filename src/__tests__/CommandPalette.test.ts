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
})

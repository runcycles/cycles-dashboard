import { describe, it, expect, beforeEach, vi } from 'vitest'

const listTenantsMock = vi.fn()
vi.mock('../api/client', () => ({
  listTenants: (...args: unknown[]) => listTenantsMock(...args),
}))

import {
  useCommandPalette,
  __resetCommandPaletteCacheForTests,
} from '../composables/useCommandPalette'

const t = (id: string, name = id) => ({
  tenant_id: id,
  name,
  status: 'ACTIVE',
  created_at: '2026-01-01T00:00:00Z',
})

describe('useCommandPalette', () => {
  beforeEach(() => {
    listTenantsMock.mockReset()
    __resetCommandPaletteCacheForTests()
  })

  it('prefetches up to 3 pages and stops when has_more=false', async () => {
    listTenantsMock
      .mockResolvedValueOnce({ tenants: [t('a'), t('b')], has_more: true, next_cursor: 'c1' })
      .mockResolvedValueOnce({ tenants: [t('c')], has_more: false })

    const { loadInitial } = useCommandPalette()
    const cache = await loadInitial()

    expect(listTenantsMock).toHaveBeenCalledTimes(2)
    expect(cache.tenants.map((x) => x.tenant_id)).toEqual(['a', 'b', 'c'])
    expect(cache.hasMore).toBe(false)
  })

  it('caps prefetch at MAX_PREFETCH_PAGES and preserves has_more for Load more', async () => {
    listTenantsMock
      .mockResolvedValueOnce({ tenants: [t('a')], has_more: true, next_cursor: 'c1' })
      .mockResolvedValueOnce({ tenants: [t('b')], has_more: true, next_cursor: 'c2' })
      .mockResolvedValueOnce({ tenants: [t('c')], has_more: true, next_cursor: 'c3' })

    const { loadInitial } = useCommandPalette()
    const cache = await loadInitial()

    expect(listTenantsMock).toHaveBeenCalledTimes(3)
    expect(cache.hasMore).toBe(true)
    expect(cache.nextCursor).toBe('c3')
  })

  it('returns the cached tenant set on the second call (within TTL)', async () => {
    listTenantsMock.mockResolvedValue({ tenants: [t('a')], has_more: false })

    const { loadInitial } = useCommandPalette()
    await loadInitial()
    await loadInitial()

    // Second call hit the cache — no additional fetch.
    expect(listTenantsMock).toHaveBeenCalledTimes(1)
  })

  it('dedupes concurrent loadInitial calls into one in-flight promise', async () => {
    let resolveFirst!: (v: unknown) => void
    listTenantsMock.mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))

    const { loadInitial } = useCommandPalette()
    const a = loadInitial()
    const b = loadInitial()
    resolveFirst({ tenants: [t('a')], has_more: false })
    await Promise.all([a, b])

    expect(listTenantsMock).toHaveBeenCalledTimes(1)
  })

  it('loadMore appends and threads the cursor', async () => {
    listTenantsMock
      .mockResolvedValueOnce({ tenants: [t('a')], has_more: true, next_cursor: 'c1' })
      .mockResolvedValueOnce({ tenants: [t('b')], has_more: true, next_cursor: 'c2' })
      .mockResolvedValueOnce({ tenants: [t('c')], has_more: true, next_cursor: 'c3' })
      .mockResolvedValueOnce({ tenants: [t('d')], has_more: false })

    const { loadInitial, loadMore } = useCommandPalette()
    await loadInitial()
    const after = await loadMore()

    expect(after?.tenants.map((x) => x.tenant_id)).toEqual(['a', 'b', 'c', 'd'])
    expect(after?.hasMore).toBe(false)
    const lastCall = listTenantsMock.mock.calls[listTenantsMock.mock.calls.length - 1][0]
    expect(lastCall).toMatchObject({ cursor: 'c3' })
  })

  it('toggle flips open/close', () => {
    const { isOpen, toggle } = useCommandPalette()
    expect(isOpen.value).toBe(false)
    toggle()
    expect(isOpen.value).toBe(true)
    toggle()
    expect(isOpen.value).toBe(false)
  })
})

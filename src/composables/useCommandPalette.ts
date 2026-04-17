import { ref } from 'vue'
import { listTenants } from '../api/client'
import type { Tenant } from '../types'

// Global command palette state + tenant cache. Singleton so the Cmd/K
// listener in AppLayout and the <CommandPalette> component share one
// open-ref; avoids prop drilling through the router-view boundary.
//
// Tenant cache lives at module scope with a 60s TTL. A palette
// interaction is bounded (user types, picks, closes), so re-fetching
// on every open would waste a round-trip when the operator is paging
// through candidate tenants. 60s matches the existing TenantsView
// polling cadence — the cache is at worst one poll stale.
//
// Scale note (W3): the admin spec's listTenants does NOT yet accept a
// server-side `search=` substring filter. This palette pages up to
// MAX_PREFETCH_PAGES (150 tenants) and filters client-side. At true
// thousand-tenant scale the "Load more" affordance lets operators
// drill past the initial window; a spec-level search param (deferred)
// would make this unnecessary but is a separate repo round-trip.

const PAGE_SIZE = 50
const MAX_PREFETCH_PAGES = 3
const CACHE_TTL_MS = 60_000

const isOpen = ref(false)

type Cache = {
  tenants: Tenant[]
  loadedAt: number
  hasMore: boolean
  nextCursor?: string
}

let cache: Cache | null = null
let inflight: Promise<Cache> | null = null

function cacheFresh(): boolean {
  return cache !== null && Date.now() - cache.loadedAt < CACHE_TTL_MS
}

export function useCommandPalette() {
  function open() { isOpen.value = true }
  function close() { isOpen.value = false }
  function toggle() { isOpen.value = !isOpen.value }

  async function loadInitial(force = false): Promise<Cache> {
    if (!force && cacheFresh()) return cache!
    if (inflight) return inflight

    inflight = (async () => {
      const collected: Tenant[] = []
      let cursor: string | undefined
      let hasMore = false
      for (let page = 0; page < MAX_PREFETCH_PAGES; page++) {
        const params: Record<string, string> = { limit: String(PAGE_SIZE) }
        if (cursor) params.cursor = cursor
        const res = await listTenants(params)
        collected.push(...res.tenants)
        hasMore = res.has_more
        cursor = res.next_cursor
        if (!hasMore || !cursor) break
      }
      cache = { tenants: collected, loadedAt: Date.now(), hasMore, nextCursor: cursor }
      return cache
    })()

    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  async function loadMore(): Promise<Cache | null> {
    if (!cache || !cache.hasMore || !cache.nextCursor) return cache
    const res = await listTenants({ limit: String(PAGE_SIZE), cursor: cache.nextCursor })
    cache = {
      tenants: [...cache.tenants, ...res.tenants],
      loadedAt: cache.loadedAt,
      hasMore: res.has_more,
      nextCursor: res.next_cursor,
    }
    return cache
  }

  function invalidate() {
    cache = null
  }

  return { isOpen, open, close, toggle, loadInitial, loadMore, invalidate }
}

// Test-only helper. Module-scope cache survives across test cases
// because vitest imports are cached; without this reset the second
// suite would see the first suite's tenants. Not exported for runtime
// use — prefixed with __ to signal test-only.
export function __resetCommandPaletteCacheForTests() {
  cache = null
  inflight = null
  isOpen.value = false
}

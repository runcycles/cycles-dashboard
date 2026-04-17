import { ref, computed, type Ref } from 'vue'

export type SortDir = 'asc' | 'desc'
export type ValueAccessor<T> = (item: T) => string | number | null | undefined

/**
 * Server-sort opt-in options. When `serverSide: true`:
 *  - `sorted` passes `items.value` through verbatim (no client-side sort).
 *    Views are expected to pass server-sorted results as the backing ref.
 *  - `toggle(key)` fires `onChange(key, dir)` so the view can re-fetch with
 *    `sort_by` / `sort_dir` query params. The returned `sortKey` / `sortDir`
 *    still update in place so `SortHeader` reflects the active column.
 *
 * Client-side sort (the default, no opts passed) is unchanged — every
 * existing call site continues to work byte-for-byte.
 */
export interface SortOptions {
  serverSide?: boolean
  onChange?: (sortKey: string, sortDir: SortDir) => void
}

// `defaultKey` intentionally allows any string, not just `keyof T & string`:
// callers commonly seed the default with a synthetic key backed by an
// accessor (e.g. BudgetsView uses `'utilization'`, which isn't a field on
// BudgetLedger but is provided by `accessors.utilization`). Constraining to
// `keyof T` would force an `as any` at every such call site.
export function useSort<T>(
  items: Ref<T[]>,
  defaultKey?: string,
  defaultDir: SortDir = 'asc',
  accessors?: Record<string, ValueAccessor<T>>,
  options?: SortOptions,
) {
  const sortKey = ref<string>(defaultKey ?? '')
  const sortDir = ref<SortDir>(defaultDir)
  const serverSide = options?.serverSide === true

  function toggle(key: string) {
    if (sortKey.value === key) {
      sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
    } else {
      sortKey.value = key
      sortDir.value = 'asc'
    }
    options?.onChange?.(sortKey.value, sortDir.value)
  }

  function getValue(item: T, key: string): string | number | null | undefined {
    if (accessors?.[key]) return accessors[key](item)
    return (item as Record<string, unknown>)[key] as string | number | null | undefined
  }

  const sorted = computed(() => {
    // Server-mode short-circuit: the backing `items` ref is the server's
    // already-sorted page. Re-sorting client-side would destroy the
    // tie-breaker ordering the server uses for cursor stability.
    if (serverSide) return items.value
    if (!sortKey.value) return items.value
    const key = sortKey.value
    const dir = sortDir.value === 'asc' ? 1 : -1
    return [...items.value].sort((a, b) => {
      const av = getValue(a, key)
      const bv = getValue(b, key)
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
  })

  return { sortKey, sortDir, toggle, sorted }
}

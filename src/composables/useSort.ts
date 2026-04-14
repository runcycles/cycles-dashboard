import { ref, computed, type Ref } from 'vue'

export type SortDir = 'asc' | 'desc'
export type ValueAccessor<T> = (item: T) => string | number | null | undefined

// `defaultKey` intentionally allows any string, not just `keyof T & string`:
// callers commonly seed the default with a synthetic key backed by an
// accessor (e.g. BudgetsView uses `'utilization'`, which isn't a field on
// BudgetLedger but is provided by `accessors.utilization`). Constraining to
// `keyof T` would force an `as any` at every such call site.
export function useSort<T>(items: Ref<T[]>, defaultKey?: string, defaultDir: SortDir = 'asc', accessors?: Record<string, ValueAccessor<T>>) {
  const sortKey = ref<string>(defaultKey ?? '')
  const sortDir = ref<SortDir>(defaultDir)

  function toggle(key: string) {
    if (sortKey.value === key) {
      sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
    } else {
      sortKey.value = key
      sortDir.value = 'asc'
    }
  }

  function getValue(item: T, key: string): string | number | null | undefined {
    if (accessors?.[key]) return accessors[key](item)
    return (item as Record<string, unknown>)[key] as string | number | null | undefined
  }

  const sorted = computed(() => {
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

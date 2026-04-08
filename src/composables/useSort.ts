import { ref, computed, type Ref } from 'vue'

export type SortDir = 'asc' | 'desc'

export function useSort<T>(items: Ref<T[]>, defaultKey?: keyof T & string, defaultDir: SortDir = 'asc') {
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

  const sorted = computed(() => {
    if (!sortKey.value) return items.value
    const k = sortKey.value as keyof T
    const dir = sortDir.value === 'asc' ? 1 : -1
    return [...items.value].sort((a, b) => {
      const av = a[k]
      const bv = b[k]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
  })

  return { sortKey, sortDir, toggle, sorted }
}

import { ref, watch, onScopeDispose, type Ref } from 'vue'

/**
 * Returns a read-only ref that mirrors `source` but only updates `delay`
 * milliseconds after the last change. Useful for deferring expensive
 * reactions to fast-changing inputs — debounced search boxes, filter
 * typing, numeric-input scrubbers.
 *
 * ## Semantics
 * - Initial value is captured synchronously from `source.value`.
 * - Every change to `source` cancels any pending update and schedules
 *   a new one `delay` ms out.
 * - If the component is torn down before the pending update fires,
 *   the timer is cleared (`onScopeDispose`) so no post-unmount write
 *   happens and no memory is leaked.
 *
 * ## Use patterns
 * ```
 * // 1. Drive a client-side computed filter:
 * const search = ref('')
 * const debouncedSearch = useDebouncedRef(search, 250)
 * const filtered = computed(() =>
 *   items.value.filter(i => i.name.includes(debouncedSearch.value))
 * )
 *
 * // 2. Drive a server-side fetch via watch:
 * const q = ref('')
 * const debouncedQ = useDebouncedRef(q, 300)
 * watch(debouncedQ, () => fetchList())
 * ```
 *
 * ## Why not VueUse's version
 * VueUse ships `refDebounced` which does the same thing. Local
 * implementation keeps the composables directory dependency-free and
 * lets us tune the exact semantics (initial-sync vs deferred, effect-
 * scope cleanup strategy) without pulling a whole utility library.
 */
export function useDebouncedRef<T>(source: Ref<T>, delay: number): Readonly<Ref<T>> {
  const debounced = ref(source.value) as Ref<T>
  let timer: ReturnType<typeof setTimeout> | null = null

  function clear() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  watch(source, (next) => {
    clear()
    timer = setTimeout(() => {
      debounced.value = next
      timer = null
    }, delay)
  })

  // Auto-cancel pending update if the setup scope (component) tears
  // down. `onScopeDispose` also fires under effectScope(), so this
  // works inside helper composables too.
  onScopeDispose(clear)

  return debounced as Readonly<Ref<T>>
}

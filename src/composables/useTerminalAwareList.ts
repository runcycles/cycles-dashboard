import { ref, computed, watch, type Ref, type ComputedRef } from 'vue'
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router'

// Terminal states per governance-spec lifecycle. These entities act like
// `ON DELETE CASCADE` children — once they hit a terminal status, every
// mutating operation against them is spec-rejected (Rule 2 of the tenant-
// close cascade; equivalent per-entity lifecycle terminals for webhook /
// api-key / budget). The dashboard treats them as *done* — Gmail /
// GitHub / Linear / Jira all hide done/archived work by default with a
// one-click opt-in. Matching that convention here.
export type EntityKind = 'tenant' | 'budget' | 'webhook' | 'apiKey'

export const TERMINAL_STATUSES: Record<EntityKind, readonly string[]> = {
  tenant: ['CLOSED'],
  budget: ['CLOSED'],
  webhook: ['DISABLED'],
  // EXPIRED is effectively terminal — no mutations allowed and nothing an
  // operator does to the row can bring it back (they must create a new
  // key with a fresh expires_at). Grouped with REVOKED for default-hide.
  apiKey: ['REVOKED', 'EXPIRED'],
}

// Human-readable label used in the toggle ("Show 3 disabled"). Chosen to
// be the participle that matches operator vocabulary, not the enum literal.
export const TERMINAL_VERB: Record<EntityKind, string> = {
  tenant: 'closed',
  budget: 'closed',
  webhook: 'disabled',
  apiKey: 'revoked',
}

export function isTerminalStatus(kind: EntityKind, status: string | null | undefined): boolean {
  if (!status) return false
  return TERMINAL_STATUSES[kind].includes(status)
}

export interface UseTerminalAwareListOptions<T> {
  kind: EntityKind
  /** Upstream ref — typically the already-filtered + sorted row set. */
  source: Ref<T[]> | ComputedRef<T[]>
  statusOf: (item: T) => string | null | undefined
  /**
   * Operator's explicit status filter, if the view has one. When the
   * operator picks a terminal value (e.g. status=DISABLED), auto-engage
   * the toggle — otherwise their explicit filter would produce an empty
   * list, which is confusing. Matches the GitHub Issues `state:closed`
   * convention.
   */
  explicitStatus?: Ref<string>
  /** Enable URL mirror via `?include_terminal=1`. */
  route?: RouteLocationNormalizedLoaded
  router?: Router
  /**
   * URL param name. Defaults to `include_terminal`, but views that already
   * have a `terminal=…` param for another purpose can override.
   */
  queryParam?: string
}

export function useTerminalAwareList<T>(opts: UseTerminalAwareListOptions<T>) {
  const terminalSet = TERMINAL_STATUSES[opts.kind]
  const paramName = opts.queryParam ?? 'include_terminal'

  function readFromQuery(): boolean {
    if (!opts.route) return false
    const v = opts.route.query[paramName]
    return v === '1' || v === 'true'
  }

  const includeTerminal = ref<boolean>(readFromQuery())

  // URL mirror: ref → URL, and URL → ref (for browser back/forward and
  // deep-link deep-links from the Overview counters that might one day
  // include `?include_terminal=1`). Loop-safe: if the value already
  // matches, skip the router.replace.
  if (opts.route && opts.router) {
    const route = opts.route
    const router = opts.router
    watch(includeTerminal, val => {
      const desired = val ? '1' : undefined
      const current = typeof route.query[paramName] === 'string'
        ? (route.query[paramName] as string)
        : undefined
      if (desired === current) return
      router.replace({
        query: { ...route.query, [paramName]: desired },
      })
    })
    watch(() => route.query[paramName], () => {
      const q = readFromQuery()
      if (q !== includeTerminal.value) includeTerminal.value = q
    })
  }

  const explicitlyFilteringTerminal = computed<boolean>(() => {
    const s = opts.explicitStatus?.value
    if (!s) return false
    return terminalSet.includes(s)
  })

  // Effective visibility: toggle OR explicit terminal-status filter. If
  // the operator types status=DISABLED into the dropdown, show them even
  // if the toggle is off.
  const showTerminal = computed<boolean>(() =>
    includeTerminal.value || explicitlyFilteringTerminal.value,
  )

  function isTerminal(item: T): boolean {
    return terminalSet.includes(opts.statusOf(item) ?? '')
  }

  // Stable partition: preserves upstream sort order within each group,
  // then concatenates active-first, terminal-last. When there are no
  // terminals (or all items are terminal), returns the source ref
  // unchanged so the virtualizer doesn't re-index unnecessarily.
  const visibleRows = computed<T[]>(() => {
    // Defensive: upstream refs may hold undefined in between fetches (e.g.
    // when a view clears its rows during a re-fetch). Fall back to [] so
    // we don't iterate/filter on undefined and crash the component.
    const all = opts.source.value ?? []
    if (showTerminal.value) {
      const active: T[] = []
      const terminal: T[] = []
      for (const item of all) {
        if (isTerminal(item)) terminal.push(item)
        else active.push(item)
      }
      if (terminal.length === 0 || active.length === 0) return all
      return [...active, ...terminal]
    }
    return all.filter(item => !isTerminal(item))
  })

  const terminalCount = computed<number>(() =>
    (opts.source.value ?? []).filter(isTerminal).length,
  )

  return {
    includeTerminal,
    showTerminal,
    visibleRows,
    terminalCount,
    terminalVerb: TERMINAL_VERB[opts.kind],
    isTerminal,
  }
}

import { ref, watch } from 'vue'
import {
  getOverview as getOverviewDefault,
  listApiKeys as listApiKeysDefault,
  listAuditLogs as listAuditLogsDefault,
  listBudgets as listBudgetsDefault,
  listTenants as listTenantsDefault,
  listWebhooks as listWebhooksDefault,
} from '../api/client'
import type {
  AdminOverviewResponse,
  ApiKey,
  AuditLogEntry,
  BudgetLedger,
  WebhookSubscription,
} from '../types'
import { POLLING_STALE } from './pollingResult'
import { POLL_FAST_MS } from './pollingConstants'
import { usePolling as usePollingDefault } from './usePolling'
import { toMessage } from '../utils/errors'
import { walkCursorPages, LIST_PAGE_LIMIT } from '../utils/cursorWalk'

type OverviewPolling = (
  callback: Parameters<typeof usePollingDefault>[0],
  intervalMs: number,
) => Pick<ReturnType<typeof usePollingDefault>, 'refresh' | 'isLoading' | 'lastSuccessAt'>

export interface OverviewDataDependencies {
  getOverview: typeof getOverviewDefault
  listApiKeys: typeof listApiKeysDefault
  listAuditLogs: typeof listAuditLogsDefault
  listBudgets: typeof listBudgetsDefault
  listTenants: typeof listTenantsDefault
  listWebhooks: typeof listWebhooksDefault
  usePolling: OverviewPolling
}

const defaultDependencies: OverviewDataDependencies = {
  getOverview: getOverviewDefault,
  listApiKeys: listApiKeysDefault,
  listAuditLogs: listAuditLogsDefault,
  listBudgets: listBudgetsDefault,
  listTenants: listTenantsDefault,
  listWebhooks: listWebhooksDefault,
  usePolling: usePollingDefault,
}

/**
 * Owns Overview's two-phase acquisition protocol.
 *
 * Presentation stays in OverviewView: this composable only coordinates the
 * cheap poll, bounded cursor walks, walk retry/backoff, partial-result flags,
 * and queued operator refresh.
 */
export function useOverviewData(
  overrides: Partial<OverviewDataDependencies> = {},
) {
  const deps: OverviewDataDependencies = { ...defaultDependencies, ...overrides }

  const overview = ref<AdminOverviewResponse | null>(null)
  const keys = ref<ApiKey[]>([])
  const recentAudit = ref<AuditLogEntry[]>([])
  // Closed-tenant exclusion set. Spec v0.1.25.31 Rule 1 cascades a closed
  // tenant's owned objects to terminal states; under Mode B (admin
  // reference implementation) the cascade is eventually-consistent, so
  // between the CLOSED flip and cascade completion an operator can
  // observe a closed tenant's still-ACTIVE budget / still-ACTIVE api-key
  // / still-ACTIVE webhook. Those don't belong on the "what needs
  // attention" landing page — a closed tenant is terminal and TenantDetail
  // surfaces the per-tenant cascade-recovery banner. Fetch the closed set
  // once per poll and filter every client-side-fetched attention card
  // against it. The Overview's counter-strip tile chips (e.g. "3 over",
  // "2 failing") stay on the server aggregate — they're positioned as
  // navigational state breakdowns, not attention signals; a true
  // tenant-status-aware aggregate count needs spec/admin work.
  const closedTenantIds = ref<Set<string>>(new Set())
  // Budgets with debt — replaces the use of overview.debt_scopes (which
  // lacks tenant_id and so cannot be filtered against the closed set).
  // listBudgets(has_debt=true) returns BudgetLedger rows that carry
  // tenant_id from v0.1.25.19+.
  const debtBudgets = ref<BudgetLedger[]>([])
  // Failing webhooks — replaces overview.failing_webhooks (narrower
  // shape without tenant_id). Fetch full WebhookSubscription rows, then
  // client-filter for (consecutive_failures ?? 0) > 0. listWebhooks has
  // no server-side `failing` filter (WebhooksView applies it client-side
  // too; see src/views/WebhooksView.vue:126), so we pull a reasonable
  // page and filter locally. Closed-tenant exclusion layered on top.
  const failingWebhooksRaw = ref<WebhookSubscription[]>([])
  // Budgets at or near cap (utilization ≥ 90%). The Overview payload's
  // `over_limit_scopes` is narrower than what operators expect: per
  // spec (cycles-governance-admin-v0.1.25.yaml:1415–1417)
  // `is_over_limit = debt > overdraft_limit` — purely a financial
  // overdraft signal. A budget with spent > allocated but debt = 0
  // (e.g. overdraft_limit = 0, so commit_overage_policy denied the
  // overage) is NOT in `over_limit_scopes` even though it's the
  // operator-visible "this budget is broken" state. Pull the broader
  // at-or-near-cap set from listBudgets?utilization_min=0.9 to close
  // that gap AND surface budgets about to blow before they do. The
  // card encodes severity inline: rows ≥100% render red (at cap),
  // rows 90–99% render amber (near cap, approaching trouble). 10 rows
  // is plenty for a landing card.
  const atCapBudgets = ref<BudgetLedger[]>([])
  // Frozen budgets — `overview.budget_counts.frozen` gives us the
  // count, but not the scopes, so the card had to render as a
  // "View N frozen budgets" center link instead of a list. Fetch
  // listBudgets?status=FROZEN to surface the top-5 frozen scopes
  // inline, matching the at-or-near-cap + with-debt pattern so all
  // three budget cards on row 1 read consistently.
  const frozenBudgets = ref<BudgetLedger[]>([])
  const error = ref('')

  // Partial-walk flags — true when the corresponding cursor walk hit its
  // page cap with the server still reporting more rows. The affected
  // cards surface a "counts may be partial" hint so a truncated aggregate
  // is never presented as the full fleet. Server clamps `limit` to 100 on
  // every list endpoint, so single-request "big limit" fetches silently
  // truncated pre-fix; the walks below are the honest replacement.
  const atCapPartial = ref(false)
  const closedTenantsPartial = ref(false)
  const keysPartial = ref(false)
  const webhooksPartial = ref(false)

  // Cursor-walk wrappers — one page shape per endpoint, LIST_PAGE_LIMIT
  // (100, the server clamp) per page, CURSOR_WALK_MAX_PAGES (10) pages
  // max = 1,000 rows per walk. Walks run in parallel with each other
  // (Promise.allSettled below); each adds at most 9 extra sequential
  // round-trips over the old single fetch, and only on fleets that
  // actually have that many matching rows.
  function walkBudgetsPages(base: Record<string, string>) {
    return walkCursorPages<BudgetLedger>(async (cursor) => {
      const res = await deps.listBudgets({ ...base, limit: String(LIST_PAGE_LIMIT), ...(cursor ? { cursor } : {}) })
      return { items: res.ledgers, hasMore: !!res.has_more, nextCursor: res.next_cursor ?? '' }
    })
  }
  function walkTenantsPages(base: Record<string, string>) {
    return walkCursorPages<{ tenant_id: string }>(async (cursor) => {
      const res = await deps.listTenants({ ...base, limit: String(LIST_PAGE_LIMIT), ...(cursor ? { cursor } : {}) })
      return { items: res.tenants, hasMore: !!res.has_more, nextCursor: res.next_cursor ?? '' }
    })
  }
  function walkWebhooksPages(base: Record<string, string>) {
    return walkCursorPages<WebhookSubscription>(async (cursor) => {
      const res = await deps.listWebhooks({ ...base, limit: String(LIST_PAGE_LIMIT), ...(cursor ? { cursor } : {}) })
      return { items: res.subscriptions, hasMore: !!res.has_more, nextCursor: res.next_cursor ?? '' }
    })
  }
  function walkApiKeysPages(base: Record<string, string>) {
    return walkCursorPages<ApiKey>(async (cursor) => {
      const res = await deps.listApiKeys({ ...base, limit: String(LIST_PAGE_LIMIT), ...(cursor ? { cursor } : {}) })
      return { items: res.keys, hasMore: !!res.has_more, nextCursor: res.next_cursor ?? '' }
    })
  }

  // Walk gating — the four cursor walks are up to 40 sequential list
  // requests per run, far too heavy to replay on every 30s poll tick.
  // They run unconditionally on initial load and manual refresh; on poll
  // ticks they only re-run when the cheap getOverview() aggregate signals
  // change (walkSignature below covers the counter fields backing the
  // walk-fed cards), with a slow-cadence fallback (every 10th fast tick)
  // so drift can't persist indefinitely when counters don't move — e.g.
  // a new ACTIVE api key, which no overview counter reflects. A walk round
  // with any rejection is never committed as done — it retries under the
  // cursor-walk backoff below (see the post-settle commit).
  const WALK_FALLBACK_TICKS = 10
  let forceWalks = true // initial load always walks
  let ticksSinceWalk = 0 // ticks since the last walk ATTEMPT (success or failure)
  let lastWalkSignature: string | null = null
  // POLLING_STALE prevents the shared poller from advancing freshness or
  // changing cadence while this tick counter owns the cursor-walk retry.
  let walkRetryBackoffTicks = 1
  let walkFailStreak = false
  // First failure message from the last attempted walk round. Folded into
  // the error banner (see the post-settle block) so the failure stays
  // visible across the whole backoff window — the opposite defect of the
  // prior round was a banner that cleared as soon as a later tick's
  // phase-1 fetches succeeded while the walks were still broken.
  const walkError = ref('')

  // Counter fields relevant to the walk-backed cards: tenant counts
  // (closed-tenant exclusion walk), budget counts (at/near-cap walk),
  // webhook counts (failing-webhooks walk). The overview payload has no
  // api-key aggregate, so key drift is covered by the fallback re-walk.
  function walkSignature(ov: AdminOverviewResponse): string {
    return JSON.stringify([ov.tenant_counts, ov.budget_counts, ov.webhook_counts])
  }

  // All fetches within a phase parallelize; any individual failure
  // degrades gracefully (error banner, but other sections keep rendering
  // so a flaky audit endpoint doesn't blank out the whole landing page).
  const { refresh, isLoading, lastSuccessAt } = deps.usePolling(async () => {
    // Phase 1 — cheap single-request fetches, every tick.
    const [ov, audit, frozen, debt] = await Promise.allSettled([
      deps.getOverview(),
      // Last 10 audit entries, newest first. Server default sort is
      // timestamp desc per governance-admin spec, so no sort params needed.
      deps.listAuditLogs({ limit: '10' }),
      // Frozen budgets — scopes, not just a count. Lets the Frozen
      // Budgets card list the top 5 inline instead of a center link.
      deps.listBudgets({ status: 'FROZEN', limit: '10' }),
      // Budgets with debt — replaces overview.debt_scopes so the list
      // carries tenant_id and can be filtered against the closed set.
      deps.listBudgets({ has_debt: 'true', limit: '10' }),
    ])
    if (ov.status === 'fulfilled') overview.value = ov.value
    if (audit.status === 'fulfilled') recentAudit.value = audit.value.logs
    if (frozen.status === 'fulfilled') frozenBudgets.value = frozen.value.ledgers
    if (debt.status === 'fulfilled') debtBudgets.value = debt.value.ledgers

    // Phase 2 — the cursor walks, gated. A failed getOverview() yields no
    // signature; walk only if forced or fallback-due (can't detect change).
    // During a failure streak every backed-off polling tick retries. The
    // counter-change trigger is suspended because the uncommitted signature
    // reads as "changed" throughout an outage.
    ticksSinceWalk++
    const sig = ov.status === 'fulfilled' ? walkSignature(ov.value) : null
    const countersChanged = sig !== null && sig !== lastWalkSignature
    const walkDue = ticksSinceWalk >= (walkFailStreak ? walkRetryBackoffTicks : WALK_FALLBACK_TICKS)
    if (forceWalks || walkDue || (countersChanged && !walkFailStreak)) {
      const [apiKeys, atCap, closed, webhooks] = await Promise.allSettled([
        // Expiring-keys card. The server sorts by created_at desc — NOT by
        // expiry — and has no `expires_before` filter, so one default page
        // (50 rows) could miss soon-expiring keys entirely on large fleets.
        // Walk the ACTIVE set (filterExpiringKeys only considers ACTIVE
        // keys) and filter the 7d window client-side.
        walkApiKeysPages({ status: 'ACTIVE' }),
        // Budgets at or near cap (utilization ≥ 0.9). Catches
        // exhausted-without-debt (our blind spot), over-limit-via-debt,
        // AND the 90–99% range so operators can intervene before a
        // budget actually blows rather than after. The at-cap card slices
        // to 5 for display, but the utilization donut computes its
        // Near-cap / Over-cap buckets from this same set so it needs the
        // fleet, not just the top 10. The old single limit='2000' request
        // was silently truncated to 100 by the server-side clamp — the
        // cursor walk is the honest fix (partial flag when > 1,000 rows).
        walkBudgetsPages({ utilization_min: '0.9' }),
        // Closed tenants — exclusion set for all client-side-fetched
        // attention cards (see closedTenantIds declaration). Cursor-walked
        // because the old limit='1000' was clamped to 100 server-side; a
        // partial walk means the exclusion set may be incomplete, so the
        // walk-backed cards fold closedTenantsPartial into their hint.
        walkTenantsPages({ status: 'CLOSED' }),
        // Webhooks — for the Failing Webhooks card. Full list + client
        // filter for (consecutive_failures ?? 0) > 0 (WebhooksView does
        // the same thing; the admin API has no server-side `failing`
        // filter). Cursor-walked — the old limit='200' was clamped to 100.
        walkWebhooksPages({}),
      ])
      if (apiKeys.status === 'fulfilled') {
        keys.value = apiKeys.value.items
        keysPartial.value = apiKeys.value.partial
      }
      if (atCap.status === 'fulfilled') {
        atCapBudgets.value = atCap.value.items
        atCapPartial.value = atCap.value.partial
      }
      if (closed.status === 'fulfilled') {
        closedTenantIds.value = new Set(closed.value.items.map(t => t.tenant_id))
        closedTenantsPartial.value = closed.value.partial
      }
      if (webhooks.status === 'fulfilled') {
        failingWebhooksRaw.value = webhooks.value.items
        webhooksPartial.value = webhooks.value.partial
      }
      // Commit the walk as "done" only when ALL four fulfilled. Committing
      // up-front (pre-fix) meant a rejected walk left its card stale for up
      // to WALK_FALLBACK_TICKS (~5 min) — the next ticks saw an unchanged
      // signature and skipped the walks. On any rejection, keep the
      // signature uncommitted (the next attempt replays the full round),
      // remember the failure for the banner, and back off exponentially
      // instead of hammering the degraded endpoint every tick.
      forceWalks = false
      ticksSinceWalk = 0
      const firstWalkFail = [apiKeys, atCap, closed, webhooks].find(r => r.status === 'rejected')
      if (firstWalkFail && firstWalkFail.status === 'rejected') {
        walkFailStreak = true
        walkRetryBackoffTicks = Math.min(walkRetryBackoffTicks * 2, WALK_FALLBACK_TICKS)
        walkError.value = toMessage(firstWalkFail.reason)
      } else {
        walkFailStreak = false
        walkRetryBackoffTicks = 1
        walkError.value = ''
        if (sig !== null) lastWalkSignature = sig
      }
    }
    // Surface the first failure so the operator sees *something* wrong —
    // but only error-banner; cards for the successful fetches still render.
    // Phase-1 failures win (they're fresher — re-checked every tick);
    // otherwise the last walk round's failure persists across the backoff
    // window instead of clearing between retries.
    const phase1Fail = [ov, audit, frozen, debt].find(r => r.status === 'rejected')
    error.value = phase1Fail && phase1Fail.status === 'rejected'
      ? toMessage(phase1Fail.reason)
      : walkError.value
    // Phase-1 failures use the shared network backoff. Walk failures preserve
    // freshness while their existing tick-based backoff owns retry cadence.
    if (phase1Fail) return false
    return walkError.value ? POLLING_STALE : true
  }, POLL_FAST_MS)

  // Manual refresh (PageHeader button) always re-runs the walks — the
  // operator is explicitly asking for fresh data, so the counter gate
  // must not skip the walk-backed cards.
  //
  // usePolling's refresh() is a deliberate no-op while a tick is in
  // flight (in-flight dedup — other views rely on it, so the composable
  // semantics stay untouched). Walk rounds make Overview ticks span
  // seconds, which turned a mid-round click into a silent drop until the
  // next 30s tick. Queue the click instead: the isLoading watcher below
  // consumes the flag on the true→false edge and re-invokes refreshAll,
  // so forceWalks is armed for the replayed run.
  const pendingManualRefresh = ref(false)
  function refreshAll() {
    if (isLoading.value) {
      pendingManualRefresh.value = true
      return
    }
    forceWalks = true
    refresh()
  }
  watch(isLoading, (now, was) => {
    if (was && !now && pendingManualRefresh.value) {
      pendingManualRefresh.value = false
      refreshAll()
    }
  })

  return {
    overview,
    keys,
    recentAudit,
    closedTenantIds,
    debtBudgets,
    failingWebhooksRaw,
    atCapBudgets,
    frozenBudgets,
    error,
    atCapPartial,
    closedTenantsPartial,
    keysPartial,
    webhooksPartial,
    refreshAll,
    isLoading,
    lastSuccessAt,
  }
}

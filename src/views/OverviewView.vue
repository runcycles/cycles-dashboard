<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue'
import { useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { getOverview, listApiKeys, listAuditLogs, listBudgets, listTenants, listWebhooks } from '../api/client'
import type { AdminOverviewResponse, ApiKey, AuditLogEntry, BudgetLedger, WebhookSubscription } from '../types'
import PageHeader from '../components/PageHeader.vue'
import LoadingSkeleton from '../components/LoadingSkeleton.vue'
import WarningIcon from '../components/icons/WarningIcon.vue'
import CheckCircleIcon from '../components/icons/CheckCircleIcon.vue'
// Lazy-loaded to keep ECharts + vue-echarts out of the OverviewView
// initial chunk. Charts render only after the `v-if` slice-count guard
// passes, so the bundle split also delays the network fetch until the
// chart is actually needed.
const BaseChart = defineAsyncComponent(() => import('../components/BaseChart.vue'))
import { useChartTheme } from '../composables/useChartTheme'
import { formatTime } from '../utils/format'
import { toMessage } from '../utils/errors'
import { filterExpiringKeys, type ExpiringKey } from '../utils/expiringKeys'

// I1 (UI/UX P0): Overview is the operator's landing page and, for an
// admin console, "landing page" means "what needs your attention right
// now". This view puts the alert banner + actionable cards at the top.
// The 4-up counter strip (Tenants / Budgets / Webhooks / Events) sits
// directly below the banner as a quick-jump nav aid (Linear / GitHub /
// Grafana convention) — kept compact so it doesn't compete with the
// alert cards for attention. Each tile is symmetrical: title + total +
// color-coded state chips that drill down to the filtered list view.
// Adds an "Expiring API keys (7d)" card and a "Recent operator
// activity" audit feed (also closes I3).

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

// All eight fetches parallelize; any individual failure degrades
// gracefully (error banner, but other sections keep rendering so a
// flaky audit endpoint doesn't blank out the whole landing page).
const { refresh, isLoading } = usePolling(async () => {
  const [ov, apiKeys, audit, atCap, frozen, closed, debt, webhooks] = await Promise.allSettled([
    getOverview(),
    // Pull one page; client-side filter for 7d window. Fine even for
    // tenants with thousands of keys — we don't need the full set,
    // we need the upcoming expiries, and server returns keys ordered.
    listApiKeys(),
    // Last 10 audit entries, newest first. Server default sort is
    // timestamp desc per governance-admin spec, so no sort params needed.
    listAuditLogs({ limit: '10' }),
    // Budgets at or near cap (utilization ≥ 0.9). Catches
    // exhausted-without-debt (our blind spot), over-limit-via-debt,
    // AND the 90–99% range so operators can intervene before a
    // budget actually blows rather than after. Limit 500 is the
    // fleet-histogram cap — the at-cap card slices to 5 for display,
    // but the utilization donut computes its Near-cap / Over-cap
    // buckets from this same set so it needs a representative sample
    // of the fleet, not just the top 10. Deployments with > 500
    // budgets at ≥ 90% utilization will under-count the donut; the
    // card badge / "View all" link still carry the full audit.
    listBudgets({ utilization_min: '0.9', limit: '500' }),
    // Frozen budgets — scopes, not just a count. Lets the Frozen
    // Budgets card list the top 5 inline instead of a center link.
    listBudgets({ status: 'FROZEN', limit: '10' }),
    // Closed tenants — exclusion set for all client-side-fetched
    // attention cards (see closedTenantIds declaration). Typical admin
    // deployments have << 1000 closed tenants; if a deployment exceeds
    // that, the unfiltered items are over-counted on Overview (server
    // aggregates stay correct), and the follow-up is spec work to add
    // `exclude_closed_tenants` to the list endpoints.
    listTenants({ status: 'CLOSED', limit: '1000' }),
    // Budgets with debt — replaces overview.debt_scopes so the list
    // carries tenant_id and can be filtered against the closed set.
    listBudgets({ has_debt: 'true', limit: '10' }),
    // Webhooks — for the Failing Webhooks card. Full list + client
    // filter for (consecutive_failures ?? 0) > 0 (WebhooksView does
    // the same thing; the admin API has no server-side `failing`
    // filter). Limit sized generously so the typical deployment has
    // all failing subs in this page.
    listWebhooks({ limit: '200' }),
  ])
  if (ov.status === 'fulfilled') overview.value = ov.value
  if (apiKeys.status === 'fulfilled') keys.value = apiKeys.value.keys
  if (audit.status === 'fulfilled') recentAudit.value = audit.value.logs
  if (atCap.status === 'fulfilled') atCapBudgets.value = atCap.value.ledgers
  if (frozen.status === 'fulfilled') frozenBudgets.value = frozen.value.ledgers
  if (closed.status === 'fulfilled') {
    closedTenantIds.value = new Set(closed.value.tenants.map(t => t.tenant_id))
  }
  if (debt.status === 'fulfilled') debtBudgets.value = debt.value.ledgers
  if (webhooks.status === 'fulfilled') failingWebhooksRaw.value = webhooks.value.subscriptions
  // Surface the first failure so the operator sees *something* wrong —
  // but only error-banner; cards for the successful fetches still render.
  const firstFail = [ov, apiKeys, audit, atCap, frozen, closed, debt, webhooks].find(r => r.status === 'rejected')
  error.value = firstFail && firstFail.status === 'rejected' ? toMessage(firstFail.reason) : ''
}, 30000)

// A row belongs on an "attention" card only if its owning tenant is
// not CLOSED. Rows without a tenant_id (pre-v0.1.25.19 servers) are
// kept — we can't prove they're closed, so don't hide them.
function isNotClosedTenant(t: { tenant_id?: string }): boolean {
  if (!t.tenant_id) return true
  return !closedTenantIds.value.has(t.tenant_id)
}

// Utilization helper — BudgetLedger carries {unit, amount} Amount
// objects for allocated/spent. When allocated.amount is 0, utilization
// is undefined; report 0 so the sort is stable and "over cap" logic
// doesn't mis-flag the empty-allocation case.
function utilizationOf(b: BudgetLedger): number {
  const alloc = b.allocated?.amount ?? 0
  const spent = b.spent?.amount ?? 0
  if (alloc <= 0) return 0
  return spent / alloc
}

// Closed-tenant-filtered views. Each attention card derives from its
// *Filtered* computed so the badge, banner axis count, and row list
// all agree. Rows without tenant_id fall through (see isNotClosedTenant).
const atCapBudgetsFiltered = computed<BudgetLedger[]>(() => atCapBudgets.value.filter(isNotClosedTenant))
const frozenBudgetsFiltered = computed<BudgetLedger[]>(() => frozenBudgets.value.filter(isNotClosedTenant))
const debtBudgetsFiltered = computed<BudgetLedger[]>(() => debtBudgets.value.filter(isNotClosedTenant))
const keysFiltered = computed<ApiKey[]>(() => keys.value.filter(isNotClosedTenant))
const failingWebhooksFiltered = computed<WebhookSubscription[]>(() =>
  failingWebhooksRaw.value
    .filter(w => (w.consecutive_failures ?? 0) > 0)
    .filter(isNotClosedTenant)
)

// Sorted descending by utilization so the most-broken budget leads
// the card display. Tie-break by scope for stable rendering. Sliced
// to 5 to match the Expiring Keys card convention — landing-page
// summary, not a full list; "View all" link carries operators to
// /budgets?utilization_min=0.9 for the complete set. The banner
// badge still shows the full count (atCapBudgetsFiltered.length), so
// the operator sees "7" on the pill and 5 rows in the card with the
// "View all" link implicitly covering the other 2.
const atCapSorted = computed<BudgetLedger[]>(() => {
  return [...atCapBudgetsFiltered.value].sort((a, b) => {
    const ua = utilizationOf(a)
    const ub = utilizationOf(b)
    if (ua !== ub) return ub - ua
    return a.scope.localeCompare(b.scope)
  }).slice(0, 5)
})

// Frozen budgets — sort by scope (no natural severity ordering;
// "frozen" is a binary state) and slice to 5 for the landing-page
// summary. "View all" in the header carries operators to the full
// filtered BudgetsView.
const frozenSorted = computed<BudgetLedger[]>(() => {
  return [...frozenBudgetsFiltered.value]
    .sort((a, b) => a.scope.localeCompare(b.scope))
    .slice(0, 5)
})

// Budgets with debt — sort desc by debt amount (server returns ordered
// but filtering may re-order on edge cases; re-sort defensively).
// Slice to 5 for parity with the other two budget cards.
const debtBudgetsSorted = computed<BudgetLedger[]>(() => {
  return [...debtBudgetsFiltered.value]
    .sort((a, b) => (b.debt?.amount ?? 0) - (a.debt?.amount ?? 0))
    .slice(0, 5)
})

// Expiring keys (7d) — sorted soonest-first, capped to 5 for the card.
const expiringKeys = computed<ExpiringKey[]>(() => filterExpiringKeys(keysFiltered.value).slice(0, 5))
const expiringTotal = computed<number>(() => filterExpiringKeys(keysFiltered.value).length)

// Failing webhooks — slice to 5 for landing-page summary parity with
// the three budget cards and Expiring Keys. "View all" link carries
// operators to /webhooks?failing=1 for the complete set. The axis
// badge now shows the filtered count (excludes closed-tenant subs) so
// the banner pill, badge, and card body all agree.
const failingWebhooksSorted = computed<WebhookSubscription[]>(() => {
  return [...failingWebhooksFiltered.value]
    .sort((a, b) => (b.consecutive_failures ?? 0) - (a.consecutive_failures ?? 0))
    .slice(0, 5)
})

// Recent denials — slice to 5 for the same reason. The server caps the
// list at 10; we trim to 5 so every landing-card shows the same top-N
// depth. Full count still flows through the axis badge + banner pill.
const recentDenialsSorted = computed(() => {
  return (overview.value?.recent_denials ?? []).slice(0, 5)
})

// Paused webhook count is derived: the server's WebhookCounts schema
// exposes only {total, active, disabled, with_failures}, but the status
// enum is {ACTIVE, PAUSED, DISABLED} — total includes PAUSED even though
// the field is never broken out. `with_failures` is orthogonal to status
// (it's a failure-count overlay, not a state), so a proper state
// breakdown is active + paused + disabled = total. Compute paused here
// so the Webhooks tile reads as a true state aggregate.
// Math.max guards against server drift so a transient 0-out-of-range
// never renders a negative chip count.
const webhookPausedCount = computed<number>(() => {
  if (!overview.value) return 0
  const wc = overview.value.webhook_counts
  return Math.max(0, wc.total - wc.active - wc.disabled)
})

// Trial visualization (v0.1.25.47): budget status donut. Consumes the
// already-fetched overview.budget_counts — no new request. The stat-strip
// tile right above gives the authoritative numbers; this chart sits
// beside it to visualize the distribution (what share of the fleet is
// active vs. frozen vs. closed vs. over-limit). Colors match the
// counter-strip chip palette so operators read one mental model.
const { palette } = useChartTheme()

// Chart drill-down. Each slice/segment is a filter predicate — clicking
// navigates to the corresponding list view with that filter pre-applied
// via the router. Reuses the existing URL query contracts:
//   - BudgetsView: ?status=ACTIVE|FROZEN|CLOSED and ?filter=over_limit|has_debt
//   - EventsView:  ?category=<name>
// Keeps the chart wrapper stateless; navigation lives with the view
// that owns the data model.
const router = useRouter()

type ChartClickParams = { seriesName?: string; name?: string }

function onBudgetStatusClick(p: ChartClickParams) {
  const name = (p?.name ?? '').toLowerCase()
  if (name === 'active') router.push({ name: 'budgets', query: { status: 'ACTIVE' } })
  else if (name === 'frozen') router.push({ name: 'budgets', query: { status: 'FROZEN' } })
  else if (name === 'closed') router.push({ name: 'budgets', query: { status: 'CLOSED' } })
  else if (name === 'over-limit') router.push({ name: 'budgets', query: { filter: 'over_limit' } })
}

// Budget fleet utilization donut — drill-down by `spent/allocated`
// bucket (not by debt — see `budgetUtilizationOption` for the
// semantic distinction). Operators clicking each slice land on the
// corresponding utilization-filtered list.
//   Healthy  (< 90%)    → unfiltered /budgets (the majority view)
//   Near cap (90–100%)  → ?utilization_min=90&utilization_max=100
//   Over cap (≥ 100%)   → ?utilization_min=100
// Integer-percent bounds are inclusive on both edges, so a budget at
// exactly 90% surfaces in both Healthy (via fleet default) and Near
// cap; exactly 100% surfaces in both Near cap and Over cap. Minor
// boundary overlap is standard histogram behavior.
function onBudgetUtilizationClick(p: ChartClickParams) {
  const name = (p?.name ?? '').toLowerCase()
  if (name === 'near cap') {
    router.push({ name: 'budgets', query: { utilization_min: '90', utilization_max: '100' } })
  } else if (name === 'over cap') {
    router.push({ name: 'budgets', query: { utilization_min: '100' } })
  } else if (name === 'healthy') {
    router.push({ name: 'budgets' })
  }
}

function onEventsCategoryClick(p: ChartClickParams) {
  const name = p?.name ?? ''
  if (name && name !== 'uncategorized') {
    router.push({ name: 'events', query: { category: name } })
  } else if (name === 'uncategorized') {
    router.push({ name: 'events' })
  }
}

// Webhook fleet-health donut. Relocated from WebhooksView
// (v0.1.25.52) — Overview is the glance layer; the list view
// was the wrong home because it squeezed the table and
// duplicated the role of this page's at-a-glance strip.
// Client-side reduce over `failingWebhooksRaw`, which already
// holds the full webhook page (limit 200). The "Failing" slice
// counts any webhook with `consecutive_failures ≥ 1` regardless
// of status, so a PAUSED webhook with latent failures still
// surfaces — matches the `?failing=1` URL filter semantics.
type WebhookFleetSlices = { healthy: number; failing: number; paused: number; disabled: number }
const webhookFleetSlices = computed<WebhookFleetSlices>(() => {
  const out: WebhookFleetSlices = { healthy: 0, failing: 0, paused: 0, disabled: 0 }
  for (const w of failingWebhooksRaw.value) {
    const failing = (w.consecutive_failures ?? 0) >= 1
    if (w.status === 'DISABLED') out.disabled++
    else if (failing) out.failing++
    else if (w.status === 'PAUSED') out.paused++
    else out.healthy++
  }
  return out
})

const webhookHealthOption = computed(() => {
  const f = webhookFleetSlices.value
  const slices = [
    { name: 'Healthy', value: f.healthy, itemStyle: { color: palette.value.success } },
    { name: 'Failing', value: f.failing, itemStyle: { color: palette.value.danger } },
    { name: 'Paused', value: f.paused, itemStyle: { color: palette.value.warning } },
    { name: 'Disabled', value: f.disabled, itemStyle: { color: palette.value.neutral } },
  ].filter(s => s.value > 0)
  return {
    tooltip: {
      trigger: 'item' as const,
      backgroundColor: palette.value.tooltipBg,
      borderColor: palette.value.tooltipBorder,
      textStyle: { color: palette.value.textPrimary },
    },
    legend: {
      bottom: 0,
      type: 'scroll' as const,
      itemWidth: 10,
      itemHeight: 8,
      itemGap: 10,
      textStyle: { color: palette.value.textMuted, fontSize: 11 },
    },
    series: [{
      type: 'pie' as const,
      radius: ['48%', '68%'],
      center: ['50%', '40%'],
      avoidLabelOverlap: true,
      label: { show: false },
      labelLine: { show: false },
      data: slices,
    }],
  }
})

function onWebhookHealthClick(p: ChartClickParams) {
  const name = (p?.name ?? '').toLowerCase()
  if (name === 'failing') router.push({ name: 'webhooks', query: { failing: '1' } })
  else if (name === 'paused') router.push({ name: 'webhooks', query: { status: 'PAUSED' } })
  else if (name === 'disabled') router.push({ name: 'webhooks', query: { status: 'DISABLED' } })
  else if (name === 'healthy') router.push({ name: 'webhooks', query: { status: 'ACTIVE' } })
}

const budgetStatusOption = computed(() => {
  const bc = overview.value?.budget_counts
  const slices = bc
    ? [
        { name: 'Active', value: bc.active, itemStyle: { color: palette.value.success } },
        { name: 'Frozen', value: bc.frozen, itemStyle: { color: palette.value.warning } },
        { name: 'Over-limit', value: bc.over_limit, itemStyle: { color: palette.value.danger } },
        { name: 'Closed', value: bc.closed, itemStyle: { color: palette.value.neutral } },
      ].filter((s) => s.value > 0)
    : []
  return {
    tooltip: {
      trigger: 'item' as const,
      backgroundColor: palette.value.tooltipBg,
      borderColor: palette.value.tooltipBorder,
      textStyle: { color: palette.value.textPrimary },
    },
    legend: {
      bottom: 0,
      type: 'scroll' as const,
      itemWidth: 10,
      itemHeight: 8,
      itemGap: 10,
      textStyle: { color: palette.value.textMuted, fontSize: 11 },
    },
    series: [
      {
        type: 'pie' as const,
        radius: ['48%', '68%'],
        center: ['50%', '40%'],
        avoidLabelOverlap: true,
        label: { show: false },
        labelLine: { show: false },
        data: slices,
      },
    ],
  }
})

// Budget fleet utilization — donut over actual `spent / allocated`
// (true utilization), NOT over the server's debt-based aggregates.
// An earlier iteration derived segments from `budget_counts.over_limit`
// + `budget_counts.with_debt`, but per spec
// (cycles-governance-admin-v0.1.25.yaml:1415–1417) `is_over_limit =
// debt > overdraft_limit` — a purely financial overdraft signal. A
// budget at 113% spent/allocated with overdraft_limit covering the
// overage has debt = 0 and counted as "Healthy" in the old chart
// even though operators would call it critically over cap. The new
// chart reads the same `listBudgets({utilization_min:0.9, limit:500})`
// fetch the attention cards use and buckets by real utilization:
//   • Near cap (90–99%) — warning, "about to blow"
//   • Over cap (≥100%)  — danger, "spent exceeds allocated"
//   • Healthy (<90%)    — success, everything else
// Click contract: each slice drills to the utilization-filtered
// BudgetsView so the operator can triage the band directly. Shape
// matches the other two Overview donuts for visual consistency.
const budgetUtilizationOption = computed(() => {
  const bc = overview.value?.budget_counts
  if (!bc || bc.total === 0) {
    return { series: [{ type: 'pie' as const, data: [] }] }
  }
  // atCapBudgets is server-filtered to utilization ≥ 0.9. Bucket
  // client-side: ≥1.0 → over cap; in [0.9, 1.0) → near cap.
  let nearCap = 0
  let overCap = 0
  for (const b of atCapBudgets.value) {
    if (utilizationOf(b) >= 1) overCap++
    else nearCap++
  }
  // Healthy = total − (near + over). `bc.total` is a server aggregate
  // that includes closed-tenant children, so this slightly over-counts
  // Healthy vs. the cards' closed-tenant-filtered numbers — acceptable
  // because the donut is the fleet-health read, not the attention read.
  // Clamp to 0 in case of transient server/client skew.
  const healthy = Math.max(0, bc.total - nearCap - overCap)
  const slices = [
    { name: 'Healthy', value: healthy, itemStyle: { color: palette.value.success } },
    { name: 'Near cap', value: nearCap, itemStyle: { color: palette.value.warning } },
    { name: 'Over cap', value: overCap, itemStyle: { color: palette.value.danger } },
  ].filter((s) => s.value > 0)
  return {
    tooltip: {
      trigger: 'item' as const,
      backgroundColor: palette.value.tooltipBg,
      borderColor: palette.value.tooltipBorder,
      textStyle: { color: palette.value.textPrimary },
      formatter: (params: unknown) => {
        const p = Array.isArray(params) ? params[0] : params
        const name = String((p as { name?: string }).name ?? '')
        const value = Number((p as { value?: unknown }).value ?? 0)
        const pct = Number((p as { percent?: number }).percent ?? 0)
        const band =
          name === 'Healthy' ? ' (< 90%)' :
          name === 'Near cap' ? ' (90–99%)' :
          name === 'Over cap' ? ' (≥ 100%)' : ''
        return `${name}${band}: <b>${value}</b> (${pct}%)`
      },
    },
    legend: {
      bottom: 0,
      type: 'scroll' as const,
      itemWidth: 10,
      itemHeight: 8,
      itemGap: 10,
      textStyle: { color: palette.value.textMuted, fontSize: 11 },
    },
    series: [
      {
        type: 'pie' as const,
        radius: ['48%', '68%'],
        center: ['50%', '40%'],
        avoidLabelOverlap: true,
        label: { show: false },
        labelLine: { show: false },
        data: slices,
      },
    ],
  }
})

// Events by category donut — what class of activity is the runtime
// emitting in the recent window. Sourced from
// `overview.event_counts.by_category` (already-aggregated). Operators
// use this to sanity-check traffic mix: a sudden spike in "policy" or
// "webhook" events vs. the usual "reservation" baseline is the kind
// of thing that merits attention. Hidden when zero categories have
// non-zero volume.
// Color assignment strategy for event categories:
//   1. `policy` and `reservation` keep semantic colors (danger =
//      denial-adjacent; success = normal traffic) — operators already
//      associate those.
//   2. Every other known category gets a distinct hue from the
//      qualitative palette so no two categories collide. Operator
//      report: "tenant, api_key both grey — why is the color the
//      same for 2 categories?" — fixed by one hue per category.
//   3. Unknown categories fall back to a deterministic hash →
//      qualitative index so two unknowns also land on different
//      slots (not on the same fallback neutral).
function hashCategory(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return h
}
function categoryColor(name: string): string {
  const key = name.toLowerCase()
  if (key === 'policy') return palette.value.danger
  if (key === 'reservation') return palette.value.success
  // Stable qualitative slot per known category (index into palette.categorical).
  const assignments: Record<string, number> = {
    webhook: 0,     // blue
    budget: 2,      // amber
    tenant: 4,      // purple
    api_key: 5,     // teal — was grey before
    apikey: 5,
    audit: 6,       // pink — was grey before
    runtime: 7,     // indigo
    policy_eval: 3, // red-adjacent sub-category
  }
  const cat = palette.value.categorical
  const idx = assignments[key] ?? (hashCategory(key) % cat.length)
  return cat[idx]
}
// Wrapping-grid visibility: always show the row once overview has
// loaded. The events-by-category card is always rendered (with an
// empty-state message if no events), so the 3-up layout stays stable
// across environments — operators reported the row disappearing on
// idle dev environments when we previously hid the events card.
const hasAnyChart = computed(() => overview.value !== null)

const eventsByCategoryOption = computed(() => {
  const ec = overview.value?.event_counts
  const map = ec?.by_category
  let slices = map
    ? Object.entries(map)
        .map(([name, value]) => ({
          name,
          value: value as number,
          itemStyle: { color: categoryColor(name) },
        }))
        .filter((s) => s.value > 0)
        .sort((a, b) => b.value - a.value)
    : []
  // Fallback: if we have events but no category breakdown (older admin
  // versions, or a runtime that hasn't categorized yet), render a
  // single "uncategorized" slice so the chart still shows *something*
  // instead of disappearing. Operators reported "only see 2 charts"
  // exactly because of this empty-by_category path.
  if (slices.length === 0 && (ec?.total_recent ?? 0) > 0) {
    slices = [
      {
        name: 'uncategorized',
        value: ec!.total_recent,
        itemStyle: { color: palette.value.neutral as string },
      },
    ]
  }
  return {
    tooltip: {
      trigger: 'item' as const,
      backgroundColor: palette.value.tooltipBg,
      borderColor: palette.value.tooltipBorder,
      textStyle: { color: palette.value.textPrimary },
      formatter: (params: unknown) => {
        const p = Array.isArray(params) ? params[0] : params
        const name = String((p as { name?: string }).name ?? '')
        const value = Number((p as { value?: unknown }).value ?? 0)
        const pct = Number((p as { percent?: number }).percent ?? 0)
        return `${name}: <b>${value}</b> (${pct}%)`
      },
    },
    legend: {
      bottom: 0,
      type: 'scroll' as const,
      itemWidth: 10,
      itemHeight: 8,
      itemGap: 10,
      textStyle: { color: palette.value.textMuted, fontSize: 11 },
    },
    series: [
      {
        type: 'pie' as const,
        radius: ['48%', '68%'],
        center: ['50%', '40%'],
        avoidLabelOverlap: true,
        label: { show: false },
        labelLine: { show: false },
        data: slices,
      },
    ],
  }
})

// Denial breakdown by reason_code (v0.1.25.8+ server). The per-row
// display is capped at 10 but the breakdown aggregates the full window,
// so it's the honest "why are things getting denied" read when the
// denial volume exceeds the row cap. Sorted desc by count so the
// dominant reason leads. Clickable deep-link to events filtered by
// reason is deferred — `listEvents` server-side search matches only
// correlation_id + scope, not data.reason_code; would require a spec
// addition to the search field set.
interface DenialReason { code: string; count: number }
const denialReasons = computed<DenialReason[]>(() => {
  const map = overview.value?.recent_denials_by_reason
  if (!map) return []
  return Object.entries(map)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count)
})

// Firing-axis model. Each axis declares its severity ('danger' =
// red, something is broken; 'warning' = amber, something needs
// a closer look but isn't outright failing), its count, and the
// anchor id of the card that explains it. The banner enumerates
// this list as jump-link pills so "what and where" is answered
// on the first glance — the operator doesn't have to scan all
// six cards to find the two that are firing.
type AxisSeverity = 'danger' | 'warning'
interface AlertAxis {
  id: string          // hash anchor — matches the card's id attribute
  label: string       // short human label, pluralized elsewhere
  count: number
  severity: AxisSeverity
}
// Axis counts derive from the closed-tenant-filtered lists so the
// banner pills, card badges, and card row counts all agree. Server
// aggregates (`webhook_counts.with_failures`, `budget_counts.frozen`,
// etc.) still power the counter-strip tile chips, which are
// navigational, not attention signals — see closedTenantIds.
const alertAxes = computed<AlertAxis[]>(() => {
  if (!overview.value) return []
  const axes: AlertAxis[] = []
  if (failingWebhooksFiltered.value.length > 0) {
    axes.push({ id: 'failing-webhooks', label: 'Failing webhooks', count: failingWebhooksFiltered.value.length, severity: 'danger' })
  }
  // atCapBudgetsFiltered is broader than overview.budget_counts.over_limit —
  // catches exhausted-without-debt AND the 90–99% "about to blow"
  // range (see atCapBudgets declaration for spec-gap rationale).
  // Severity tracks the worst row: danger if any budget is actually
  // at/over cap, warning if everything firing is in the near-cap
  // 90–99% range.
  if (atCapBudgetsFiltered.value.length > 0) {
    const anyAtCap = atCapBudgetsFiltered.value.some(b => utilizationOf(b) >= 1)
    axes.push({
      id: 'budgets-at-cap',
      label: anyAtCap ? 'Budgets at or near cap' : 'Budgets near cap',
      count: atCapBudgetsFiltered.value.length,
      severity: anyAtCap ? 'danger' : 'warning',
    })
  }
  if (overview.value.recent_denials.length > 0) {
    axes.push({ id: 'recent-denials', label: 'Recent denials', count: overview.value.recent_denials.length, severity: 'danger' })
  }
  if (debtBudgetsFiltered.value.length > 0) {
    axes.push({ id: 'budgets-with-debt', label: 'Budgets with debt', count: debtBudgetsFiltered.value.length, severity: 'warning' })
  }
  if (expiringTotal.value > 0) {
    axes.push({ id: 'expiring-keys', label: 'Expiring keys', count: expiringTotal.value, severity: 'warning' })
  }
  if (frozenBudgetsFiltered.value.length > 0) {
    axes.push({ id: 'frozen-budgets', label: 'Frozen budgets', count: frozenBudgetsFiltered.value.length, severity: 'warning' })
  }
  return axes
})
// Lookup by card id → firing state. Card templates consult this to
// decide whether to apply the severity border + warning icon.
const axisById = computed<Record<string, AlertAxis>>(() => {
  const m: Record<string, AlertAxis> = {}
  for (const a of alertAxes.value) m[a.id] = a
  return m
})
const alertCount = computed<number>(() => alertAxes.value.length)
// Scroll-to-card handler. Smooth-scroll gives visual continuity
// between banner click and card focus without the jarring jump the
// default anchor nav produces.
function jumpTo(id: string) {
  const el = document.getElementById(id)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// Map an audit entry to the most useful detail-view link. Falls back
// to the Audit view with a pre-filled filter so "click through for
// context" always works.
function auditLinkFor(entry: AuditLogEntry): { name: string; params?: Record<string, string>; query?: Record<string, string> } {
  if (entry.resource_type === 'tenant' && entry.resource_id) {
    return { name: 'tenant-detail', params: { id: entry.resource_id } }
  }
  if (entry.resource_type === 'webhook' && entry.resource_id) {
    return { name: 'webhook-detail', params: { id: entry.resource_id } }
  }
  // Default: jump to audit with the log_id surfaced so the operator
  // sees the full row including metadata.
  return { name: 'audit', query: { search: entry.log_id } }
}
</script>

<template>
  <div>
    <PageHeader
      title="Overview"
      subtitle="What needs attention"
      :loading="isLoading"
      @refresh="refresh"
    />

    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-2 mb-4 dark:bg-red-950 dark:border-red-800 dark:text-red-300">
      {{ error }}
    </p>

    <LoadingSkeleton v-if="!overview" />

    <template v-else>
      <!-- Alert headline. Enumerates firing axes as jump-link pills so
           "what and where" is answered on the first glance — operator
           clicks a pill to smooth-scroll to the card that explains it.
           Each pill carries its own severity color (red = danger,
           amber = warning) so even users with color-vision deficiency
           have the triangle icon as a second cue. -->
      <div
        v-if="alertCount > 0"
        role="status"
        data-testid="alert-banner"
        class="mb-4 px-4 py-3 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800"
      >
        <div class="flex items-center gap-3 mb-2">
          <WarningIcon class="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
          <p class="text-sm text-amber-900 dark:text-amber-200">
            <strong>{{ alertCount }} {{ alertCount === 1 ? 'area needs' : 'areas need' }} attention</strong>
          </p>
        </div>
        <div class="flex flex-wrap gap-1.5 pl-8" data-testid="alert-axes">
          <button
            v-for="a in alertAxes"
            :key="a.id"
            type="button"
            :data-axis="a.id"
            @click="jumpTo(a.id)"
            class="chip cursor-pointer hover:underline"
            :class="a.severity === 'danger' ? 'chip-danger' : 'chip-warning'"
            :title="`Jump to ${a.label}`"
          >{{ a.label }} <span class="ml-1 tabular-nums">·{{ a.count }}</span></button>
        </div>
      </div>
      <div
        v-else
        role="status"
        class="mb-4 px-4 py-3 rounded-lg border border-green-200 bg-green-50 dark:bg-green-950/40 dark:border-green-800 flex items-center gap-3"
      >
        <CheckCircleIcon class="w-5 h-5 text-green-600 dark:text-green-400 shrink-0" />
        <p class="text-sm text-green-900 dark:text-green-200">
          <strong>All clear.</strong>
          No webhooks failing, no budgets near cap, no keys near expiry, no denials in the last hour.
        </p>
      </div>

      <!-- AT-A-GLANCE TOTALS — compact 4-up strip directly below the
           status banner. Serves as quick-jump navigation to each
           resource list view (Linear / GitHub / Grafana convention).
           Each tile is symmetrical: title (clickable → unfiltered list)
           + total + a row of state chips. Each chip is a drill-down
           link to the same list view filtered by that state.
           Color convention: green = healthy/active, yellow =
           paused/frozen/disabled/expiring, red = failing/over-limit,
           gray = closed/neutral, blue/purple = event categories.
           Kept compact (text-lg + p-3) so it stays a nav aid, not the
           hero — alert cards below get the operator's main attention. -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6" data-testid="counter-strip">
        <!-- TENANTS — total + active / suspended / closed chips. -->
        <div class="card p-3" data-testid="tile-tenants">
          <div class="flex justify-between items-baseline mb-1">
            <router-link to="/tenants" class="text-sm font-medium text-gray-700 dark:text-gray-200 hover:underline">Tenants</router-link>
            <router-link to="/tenants" class="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:underline">{{ overview.tenant_counts.total }}</router-link>
          </div>
          <div class="flex flex-wrap gap-1">
            <router-link
              v-if="overview.tenant_counts.active > 0"
              :to="{ name: 'tenants', query: { status: 'ACTIVE' } }"
              class="chip chip-success"
              :title="`${overview.tenant_counts.active} active tenants`"
            >{{ overview.tenant_counts.active }} active</router-link>
            <router-link
              v-if="overview.tenant_counts.suspended > 0"
              :to="{ name: 'tenants', query: { status: 'SUSPENDED' } }"
              class="chip chip-warning"
              :title="`${overview.tenant_counts.suspended} suspended tenants`"
            >{{ overview.tenant_counts.suspended }} suspended</router-link>
            <router-link
              v-if="overview.tenant_counts.closed > 0"
              :to="{ name: 'tenants', query: { status: 'CLOSED' } }"
              class="chip chip-neutral"
              :title="`${overview.tenant_counts.closed} closed tenants`"
            >{{ overview.tenant_counts.closed }} closed</router-link>
          </div>
        </div>

        <!-- BUDGETS — total + active / frozen / closed chips, plus
             over-limit / with-debt warning chips when present. -->
        <div class="card p-3" data-testid="tile-budgets">
          <div class="flex justify-between items-baseline mb-1">
            <router-link to="/budgets" class="text-sm font-medium text-gray-700 dark:text-gray-200 hover:underline">Budgets</router-link>
            <router-link to="/budgets" class="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:underline">{{ overview.budget_counts.total }}</router-link>
          </div>
          <div class="flex flex-wrap gap-1">
            <router-link
              v-if="overview.budget_counts.active > 0"
              :to="{ name: 'budgets', query: { status: 'ACTIVE' } }"
              class="chip chip-success"
              :title="`${overview.budget_counts.active} active budgets`"
            >{{ overview.budget_counts.active }} active</router-link>
            <router-link
              v-if="overview.budget_counts.frozen > 0"
              :to="{ name: 'budgets', query: { status: 'FROZEN' } }"
              class="chip chip-warning"
              :title="`${overview.budget_counts.frozen} frozen budgets`"
            >{{ overview.budget_counts.frozen }} frozen</router-link>
            <router-link
              v-if="overview.budget_counts.closed > 0"
              :to="{ name: 'budgets', query: { status: 'CLOSED' } }"
              class="chip chip-neutral"
              :title="`${overview.budget_counts.closed} closed budgets`"
            >{{ overview.budget_counts.closed }} closed</router-link>
            <router-link
              v-if="overview.budget_counts.over_limit > 0"
              :to="{ name: 'budgets', query: { filter: 'over_limit' } }"
              class="chip chip-danger"
              :title="`${overview.budget_counts.over_limit} budgets over limit`"
            >{{ overview.budget_counts.over_limit }} over</router-link>
            <router-link
              v-if="overview.budget_counts.with_debt > 0"
              :to="{ name: 'budgets', query: { filter: 'has_debt' } }"
              class="chip chip-warning"
              :title="`${overview.budget_counts.with_debt} budgets with debt`"
            >{{ overview.budget_counts.with_debt }} debt</router-link>
          </div>
        </div>

        <!-- WEBHOOKS — total + active / disabled / failing chips.
             Failing is derived from consecutive_failures > 0, not a
             status enum, so it deep-links via ?failing=1. -->
        <div class="card p-3" data-testid="tile-webhooks">
          <div class="flex justify-between items-baseline mb-1">
            <router-link to="/webhooks" class="text-sm font-medium text-gray-700 dark:text-gray-200 hover:underline">Webhooks</router-link>
            <router-link to="/webhooks" class="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:underline">{{ overview.webhook_counts.total }}</router-link>
          </div>
          <div class="flex flex-wrap gap-1">
            <router-link
              v-if="overview.webhook_counts.active > 0"
              :to="{ name: 'webhooks', query: { status: 'ACTIVE' } }"
              class="chip chip-success"
              :title="`${overview.webhook_counts.active} active webhooks`"
            >{{ overview.webhook_counts.active }} active</router-link>
            <router-link
              v-if="webhookPausedCount > 0"
              :to="{ name: 'webhooks', query: { status: 'PAUSED' } }"
              class="chip chip-warning"
              :title="`${webhookPausedCount} paused webhooks`"
            >{{ webhookPausedCount }} paused</router-link>
            <router-link
              v-if="overview.webhook_counts.disabled > 0"
              :to="{ name: 'webhooks', query: { status: 'DISABLED' } }"
              class="chip chip-neutral"
              :title="`${overview.webhook_counts.disabled} disabled webhooks`"
            >{{ overview.webhook_counts.disabled }} disabled</router-link>
            <router-link
              v-if="overview.webhook_counts.with_failures > 0"
              :to="{ name: 'webhooks', query: { failing: '1' } }"
              class="chip chip-danger"
              :title="`${overview.webhook_counts.with_failures} webhooks with failures`"
            >{{ overview.webhook_counts.with_failures }} failing</router-link>
          </div>
        </div>

        <!-- EVENTS — total recent + per-category chips. Categories are
             unbounded (Record<string, number>) so we cycle through a
             palette of category-coded chip styles for visual distinction. -->
        <div class="card p-3" data-testid="tile-events">
          <div class="flex justify-between items-baseline mb-1">
            <router-link to="/events" class="text-sm font-medium text-gray-700 dark:text-gray-200 hover:underline">
              Events <span class="muted font-normal">({{ Math.round(overview.event_window_seconds / 60) }}m)</span>
            </router-link>
            <router-link to="/events" class="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:underline">{{ overview.event_counts.total_recent }}</router-link>
          </div>
          <div class="flex flex-wrap gap-1">
            <router-link
              v-for="(count, cat) in overview.event_counts.by_category"
              :key="cat"
              :to="{ name: 'events', query: { category: cat } }"
              class="chip chip-category"
              :title="`${count} ${cat} events`"
            >{{ count }} {{ cat }}</router-link>
            <span v-if="!Object.keys(overview.event_counts.by_category).length" class="muted-sm">no events</span>
          </div>
        </div>
      </div>

      <!-- At-a-glance visualizations. Four lightweight ancillary
           charts that read payload already in-flight — no new
           fetches. Each hides itself when its backing data is empty
           so an empty fleet never surfaces an empty chart. Layout
           is a 4-up grid on wide screens, 2-up on medium, stacking
           vertically on narrow.
             • Budget status distribution (donut) — lifecycle mix
               (active / frozen / closed / over-limit).
             • Budget fleet utilization (donut) — true utilization
               buckets (Healthy < 90% / Near cap 90–99% /
               Over cap ≥ 100%) computed from spent/allocated across
               the at-cap fetch, NOT from the debt-based server
               aggregate. See `budgetUtilizationOption` for rationale.
             • Webhook fleet health (donut, v0.1.25.52) — relocated
               from WebhooksView; Healthy / Failing / Paused /
               Disabled; click drills to /webhooks?status=... or
               ?failing=1.
             • Events by category (donut) — recent activity mix
               across the event window. -->
      <div
        v-if="hasAnyChart"
        class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6"
        data-testid="overview-charts"
      >
        <div
          v-if="budgetStatusOption.series[0].data.length > 0"
          class="card p-3"
          data-testid="budget-status-donut"
        >
          <div class="text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
            Budget status distribution
            <span class="muted text-xs font-normal">· click a slice</span>
          </div>
          <BaseChart
            :option="budgetStatusOption"
            label="Budget status distribution donut chart — clickable"
            height="200px"
            @slice-click="onBudgetStatusClick"
          />
        </div>

        <div
          v-if="overview.budget_counts.total > 0"
          class="card p-3"
          data-testid="budget-utilization-donut"
        >
          <div class="text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
            Budget fleet utilization
            <span class="muted text-xs font-normal">· click a slice</span>
          </div>
          <BaseChart
            :option="budgetUtilizationOption"
            label="Budget fleet utilization donut chart — clickable"
            height="200px"
            @slice-click="onBudgetUtilizationClick"
          />
        </div>

        <div
          v-if="failingWebhooksRaw.length > 0"
          class="card p-3"
          data-testid="webhook-fleet-health-donut"
        >
          <div class="text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
            Webhook fleet health
            <span class="muted text-xs font-normal">· click a slice</span>
          </div>
          <BaseChart
            :option="webhookHealthOption"
            label="Webhook fleet health donut chart — clickable"
            height="200px"
            @slice-click="onWebhookHealthClick"
          />
        </div>

        <div
          class="card p-3"
          data-testid="events-by-category-donut"
        >
          <div class="text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
            Events by category ({{ Math.round(overview.event_window_seconds / 60) }}m)
            <span class="muted text-xs font-normal">· click a slice</span>
          </div>
          <BaseChart
            v-if="eventsByCategoryOption.series[0].data.length > 0"
            :option="eventsByCategoryOption"
            label="Events by category donut chart — clickable"
            height="200px"
            @slice-click="onEventsCategoryClick"
          />
          <div
            v-else
            class="flex items-center justify-center text-xs muted"
            style="height: 180px"
          >
            No recent events in the last {{ Math.round(overview.event_window_seconds / 60) }}m
          </div>
        </div>
      </div>

      <!-- WHAT NEEDS ATTENTION — 6 cards, alerts-first. Each card has a
           "problems first" orientation: count badge + severity-colored
           left border + warning icon in the title row if firing;
           positive reassurance copy + neutral card if healthy.
           `id` attributes match AlertAxis.id so the banner pills
           smooth-scroll to the right card. Cards don't reorder across
           polls — stable position, variable prominence.
           Layout: row 1 = the three budget cards together (at cap /
           with debt / frozen), row 2 = non-budget signals (webhooks /
           keys / denials). Budgets lead because "is anything over
           cap?" is the single most-asked ops question at 2am, and
           grouping all budget-scoped alerts on row 1 makes "state of
           budgets" a single horizontal scan. -->
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        <!-- Budgets at or near cap — utilization ≥ 90%. Broader than
             the spec's `over_limit` (debt > overdraft_limit) so
             exhausted budgets with no overdraft appetite AND budgets
             in the 90–99% "about to blow" range both surface here;
             see atCapBudgets declaration in the script block. Row-level
             color encodes per-budget severity (red ≥100%, amber 90–99%)
             so operators can triage at-cap vs. approaching at a glance.
             Card-level severity (border + icon + badge) follows the
             worst row — danger if any budget is actually at/over cap,
             warning if everything firing is in the near-cap range.
             Leads row 1 — the three budget cards are grouped together
             because "state of budgets" is the headline ops question. -->
        <div
          id="budgets-at-cap"
          class="card p-4"
          data-testid="budgets-at-cap-card"
          :class="axisById['budgets-at-cap']
            ? (axisById['budgets-at-cap'].severity === 'danger'
                ? 'border-l-4 border-l-red-500 dark:border-l-red-500'
                : 'border-l-4 border-l-amber-500 dark:border-l-amber-500')
            : ''"
        >
          <div class="flex justify-between items-center mb-3">
            <h2 class="text-sm font-medium text-gray-700 dark:text-gray-200 flex items-center gap-1.5">
              <WarningIcon
                v-if="axisById['budgets-at-cap']"
                class="w-4 h-4 shrink-0"
                :class="axisById['budgets-at-cap'].severity === 'danger' ? 'text-red-500 dark:text-red-400' : 'text-amber-500 dark:text-amber-400'"
              />
              Budgets at or near cap
              <span
                v-if="atCapBudgetsFiltered.length > 0"
                class="ml-1"
                :class="axisById['budgets-at-cap']?.severity === 'danger' ? 'badge-danger' : 'badge-warning'"
              >{{ atCapBudgetsFiltered.length }}</span>
            </h2>
            <router-link :to="{ name: 'budgets', query: { utilization_min: '90' } }" class="text-xs text-blue-600 hover:underline dark:text-blue-400">View all</router-link>
          </div>
          <div v-if="atCapSorted.length === 0" class="text-sm muted py-4 text-center">All budgets under 90% utilized</div>
          <div
            v-for="b in atCapSorted"
            :key="b.scope + b.unit"
            class="flex justify-between items-center py-1.5 border-b border-gray-100 last:border-0 dark:border-gray-700"
          >
            <router-link
              :to="{ name: 'budgets', query: { scope: b.scope, unit: b.unit } }"
              class="text-sm text-blue-600 hover:underline truncate mr-2 dark:text-blue-400"
              :title="b.scope"
            >{{ b.scope }}</router-link>
            <span
              class="text-xs shrink-0 tabular-nums"
              :class="utilizationOf(b) >= 1 ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'"
              :title="`${b.spent?.amount?.toLocaleString() ?? '0'} / ${b.allocated?.amount?.toLocaleString() ?? '0'} ${b.unit}`"
            >{{ Math.round(utilizationOf(b) * 100) }}%</span>
          </div>
        </div>

        <!-- Budgets with debt -->
        <div
          id="budgets-with-debt"
          class="card p-4"
          :class="axisById['budgets-with-debt'] ? 'border-l-4 border-l-amber-500 dark:border-l-amber-500' : ''"
        >
          <div class="flex justify-between items-center mb-3">
            <h2 class="text-sm font-medium text-gray-700 dark:text-gray-200 flex items-center gap-1.5">
              <WarningIcon v-if="axisById['budgets-with-debt']" class="w-4 h-4 text-amber-500 dark:text-amber-400 shrink-0" />
              Budgets with debt
              <span v-if="debtBudgetsFiltered.length > 0" class="ml-1 badge-warning">{{ debtBudgetsFiltered.length }}</span>
            </h2>
            <router-link :to="{ name: 'budgets', query: { filter: 'has_debt' } }" class="text-xs text-blue-600 hover:underline dark:text-blue-400">View all</router-link>
          </div>
          <div v-if="debtBudgetsSorted.length === 0" class="text-sm muted py-4 text-center">No outstanding debt</div>
          <div
            v-for="b in debtBudgetsSorted"
            :key="b.scope + b.unit"
            class="flex justify-between items-center py-1.5 border-b border-gray-100 last:border-0 dark:border-gray-700"
          >
            <router-link
              :to="{ name: 'budgets', query: { scope: b.scope, unit: b.unit } }"
              class="text-sm text-blue-600 hover:underline truncate mr-2 dark:text-blue-400"
              :title="b.scope"
            >{{ b.scope }}</router-link>
            <span class="muted-sm shrink-0 tabular-nums">{{ (b.debt?.amount ?? 0).toLocaleString() }} / {{ (b.overdraft_limit?.amount ?? 0).toLocaleString() }}</span>
          </div>
        </div>

        <!-- Frozen budgets -->
        <div
          id="frozen-budgets"
          class="card p-4"
          :class="axisById['frozen-budgets'] ? 'border-l-4 border-l-amber-500 dark:border-l-amber-500' : ''"
        >
          <div class="flex justify-between items-center mb-3">
            <h2 class="text-sm font-medium text-gray-700 dark:text-gray-200 flex items-center gap-1.5">
              <WarningIcon v-if="axisById['frozen-budgets']" class="w-4 h-4 text-amber-500 dark:text-amber-400 shrink-0" />
              Frozen budgets
              <span v-if="frozenBudgetsFiltered.length > 0" class="ml-1 badge-warning">{{ frozenBudgetsFiltered.length }}</span>
            </h2>
            <router-link :to="{ name: 'budgets', query: { status: 'FROZEN' } }" class="text-xs text-blue-600 hover:underline dark:text-blue-400">View all</router-link>
          </div>
          <!-- Empty state: prefer the filtered list as the source of
               truth. If the frozen-scopes fetch failed but the overview
               count is non-zero, we surface the count rather than
               silently rendering "No frozen budgets" — otherwise the
               card would contradict the banner badge. The overview
               count includes closed-tenant children (server aggregate),
               so the "details unavailable" line can over-state vs the
               filtered card; acceptable fallback, matches the banner. -->
          <div v-if="frozenSorted.length === 0 && overview.budget_counts.frozen === 0" class="text-sm muted py-4 text-center">No frozen budgets</div>
          <div v-else-if="frozenSorted.length === 0" class="text-sm muted py-4 text-center">
            {{ overview.budget_counts.frozen }} frozen budget<span v-if="overview.budget_counts.frozen !== 1">s</span> — details unavailable
          </div>
          <div
            v-for="b in frozenSorted"
            :key="b.scope + b.unit"
            class="flex justify-between items-center py-1.5 border-b border-gray-100 last:border-0 dark:border-gray-700"
          >
            <router-link
              :to="{ name: 'budgets', query: { scope: b.scope, unit: b.unit } }"
              class="text-sm text-blue-600 hover:underline truncate mr-2 dark:text-blue-400"
              :title="b.scope"
            >{{ b.scope }}</router-link>
            <!-- Allocated amount as the secondary — tells the operator
                 how much capacity is frozen at a glance. Debt cards show
                 debt/limit, at-cap cards show utilization %; this one
                 leans on allocated since "frozen" is a binary state,
                 not a magnitude. -->
            <span class="muted-sm shrink-0 tabular-nums" :title="`${b.allocated?.amount?.toLocaleString() ?? '0'} ${b.unit} allocated`">{{ b.allocated?.amount?.toLocaleString() ?? '0' }} {{ b.unit }}</span>
          </div>
        </div>

        <!-- Failing webhooks -->
        <div
          id="failing-webhooks"
          class="card p-4"
          :class="axisById['failing-webhooks'] ? 'border-l-4 border-l-red-500 dark:border-l-red-500' : ''"
        >
          <div class="flex justify-between items-center mb-3">
            <h2 class="text-sm font-medium text-gray-700 dark:text-gray-200 flex items-center gap-1.5">
              <WarningIcon v-if="axisById['failing-webhooks']" class="w-4 h-4 text-red-500 dark:text-red-400 shrink-0" />
              Failing webhooks
              <span v-if="failingWebhooksFiltered.length > 0" class="ml-1 badge-danger">{{ failingWebhooksFiltered.length }}</span>
            </h2>
            <router-link to="/webhooks" class="text-xs text-blue-600 hover:underline dark:text-blue-400">View all</router-link>
          </div>
          <div v-if="failingWebhooksSorted.length === 0" class="text-sm muted py-4 text-center">All webhooks healthy</div>
          <div
            v-for="w in failingWebhooksSorted"
            :key="w.subscription_id"
            class="flex justify-between items-center py-1.5 border-b border-gray-100 last:border-0 dark:border-gray-700"
          >
            <router-link
              :to="{ name: 'webhook-detail', params: { id: w.subscription_id } }"
              class="text-sm text-blue-600 hover:underline truncate mr-2 dark:text-blue-400"
              :title="w.url"
            >{{ w.url }}</router-link>
            <span class="text-xs text-red-600 dark:text-red-400 shrink-0 tabular-nums">{{ w.consecutive_failures ?? 0 }} failures</span>
          </div>
        </div>

        <!-- Expiring API keys -->
        <div
          id="expiring-keys"
          class="card p-4"
          data-testid="expiring-keys-card"
          :class="axisById['expiring-keys'] ? 'border-l-4 border-l-amber-500 dark:border-l-amber-500' : ''"
        >
          <div class="flex justify-between items-center mb-3">
            <h2 class="text-sm font-medium text-gray-700 dark:text-gray-200 flex items-center gap-1.5">
              <WarningIcon v-if="axisById['expiring-keys']" class="w-4 h-4 text-amber-500 dark:text-amber-400 shrink-0" />
              Expiring API keys <span class="muted font-normal">(7d)</span>
              <span v-if="expiringTotal > 0" class="ml-1 badge-warning">{{ expiringTotal }}</span>
            </h2>
            <router-link :to="{ name: 'api-keys' }" class="text-xs text-blue-600 hover:underline dark:text-blue-400">View all</router-link>
          </div>
          <div v-if="expiringKeys.length === 0" class="text-sm muted py-4 text-center">No keys expiring in the next 7 days</div>
          <div
            v-for="e in expiringKeys"
            :key="e.key.key_id"
            class="flex justify-between items-center py-1.5 border-b border-gray-100 last:border-0 dark:border-gray-700"
          >
            <router-link
              :to="{ name: 'api-keys', query: { key_id: e.key.key_id } }"
              class="text-sm text-blue-600 hover:underline truncate mr-2 dark:text-blue-400"
              :title="e.key.key_id"
            >{{ e.key.name || e.key.key_id }}</router-link>
            <span
              class="text-xs shrink-0 tabular-nums"
              :class="e.daysUntilExpiry <= 2 ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'"
            >{{ e.daysUntilExpiry }}d</span>
          </div>
        </div>

        <!-- Recent denials (runtime plane) -->
        <div
          id="recent-denials"
          class="card p-4"
          :class="axisById['recent-denials'] ? 'border-l-4 border-l-red-500 dark:border-l-red-500' : ''"
        >
          <div class="flex justify-between items-center mb-3">
            <h2 class="text-sm font-medium text-gray-700 dark:text-gray-200 flex items-center gap-1.5">
              <WarningIcon v-if="axisById['recent-denials']" class="w-4 h-4 text-red-500 dark:text-red-400 shrink-0" />
              Recent denials <span class="muted font-normal">(1h)</span>
              <span v-if="overview.recent_denials.length > 0" class="ml-1 badge-danger">{{ overview.recent_denials.length }}</span>
            </h2>
            <router-link :to="{ name: 'events', query: { type: 'reservation.denied' } }" class="text-xs text-blue-600 hover:underline dark:text-blue-400">View all</router-link>
          </div>
          <div v-if="overview.recent_denials.length === 0" class="text-sm muted py-4 text-center">No denials in the last hour</div>
          <!-- Reason breakdown across the full window (v0.1.25.8+ server).
               Shown when populated — server omits the field when no
               denial has a reason_code set, so absence is meaningful
               (denials exist but upstream hasn't filled reason_code). -->
          <div
            v-if="denialReasons.length > 0"
            data-testid="denial-reasons"
            class="flex flex-wrap gap-1.5 pb-2 mb-2 border-b border-gray-100 dark:border-gray-700"
          >
            <!-- cycles-governance-admin v0.1.25.24 unlocked server-side
                 filtering of audit logs by error_code. Each reason pill
                 now drills into /audit?error_code=CODE&status_band=errors
                 so the operator lands on the failed admin operations
                 carrying that code — the actionable read behind "12
                 denials with reason X". AuditView's URL-param wiring
                 reads both params on mount. -->
            <router-link
              v-for="r in denialReasons"
              :key="r.code"
              :to="{ name: 'audit', query: { error_code: r.code, status_band: 'errors' } }"
              class="chip chip-danger hover:underline"
              :title="`View ${r.count} audit ${r.count === 1 ? 'entry' : 'entries'} with error_code ${r.code}`"
            >{{ r.code }} <span class="ml-1 tabular-nums">×{{ r.count }}</span></router-link>
          </div>
          <div
            v-for="e in recentDenialsSorted"
            :key="e.event_id"
            class="py-1.5 border-b border-gray-100 last:border-0 dark:border-gray-700"
          >
            <div class="flex justify-between">
              <span class="text-sm text-gray-700 truncate dark:text-gray-200">{{ e.scope || e.tenant_id }}</span>
              <span class="muted-sm shrink-0 ml-2" :title="new Date(e.timestamp).toISOString()">{{ formatTime(e.timestamp) }}</span>
            </div>
            <p class="muted-sm">{{ e.data?.reason_code || 'denied' }}</p>
          </div>
        </div>
      </div>

      <!-- RECENT OPERATOR ACTIVITY (closes I3) — the "who did what in the
           last hour" read that was missing from the old Overview. -->
      <div class="mb-6">
        <div class="card p-4" data-testid="recent-activity-card">
          <div class="flex justify-between items-center mb-3">
            <h2 class="text-sm font-medium text-gray-700 dark:text-gray-200">Recent operator activity</h2>
            <router-link :to="{ name: 'audit' }" class="text-xs text-blue-600 hover:underline dark:text-blue-400">View all</router-link>
          </div>
          <div v-if="recentAudit.length === 0" class="text-sm muted py-4 text-center">No operator changes in range</div>
          <div
            v-for="a in recentAudit"
            :key="a.log_id"
            class="py-1.5 border-b border-gray-100 last:border-0 dark:border-gray-700"
          >
            <div class="flex justify-between items-baseline gap-2">
              <!-- Operation name rendered raw (dot-separated enum) in
                   font-mono to match AuditView.vue column render. -->
              <router-link
                :to="auditLinkFor(a)"
                class="font-mono text-xs text-blue-600 hover:underline truncate dark:text-blue-400"
                :title="a.operation"
              >{{ a.operation }}</router-link>
              <span class="muted-sm shrink-0" :title="new Date(a.timestamp).toISOString()">{{ formatTime(a.timestamp) }}</span>
            </div>
            <p class="muted-sm truncate">
              <span v-if="a.tenant_id" class="font-mono">{{ a.tenant_id }}</span>
              <span v-if="a.error_code" class="ml-1 text-red-600 dark:text-red-400">· {{ a.error_code }}</span>
              <span v-else-if="a.status >= 400" class="ml-1 text-red-600 dark:text-red-400">· {{ a.status }}</span>
            </p>
          </div>
        </div>
      </div>

    </template>
  </div>
</template>

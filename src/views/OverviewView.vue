<script setup lang="ts">
import { computed, ref } from 'vue'
import { usePolling } from '../composables/usePolling'
import { getOverview, listApiKeys, listAuditLogs, listBudgets } from '../api/client'
import type { AdminOverviewResponse, ApiKey, AuditLogEntry, BudgetLedger } from '../types'
import PageHeader from '../components/PageHeader.vue'
import LoadingSkeleton from '../components/LoadingSkeleton.vue'
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

// All five fetches parallelize; any individual failure degrades
// gracefully (error banner, but other sections keep rendering so a
// flaky audit endpoint doesn't blank out the whole landing page).
const { refresh, isLoading } = usePolling(async () => {
  const [ov, apiKeys, audit, atCap, frozen] = await Promise.allSettled([
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
    // budget actually blows rather than after.
    listBudgets({ utilization_min: '0.9', limit: '10' }),
    // Frozen budgets — scopes, not just a count. Lets the Frozen
    // Budgets card list the top 5 inline instead of a center link.
    listBudgets({ status: 'FROZEN', limit: '10' }),
  ])
  if (ov.status === 'fulfilled') overview.value = ov.value
  if (apiKeys.status === 'fulfilled') keys.value = apiKeys.value.keys
  if (audit.status === 'fulfilled') recentAudit.value = audit.value.logs
  if (atCap.status === 'fulfilled') atCapBudgets.value = atCap.value.ledgers
  if (frozen.status === 'fulfilled') frozenBudgets.value = frozen.value.ledgers
  // Surface the first failure so the operator sees *something* wrong —
  // but only error-banner; cards for the successful fetches still render.
  const firstFail = [ov, apiKeys, audit, atCap, frozen].find(r => r.status === 'rejected')
  error.value = firstFail && firstFail.status === 'rejected' ? toMessage(firstFail.reason) : ''
}, 30000)

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

// Sorted descending by utilization so the most-broken budget leads
// the card display. Tie-break by scope for stable rendering. Sliced
// to 5 to match the Expiring Keys card convention — landing-page
// summary, not a full list; "View all" link carries operators to
// /budgets?utilization_min=0.9 for the complete set. The banner
// badge still shows the full count (atCapBudgets.length), so the
// operator sees "7" on the pill and 5 rows in the card with the
// "View all" link implicitly covering the other 2.
const atCapSorted = computed<BudgetLedger[]>(() => {
  return [...atCapBudgets.value].sort((a, b) => {
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
  return [...frozenBudgets.value]
    .sort((a, b) => a.scope.localeCompare(b.scope))
    .slice(0, 5)
})

// Debt scopes — slice to 5 for parity with the other two budget
// cards. The server already sorts desc by debt (per overview spec),
// so we keep that ordering.
const debtScopesSorted = computed(() => {
  return (overview.value?.debt_scopes ?? []).slice(0, 5)
})

// Expiring keys (7d) — sorted soonest-first, capped to 5 for the card.
const expiringKeys = computed<ExpiringKey[]>(() => filterExpiringKeys(keys.value).slice(0, 5))
const expiringTotal = computed<number>(() => filterExpiringKeys(keys.value).length)

// Failing webhooks — slice to 5 for landing-page summary parity with
// the three budget cards and Expiring Keys. "View all" link carries
// operators to /webhooks?failing=1 for the complete set. The axis
// badge still shows the full `webhook_counts.with_failures` aggregate,
// so "7 failing · showing 5" reads consistently across cards.
const failingWebhooksSorted = computed(() => {
  return (overview.value?.failing_webhooks ?? []).slice(0, 5)
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
const alertAxes = computed<AlertAxis[]>(() => {
  if (!overview.value) return []
  const axes: AlertAxis[] = []
  if (overview.value.webhook_counts.with_failures > 0) {
    axes.push({ id: 'failing-webhooks', label: 'Failing webhooks', count: overview.value.webhook_counts.with_failures, severity: 'danger' })
  }
  // atCapBudgets is broader than overview.budget_counts.over_limit —
  // catches exhausted-without-debt AND the 90–99% "about to blow"
  // range (see atCapBudgets declaration for spec-gap rationale).
  // Severity tracks the worst row: danger if any budget is actually
  // at/over cap, warning if everything firing is in the near-cap
  // 90–99% range.
  if (atCapBudgets.value.length > 0) {
    const anyAtCap = atCapBudgets.value.some(b => utilizationOf(b) >= 1)
    axes.push({
      id: 'budgets-at-cap',
      label: anyAtCap ? 'Budgets at or near cap' : 'Budgets near cap',
      count: atCapBudgets.value.length,
      severity: anyAtCap ? 'danger' : 'warning',
    })
  }
  if (overview.value.recent_denials.length > 0) {
    axes.push({ id: 'recent-denials', label: 'Recent denials', count: overview.value.recent_denials.length, severity: 'danger' })
  }
  if (overview.value.budget_counts.with_debt > 0) {
    axes.push({ id: 'budgets-with-debt', label: 'Budgets with debt', count: overview.value.budget_counts.with_debt, severity: 'warning' })
  }
  if (expiringTotal.value > 0) {
    axes.push({ id: 'expiring-keys', label: 'Expiring keys', count: expiringTotal.value, severity: 'warning' })
  }
  if (overview.value.budget_counts.frozen > 0) {
    axes.push({ id: 'frozen-budgets', label: 'Frozen budgets', count: overview.value.budget_counts.frozen, severity: 'warning' })
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
      :last-updated="overview?.as_of ?? null"
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
          <svg class="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
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
        <svg class="w-5 h-5 text-green-600 dark:text-green-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" /></svg>
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
              <svg
                v-if="axisById['budgets-at-cap']"
                class="w-4 h-4 shrink-0"
                :class="axisById['budgets-at-cap'].severity === 'danger' ? 'text-red-500 dark:text-red-400' : 'text-amber-500 dark:text-amber-400'"
                fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"
              ><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
              Budgets at or near cap
              <span
                v-if="atCapBudgets.length > 0"
                class="ml-1"
                :class="axisById['budgets-at-cap']?.severity === 'danger' ? 'badge-danger' : 'badge-warning'"
              >{{ atCapBudgets.length }}</span>
            </h2>
            <router-link :to="{ name: 'budgets', query: { utilization_min: '0.9' } }" class="text-xs text-blue-600 hover:underline dark:text-blue-400">View all</router-link>
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
              <svg v-if="axisById['budgets-with-debt']" class="w-4 h-4 text-amber-500 dark:text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
              Budgets with debt
              <span v-if="overview.budget_counts.with_debt > 0" class="ml-1 badge-warning">{{ overview.budget_counts.with_debt }}</span>
            </h2>
            <router-link :to="{ name: 'budgets', query: { filter: 'has_debt' } }" class="text-xs text-blue-600 hover:underline dark:text-blue-400">View all</router-link>
          </div>
          <div v-if="debtScopesSorted.length === 0" class="text-sm muted py-4 text-center">No outstanding debt</div>
          <div
            v-for="s in debtScopesSorted"
            :key="s.scope + s.unit"
            class="flex justify-between items-center py-1.5 border-b border-gray-100 last:border-0 dark:border-gray-700"
          >
            <router-link
              :to="{ name: 'budgets', query: { scope: s.scope, unit: s.unit } }"
              class="text-sm text-blue-600 hover:underline truncate mr-2 dark:text-blue-400"
              :title="s.scope"
            >{{ s.scope }}</router-link>
            <span class="muted-sm shrink-0 tabular-nums">{{ s.debt.toLocaleString() }} / {{ s.overdraft_limit.toLocaleString() }}</span>
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
              <svg v-if="axisById['frozen-budgets']" class="w-4 h-4 text-amber-500 dark:text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
              Frozen budgets
              <span v-if="overview.budget_counts.frozen > 0" class="ml-1 badge-warning">{{ overview.budget_counts.frozen }}</span>
            </h2>
            <router-link :to="{ name: 'budgets', query: { status: 'FROZEN' } }" class="text-xs text-blue-600 hover:underline dark:text-blue-400">View all</router-link>
          </div>
          <!-- Empty state prefers the overview count as the source of
               truth. If the frozen-scopes fetch failed but the overview
               count is non-zero, we surface the count rather than
               silently rendering "No frozen budgets" — otherwise the
               card would contradict the banner badge. -->
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
              <svg v-if="axisById['failing-webhooks']" class="w-4 h-4 text-red-500 dark:text-red-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
              Failing webhooks
              <span v-if="overview.webhook_counts.with_failures > 0" class="ml-1 badge-danger">{{ overview.webhook_counts.with_failures }}</span>
            </h2>
            <router-link to="/webhooks" class="text-xs text-blue-600 hover:underline dark:text-blue-400">View all</router-link>
          </div>
          <div v-if="overview.failing_webhooks.length === 0" class="text-sm muted py-4 text-center">All webhooks healthy</div>
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
            <span class="text-xs text-red-600 dark:text-red-400 shrink-0 tabular-nums">{{ w.consecutive_failures }} failures</span>
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
              <svg v-if="axisById['expiring-keys']" class="w-4 h-4 text-amber-500 dark:text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
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
              <svg v-if="axisById['recent-denials']" class="w-4 h-4 text-red-500 dark:text-red-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
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

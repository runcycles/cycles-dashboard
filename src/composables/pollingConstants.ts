// Shared polling-interval constants. Pre-fix every view hardcoded
// `30000` / `60000`; a global tuning decision (e.g. reduce polling
// during an incident) had to touch 9 views. Now there's one place.
//
// Kept in its own module so test files that `vi.mock('../composables/usePolling')`
// (many do) don't need to re-export these — the constants import independently.
//
// Fast: 30s. Used by hot/event-adjacent surfaces — Overview counters,
// Reservations, WebhookDetail — where staleness is immediately
// actionable.
// Slow: 60s. Used by the structural list views — Tenants / Budgets /
// Webhooks / ApiKeys / TenantDetail — where the underlying data
// changes at human cadence and 60s is indistinguishable from 30s to
// the operator.
// Events: 15s. Events view is the live-tail surface; fastest poll in
// the app so a cascade incident lights up promptly.
export const POLL_FAST_MS = 30_000
export const POLL_SLOW_MS = 60_000
export const POLL_EVENTS_MS = 15_000

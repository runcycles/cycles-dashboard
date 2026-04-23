// All formatters accept nullable input and return an em-dash placeholder
// when given null / undefined / empty / unparseable values. Prior to this
// guard, `new Date(null)` → Invalid Date was rendering literally as
// "Invalid Date" in views that skipped the `v-if` check.
const EMPTY = '—'

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return isNaN(d.getTime()) ? null : d
}

// P1-M1: timezone disambiguation. Server emits UTC ISO; the browser
// renders in the user's local zone. Without a `timeZoneName` marker
// operators can't tell whether "14:34" on the dashboard lines up with
// "14:34 UTC" in the audit logs or "14:34 PDT" in their own timeline.
// Appending the short zone name ("PDT", "UTC+2") is the
// Gmail / Linear / Grafana convention — local for the reader, explicit
// about which local.
export function formatDateTime(iso: string | null | undefined): string {
  const d = parse(iso)
  if (!d) return EMPTY
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'short',
  })
}

export function formatDate(iso: string | null | undefined): string {
  const d = parse(iso)
  if (!d) return EMPTY
  return d.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

export function formatTime(iso: string | null | undefined): string {
  const d = parse(iso)
  if (!d) return EMPTY
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'short',
  })
}

export function formatRelative(iso: string | null | undefined): string {
  const d = parse(iso)
  if (!d) return EMPTY
  const diffMs = Date.now() - d.getTime()
  if (diffMs < 60_000) return 'just now'
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`
  return formatDate(iso)
}

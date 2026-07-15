// Guard for date-valued URL query params (?from= / ?to=) that later
// feed `new Date(v).toISOString()` conversions. Route queries are
// operator-editable text — junk like `?from=lastweek` would otherwise
// throw RangeError ("Invalid time value") at query-build time and
// hard-fail the whole fetch behind an unexplained error banner.
// Returns the raw string when it parses as a date (so datetime-local
// values round-trip unchanged), '' otherwise — callers already treat
// '' as "filter absent".
export function dateParamOrEmpty(v: unknown): string {
  const s = typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : ''
  return s && !Number.isNaN(Date.parse(s)) ? s : ''
}

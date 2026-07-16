import type { LocationQueryValue } from 'vue-router'

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

// String-valued URL query param normalizer. vue-router types every
// query value as `LocationQueryValue | LocationQueryValue[]` — a
// duplicated param (?search=a&search=b) arrives as an ARRAY, and a
// valueless param (?search) as null. Views that hydrated refs with a
// bare `route.query.search as string` cast crashed downstream the
// moment a string method ran on the array (`.toLowerCase()`,
// `.trim()`), blanking the whole view. Strings pass through; an array
// yields its first string element (the leftmost occurrence — matches
// how most servers resolve duplicated params); anything else
// (null / undefined) is ''.
export function stringParam(v: LocationQueryValue | LocationQueryValue[] | undefined): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.find((x): x is string => typeof x === 'string') ?? ''
  return ''
}

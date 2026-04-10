// Normalize an unknown caught value (from `catch (e) { ... }`) into a
// human-readable message. Handles the common cases:
//  - real Error instances                    → e.message (if non-empty)
//  - thrown strings                          → the string itself
//  - plain objects with a `message` field    → that field
//  - anything else                           → a reasonable fallback
//
// Keeps `catch` blocks DRY and avoids the "undefined" message bug that
// arises when `e.message` is read on a non-Error value.
export function toMessage(e: unknown, fallback = 'Unknown error'): string {
  if (e instanceof Error) {
    return e.message || fallback
  }
  if (typeof e === 'string') {
    return e || fallback
  }
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message: unknown }).message
    if (typeof m === 'string' && m.length > 0) return m
  }
  return fallback
}

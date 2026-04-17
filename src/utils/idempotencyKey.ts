// Idempotency-key generation for admin-plane mutations that require
// server-side replay protection (funding, reservations release,
// bulk-action). Wrapping crypto.randomUUID() in a named utility makes
// the call-sites self-documenting at the point-of-use and gives
// vitest a single function to stub when asserting request shape.
//
// The cycles-governance-admin spec requires UUID v4 shape; all modern
// browsers (2022+) and Node 16.7+ provide `crypto.randomUUID()`. The
// fallback below preserves UUID v4 digits for environments where
// `crypto.randomUUID` is absent (e.g., old Safari on iOS <15.4) — the
// output MUST still satisfy `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`.
//
// Security note: the fallback uses `crypto.getRandomValues` when
// available (cryptographically strong); if even that's missing
// (ancient IE, non-browser eval), it degrades to `Math.random()`
// which is NOT cryptographically strong but is still uniform enough
// to avoid idempotency-key collisions in practice. The server treats
// the key as opaque; guessability matters only for authenticated
// request forgery, which our Bearer/Admin-Key authn already blocks.

export function generateIdempotencyKey(): string {
  const g = globalThis as { crypto?: Crypto }
  if (g.crypto?.randomUUID) {
    return g.crypto.randomUUID()
  }
  // UUID v4 template: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx where
  // `y` is one of 8, 9, a, b (RFC 4122 variant bits).
  const rnd = (bytes: number): Uint8Array => {
    const out = new Uint8Array(bytes)
    if (g.crypto?.getRandomValues) {
      g.crypto.getRandomValues(out)
    } else {
      for (let i = 0; i < bytes; i++) out[i] = Math.floor(Math.random() * 256)
    }
    return out
  }
  const b = rnd(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

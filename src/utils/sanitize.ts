// Sanitize post-login redirect target.
//
// Two protections:
//  1. Open-redirect: resolve against the current origin and only accept
//     same-origin results. Catches `//evil.com`, `/\evil.com`,
//     `/%2Fevil.com`, `https://evil.com`, and similar parser-difference
//     tricks that a naive startsWith('/') check would miss.
//  2. Login loop: reject any /login target. If a logout-race produces
//     `?redirect=/login` we'd trap the user on the login screen after
//     successful auth.
//
// Returns a same-origin path (pathname + search + hash) or '/' on any
// validation failure.
export function sanitizeRedirect(raw: unknown, origin: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return '/'
  try {
    const url = new URL(raw, origin)
    if (url.origin !== origin) return '/'
    if (url.pathname === '/login' || url.pathname.startsWith('/login/')) return '/'
    return url.pathname + url.search + url.hash
  } catch {
    return '/'
  }
}

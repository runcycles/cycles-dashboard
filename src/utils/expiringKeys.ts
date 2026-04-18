import type { ApiKey } from '../types'

// I1 (UI/UX P0): helper shared by the Overview "Expiring Keys" card.
// Keeps the date math out of the view so it can be unit-tested without
// mounting the whole page.
//
// Why a dedicated helper:
//   - listApiKeys has no `expires_before` server-side filter; Overview
//     has to filter client-side.
//   - The card shows keys expiring within the next N days (default 7)
//     AND still ACTIVE. Already-expired keys are *not* shown — the
//     operator already can't use them, so they belong on the ApiKeys
//     list with the normal status filter, not in an alert card.
//   - Sort by ascending expires_at so the soonest-to-expire float up.

export interface ExpiringKey {
  key: ApiKey
  expiresAt: string
  daysUntilExpiry: number
}

export function filterExpiringKeys(
  keys: readonly ApiKey[],
  options: { windowDays?: number; now?: Date } = {},
): ExpiringKey[] {
  const windowDays = options.windowDays ?? 7
  const now = options.now ?? new Date()
  const nowMs = now.getTime()
  const cutoffMs = nowMs + windowDays * 24 * 60 * 60 * 1000

  const out: ExpiringKey[] = []
  for (const key of keys) {
    if (key.status !== 'ACTIVE') continue
    if (!key.expires_at) continue
    const expMs = Date.parse(key.expires_at)
    if (Number.isNaN(expMs)) continue
    if (expMs <= nowMs) continue  // already expired — not an alert signal
    if (expMs > cutoffMs) continue
    out.push({
      key,
      expiresAt: key.expires_at,
      daysUntilExpiry: Math.max(0, Math.ceil((expMs - nowMs) / (24 * 60 * 60 * 1000))),
    })
  }
  out.sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))
  return out
}

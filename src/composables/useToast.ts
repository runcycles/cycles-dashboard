import { ref } from 'vue'

export interface Toast {
  id: number
  message: string
  type: 'success' | 'error' | 'warning'
}

const AUTO_DISMISS_MS = 4000
// Cap the visible stack. Error toasts persist until dismissed, so an
// unbounded stack could grow past the viewport during an incident and
// leave the oldest dismiss buttons unreachable. Pushing past the cap
// evicts the oldest NON-error toast first — success/warning toasts are
// transient advisories, while an evicted error is a silently-vanished
// failure the operator never acknowledged. On an all-error stack the
// rule depends on what's incoming: another ERROR evicts the oldest
// error (the cap stays hard among errors; the newest failure is the one
// the operator is reacting to), but a transient success/warning pushes
// as a soft overflow instead — it auto-dismisses in 4s, restoring the
// cap, whereas evicting an unacknowledged error for a 4-second advisory
// would silently vanish a failure.
const MAX_TOASTS = 5

let nextId = 0
export const toasts = ref<Toast[]>([])

// Remove a single toast by id. Exported for ToastContainer's dismiss
// button; also part of the useToast() return for programmatic use.
export function dismissToast(id: number) {
  toasts.value = toasts.value.filter(t => t.id !== id)
}

export function useToast() {
  function show(message: string, type: Toast['type'] = 'success') {
    const id = nextId++
    // Evict BEFORE pushing so the incoming toast can never be its own
    // eviction candidate. Oldest non-error first; on an all-error stack
    // only an incoming ERROR evicts (oldest error) — a transient
    // success/warning soft-overflows past the cap instead, since its
    // own auto-dismiss restores the cap in 4s and unacknowledged errors
    // must never be evicted by transients. See MAX_TOASTS above.
    if (toasts.value.length >= MAX_TOASTS) {
      const evictIdx = toasts.value.findIndex(t => t.type !== 'error')
      if (evictIdx !== -1) {
        toasts.value = toasts.value.filter((_, i) => i !== evictIdx)
      } else if (type === 'error') {
        toasts.value = toasts.value.slice(1)
      }
    }
    toasts.value.push({ id, message, type })
    // Error toasts persist until manually dismissed — a 4s window is
    // not enough to read a failure message (WCAG 2.2.1), and a missed
    // error toast is a silently-failed mutation from the operator's
    // point of view. Success and warning toasts keep the auto-dismiss:
    // warnings are advisories, not failures, so a persistent one would
    // read as an unresolved error after the operation succeeds.
    if (type !== 'error') {
      setTimeout(() => dismissToast(id), AUTO_DISMISS_MS)
    }
  }

  function success(message: string) { show(message, 'success') }
  function error(message: string) { show(message, 'error') }
  function warning(message: string) { show(message, 'warning') }

  return { toasts, success, error, warning, dismiss: dismissToast }
}

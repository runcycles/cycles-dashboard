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
// failure the operator never acknowledged. Only when the stack is all
// errors does the oldest error go (the cap stays hard at 5; the newest
// failure is the one the operator is reacting to).
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
    // eviction candidate (a success landing on 5 errors must evict the
    // oldest error, not itself). Oldest non-error first; oldest error
    // only as a last resort (all-error stack). See MAX_TOASTS above.
    if (toasts.value.length >= MAX_TOASTS) {
      const evictIdx = toasts.value.findIndex(t => t.type !== 'error')
      const evictAt = evictIdx === -1 ? 0 : evictIdx
      toasts.value = toasts.value.filter((_, i) => i !== evictAt)
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

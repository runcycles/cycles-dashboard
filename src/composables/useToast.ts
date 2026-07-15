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
// drops the oldest toast (FIFO) — the newest failure is the one the
// operator is reacting to.
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
    toasts.value.push({ id, message, type })
    if (toasts.value.length > MAX_TOASTS) {
      toasts.value = toasts.value.slice(toasts.value.length - MAX_TOASTS)
    }
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

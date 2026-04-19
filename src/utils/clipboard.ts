import { safeJsonStringify } from './safe'

// Thin wrapper around navigator.clipboard.writeText that resolves to
// `true` on success and `false` on failure (denied permission, insecure
// context, browser without the Async Clipboard API). Keeps the caller's
// toast / inline-feedback logic local.
export async function writeClipboardText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

// Pretty-print an object as JSON (via safeJsonStringify — handles
// cycles and bigints) and copy it. Shared by the row-kebab
// "Copy as JSON" items on every list view and by the expanded-panel
// copy icons on EventsView / AuditView / EventTimeline.
export async function writeClipboardJson(obj: unknown): Promise<boolean> {
  return writeClipboardText(safeJsonStringify(obj))
}

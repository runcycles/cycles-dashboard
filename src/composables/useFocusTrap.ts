import { onMounted, onBeforeUnmount, type Ref } from 'vue'

// Focus-trap composable for modal dialogs.
//
// On mount:
//   - remembers the currently-focused element (so it can be restored later)
//   - focuses the first focusable element inside `containerRef` (or the
//     container itself if none found)
//
// While mounted, Tab / Shift+Tab cycle focus within the container instead
// of escaping to the background page.
//
// On unmount, restores focus to the element that had it before the dialog
// opened — so the operator lands back where they were after closing a
// confirmation or form dialog.
//
// Selector matches standard focusable elements, skipping disabled controls
// and elements with tabindex="-1".
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(el => !el.hasAttribute('disabled') && el.tabIndex !== -1)
}

export function useFocusTrap(containerRef: Ref<HTMLElement | null>) {
  let previouslyFocused: HTMLElement | null = null

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Tab') return
    const container = containerRef.value
    if (!container) return
    const focusable = getFocusable(container)
    if (focusable.length === 0) {
      e.preventDefault()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement as HTMLElement | null
    if (e.shiftKey) {
      if (active === first || !container.contains(active)) {
        e.preventDefault()
        last.focus()
      }
    } else {
      if (active === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  onMounted(() => {
    previouslyFocused = (document.activeElement as HTMLElement) ?? null
    // Wait a tick for the container template ref to populate.
    queueMicrotask(() => {
      const container = containerRef.value
      if (!container) return
      const focusable = getFocusable(container)
      if (focusable.length > 0) {
        focusable[0].focus()
      } else {
        // Make the container itself focusable as a fallback.
        container.setAttribute('tabindex', '-1')
        container.focus()
      }
    })
    document.addEventListener('keydown', onKeydown)
  })

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKeydown)
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      try { previouslyFocused.focus() } catch { /* ignore */ }
    }
  })
}

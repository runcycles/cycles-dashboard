import { onBeforeUnmount, watch, type Ref } from 'vue'

// Focus-trap composable for modal dialogs.
//
// Activation keys off `containerRef`, NOT the component lifecycle. For
// dedicated dialog components (FormDialog, ConfirmAction, the bulk-action
// dialogs) mount == open, so the behavior is unchanged. But views also
// call this at setup scope for hand-rolled v-if'd dialogs (ApiKeysView's
// perms viewer, TenantDetailView's close dialog) — there, binding to the
// lifecycle meant the document-level Tab handler ran for the whole view
// lifetime and the unmount focus-restore fired on route NAVIGATION,
// yanking focus to a stale element even when the dialog was never opened.
//
// When the ref becomes non-null (dialog rendered):
//   - remembers the currently-focused element (so it can be restored later)
//   - focuses the first focusable element inside the container (or the
//     container itself if none found)
//   - attaches the document-level Tab handler
//
// While active, Tab / Shift+Tab cycle focus within the container instead
// of escaping to the background page.
//
// When the ref becomes null (dialog closed) — or the component unmounts
// while the trap is active — detaches the handler and restores focus to
// the element that had it before the dialog opened, so the operator lands
// back where they were. Unmounting with the trap inactive is a no-op.
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
  let trapActive = false

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
      // Recapture escaped focus on forward Tab too — if focus is
      // outside the container (programmatic focus, a container swap
      // race), a plain wrap-on-last check would let Tab walk the page
      // behind the modal freely.
      if (active === last || !container.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  // Initial-focus logic shared by activation and container swaps: first
  // focusable child, else the container itself (made focusable).
  function focusInto(container: HTMLElement) {
    const focusable = getFocusable(container)
    if (focusable.length > 0) {
      focusable[0].focus()
    } else {
      // Make the container itself focusable as a fallback.
      container.setAttribute('tabindex', '-1')
      container.focus()
    }
  }

  function activate(container: HTMLElement) {
    if (trapActive) return
    trapActive = true
    previouslyFocused = (document.activeElement as HTMLElement) ?? null
    focusInto(container)
    document.addEventListener('keydown', onKeydown)
  }

  function deactivate() {
    if (!trapActive) return
    trapActive = false
    document.removeEventListener('keydown', onKeydown)
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      try { previouslyFocused.focus() } catch { /* ignore */ }
    }
    previouslyFocused = null
  }

  // flush: 'post' so the container's children are already in the DOM
  // when we pick the initial focus target. If the ref swaps directly
  // between two elements (no null in between), the trap stays active —
  // onKeydown reads containerRef.value live, so the cycle follows the
  // new element — and focus is moved into the new container when the
  // swap stranded it outside (the old element is typically detached, so
  // focus fell to <body>, behind the modal). previouslyFocused is kept
  // from the original activation so closing still restores the operator
  // to where they were before the dialog opened.
  watch(containerRef, (el, prev) => {
    if (el) {
      if (!trapActive) {
        activate(el)
      } else if (prev && el !== prev && !el.contains(document.activeElement)) {
        focusInto(el)
      }
    } else {
      deactivate()
    }
  }, { flush: 'post' })

  onBeforeUnmount(() => deactivate())
}

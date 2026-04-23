<script setup lang="ts">
import { nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import Sidebar from './Sidebar.vue'
import CommandPalette from './CommandPalette.vue'
import { useCommandPalette } from '../composables/useCommandPalette'
import HamburgerIcon from './icons/HamburgerIcon.vue'

const sidebarOpen = ref(false)
const hamburgerEl = ref<HTMLButtonElement | null>(null)
const palette = useCommandPalette()

// Mobile-drawer affordances (v0.1.25.58 responsive sweep).
//   - Escape closes the drawer.
//   - Body scroll is locked while the drawer is open, otherwise a mobile
//     user can scroll the underlying list behind the dark overlay, which
//     reads as a bug and lets them tap interactive elements through the
//     backdrop.
//   - Focus returns to the hamburger after close so keyboard flow stays
//     coherent.
function closeSidebar(returnFocus: boolean) {
  if (!sidebarOpen.value) return
  sidebarOpen.value = false
  if (returnFocus) {
    // nextTick so the drawer is actually dismissed before we move focus.
    void nextTick().then(() => hamburgerEl.value?.focus({ preventScroll: true }))
  }
}

watch(sidebarOpen, (open) => {
  if (typeof document === 'undefined') return
  document.body.style.overflow = open ? 'hidden' : ''
})

// W3: global Cmd/K (macOS) / Ctrl+K (other) opens the tenant palette.
// Swallow the default browser shortcut (locks focus to the browser
// omnibox on some platforms) and prevent it from firing while an
// <input> or <textarea> already has focus — consistent with every
// other palette-style UI the operator is likely to know (Linear,
// GitHub, Slack, Raycast).
//
// 'k' check is case-insensitive so caps-lock doesn't break the
// shortcut. Also binds '/' as a secondary shortcut when nothing is
// focused on an input — a long-standing GitHub convention for "focus
// search".
function onGlobalKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null
  const inEditable =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target?.isContentEditable === true

  // Escape closes the mobile drawer first — if nothing is open, fall
  // through so downstream modals / CommandPalette continue to own
  // their own Escape handling.
  if (e.key === 'Escape' && sidebarOpen.value) {
    e.preventDefault()
    closeSidebar(true)
    return
  }

  const key = e.key.toLowerCase()
  if ((e.metaKey || e.ctrlKey) && key === 'k') {
    e.preventDefault()
    palette.toggle()
    return
  }
  if (key === '/' && !inEditable && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault()
    palette.open()
  }
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  // Restore body scroll on unmount in case the view tore down while
  // the drawer was still open.
  if (typeof document !== 'undefined') document.body.style.overflow = ''
})
</script>

<template>
  <!-- h-dvh (dynamic viewport height) instead of h-screen so the layout
       follows the real visible viewport on mobile Safari, which shrinks
       as the URL bar appears. h-screen = 100vh includes the bar area
       even when it's not visible, which previously clipped the mobile
       header behind the chrome on iPhone landscape. -->
  <div class="flex h-dvh bg-gray-50 dark:bg-gray-950">
    <a href="#main-content" class="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-white focus:px-4 focus:py-2 focus:rounded focus:shadow focus:text-sm focus:text-gray-900">Skip to main content</a>

    <!-- Mobile overlay -->
    <div v-if="sidebarOpen" class="fixed inset-0 bg-black/40 z-30 md:hidden" @click="closeSidebar(true)" />

    <!-- Sidebar: hidden on mobile, visible on md+ -->
    <div id="app-sidebar" :class="sidebarOpen ? 'translate-x-0' : '-translate-x-full'" class="fixed inset-y-0 left-0 z-40 transition-transform duration-200 md:static md:translate-x-0">
      <Sidebar @navigate="closeSidebar(false)" />
    </div>

    <div class="flex-1 flex flex-col overflow-hidden">
      <!-- Mobile header bar. min-h-11 and explicit button padding give the
           hamburger a ≥44×44 touch target (WCAG 2.1 AA). -->
      <div class="md:hidden flex items-center gap-2 px-2 py-2 bg-gray-900 text-white shrink-0 min-h-11">
        <button
          ref="hamburgerEl"
          @click="sidebarOpen = true"
          aria-label="Open menu"
          :aria-expanded="sidebarOpen"
          aria-controls="app-sidebar"
          class="cursor-pointer inline-flex items-center justify-center w-11 h-11 rounded hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <HamburgerIcon class="w-5 h-5" />
        </button>
        <img src="/runcycles-logo.svg" alt="Cycles" class="w-6 h-6 shrink-0" />
        <span class="text-sm font-semibold truncate">Cycles Admin</span>
      </div>

      <!-- Phase 5 (table-layout unification): overflow-y-auto (not
           overflow-auto) so wide tables scroll horizontally inside
           their own scroll container, not at the page level. Pre-fix,
           AuditView showed a double horizontal scrollbar at viewports
           < 900px because both <main> and the table shell had
           overflow-x-auto. List views inside opt into flex-fill via
           `h-full flex flex-col min-h-0` on their root so the table
           body grows/shrinks with viewport size — no magic-number
           calc(100vh - Npx) per view.
           overflow-x-hidden pinned explicitly: per CSS spec, setting
           overflow-y to anything non-visible implicitly promotes
           overflow-x from visible to auto, which re-introduced a
           page-level horizontal scrollbar below WebhooksView's
           "Load more" button whenever the table card's content-driven
           min-width exceeded viewport. Explicit hidden defeats the
           implicit promotion and keeps horizontal scroll scoped to
           the table card's own scroll container. -->
      <main id="main-content" class="flex-1 overflow-y-auto overflow-x-hidden p-4 md:p-6" tabindex="-1">
        <!-- :key="$route.path" forces a fresh component instance when the
             path segment changes — required for detail views (tenant-
             detail, webhook-detail, budget-detail) that read
             `route.params.id` into a const at setup time. Without the
             key, navigating /tenants/A → /tenants/B reuses the
             TenantDetailView instance, leaving `id` stale at "A" — the
             URL updated but data stayed frozen, a silent "clicks do
             nothing" UX bug on the Children affordances. Keying on path
             (not fullPath) is deliberate: query-only transitions like
             /tenants → /tenants?parent=X must NOT remount, because the
             parentFromQuery watcher handles the filter in-place and
             remounting would drop the loaded tenant list + pagination
             cursor. -->
        <router-view :key="$route.path" />
      </main>
    </div>

    <CommandPalette />
  </div>
</template>

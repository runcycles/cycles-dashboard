<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import Sidebar from './Sidebar.vue'
import CommandPalette from './CommandPalette.vue'
import { useCommandPalette } from '../composables/useCommandPalette'
import HamburgerIcon from './icons/HamburgerIcon.vue'

const sidebarOpen = ref(false)
const palette = useCommandPalette()

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
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown))
</script>

<template>
  <div class="flex h-screen bg-gray-50 dark:bg-gray-950">
    <a href="#main-content" class="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-white focus:px-4 focus:py-2 focus:rounded focus:shadow focus:text-sm focus:text-gray-900">Skip to main content</a>

    <!-- Mobile overlay -->
    <div v-if="sidebarOpen" class="fixed inset-0 bg-black/40 z-30 md:hidden" @click="sidebarOpen = false" />

    <!-- Sidebar: hidden on mobile, visible on md+ -->
    <div :class="sidebarOpen ? 'translate-x-0' : '-translate-x-full'" class="fixed inset-y-0 left-0 z-40 transition-transform duration-200 md:static md:translate-x-0">
      <Sidebar @navigate="sidebarOpen = false" />
    </div>

    <div class="flex-1 flex flex-col overflow-hidden">
      <!-- Mobile header bar -->
      <div class="md:hidden flex items-center gap-3 table-cell bg-gray-900 text-white shrink-0">
        <button @click="sidebarOpen = true" aria-label="Open menu" class="cursor-pointer">
          <HamburgerIcon class="w-5 h-5" />
        </button>
        <img src="/runcycles-logo.svg" alt="Cycles" class="w-6 h-6" />
        <span class="text-sm font-semibold">Cycles Admin</span>
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

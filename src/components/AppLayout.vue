<script setup lang="ts">
import { ref } from 'vue'
import Sidebar from './Sidebar.vue'

const sidebarOpen = ref(false)
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
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
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
           calc(100vh - Npx) per view. -->
      <main id="main-content" class="flex-1 overflow-y-auto p-4 md:p-6" tabindex="-1">
        <router-view />
      </main>
    </div>
  </div>
</template>

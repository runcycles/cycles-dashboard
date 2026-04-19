<script setup lang="ts">
import { computed } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useRouter, useRoute } from 'vue-router'
import { useDarkMode } from '../composables/useDarkMode'
import { useCommandPalette } from '../composables/useCommandPalette'
import SearchIcon from './icons/SearchIcon.vue'
import LogoutIcon from './icons/LogoutIcon.vue'
import SunIcon from './icons/SunIcon.vue'
import MoonIcon from './icons/MoonIcon.vue'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const caps = auth.capabilities
const version = __APP_VERSION__
const { isDark, toggle: toggleDark } = useDarkMode()
const palette = useCommandPalette()

// Platform-appropriate keyboard hint — ⌘K on macOS, Ctrl+K elsewhere.
// Picked off navigator.platform rather than userAgent because the
// platform string is stable across Chromium version skew on Windows
// and still correctly identifies "MacIntel" on macOS.
const isMac = computed(() =>
  typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test(navigator.platform || ''),
)

const navItems = [
  { name: 'Overview', route: '/', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4', cap: caps?.view_overview },
  { name: 'Tenants', route: '/tenants', icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z', cap: caps?.view_tenants },
  { name: 'Budgets', route: '/budgets', icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z', cap: caps?.view_budgets },
  { name: 'Events', route: '/events', icon: 'M13 10V3L4 14h7v7l9-11h-7z', cap: caps?.view_events },
  { name: 'API Keys', route: '/api-keys', icon: 'M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z', cap: caps?.view_api_keys },
  { name: 'Webhooks', route: '/webhooks', icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1', cap: caps?.view_webhooks },
  // v0.1.25.22: Reservations (runtime-plane dual-auth endpoints).
  // cap stays undefined when the server doesn't surface a
  // view_reservations flag → undefined !== false → renders. Older
  // admin servers that pre-date v0.1.25.8 will 401 on the list call,
  // which the dashboard handles via the existing ApiError logout path.
  { name: 'Reservations', route: '/reservations', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z', cap: caps?.view_reservations },
  { name: 'Audit', route: '/audit', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z', cap: caps?.view_audit },
]

function isActive(itemRoute: string) {
  if (itemRoute === '/') return route.path === '/'
  return route.path.startsWith(itemRoute)
}

const emit = defineEmits<{ navigate: [] }>()

function logout() {
  auth.logout()
  router.push('/login')
}
</script>

<template>
  <aside class="w-56 h-full bg-gray-900 text-gray-300 flex flex-col shrink-0">
    <div class="p-4 border-b border-gray-700 flex items-center gap-3">
      <img src="/runcycles-logo.svg" alt="Cycles" class="w-8 h-8" />
      <div>
        <h1 class="text-white font-semibold text-lg leading-tight">Cycles</h1>
        <p class="text-xs text-gray-400">Admin Dashboard</p>
      </div>
    </div>
    <!-- W3: "Find tenant" palette trigger. Cmd/K or Ctrl+K from anywhere
         opens it; this button just surfaces discoverability for mouse-
         driven operators and mobile where no keyboard shortcut exists. -->
    <div class="px-3 py-2 border-b border-gray-700">
      <button
        type="button"
        @click="palette.open()"
        aria-label="Find tenant (press Command K or Control K)"
        class="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-gray-400 bg-gray-800/60 hover:bg-gray-800 rounded transition-colors cursor-pointer"
      >
        <SearchIcon class="w-3.5 h-3.5 shrink-0" />
        <span class="flex-1 text-left">Find tenant</span>
        <kbd class="text-[10px] text-gray-300 border border-gray-600 rounded px-1">{{ isMac ? '⌘K' : 'Ctrl K' }}</kbd>
      </button>
    </div>
    <nav class="flex-1 py-3 space-y-0.5">
      <template v-for="item in navItems" :key="item.route">
        <router-link
          v-if="item.cap !== false"
          :to="item.route"
          :class="isActive(item.route) ? 'bg-gray-800 text-white border-l-2 border-white' : 'border-l-2 border-transparent text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'"
          class="flex items-center gap-3 px-4 py-2 text-sm transition-colors"
          @click="emit('navigate')"
        >
          <!-- Nav-icon path is data-driven (item.icon from navItems). Kept
               inline because a shared icon component would need a :d prop
               and would duplicate the wrapper chrome. Stroke-width 1.5
               matches the lighter weight used across the sidebar chrome. -->
          <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" :d="item.icon" />
          </svg>
          {{ item.name }}
        </router-link>
      </template>
    </nav>
    <div class="p-4 border-t border-gray-700 space-y-3">
      <div class="flex items-center justify-between">
        <button @click="logout" aria-label="Logout" class="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors cursor-pointer">
          <LogoutIcon class="w-4 h-4" />
          Logout
        </button>
        <button @click="toggleDark" :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'" class="text-gray-400 hover:text-white transition-colors cursor-pointer p-1 rounded hover:bg-gray-800">
          <SunIcon v-if="isDark" class="w-4 h-4" />
          <MoonIcon v-else class="w-4 h-4" />
        </button>
      </div>
      <p class="text-xs text-gray-400">v{{ version }}</p>
    </div>
  </aside>
</template>

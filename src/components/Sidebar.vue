<script setup lang="ts">
import { useAuthStore } from '../stores/auth'
import { useRouter } from 'vue-router'

const auth = useAuthStore()
const router = useRouter()
const caps = auth.capabilities

const navItems = [
  { name: 'Overview', route: '/', cap: caps?.view_overview },
  { name: 'Budgets', route: '/budgets', cap: caps?.view_budgets },
  { name: 'Events', route: '/events', cap: caps?.view_events },
  { name: 'Webhooks', route: '/webhooks', cap: caps?.view_webhooks },
  { name: 'Audit', route: '/audit', cap: caps?.view_audit },
  { name: 'Tenants', route: '/tenants', cap: caps?.view_tenants },
]

function logout() {
  auth.logout()
  router.push('/login')
}
</script>

<template>
  <aside class="w-56 bg-gray-900 text-gray-300 flex flex-col">
    <div class="p-4 border-b border-gray-700">
      <h1 class="text-white font-semibold text-lg">Cycles</h1>
      <p class="text-xs text-gray-500">Admin Dashboard</p>
    </div>
    <nav class="flex-1 py-2">
      <router-link
        v-for="item in navItems"
        :key="item.route"
        v-show="item.cap !== false"
        :to="item.route"
        class="block px-4 py-2 text-sm hover:bg-gray-800 hover:text-white transition-colors"
        active-class="bg-gray-800 text-white"
      >
        {{ item.name }}
      </router-link>
    </nav>
    <div class="p-4 border-t border-gray-700">
      <button @click="logout" class="text-sm text-gray-500 hover:text-white transition-colors">
        Logout
      </button>
    </div>
  </aside>
</template>

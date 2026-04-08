<script setup lang="ts">
import { ref } from 'vue'
import { usePolling } from '../composables/usePolling'
import { getOverview } from '../api/client'
import type { AdminOverviewResponse } from '../types'
const data = ref<AdminOverviewResponse | null>(null)
const error = ref('')

const { refresh } = usePolling(async () => {
  try { data.value = await getOverview(); error.value = '' }
  catch (e: any) { error.value = e.message }
}, 30000)
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-semibold text-gray-900">Overview</h1>
      <button @click="refresh" class="text-sm text-gray-500 hover:text-gray-700">Refresh</button>
    </div>

    <p v-if="error" class="text-red-600 text-sm mb-4">{{ error }}</p>

    <div v-if="!data" class="text-gray-400 text-sm">Loading...</div>

    <template v-else>
      <!-- Summary counters — each card links to its page -->
      <div class="grid grid-cols-4 gap-4 mb-6">
        <router-link to="/tenants" class="bg-white rounded-lg shadow p-4 hover:shadow-md transition-shadow block">
          <p class="text-sm text-gray-500">Tenants</p>
          <p class="text-2xl font-semibold text-gray-900">{{ data.tenant_counts.total }}</p>
          <p class="text-xs text-gray-400">{{ data.tenant_counts.active }} active<span v-if="data.tenant_counts.suspended">, {{ data.tenant_counts.suspended }} suspended</span></p>
        </router-link>
        <router-link to="/budgets" class="bg-white rounded-lg shadow p-4 hover:shadow-md transition-shadow block">
          <p class="text-sm text-gray-500">Budgets</p>
          <p class="text-2xl font-semibold text-gray-900">{{ data.budget_counts.total }}</p>
          <p class="text-xs text-gray-400">{{ data.budget_counts.active }} active<span v-if="data.budget_counts.frozen">, {{ data.budget_counts.frozen }} frozen</span></p>
        </router-link>
        <router-link to="/webhooks" class="bg-white rounded-lg shadow p-4 hover:shadow-md transition-shadow block">
          <p class="text-sm text-gray-500">Webhooks</p>
          <p class="text-2xl font-semibold text-gray-900">{{ data.webhook_counts.total }}</p>
          <p class="text-xs text-gray-400">{{ data.webhook_counts.active }} active<span v-if="data.webhook_counts.with_failures">, {{ data.webhook_counts.with_failures }} failing</span></p>
        </router-link>
        <router-link to="/events" class="bg-white rounded-lg shadow p-4 hover:shadow-md transition-shadow block">
          <p class="text-sm text-gray-500">Events ({{ Math.round(data.event_window_seconds / 60) }}m)</p>
          <p class="text-2xl font-semibold text-gray-900">{{ data.event_counts.total_recent }}</p>
          <p class="text-xs text-gray-400">
            <span v-for="(count, cat) in data.event_counts.by_category" :key="cat" class="mr-2">{{ cat }}: {{ count }}</span>
          </p>
        </router-link>
      </div>

      <!-- Alerts row -->
      <div class="grid grid-cols-2 gap-4 mb-6">
        <!-- Over-limit budgets -->
        <div class="bg-white rounded-lg shadow p-4">
          <div class="flex justify-between items-center mb-3">
            <h2 class="text-sm font-medium text-gray-700">
              Over-limit Budgets
              <span v-if="data.budget_counts.over_limit > 0" class="ml-1 bg-red-100 text-red-700 px-1.5 py-0.5 rounded text-xs">{{ data.budget_counts.over_limit }}</span>
            </h2>
            <router-link to="/budgets" class="text-xs text-blue-600 hover:underline">View all</router-link>
          </div>
          <div v-if="data.over_limit_scopes.length === 0" class="text-sm text-gray-400">None</div>
          <div v-for="s in data.over_limit_scopes" :key="s.scope + s.unit" class="flex justify-between items-center py-1.5 border-b border-gray-100 last:border-0">
            <router-link :to="{ name: 'budgets', query: { scope: s.scope, unit: s.unit } }" class="text-sm text-blue-600 hover:underline truncate mr-2">{{ s.scope }}</router-link>
            <span class="text-xs text-gray-500">{{ s.unit }}</span>
          </div>
        </div>

        <!-- Budgets with debt -->
        <div class="bg-white rounded-lg shadow p-4">
          <div class="flex justify-between items-center mb-3">
            <h2 class="text-sm font-medium text-gray-700">
              Budgets with Debt
              <span v-if="data.budget_counts.with_debt > 0" class="ml-1 bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded text-xs">{{ data.budget_counts.with_debt }}</span>
            </h2>
            <router-link to="/budgets" class="text-xs text-blue-600 hover:underline">View all</router-link>
          </div>
          <div v-if="data.debt_scopes.length === 0" class="text-sm text-gray-400">None</div>
          <div v-for="s in data.debt_scopes" :key="s.scope + s.unit" class="flex justify-between items-center py-1.5 border-b border-gray-100 last:border-0">
            <router-link :to="{ name: 'budgets', query: { scope: s.scope, unit: s.unit } }" class="text-sm text-blue-600 hover:underline truncate mr-2">{{ s.scope }}</router-link>
            <span class="text-xs text-gray-500">{{ s.debt.toLocaleString() }} / {{ s.overdraft_limit.toLocaleString() }}</span>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4 mb-6">
        <!-- Failing webhooks -->
        <div class="bg-white rounded-lg shadow p-4">
          <div class="flex justify-between items-center mb-3">
            <h2 class="text-sm font-medium text-gray-700">
              Failing Webhooks
              <span v-if="data.webhook_counts.with_failures > 0" class="ml-1 bg-red-100 text-red-700 px-1.5 py-0.5 rounded text-xs">{{ data.webhook_counts.with_failures }}</span>
            </h2>
            <router-link to="/webhooks" class="text-xs text-blue-600 hover:underline">View all</router-link>
          </div>
          <div v-if="data.failing_webhooks.length === 0" class="text-sm text-gray-400">None</div>
          <div v-for="w in data.failing_webhooks" :key="w.subscription_id" class="flex justify-between items-center py-1.5 border-b border-gray-100 last:border-0">
            <router-link :to="{ name: 'webhook-detail', params: { id: w.subscription_id } }" class="text-sm text-blue-600 hover:underline truncate mr-2">{{ w.url }}</router-link>
            <span class="text-xs text-red-600">{{ w.consecutive_failures }} failures</span>
          </div>
        </div>

        <!-- Frozen budgets -->
        <div class="bg-white rounded-lg shadow p-4">
          <div class="flex justify-between items-center mb-3">
            <h2 class="text-sm font-medium text-gray-700">
              Frozen Budgets
              <span v-if="data.budget_counts.frozen > 0" class="ml-1 bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded text-xs">{{ data.budget_counts.frozen }}</span>
            </h2>
            <router-link :to="{ name: 'budgets', query: { status: 'FROZEN' } }" class="text-xs text-blue-600 hover:underline">View all</router-link>
          </div>
          <router-link v-if="data.budget_counts.frozen > 0" :to="{ name: 'budgets', query: { status: 'FROZEN' } }" class="text-sm text-blue-600 hover:underline">
            View {{ data.budget_counts.frozen }} frozen budget{{ data.budget_counts.frozen !== 1 ? 's' : '' }}
          </router-link>
          <div v-else class="text-sm text-gray-400">None</div>
        </div>
      </div>

      <!-- Recent events -->
      <div class="grid grid-cols-2 gap-4">
        <div class="bg-white rounded-lg shadow p-4">
          <div class="flex justify-between items-center mb-3">
            <h2 class="text-sm font-medium text-gray-700">Recent Denials</h2>
            <router-link :to="{ name: 'events', query: { type: 'reservation.denied' } }" class="text-xs text-blue-600 hover:underline">View all</router-link>
          </div>
          <div v-if="data.recent_denials.length === 0" class="text-sm text-gray-400">None in window</div>
          <div v-for="e in data.recent_denials" :key="e.event_id" class="py-1.5 border-b border-gray-100 last:border-0">
            <div class="flex justify-between">
              <span class="text-sm text-gray-700 truncate">{{ e.scope || e.tenant_id }}</span>
              <span class="text-xs text-gray-400">{{ new Date(e.timestamp).toLocaleTimeString() }}</span>
            </div>
            <p class="text-xs text-gray-500">{{ e.data?.reason_code || 'denied' }}</p>
          </div>
        </div>
        <div class="bg-white rounded-lg shadow p-4">
          <div class="flex justify-between items-center mb-3">
            <h2 class="text-sm font-medium text-gray-700">Recent Expiries</h2>
            <router-link :to="{ name: 'events', query: { type: 'reservation.expired' } }" class="text-xs text-blue-600 hover:underline">View all</router-link>
          </div>
          <div v-if="data.recent_expiries.length === 0" class="text-sm text-gray-400">None in window</div>
          <div v-for="e in data.recent_expiries" :key="e.event_id" class="py-1.5 border-b border-gray-100 last:border-0">
            <div class="flex justify-between">
              <span class="text-sm text-gray-700 truncate">{{ e.scope || e.tenant_id }}</span>
              <span class="text-xs text-gray-400">{{ new Date(e.timestamp).toLocaleTimeString() }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

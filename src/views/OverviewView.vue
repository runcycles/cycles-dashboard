<script setup lang="ts">
import { ref } from 'vue'
import { usePolling } from '../composables/usePolling'
import { getOverview } from '../api/client'
import type { AdminOverviewResponse } from '../types'
import PageHeader from '../components/PageHeader.vue'
import LoadingSkeleton from '../components/LoadingSkeleton.vue'
import { formatTime } from '../utils/format'

const data = ref<AdminOverviewResponse | null>(null)
const error = ref('')

const { refresh, isLoading } = usePolling(async () => {
  try { data.value = await getOverview(); error.value = '' }
  catch (e: any) { error.value = e.message }
}, 30000)
</script>

<template>
  <div>
    <PageHeader
      title="Overview"
      :loading="isLoading"
      :last-updated="data?.as_of ?? null"
      @refresh="refresh"
    />

    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">{{ error }}</p>

    <LoadingSkeleton v-if="!data" />

    <template v-else>
      <!-- Summary counters -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <router-link to="/tenants" class="bg-white rounded-lg shadow p-4 hover:shadow-md transition-shadow block group">
          <p class="text-sm text-gray-500 group-hover:text-gray-700">Tenants</p>
          <p class="text-2xl font-semibold text-gray-900">{{ data.tenant_counts.total }}</p>
          <p class="text-xs text-gray-400">{{ data.tenant_counts.active }} active<span v-if="data.tenant_counts.suspended">, {{ data.tenant_counts.suspended }} suspended</span></p>
        </router-link>
        <router-link to="/budgets" class="bg-white rounded-lg shadow p-4 hover:shadow-md transition-shadow block group">
          <p class="text-sm text-gray-500 group-hover:text-gray-700">Budgets</p>
          <p class="text-2xl font-semibold text-gray-900">{{ data.budget_counts.total }}</p>
          <p class="text-xs text-gray-400">{{ data.budget_counts.active }} active<span v-if="data.budget_counts.frozen">, <span class="text-yellow-600">{{ data.budget_counts.frozen }} frozen</span></span></p>
        </router-link>
        <router-link to="/webhooks" class="bg-white rounded-lg shadow p-4 hover:shadow-md transition-shadow block group">
          <p class="text-sm text-gray-500 group-hover:text-gray-700">Webhooks</p>
          <p class="text-2xl font-semibold text-gray-900">{{ data.webhook_counts.total }}</p>
          <p class="text-xs text-gray-400">{{ data.webhook_counts.active }} active<span v-if="data.webhook_counts.with_failures">, <span class="text-red-600">{{ data.webhook_counts.with_failures }} failing</span></span></p>
        </router-link>
        <router-link to="/events" class="bg-white rounded-lg shadow p-4 hover:shadow-md transition-shadow block group">
          <p class="text-sm text-gray-500 group-hover:text-gray-700">Events <span class="text-gray-400 font-normal">({{ Math.round(data.event_window_seconds / 60) }}m)</span></p>
          <p class="text-2xl font-semibold text-gray-900">{{ data.event_counts.total_recent }}</p>
          <p class="text-xs text-gray-400">
            <template v-if="Object.keys(data.event_counts.by_category).length">
              <span v-for="(count, cat) in data.event_counts.by_category" :key="cat" class="mr-2">{{ cat }}: {{ count }}</span>
            </template>
            <span v-else>no events</span>
          </p>
        </router-link>
      </div>

      <!-- Alerts row -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div class="bg-white rounded-lg shadow p-4">
          <div class="flex justify-between items-center mb-3">
            <h2 class="text-sm font-medium text-gray-700">
              Over-limit Budgets
              <span v-if="data.budget_counts.over_limit > 0" class="ml-1 bg-red-100 text-red-700 px-1.5 py-0.5 rounded text-xs">{{ data.budget_counts.over_limit }}</span>
            </h2>
            <router-link :to="{ name: 'budgets', query: { filter: 'over_limit' } }" class="text-xs text-blue-600 hover:underline">View all</router-link>
          </div>
          <div v-if="data.over_limit_scopes.length === 0" class="text-sm text-gray-400 py-4 text-center">All budgets within limits</div>
          <div v-for="s in data.over_limit_scopes" :key="s.scope + s.unit" class="flex justify-between items-center py-2 border-b border-gray-100 last:border-0">
            <router-link :to="{ name: 'budgets', query: { scope: s.scope, unit: s.unit } }" class="text-sm text-blue-600 hover:underline truncate mr-2" :title="s.scope">{{ s.scope }}</router-link>
            <span class="text-xs text-gray-500 shrink-0">{{ s.unit }}</span>
          </div>
        </div>

        <div class="bg-white rounded-lg shadow p-4">
          <div class="flex justify-between items-center mb-3">
            <h2 class="text-sm font-medium text-gray-700">
              Budgets with Debt
              <span v-if="data.budget_counts.with_debt > 0" class="ml-1 bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded text-xs">{{ data.budget_counts.with_debt }}</span>
            </h2>
            <router-link :to="{ name: 'budgets', query: { filter: 'has_debt' } }" class="text-xs text-blue-600 hover:underline">View all</router-link>
          </div>
          <div v-if="data.debt_scopes.length === 0" class="text-sm text-gray-400 py-4 text-center">No outstanding debt</div>
          <div v-for="s in data.debt_scopes" :key="s.scope + s.unit" class="flex justify-between items-center py-2 border-b border-gray-100 last:border-0">
            <router-link :to="{ name: 'budgets', query: { scope: s.scope, unit: s.unit } }" class="text-sm text-blue-600 hover:underline truncate mr-2" :title="s.scope">{{ s.scope }}</router-link>
            <span class="text-xs text-gray-500 shrink-0">{{ s.debt.toLocaleString() }} / {{ s.overdraft_limit.toLocaleString() }}</span>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div class="bg-white rounded-lg shadow p-4">
          <div class="flex justify-between items-center mb-3">
            <h2 class="text-sm font-medium text-gray-700">
              Failing Webhooks
              <span v-if="data.webhook_counts.with_failures > 0" class="ml-1 bg-red-100 text-red-700 px-1.5 py-0.5 rounded text-xs">{{ data.webhook_counts.with_failures }}</span>
            </h2>
            <router-link to="/webhooks" class="text-xs text-blue-600 hover:underline">View all</router-link>
          </div>
          <div v-if="data.failing_webhooks.length === 0" class="text-sm text-gray-400 py-4 text-center">All webhooks healthy</div>
          <div v-for="w in data.failing_webhooks" :key="w.subscription_id" class="flex justify-between items-center py-2 border-b border-gray-100 last:border-0">
            <router-link :to="{ name: 'webhook-detail', params: { id: w.subscription_id } }" class="text-sm text-blue-600 hover:underline truncate mr-2">{{ w.url }}</router-link>
            <span class="text-xs text-red-600 shrink-0">{{ w.consecutive_failures }} failures</span>
          </div>
        </div>

        <div class="bg-white rounded-lg shadow p-4">
          <div class="flex justify-between items-center mb-3">
            <h2 class="text-sm font-medium text-gray-700">
              Frozen Budgets
              <span v-if="data.budget_counts.frozen > 0" class="ml-1 bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded text-xs">{{ data.budget_counts.frozen }}</span>
            </h2>
            <router-link :to="{ name: 'budgets', query: { status: 'FROZEN' } }" class="text-xs text-blue-600 hover:underline">View all</router-link>
          </div>
          <div v-if="data.budget_counts.frozen === 0" class="text-sm text-gray-400 py-4 text-center">No frozen budgets</div>
          <router-link v-else :to="{ name: 'budgets', query: { status: 'FROZEN' } }" class="text-sm text-blue-600 hover:underline block py-4 text-center">
            View {{ data.budget_counts.frozen }} frozen budget{{ data.budget_counts.frozen !== 1 ? 's' : '' }}
          </router-link>
        </div>
      </div>

      <!-- Recent events -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="bg-white rounded-lg shadow p-4">
          <div class="flex justify-between items-center mb-3">
            <h2 class="text-sm font-medium text-gray-700">Recent Denials</h2>
            <router-link :to="{ name: 'events', query: { type: 'reservation.denied' } }" class="text-xs text-blue-600 hover:underline">View all</router-link>
          </div>
          <div v-if="data.recent_denials.length === 0" class="text-sm text-gray-400 py-4 text-center">No denials in the last hour</div>
          <div v-for="e in data.recent_denials" :key="e.event_id" class="py-2 border-b border-gray-100 last:border-0">
            <div class="flex justify-between">
              <span class="text-sm text-gray-700 truncate">{{ e.scope || e.tenant_id }}</span>
              <span class="text-xs text-gray-400 shrink-0 ml-2" :title="new Date(e.timestamp).toISOString()">{{ formatTime(e.timestamp) }}</span>
            </div>
            <p class="text-xs text-gray-500">{{ e.data?.reason_code || 'denied' }}</p>
          </div>
        </div>
        <div class="bg-white rounded-lg shadow p-4">
          <div class="flex justify-between items-center mb-3">
            <h2 class="text-sm font-medium text-gray-700">Recent Expiries</h2>
            <router-link :to="{ name: 'events', query: { type: 'reservation.expired' } }" class="text-xs text-blue-600 hover:underline">View all</router-link>
          </div>
          <div v-if="data.recent_expiries.length === 0" class="text-sm text-gray-400 py-4 text-center">No expiries in the last hour</div>
          <div v-for="e in data.recent_expiries" :key="e.event_id" class="py-2 border-b border-gray-100 last:border-0">
            <div class="flex justify-between">
              <span class="text-sm text-gray-700 truncate">{{ e.scope || e.tenant_id }}</span>
              <span class="text-xs text-gray-400 shrink-0 ml-2" :title="new Date(e.timestamp).toISOString()">{{ formatTime(e.timestamp) }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

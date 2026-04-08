<script setup lang="ts">
import { ref } from 'vue'
import { usePolling } from '../composables/usePolling'
import { useSort } from '../composables/useSort'
import { listTenants } from '../api/client'
import type { Tenant } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import { formatDate } from '../utils/format'

const tenants = ref<Tenant[]>([])
const error = ref('')
const { sortKey, sortDir, toggle, sorted: sortedTenants } = useSort(tenants)

const { refresh, isLoading, lastUpdated } = usePolling(async () => {
  try {
    const res = await listTenants()
    tenants.value = res.tenants
    error.value = ''
  } catch (e: any) { error.value = e.message }
}, 60000)
</script>

<template>
  <div>
    <PageHeader title="Tenants" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh" />
    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">{{ error }}</p>
    <div class="bg-white rounded-lg shadow overflow-hidden overflow-x-auto">
      <table class="w-full text-sm min-w-[480px]">
        <thead class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
          <tr>
            <SortHeader label="Tenant ID" column="tenant_id" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Name" column="name" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Status" column="status" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Created" column="created_at" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="t in sortedTenants" :key="t.tenant_id" class="hover:bg-gray-50 transition-colors">
            <td class="px-4 py-3">
              <router-link :to="{ name: 'tenant-detail', params: { id: t.tenant_id } }" class="text-blue-600 hover:underline font-mono text-xs">{{ t.tenant_id }}</router-link>
            </td>
            <td class="px-4 py-3 text-gray-700">{{ t.name }}</td>
            <td class="px-4 py-3"><StatusBadge :status="t.status" /></td>
            <td class="px-4 py-3 text-gray-400 text-xs">{{ formatDate(t.created_at) }}</td>
          </tr>
          <tr v-if="tenants.length === 0">
            <td colspan="4"><EmptyState message="No tenants found" hint="Tenants will appear here once created" /></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

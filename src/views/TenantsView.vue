<script setup lang="ts">
import { ref } from 'vue'
import { usePolling } from '../composables/usePolling'
import { listTenants } from '../api/client'
import type { Tenant } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'

const tenants = ref<Tenant[]>([])
const error = ref('')

const { refresh, isLoading } = usePolling(async () => {
  try {
    const res = await listTenants()
    tenants.value = res.tenants
    error.value = ''
  } catch (e: any) { error.value = e.message }
}, 60000)
</script>

<template>
  <div>
    <PageHeader title="Tenants" :loading="isLoading" @refresh="refresh" />
    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">{{ error }}</p>
    <div class="bg-white rounded-lg shadow overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
          <tr>
            <th class="px-4 py-3 text-left">Tenant ID</th>
            <th class="px-4 py-3 text-left">Name</th>
            <th class="px-4 py-3 text-left">Status</th>
            <th class="px-4 py-3 text-left">Created</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="t in tenants" :key="t.tenant_id" class="hover:bg-gray-50 transition-colors">
            <td class="px-4 py-3">
              <router-link :to="{ name: 'tenant-detail', params: { id: t.tenant_id } }" class="text-blue-600 hover:underline font-mono text-xs">{{ t.tenant_id }}</router-link>
            </td>
            <td class="px-4 py-3 text-gray-700">{{ t.name }}</td>
            <td class="px-4 py-3"><StatusBadge :status="t.status" /></td>
            <td class="px-4 py-3 text-gray-400 text-xs">{{ new Date(t.created_at).toLocaleDateString() }}</td>
          </tr>
          <tr v-if="tenants.length === 0">
            <td colspan="4" class="px-4 py-12 text-center text-gray-400">No tenants found</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { usePolling } from '../composables/usePolling'
import { listTenants } from '../api/client'
import type { Tenant } from '../types'
import StatusBadge from '../components/StatusBadge.vue'

const tenants = ref<Tenant[]>([])
const error = ref('')

const { refresh } = usePolling(async () => {
  try {
    const res = await listTenants()
    tenants.value = res.tenants
    error.value = ''
  } catch (e: any) { error.value = e.message }
}, 60000)
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-semibold text-gray-900">Tenants</h1>
      <button @click="refresh" class="text-sm text-gray-500 hover:text-gray-700">Refresh</button>
    </div>
    <p v-if="error" class="text-red-600 text-sm mb-4">{{ error }}</p>
    <div class="bg-white rounded-lg shadow overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 text-gray-500 text-xs uppercase">
          <tr>
            <th class="px-4 py-3 text-left">Tenant ID</th>
            <th class="px-4 py-3 text-left">Name</th>
            <th class="px-4 py-3 text-left">Status</th>
            <th class="px-4 py-3 text-left">Created</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in tenants" :key="t.tenant_id" class="border-t border-gray-100 hover:bg-gray-50">
            <td class="px-4 py-3">
              <router-link :to="{ name: 'tenant-detail', params: { id: t.tenant_id } }" class="text-blue-600 hover:underline">{{ t.tenant_id }}</router-link>
            </td>
            <td class="px-4 py-3 text-gray-700">{{ t.name }}</td>
            <td class="px-4 py-3"><StatusBadge :status="t.status" /></td>
            <td class="px-4 py-3 text-gray-400">{{ new Date(t.created_at).toLocaleDateString() }}</td>
          </tr>
          <tr v-if="tenants.length === 0">
            <td colspan="4" class="px-4 py-8 text-center text-gray-400">No tenants found</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

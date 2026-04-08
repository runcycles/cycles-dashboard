<script setup lang="ts">
import { ref } from 'vue'
import { listAuditLogs } from '../api/client'
import type { AuditLogEntry } from '../types'
import PageHeader from '../components/PageHeader.vue'

const entries = ref<AuditLogEntry[]>([])
const error = ref('')
const loading = ref(false)
const hasQueried = ref(false)

const tenantId = ref('')
const keyId = ref('')
const operation = ref('')
const fromDate = ref('')
const toDate = ref('')

async function query() {
  loading.value = true
  hasQueried.value = true
  try {
    const params: Record<string, string> = {}
    if (tenantId.value) params.tenant_id = tenantId.value
    if (keyId.value) params.key_id = keyId.value
    if (operation.value) params.operation = operation.value
    if (fromDate.value) params.from = new Date(fromDate.value).toISOString()
    if (toDate.value) params.to = new Date(toDate.value).toISOString()
    const res = await listAuditLogs(params)
    entries.value = res.entries
    error.value = ''
  } catch (e: any) { error.value = e.message }
  finally { loading.value = false }
}
</script>

<template>
  <div>
    <PageHeader title="Audit Logs" />

    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">{{ error }}</p>

    <form @submit.prevent="query" class="bg-white rounded-lg shadow p-4 mb-4">
      <div class="flex gap-3 flex-wrap items-end">
        <div>
          <label class="block text-xs text-gray-500 mb-1">Tenant ID</label>
          <input v-model="tenantId" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-32" placeholder="acme" />
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">Key ID</label>
          <input v-model="keyId" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-32" placeholder="key_..." />
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">Operation</label>
          <input v-model="operation" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-32" placeholder="createBudget" />
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">From</label>
          <input v-model="fromDate" type="datetime-local" class="border border-gray-300 rounded px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">To</label>
          <input v-model="toDate" type="datetime-local" class="border border-gray-300 rounded px-2 py-1.5 text-sm" />
        </div>
        <button type="submit" :disabled="loading" class="bg-gray-900 text-white px-4 py-1.5 rounded text-sm hover:bg-gray-800 disabled:opacity-50 cursor-pointer">
          {{ loading ? 'Querying...' : 'Run Query' }}
        </button>
      </div>
    </form>

    <p v-if="hasQueried && !loading" class="text-xs text-gray-400 mb-2">{{ entries.length }} result{{ entries.length !== 1 ? 's' : '' }}</p>

    <div class="bg-white rounded-lg shadow overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
          <tr>
            <th class="px-4 py-3 text-left">Time</th>
            <th class="px-4 py-3 text-left">Operation</th>
            <th class="px-4 py-3 text-left">Tenant</th>
            <th class="px-4 py-3 text-left">Key</th>
            <th class="px-4 py-3 text-left">Status</th>
            <th class="px-4 py-3 text-left">Request ID</th>
            <th class="px-4 py-3 text-left">IP</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="e in entries" :key="e.entry_id" class="hover:bg-gray-50 transition-colors">
            <td class="px-4 py-3 text-gray-400 whitespace-nowrap text-xs">{{ new Date(e.timestamp).toLocaleString() }}</td>
            <td class="px-4 py-3 font-mono text-xs">{{ e.operation }}</td>
            <td class="px-4 py-3 text-gray-500 text-xs">
              <router-link v-if="e.tenant_id" :to="{ name: 'tenant-detail', params: { id: e.tenant_id } }" class="text-blue-600 hover:underline">{{ e.tenant_id }}</router-link>
              <span v-else>-</span>
            </td>
            <td class="px-4 py-3 text-gray-500 font-mono text-xs">{{ e.key_id || '-' }}</td>
            <td class="px-4 py-3">
              <span class="px-1.5 py-0.5 rounded text-xs font-medium" :class="e.status >= 400 ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'">{{ e.status }}</span>
            </td>
            <td class="px-4 py-3 font-mono text-xs text-gray-400">{{ e.request_id || '-' }}</td>
            <td class="px-4 py-3 text-gray-400 text-xs">{{ e.source_ip || '-' }}</td>
          </tr>
          <tr v-if="entries.length === 0">
            <td colspan="7" class="px-4 py-12 text-center text-gray-400">
              {{ hasQueried ? 'No results for this query' : 'Run a query to see audit logs' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

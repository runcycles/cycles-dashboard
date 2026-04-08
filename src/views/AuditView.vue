<script setup lang="ts">
import { ref } from 'vue'
import { listAuditLogs } from '../api/client'
import type { AuditLogEntry } from '../types'

const entries = ref<AuditLogEntry[]>([])
const error = ref('')

const tenantId = ref('')
const keyId = ref('')
const operation = ref('')
const fromDate = ref('')
const toDate = ref('')

async function query() {
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
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-semibold text-gray-900 mb-6">Audit Logs</h1>
    <p v-if="error" class="text-red-600 text-sm mb-4">{{ error }}</p>

    <div class="flex gap-3 mb-4 flex-wrap items-end">
      <div>
        <label class="block text-xs text-gray-500 mb-1">Tenant ID</label>
        <input v-model="tenantId" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-32" />
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">Key ID</label>
        <input v-model="keyId" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-32" />
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">Operation</label>
        <input v-model="operation" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-32" />
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">From</label>
        <input v-model="fromDate" type="datetime-local" class="border border-gray-300 rounded px-2 py-1.5 text-sm" />
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">To</label>
        <input v-model="toDate" type="datetime-local" class="border border-gray-300 rounded px-2 py-1.5 text-sm" />
      </div>
      <button @click="query" class="bg-gray-900 text-white px-3 py-1.5 rounded text-sm hover:bg-gray-800">Run Query</button>
    </div>

    <div class="bg-white rounded-lg shadow overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 text-gray-500 text-xs uppercase">
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
        <tbody>
          <tr v-for="e in entries" :key="e.entry_id" class="border-t border-gray-100 hover:bg-gray-50">
            <td class="px-4 py-3 text-gray-400 whitespace-nowrap">{{ new Date(e.timestamp).toLocaleString() }}</td>
            <td class="px-4 py-3 font-mono text-xs">{{ e.operation }}</td>
            <td class="px-4 py-3 text-gray-500">{{ e.tenant_id || '-' }}</td>
            <td class="px-4 py-3 text-gray-500 font-mono text-xs">{{ e.key_id || '-' }}</td>
            <td class="px-4 py-3" :class="e.status >= 400 ? 'text-red-600' : 'text-green-600'">{{ e.status }}</td>
            <td class="px-4 py-3 font-mono text-xs text-gray-400">{{ e.request_id || '-' }}</td>
            <td class="px-4 py-3 text-gray-400">{{ e.source_ip || '-' }}</td>
          </tr>
          <tr v-if="entries.length === 0">
            <td colspan="7" class="px-4 py-8 text-center text-gray-400">Run a query to see results</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

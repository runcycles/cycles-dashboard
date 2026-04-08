<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { listAuditLogs } from '../api/client'
import type { AuditLogEntry } from '../types'
import PageHeader from '../components/PageHeader.vue'
import { formatDateTime } from '../utils/format'

const entries = ref<AuditLogEntry[]>([])
const error = ref('')
const loading = ref(false)

const tenantId = ref('')
const keyId = ref('')
const operation = ref('')
const fromDate = ref('')
const toDate = ref('')

function exportCsv() {
  if (entries.value.length === 0) return
  const headers = ['timestamp', 'operation', 'tenant_id', 'key_id', 'status', 'request_id', 'source_ip']
  const rows = entries.value.map(e => [
    e.timestamp, e.operation, e.tenant_id || '', e.key_id || '',
    String(e.status), e.request_id || '', e.source_ip || '',
  ])
  const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${v.replace(/"/g, '""')}"`).join(','))].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function exportJson() {
  if (entries.value.length === 0) return
  const blob = new Blob([JSON.stringify(entries.value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

async function query() {
  loading.value = true
  try {
    const params: Record<string, string> = {}
    if (tenantId.value) params.tenant_id = tenantId.value
    if (keyId.value) params.key_id = keyId.value
    if (operation.value) params.operation = operation.value
    if (fromDate.value) params.from = new Date(fromDate.value).toISOString()
    if (toDate.value) params.to = new Date(toDate.value).toISOString()
    const res = await listAuditLogs(params)
    entries.value = res.logs
    error.value = ''
  } catch (e: any) { error.value = e.message }
  finally { loading.value = false }
}

function setTimeRange(hours: number) {
  const now = new Date()
  const from = new Date(now.getTime() - hours * 3600_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  fromDate.value = fmt(from)
  toDate.value = fmt(now)
}

// Auto-query on page load (recent 50 logs, no filters)
onMounted(() => { query() })
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
      <div class="flex gap-2 mt-3 pt-3 border-t border-gray-100">
        <span class="text-xs text-gray-400 py-1">Quick range:</span>
        <button v-for="h in [1, 6, 24, 168]" :key="h" type="button" @click="setTimeRange(h)"
          class="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100 cursor-pointer">
          {{ h < 24 ? `${h}h` : `${h / 24}d` }}
        </button>
      </div>
    </form>

    <div v-if="!loading" class="flex items-center justify-between mb-2">
      <p class="text-xs text-gray-400">{{ entries.length }} result{{ entries.length !== 1 ? 's' : '' }}</p>
      <div v-if="entries.length > 0" class="flex gap-2">
        <button @click="exportCsv" class="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          Export CSV
        </button>
        <button @click="exportJson" class="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          Export JSON
        </button>
      </div>
    </div>

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
          <tr v-for="e in entries" :key="e.log_id" class="hover:bg-gray-50 transition-colors">
            <td class="px-4 py-3 text-gray-400 whitespace-nowrap text-xs">{{ formatDateTime(e.timestamp) }}</td>
            <td class="px-4 py-3 font-mono text-xs">{{ e.operation }}</td>
            <td class="px-4 py-3 text-gray-500 text-xs">
              <router-link v-if="e.tenant_id" :to="{ name: 'tenant-detail', params: { id: e.tenant_id } }" class="text-blue-600 hover:underline">{{ e.tenant_id }}</router-link>
              <span v-else>-</span>
            </td>
            <td class="px-4 py-3">
              <span class="text-gray-500 font-mono text-xs">{{ e.key_id || '-' }}</span>
            </td>
            <td class="px-4 py-3">
              <span class="px-1.5 py-0.5 rounded text-xs font-medium" :class="e.status >= 400 ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'">{{ e.status }}</span>
            </td>
            <td class="px-4 py-3 font-mono text-xs text-gray-400">{{ e.request_id || '-' }}</td>
            <td class="px-4 py-3 text-gray-400 text-xs">{{ e.source_ip || '-' }}</td>
          </tr>
          <tr v-if="entries.length === 0 && !loading">
            <td colspan="7" class="px-4 py-12 text-center text-gray-400">No audit logs found</td>
          </tr>
          <tr v-if="loading">
            <td colspan="7" class="px-4 py-12 text-center text-gray-400">Loading...</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { listAuditLogs } from '../api/client'
import { useSort } from '../composables/useSort'
import type { AuditLogEntry } from '../types'
import PageHeader from '../components/PageHeader.vue'
import MaskedValue from '../components/MaskedValue.vue'
import TenantLink from '../components/TenantLink.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import { formatDateTime } from '../utils/format'

const entries = ref<AuditLogEntry[]>([])
const error = ref('')
const loading = ref(false)
const showExportConfirm = ref<'csv' | 'json' | null>(null)
const { sortKey, sortDir, toggle, sorted: sortedEntries } = useSort(entries)

const tenantId = ref('')
const keyId = ref('')
const operation = ref('')
const fromDate = ref('')
const toDate = ref('')

function doExportCsv() {
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

function doExportJson() {
  const blob = new Blob([JSON.stringify(entries.value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

function confirmExport(format: 'csv' | 'json') {
  if (entries.value.length === 0) return
  showExportConfirm.value = format
}

function executeExport() {
  if (showExportConfirm.value === 'csv') doExportCsv()
  else if (showExportConfirm.value === 'json') doExportJson()
  showExportConfirm.value = null
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
          <label for="audit-tenant" class="block text-xs text-gray-500 mb-1">Tenant ID</label>
          <input id="audit-tenant" v-model="tenantId" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-32" placeholder="acme" />
        </div>
        <div>
          <label for="audit-key" class="block text-xs text-gray-500 mb-1">Key ID</label>
          <input id="audit-key" v-model="keyId" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-32" placeholder="key_..." />
        </div>
        <div>
          <label for="audit-operation" class="block text-xs text-gray-500 mb-1">Operation</label>
          <input id="audit-operation" v-model="operation" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-32" placeholder="createBudget" />
        </div>
        <div>
          <label for="audit-from" class="block text-xs text-gray-500 mb-1">From</label>
          <input id="audit-from" v-model="fromDate" type="datetime-local" class="border border-gray-300 rounded px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label for="audit-to" class="block text-xs text-gray-500 mb-1">To</label>
          <input id="audit-to" v-model="toDate" type="datetime-local" class="border border-gray-300 rounded px-2 py-1.5 text-sm" />
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
        <button @click="confirmExport('csv')" class="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          Export CSV
        </button>
        <button @click="confirmExport('json')" class="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          Export JSON
        </button>
      </div>
    </div>

    <div class="bg-white rounded-lg shadow overflow-hidden overflow-x-auto">
      <table class="w-full text-sm min-w-[800px]">
        <thead class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
          <tr>
            <SortHeader label="Time" column="timestamp" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Operation" column="operation" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Tenant" column="tenant_id" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <th class="px-4 py-3 text-left">Key ID</th>
            <SortHeader label="Status" column="status" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <th class="px-4 py-3 text-left">Request ID</th>
            <SortHeader label="IP" column="source_ip" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="e in sortedEntries" :key="e.log_id" class="hover:bg-gray-50 transition-colors">
            <td class="px-4 py-3 text-gray-400 whitespace-nowrap text-xs" :title="new Date(e.timestamp).toISOString()">{{ formatDateTime(e.timestamp) }}</td>
            <td class="px-4 py-3 font-mono text-xs">{{ e.operation }}</td>
            <td class="px-4 py-3 text-gray-500 text-xs">
              <TenantLink v-if="e.tenant_id" :tenant-id="e.tenant_id" />
              <span v-else class="text-gray-400 text-xs">-</span>
            </td>
            <td class="px-4 py-3">
              <MaskedValue v-if="e.key_id" :value="e.key_id" />
              <span v-else class="text-gray-400 text-xs">-</span>
            </td>
            <td class="px-4 py-3">
              <span class="px-1.5 py-0.5 rounded text-xs font-medium" :class="e.status >= 400 ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'">{{ e.status }}</span>
            </td>
            <td class="px-4 py-3 font-mono text-xs text-gray-400">{{ e.request_id || '-' }}</td>
            <td class="px-4 py-3 text-gray-400 text-xs">{{ e.source_ip || '-' }}</td>
          </tr>
          <tr v-if="entries.length === 0 && !loading">
            <td colspan="7"><EmptyState message="No audit logs found" hint="Adjust your filters or time range and run the query again" /></td>
          </tr>
          <tr v-if="loading">
            <td colspan="7" class="px-4 py-12 text-center text-gray-400">Loading...</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Export confirmation dialog -->
    <div v-if="showExportConfirm" class="fixed inset-0 bg-black/40 flex items-center justify-center z-50" @click.self="showExportConfirm = null">
      <div class="bg-white rounded-lg shadow-lg p-6 max-w-sm mx-4">
        <h3 class="text-sm font-semibold text-gray-900 mb-2">Export audit data?</h3>
        <p class="text-sm text-gray-600 mb-1">This export contains <strong>{{ entries.length }}</strong> audit log entries including key IDs and IP addresses.</p>
        <p class="text-xs text-gray-400 mb-4">Exported files contain unmasked sensitive data. Handle with care.</p>
        <div class="flex justify-end gap-2">
          <button @click="showExportConfirm = null" class="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 rounded hover:bg-gray-100 cursor-pointer">Cancel</button>
          <button @click="executeExport" class="px-3 py-1.5 text-sm bg-gray-900 text-white rounded hover:bg-gray-800 cursor-pointer">Export {{ showExportConfirm.toUpperCase() }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

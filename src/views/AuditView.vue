<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { listAuditLogs } from '../api/client'
import { useSort } from '../composables/useSort'
import type { AuditLogEntry } from '../types'
import PageHeader from '../components/PageHeader.vue'
import MaskedValue from '../components/MaskedValue.vue'
import TenantLink from '../components/TenantLink.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import { formatDateTime } from '../utils/format'
import { toMessage } from '../utils/errors'
import { csvEscape, safeJsonStringify } from '../utils/safe'

const entries = ref<AuditLogEntry[]>([])
const error = ref('')
const loading = ref(false)
const showExportConfirm = ref<'csv' | 'json' | null>(null)
const expanded = ref<string | null>(null)
const { sortKey, sortDir, toggle, sorted: sortedEntries } = useSort(entries)

const tenantId = ref('')
const keyId = ref('')
const operation = ref('')
const resourceType = ref('')
const resourceId = ref('')
const fromDate = ref('')
const toDate = ref('')

function doExportCsv() {
  const headers = ['timestamp', 'operation', 'resource_type', 'resource_id', 'tenant_id', 'key_id', 'status', 'error_code', 'request_id', 'source_ip', 'user_agent', 'metadata']
  const rows = entries.value.map(e => [
    e.timestamp, e.operation, e.resource_type, e.resource_id,
    e.tenant_id, e.key_id, e.status, e.error_code,
    e.request_id, e.source_ip, e.user_agent,
    e.metadata ? safeJsonStringify(e.metadata, 0) : '',
  ])
  // csvEscape neutralizes Excel/Sheets formula injection (CWE-1236) by
  // prefixing cells starting with =, +, -, @, TAB, or CR with a single
  // quote. Server-controlled fields like operation/source_ip would
  // otherwise be a vector when an admin opens the export in a spreadsheet.
  const csv = [
    headers.map(csvEscape).join(','),
    ...rows.map(r => r.map(csvEscape).join(',')),
  ].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function doExportJson() {
  const blob = new Blob([safeJsonStringify(entries.value, 2)], { type: 'application/json' })
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
    if (resourceType.value) params.resource_type = resourceType.value
    if (resourceId.value) params.resource_id = resourceId.value
    if (fromDate.value) params.from = new Date(fromDate.value).toISOString()
    if (toDate.value) params.to = new Date(toDate.value).toISOString()
    const res = await listAuditLogs(params)
    entries.value = res.logs
    error.value = ''
  } catch (e) { error.value = toMessage(e) }
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

function hasDetail(e: AuditLogEntry): boolean {
  return !!(e.resource_type || e.resource_id || e.metadata || e.error_code || e.request_id || e.source_ip || e.user_agent)
}

// v0.1.25.21 (#8): accept audit drill-down params from the URL. Lets
// "View activity" links from API key / tenant rows pre-fill the
// filters and auto-run the query, so ops doesn't have to copy-paste
// the key_id / tenant_id into the form.
const route = useRoute()
function applyQueryParams() {
  if (route.query.tenant_id) tenantId.value = String(route.query.tenant_id)
  if (route.query.key_id) keyId.value = String(route.query.key_id)
  if (route.query.operation) operation.value = String(route.query.operation)
  if (route.query.resource_type) resourceType.value = String(route.query.resource_type)
  if (route.query.resource_id) resourceId.value = String(route.query.resource_id)
}
onMounted(() => {
  applyQueryParams()
  query()
})
// Watch in-place query changes too — same-route navigation (e.g. clicking
// an Activity link from a sidebar that's already on AuditView) won't
// remount the component, so the onMounted hook wouldn't fire. Without
// this watch, the URL would update but the form would stay on the
// previous filter values.
watch(() => route.query, () => {
  applyQueryParams()
  query()
})
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
          <label for="audit-resource" class="block text-xs text-gray-500 mb-1">Resource Type</label>
          <select id="audit-resource" v-model="resourceType" class="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white">
            <option value="">All</option>
            <option>tenant</option><option>budget</option><option>api_key</option>
            <option>policy</option><option>webhook</option><option>config</option>
          </select>
        </div>
        <div>
          <label for="audit-resource-id" class="block text-xs text-gray-500 mb-1">Resource ID</label>
          <input id="audit-resource-id" v-model="resourceId" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-36" placeholder="key_abc123..." />
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
      <table class="w-full text-sm min-w-[900px]">
        <thead class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
          <tr>
            <th class="w-8"></th>
            <SortHeader label="Time" column="timestamp" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Operation" column="operation" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Resource" column="resource_type" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Tenant" column="tenant_id" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <th class="px-4 py-3 text-left">Key ID</th>
            <SortHeader label="Status" column="status" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <template v-for="e in sortedEntries" :key="e.log_id">
            <tr
              class="hover:bg-gray-50 transition-colors"
              :class="hasDetail(e) ? 'cursor-pointer' : ''"
              @click="hasDetail(e) ? (expanded = expanded === e.log_id ? null : e.log_id) : null"
              :role="hasDetail(e) ? 'button' : undefined"
              :tabindex="hasDetail(e) ? 0 : undefined"
              @keydown.enter.prevent="hasDetail(e) ? (expanded = expanded === e.log_id ? null : e.log_id) : null"
              @keydown.space.prevent="hasDetail(e) ? (expanded = expanded === e.log_id ? null : e.log_id) : null"
              :aria-expanded="hasDetail(e) ? expanded === e.log_id : undefined"
            >
              <td class="pl-3 py-3 text-gray-400">
                <svg v-if="hasDetail(e)" class="w-3.5 h-3.5 transition-transform" :class="expanded === e.log_id ? 'rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </td>
              <td class="px-4 py-3 text-gray-400 whitespace-nowrap text-xs" :title="new Date(e.timestamp).toISOString()">{{ formatDateTime(e.timestamp) }}</td>
              <td class="px-4 py-3 font-mono text-xs">{{ e.operation }}</td>
              <td class="px-4 py-3 text-xs">
                <span v-if="e.resource_type" class="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{{ e.resource_type }}</span>
                <span v-if="e.resource_id" class="ml-1 font-mono text-gray-400">{{ e.resource_id }}</span>
                <span v-if="!e.resource_type && !e.resource_id" class="text-gray-400">-</span>
              </td>
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
                <span v-if="e.error_code" class="ml-1 text-xs text-red-500 font-mono">{{ e.error_code }}</span>
              </td>
            </tr>
            <!-- Expanded detail row -->
            <tr v-if="expanded === e.log_id" class="bg-gray-50/70">
              <td :colspan="7" class="px-4 py-3 pl-11">
                <div class="grid grid-cols-2 gap-x-6 gap-y-1 text-xs mb-3">
                  <div v-if="e.request_id"><span class="text-gray-400">Request ID:</span> <span class="font-mono">{{ e.request_id }}</span></div>
                  <div v-if="e.source_ip"><span class="text-gray-400">Source IP:</span> <span class="font-mono">{{ e.source_ip }}</span></div>
                  <div v-if="e.user_agent"><span class="text-gray-400">User Agent:</span> {{ e.user_agent }}</div>
                  <div v-if="e.error_code"><span class="text-gray-400">Error Code:</span> <span class="font-mono text-red-500">{{ e.error_code }}</span></div>
                  <div v-if="e.resource_type"><span class="text-gray-400">Resource Type:</span> {{ e.resource_type }}</div>
                  <div v-if="e.resource_id"><span class="text-gray-400">Resource ID:</span> <span class="font-mono">{{ e.resource_id }}</span></div>
                </div>
                <div v-if="e.metadata && Object.keys(e.metadata).length > 0" class="bg-white border border-gray-200 rounded p-3 text-xs font-mono overflow-auto max-h-48">
                  <div class="text-gray-400 mb-1 font-sans text-xs">Metadata</div>
                  <pre class="whitespace-pre-wrap">{{ safeJsonStringify(e.metadata) }}</pre>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="entries.length === 0 && !loading">
            <td colspan="7"><EmptyState message="No audit logs found" hint="Try a broader time range (e.g. Last 24h) or clear your filters" /></td>
          </tr>
          <tr v-if="loading">
            <td colspan="7" class="px-4 py-12 text-center text-gray-400">Loading...</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Export confirmation dialog -->
    <div v-if="showExportConfirm" class="fixed inset-0 bg-black/40 flex items-center justify-center z-50" @click.self="showExportConfirm = null">
      <div class="bg-white dark:bg-gray-900 dark:border dark:border-gray-700 rounded-lg shadow-lg p-6 max-w-sm mx-4">
        <h3 class="text-sm font-semibold text-gray-900 mb-2">Export audit data?</h3>
        <p class="text-sm text-gray-600 mb-1">This export contains <strong>{{ entries.length }}</strong> audit log entries including key IDs, IP addresses, and metadata.</p>
        <p class="text-xs text-gray-400 mb-4">Exported files contain unmasked sensitive data. Handle with care.</p>
        <div class="flex justify-end gap-2">
          <button @click="showExportConfirm = null" class="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 rounded hover:bg-gray-100 cursor-pointer">Cancel</button>
          <button @click="executeExport" class="px-3 py-1.5 text-sm bg-gray-900 text-white rounded hover:bg-gray-800 cursor-pointer">Export {{ showExportConfirm.toUpperCase() }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

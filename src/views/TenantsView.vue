<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { useSort } from '../composables/useSort'
import { listTenants, createTenant } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { Tenant } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import FormDialog from '../components/FormDialog.vue'
import { formatDate } from '../utils/format'
import { useToast } from '../composables/useToast'

const toast = useToast()

const router = useRouter()
const auth = useAuthStore()
const canManage = computed(() => auth.capabilities?.manage_tenants !== false)

const tenants = ref<Tenant[]>([])
const error = ref('')
const search = ref('')
const filteredTenants = computed(() => {
  if (!search.value) return tenants.value
  const q = search.value.toLowerCase()
  return tenants.value.filter(t => t.tenant_id.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
})
const { sortKey, sortDir, toggle, sorted: sortedTenants } = useSort(filteredTenants)

// Create tenant
const showCreate = ref(false)
const createLoading = ref(false)
const createError = ref('')
const createForm = ref({ tenant_id: '', name: '', parent_tenant_id: '' })

function openCreate() {
  createForm.value = { tenant_id: '', name: '', parent_tenant_id: '' }
  createError.value = ''
  showCreate.value = true
}

async function submitCreate() {
  createError.value = ''
  if (!/^[a-z0-9-]+$/.test(createForm.value.tenant_id)) {
    createError.value = 'Tenant ID must contain only lowercase letters, numbers, and hyphens'
    return
  }
  createLoading.value = true
  try {
    const body: Record<string, unknown> = { tenant_id: createForm.value.tenant_id, name: createForm.value.name }
    if (createForm.value.parent_tenant_id) body.parent_tenant_id = createForm.value.parent_tenant_id
    await createTenant(body as any)
    showCreate.value = false
    toast.success(`Tenant '${createForm.value.name}' created`)
    router.push({ name: 'tenant-detail', params: { id: createForm.value.tenant_id } })
  } catch (e: any) { createError.value = e.message }
  finally { createLoading.value = false }
}

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
    <div class="flex items-center justify-between">
      <PageHeader title="Tenants" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh" />
      <button v-if="canManage" @click="openCreate" class="text-xs bg-blue-600 text-white hover:bg-blue-700 rounded px-3 py-1.5 cursor-pointer transition-colors">Create Tenant</button>
    </div>
    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">{{ error }}</p>
    <div class="mb-4">
      <input v-model="search" placeholder="Search tenants by ID or name..." class="border border-gray-300 rounded px-3 py-1.5 text-sm w-full max-w-xs" />
    </div>
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
          <tr v-if="filteredTenants.length === 0">
            <td colspan="4"><EmptyState :message="search ? 'No tenants match your search' : 'No tenants found'" :hint="search ? undefined : 'Tenants will appear here once created'" /></td>
          </tr>
        </tbody>
      </table>
    </div>

    <FormDialog v-if="showCreate" title="Create Tenant" submit-label="Create Tenant" :loading="createLoading" :error="createError" @submit="submitCreate" @cancel="showCreate = false">
      <div>
        <label for="ct-id" class="block text-xs text-gray-500 mb-1">Tenant ID</label>
        <input id="ct-id" v-model="createForm.tenant_id" required pattern="^[a-z0-9-]+$" minlength="3" maxlength="64" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full font-mono" placeholder="acme-corp" />
        <p class="text-xs text-gray-400 mt-0.5">Lowercase letters, numbers, and hyphens only</p>
      </div>
      <div>
        <label for="ct-name" class="block text-xs text-gray-500 mb-1">Display Name</label>
        <input id="ct-name" v-model="createForm.name" required maxlength="256" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full" placeholder="Acme Corporation" />
      </div>
      <div>
        <label for="ct-parent" class="block text-xs text-gray-500 mb-1">Parent Tenant (optional)</label>
        <select id="ct-parent" v-model="createForm.parent_tenant_id" class="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white w-full">
          <option value="">None</option>
          <option v-for="t in tenants" :key="t.tenant_id" :value="t.tenant_id">{{ t.name || t.tenant_id }}</option>
        </select>
      </div>
    </FormDialog>
  </div>
</template>

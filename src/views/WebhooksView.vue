<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { usePolling } from '../composables/usePolling'
import { useSort } from '../composables/useSort'
import { listWebhooks, listTenants, createWebhook } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { WebhookSubscription, WebhookCreateResponse, Tenant } from '../types'
import { EVENT_TYPES } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import PageHeader from '../components/PageHeader.vue'
import SortHeader from '../components/SortHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import FormDialog from '../components/FormDialog.vue'
import SecretReveal from '../components/SecretReveal.vue'
import { useToast } from '../composables/useToast'

const toast = useToast()

const router = useRouter()
const auth = useAuthStore()
const canManage = computed(() => auth.capabilities?.manage_webhooks !== false)

const webhooks = ref<WebhookSubscription[]>([])
const tenants = ref<Tenant[]>([])
const error = ref('')
const { sortKey, sortDir, toggle, sorted: sortedWebhooks } = useSort(webhooks)

function healthColor(w: WebhookSubscription): string {
  if (w.status === 'DISABLED') return 'bg-red-500'
  if ((w.consecutive_failures ?? 0) >= 1) return 'bg-yellow-500'
  return 'bg-green-500'
}

function healthLabel(w: WebhookSubscription): string {
  if (w.status === 'DISABLED') return 'Disabled'
  if ((w.consecutive_failures ?? 0) >= 1) return 'Failing'
  return 'Healthy'
}

// Create webhook
const showCreate = ref(false)
const createLoading = ref(false)
const createError = ref('')
const createForm = ref({ url: '', name: '', event_types: [] as string[], tenant_id: '', scope_filter: '' })
const createdWebhook = ref<WebhookCreateResponse | null>(null)

function openCreate() {
  createForm.value = { url: '', name: '', event_types: [], tenant_id: '', scope_filter: '' }
  createError.value = ''
  showCreate.value = true
}

async function onSecretClose() {
  const subId = createdWebhook.value?.subscription?.subscription_id
  createdWebhook.value = null
  if (subId) router.push({ name: 'webhook-detail', params: { id: subId } })
  else await refresh()
}

async function submitCreate() {
  createError.value = ''
  if (!createForm.value.event_types.length) { createError.value = 'Select at least one event type'; return }
  createLoading.value = true
  try {
    const body: Record<string, unknown> = { url: createForm.value.url, event_types: createForm.value.event_types }
    if (createForm.value.name) body.name = createForm.value.name
    if (createForm.value.scope_filter) body.scope_filter = createForm.value.scope_filter
    const res = await createWebhook(body as any, createForm.value.tenant_id || undefined)
    createdWebhook.value = res
    showCreate.value = false
    toast.success('Webhook created')
  } catch (e: any) { createError.value = e.message }
  finally { createLoading.value = false }
}

const { refresh, isLoading, lastUpdated } = usePolling(async () => {
  try {
    const [wRes, tRes] = await Promise.all([listWebhooks(), listTenants()])
    webhooks.value = wRes.subscriptions
    tenants.value = tRes.tenants
    error.value = ''
  } catch (e: any) { error.value = e.message }
}, 60000)
</script>

<template>
  <div>
    <div class="flex items-center justify-between">
      <PageHeader title="Webhooks" :loading="isLoading" :last-updated="lastUpdated" @refresh="refresh" />
      <button v-if="canManage" @click="openCreate" class="text-xs bg-blue-600 text-white hover:bg-blue-700 rounded px-3 py-1.5 cursor-pointer transition-colors">Create Webhook</button>
    </div>
    <p v-if="error" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">{{ error }}</p>
    <div class="bg-white rounded-lg shadow overflow-hidden overflow-x-auto">
      <table class="w-full text-sm min-w-[600px]">
        <thead class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
          <tr>
            <th class="px-4 py-3 text-left w-10">Health</th>
            <SortHeader label="URL" column="url" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Status" column="status" :active-column="sortKey" :direction="sortDir" @sort="toggle" />
            <SortHeader label="Failures" column="consecutive_failures" :active-column="sortKey" :direction="sortDir" @sort="toggle" align="right" />
            <th class="px-4 py-3 text-left">Events</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="w in sortedWebhooks" :key="w.subscription_id" class="hover:bg-gray-50 transition-colors">
            <td class="px-4 py-3"><span :class="healthColor(w)" class="inline-block w-2.5 h-2.5 rounded-full" :title="healthLabel(w)" /></td>
            <td class="px-4 py-3">
              <router-link :to="{ name: 'webhook-detail', params: { id: w.subscription_id } }" class="text-blue-600 hover:underline truncate block max-w-[300px]">{{ w.url }}</router-link>
              <span v-if="w.name" class="text-xs text-gray-400">{{ w.name }}</span>
            </td>
            <td class="px-4 py-3"><StatusBadge :status="w.status" /></td>
            <td class="px-4 py-3 text-right tabular-nums" :class="(w.consecutive_failures ?? 0) > 0 ? 'text-red-600 font-medium' : 'text-gray-400'">{{ w.consecutive_failures ?? 0 }}</td>
            <td class="px-4 py-3 text-xs text-gray-500">{{ w.event_types?.join(', ') || w.event_categories?.join(', ') || 'all' }}</td>
          </tr>
          <tr v-if="webhooks.length === 0">
            <td colspan="5"><EmptyState message="No webhook subscriptions" hint="Webhook subscriptions will appear here once configured" /></td>
          </tr>
        </tbody>
      </table>
    </div>

    <FormDialog v-if="showCreate" title="Create Webhook" submit-label="Create Webhook" :loading="createLoading" :error="createError" @submit="submitCreate" @cancel="showCreate = false" :wide="true">
      <div>
        <label for="cw-url" class="block text-xs text-gray-500 mb-1">URL</label>
        <input id="cw-url" v-model="createForm.url" type="url" required class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full font-mono" placeholder="https://example.com/webhooks" />
      </div>
      <div>
        <label for="cw-name" class="block text-xs text-gray-500 mb-1">Name (optional)</label>
        <input id="cw-name" v-model="createForm.name" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full" placeholder="Production alerts" />
      </div>
      <div>
        <label for="cw-tenant" class="block text-xs text-gray-500 mb-1">Tenant (optional — omit for system-wide)</label>
        <select id="cw-tenant" v-model="createForm.tenant_id" class="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white w-full">
          <option value="">System-wide</option>
          <option v-for="t in tenants" :key="t.tenant_id" :value="t.tenant_id">{{ t.name || t.tenant_id }}</option>
        </select>
      </div>
      <div>
        <label class="block text-xs text-gray-500 mb-1">Event types</label>
        <div class="grid grid-cols-2 gap-1 max-h-48 overflow-y-auto border border-gray-200 rounded p-2">
          <label v-for="et in EVENT_TYPES" :key="et" class="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" :value="et" v-model="createForm.event_types" class="rounded" />
            {{ et }}
          </label>
        </div>
      </div>
      <div>
        <label for="cw-scope" class="block text-xs text-gray-500 mb-1">Scope filter (optional)</label>
        <input id="cw-scope" v-model="createForm.scope_filter" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-full font-mono" placeholder="tenant:acme/*" />
      </div>
    </FormDialog>

    <SecretReveal
      v-if="createdWebhook?.signing_secret"
      title="Webhook Created"
      :secret="createdWebhook.signing_secret"
      label="Signing Secret"
      @close="onSecretClose"
    />
  </div>
</template>

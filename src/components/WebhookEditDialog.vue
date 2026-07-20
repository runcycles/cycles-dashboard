<script setup lang="ts">
import type { WebhookSubscription } from '../types'
import type { WebhookEditForm } from '../composables/useWebhookEditor'
import type { WebhookAdvancedForm } from '../utils/webhookAdvanced'
import FormDialog from './FormDialog.vue'
import WebhookAdvancedFields from './WebhookAdvancedFields.vue'

defineProps<{
  loading: boolean
  error: string
  metadataError: string
  form: WebhookEditForm
  advanced: WebhookAdvancedForm
  advancedHasConfig: boolean
  eventTypes: readonly string[]
  eventCategories: readonly string[]
  tenantOwned: boolean
  hiddenLegacySelectorCount: number
  webhook: WebhookSubscription | null
}>()

defineEmits<{ submit: []; cancel: [] }>()
</script>

<template>
  <FormDialog
    title="Edit Webhook"
    submit-label="Save Changes"
    :loading="loading"
    :error="error"
    :wide="true"
    @submit="$emit('submit')"
    @cancel="$emit('cancel')"
  >
    <div>
      <label for="ew-name" class="form-label">Name</label>
      <input id="ew-name" v-model="form.name" class="form-input" placeholder="Human-readable name (optional)" maxlength="256" />
    </div>
    <div>
      <label for="ew-description" class="form-label">Description</label>
      <textarea id="ew-description" v-model="form.description" class="form-input" rows="2" placeholder="What this webhook is for (optional)" maxlength="1024" />
    </div>
    <div>
      <label for="ew-url" class="form-label">URL</label>
      <input id="ew-url" v-model="form.url" type="url" required class="form-input-mono" />
    </div>
    <fieldset>
      <legend class="form-label">Event types</legend>
      <div class="grid grid-cols-2 gap-1 max-h-48 overflow-y-auto border border-gray-200 rounded p-2">
        <label v-for="eventType in eventTypes" :key="eventType" class="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
          <input v-model="form.event_types" type="checkbox" :value="eventType" class="rounded" />
          {{ eventType }}
        </label>
      </div>
      <p v-if="tenantOwned" class="muted-sm mt-1">Tenant-owned subscriptions can only receive tenant-scoped events (budget.*, reservation.*, tenant.*).</p>
      <p v-if="hiddenLegacySelectorCount" class="muted-sm mt-1" data-testid="hidden-legacy-selectors-hint">
        {{ hiddenLegacySelectorCount }} legacy admin-only selector{{ hiddenLegacySelectorCount === 1 ? ' is' : 's are' }} hidden here; {{ hiddenLegacySelectorCount === 1 ? 'it remains' : 'they remain' }} active until you edit the selectors, at which point {{ hiddenLegacySelectorCount === 1 ? 'it is' : 'they are' }} cleared.
      </p>
    </fieldset>
    <fieldset>
      <legend class="form-label">Event categories <span class="muted-sm">(additive — subscribes to all events in category, including future ones)</span></legend>
      <div class="flex flex-wrap gap-2 border border-gray-200 rounded p-2">
        <label v-for="category in eventCategories" :key="category" class="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
          <input v-model="form.event_categories" type="checkbox" :value="category" class="rounded" />
          {{ category }}
        </label>
      </div>
    </fieldset>
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label for="ew-scope" class="form-label">Scope filter</label>
        <input id="ew-scope" v-model="form.scope_filter" class="form-input-mono" placeholder="tenant:acme/*" />
      </div>
      <div>
        <label for="ew-failures" class="form-label">Disable after failures</label>
        <input id="ew-failures" v-model="form.disable_after_failures" type="number" min="1" step="1" required class="form-input" />
      </div>
    </div>
    <div>
      <label for="ew-metadata" class="form-label">Metadata <span class="muted-sm">(JSON object, optional)</span></label>
      <textarea id="ew-metadata" v-model="form.metadata" class="form-input-mono" rows="4" placeholder='{ "team": "payments", "env": "prod" }' />
      <p v-if="metadataError" class="text-xs text-red-600 mt-1" role="alert">{{ metadataError }}</p>
    </div>
    <div v-if="webhook?.headers && Object.keys(webhook.headers).length > 0" class="info-panel">
      <span class="form-label">Custom headers</span>
      <p class="muted-sm mb-1">Keys preserved, values encrypted on the server and masked on read. Rotating values requires re-creating the subscription.</p>
      <div class="flex flex-wrap gap-1 mt-1">
        <span v-for="key in Object.keys(webhook.headers)" :key="key" class="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-xs font-mono">{{ key }}: ********</span>
      </div>
    </div>
    <WebhookAdvancedFields :form="advanced" :start-open="advancedHasConfig" id-prefix="ew-adv" mode="edit" />
  </FormDialog>
</template>

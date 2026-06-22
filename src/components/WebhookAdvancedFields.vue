<script setup lang="ts">
// Collapsible "Alerting thresholds & retry" editor shared by the webhook
// create (WebhooksView) and edit (WebhookDetailView) dialogs. Surfaces
// the spec's WebhookThresholdConfig + WebhookRetryPolicy, which the
// dashboard previously treated as opaque read-only blobs. Conversion to
// the request shape lives in utils/webhookAdvanced.ts (unit-testable).
import { ref } from 'vue'
import type { WebhookAdvancedForm } from '../utils/webhookAdvanced'
import ChevronRightIcon from './icons/ChevronRightIcon.vue'

const props = defineProps<{
  form: WebhookAdvancedForm
  startOpen?: boolean
  idPrefix?: string
}>()

const open = ref(!!props.startOpen)
const pfx = props.idPrefix ?? 'wh-adv'
</script>

<template>
  <div class="border-t border-gray-200 dark:border-gray-700 pt-3">
    <button
      type="button"
      class="flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-200 cursor-pointer"
      :aria-expanded="open"
      :data-testid="`${pfx}-toggle`"
      @click="open = !open"
    >
      <ChevronRightIcon class="w-4 h-4 transition-transform" :class="open ? 'rotate-90' : ''" />
      Alerting thresholds &amp; retry policy
    </button>

    <div v-if="open" class="mt-3 space-y-4">
      <fieldset class="space-y-2">
        <legend class="form-label">Thresholds</legend>
        <p class="muted-sm">Only relevant when subscribed to threshold / rate-spike event types. Blank fields use server defaults.</p>
        <div>
          <label :for="`${pfx}-util`" class="form-label">Budget utilization (fractions 0–1, comma-separated)</label>
          <input :id="`${pfx}-util`" v-model="form.budget_utilization" class="form-input-mono" placeholder="0.8, 0.95, 1.0" />
        </div>
        <div class="grid gap-3 sm:grid-cols-3">
          <div>
            <label :for="`${pfx}-burn-mult`" class="form-label">Burn-rate multiplier</label>
            <input :id="`${pfx}-burn-mult`" v-model="form.burn_rate_multiplier" type="number" min="1.5" step="0.1" class="form-input-mono" placeholder="3.0" />
          </div>
          <div>
            <label :for="`${pfx}-burn-win`" class="form-label">Burn-rate window (s)</label>
            <input :id="`${pfx}-burn-win`" v-model="form.burn_rate_window_seconds" type="number" min="60" max="86400" step="1" class="form-input-mono" placeholder="300" />
          </div>
          <div>
            <label :for="`${pfx}-rate-win`" class="form-label">Rate-spike window (s)</label>
            <input :id="`${pfx}-rate-win`" v-model="form.rate_window_seconds" type="number" min="60" max="86400" step="1" class="form-input-mono" placeholder="300" />
          </div>
        </div>
        <div class="grid gap-3 sm:grid-cols-3">
          <div>
            <label :for="`${pfx}-denial`" class="form-label">Denial-rate threshold</label>
            <input :id="`${pfx}-denial`" v-model="form.denial_rate_threshold" type="number" min="0" max="1" step="0.01" class="form-input-mono" placeholder="0.10" />
          </div>
          <div>
            <label :for="`${pfx}-expiry`" class="form-label">Expiry-rate threshold</label>
            <input :id="`${pfx}-expiry`" v-model="form.expiry_rate_threshold" type="number" min="0" max="1" step="0.01" class="form-input-mono" placeholder="0.05" />
          </div>
          <div>
            <label :for="`${pfx}-authfail`" class="form-label">Auth-failure-rate threshold</label>
            <input :id="`${pfx}-authfail`" v-model="form.auth_failure_rate_threshold" type="number" min="0" max="1" step="0.01" class="form-input-mono" placeholder="0.10" />
          </div>
        </div>
      </fieldset>

      <fieldset class="grid gap-3 sm:grid-cols-2">
        <legend class="form-label">Retry policy</legend>
        <div>
          <label :for="`${pfx}-retries`" class="form-label">Max retries (0–10)</label>
          <input :id="`${pfx}-retries`" v-model="form.max_retries" type="number" min="0" max="10" step="1" class="form-input-mono" placeholder="5" />
        </div>
        <div>
          <label :for="`${pfx}-initial`" class="form-label">Initial delay (ms)</label>
          <input :id="`${pfx}-initial`" v-model="form.initial_delay_ms" type="number" min="100" max="60000" step="1" class="form-input-mono" placeholder="1000" />
        </div>
        <div>
          <label :for="`${pfx}-backoff`" class="form-label">Backoff multiplier</label>
          <input :id="`${pfx}-backoff`" v-model="form.backoff_multiplier" type="number" min="1" max="10" step="0.1" class="form-input-mono" placeholder="2.0" />
        </div>
        <div>
          <label :for="`${pfx}-maxdelay`" class="form-label">Max delay (ms)</label>
          <input :id="`${pfx}-maxdelay`" v-model="form.max_delay_ms" type="number" min="1000" max="3600000" step="1" class="form-input-mono" placeholder="60000" />
        </div>
      </fieldset>
    </div>
  </div>
</template>

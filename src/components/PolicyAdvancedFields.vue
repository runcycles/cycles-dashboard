<script setup lang="ts">
// Collapsible "Advanced enforcement" editor shared by the create and
// edit policy dialogs. Surfaces the spec's caps / rate_limits /
// reservation_ttl_override / effective-window surface that previously
// could not be set from the dashboard. The parent owns a
// PolicyAdvancedForm (flat string model); this component binds to its
// fields. Conversion to the spec-shaped request lives in
// utils/policyAdvanced.ts so it's unit-testable without mounting.
import { ref } from 'vue'
import type { PolicyAdvancedForm } from '../utils/policyAdvanced'
import ChevronRightIcon from './icons/ChevronRightIcon.vue'

const props = defineProps<{
  form: PolicyAdvancedForm
  // Expand on mount (edit flow opens expanded when the policy already
  // carries advanced config so it's visible without a click).
  startOpen?: boolean
  idPrefix?: string
  // 'edit' explains the API's replacement/clear boundary.
  mode?: 'create' | 'edit'
}>()

const open = ref(!!props.startOpen)
const pfx = props.idPrefix ?? 'pol-adv'
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
      Advanced enforcement (caps, rate limits, TTL, schedule)
    </button>

    <div v-if="open" class="mt-3 space-y-4">
      <p v-if="mode === 'edit'" class="text-xs rounded px-3 py-2 bg-blue-50 text-blue-800 border border-blue-200 dark:bg-blue-950 dark:text-blue-200 dark:border-blue-800">
        Caps, rate limits, and TTL overrides use replacement semantics; clearing
        fields removes them from that group. Effective timestamps can be changed,
        but the current admin API cannot clear a timestamp once set.
      </p>
      <fieldset class="space-y-2">
        <legend class="form-label">Caps</legend>
        <div class="grid gap-3 sm:grid-cols-3">
          <div>
            <label :for="`${pfx}-max-tokens`" class="form-label">Max tokens</label>
            <input :id="`${pfx}-max-tokens`" v-model="form.max_tokens" type="number" min="0" step="1" class="form-input-mono" placeholder="—" />
          </div>
          <div>
            <label :for="`${pfx}-max-steps`" class="form-label">Max steps remaining</label>
            <input :id="`${pfx}-max-steps`" v-model="form.max_steps_remaining" type="number" min="0" step="1" class="form-input-mono" placeholder="—" />
          </div>
          <div>
            <label :for="`${pfx}-cooldown`" class="form-label">Cooldown (ms)</label>
            <input :id="`${pfx}-cooldown`" v-model="form.cooldown_ms" type="number" min="0" step="1" class="form-input-mono" placeholder="—" />
          </div>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label :for="`${pfx}-allow`" class="form-label">Tool allowlist</label>
            <textarea :id="`${pfx}-allow`" v-model="form.tool_allowlist" rows="3" class="form-input font-mono text-xs" placeholder="one tool per line"></textarea>
          </div>
          <div>
            <label :for="`${pfx}-deny`" class="form-label">Tool denylist</label>
            <textarea :id="`${pfx}-deny`" v-model="form.tool_denylist" rows="3" class="form-input font-mono text-xs" placeholder="one tool per line"></textarea>
          </div>
        </div>
      </fieldset>

      <fieldset class="grid gap-3 sm:grid-cols-2">
        <legend class="form-label">Rate limits (per minute)</legend>
        <div>
          <label :for="`${pfx}-rl-res`" class="form-label">Max reservations / min</label>
          <input :id="`${pfx}-rl-res`" v-model="form.max_reservations_per_minute" type="number" min="1" step="1" class="form-input-mono" placeholder="—" />
        </div>
        <div>
          <label :for="`${pfx}-rl-commit`" class="form-label">Max commits / min</label>
          <input :id="`${pfx}-rl-commit`" v-model="form.max_commits_per_minute" type="number" min="1" step="1" class="form-input-mono" placeholder="—" />
        </div>
      </fieldset>

      <fieldset class="grid gap-3 sm:grid-cols-3">
        <legend class="form-label">Reservation TTL override</legend>
        <div>
          <label :for="`${pfx}-ttl-default`" class="form-label">Default TTL (ms)</label>
          <input :id="`${pfx}-ttl-default`" v-model="form.default_ttl_ms" type="number" min="1000" max="86400000" step="1" class="form-input-mono" placeholder="—" />
        </div>
        <div>
          <label :for="`${pfx}-ttl-max`" class="form-label">Max TTL (ms)</label>
          <input :id="`${pfx}-ttl-max`" v-model="form.max_ttl_ms" type="number" min="1000" max="86400000" step="1" class="form-input-mono" placeholder="—" />
        </div>
        <div>
          <label :for="`${pfx}-ttl-ext`" class="form-label">Max extensions</label>
          <input :id="`${pfx}-ttl-ext`" v-model="form.max_extensions" type="number" min="0" step="1" class="form-input-mono" placeholder="—" />
        </div>
      </fieldset>

      <fieldset class="grid gap-3 sm:grid-cols-2">
        <legend class="form-label">Effective window</legend>
        <div>
          <label :for="`${pfx}-eff-from`" class="form-label">Effective from</label>
          <input :id="`${pfx}-eff-from`" v-model="form.effective_from" type="datetime-local" class="form-input" />
        </div>
        <div>
          <label :for="`${pfx}-eff-until`" class="form-label">Effective until</label>
          <input :id="`${pfx}-eff-until`" v-model="form.effective_until" type="datetime-local" class="form-input" />
        </div>
      </fieldset>
    </div>
  </div>
</template>

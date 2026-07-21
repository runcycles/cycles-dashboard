<script setup lang="ts">
import FormDialog from './FormDialog.vue'
import PolicyAdvancedFields from './PolicyAdvancedFields.vue'
import ScopeBuilder from './ScopeBuilder.vue'
import type {
  TenantPolicyCreateForm,
  TenantPolicyForm,
} from '../composables/useTenantPolicies'
import type { Policy } from '../types'
import { COMMIT_OVERAGE_POLICIES } from '../types'
import type { PolicyAdvancedForm } from '../utils/policyAdvanced'
import type { DeepReadonly } from 'vue'

defineProps<{
  tenantId: string
  showCreate: boolean
  createLoading: boolean
  createError: string
  createForm: TenantPolicyCreateForm
  createAdvanced: PolicyAdvancedForm
  editingPolicy: DeepReadonly<Policy> | null
  editLoading: boolean
  editError: string
  editForm: TenantPolicyForm
  editAdvanced: PolicyAdvancedForm
  editHasAdvanced: boolean
}>()

defineEmits<{
  submitCreate: []
  cancelCreate: []
  submitEdit: []
  cancelEdit: []
}>()

function isKnownCommitOveragePolicy(value: string | undefined): boolean {
  return !value || COMMIT_OVERAGE_POLICIES.some(policy => policy === value)
}
</script>

<template>
  <FormDialog
    v-if="showCreate"
    wide
    title="Create Policy"
    submit-label="Create"
    :loading="createLoading"
    :error="createError"
    @submit="$emit('submitCreate')"
    @cancel="$emit('cancelCreate')"
  >
    <div>
      <label for="cp-name" class="form-label">Name</label>
      <input id="cp-name" v-model="createForm.name" required maxlength="256" class="form-input" />
    </div>
    <fieldset>
      <legend class="form-label">Scope pattern</legend>
      <ScopeBuilder v-model="createForm.scope_pattern" :tenant-id="tenantId" allow-wildcards />
    </fieldset>
    <div>
      <label for="cp-desc" class="form-label">Description (optional)</label>
      <input id="cp-desc" v-model="createForm.description" maxlength="1024" class="form-input" />
    </div>
    <div>
      <label for="cp-priority" class="form-label">Priority (higher wins on overlap)</label>
      <input id="cp-priority" v-model="createForm.priority" type="number" min="0" step="1" class="form-input-mono" placeholder="0" />
    </div>
    <div>
      <label for="cp-cop" class="form-label">Commit overage policy (optional)</label>
      <select id="cp-cop" v-model="createForm.commit_overage_policy" class="form-select w-full">
        <option value="">— Default —</option>
        <option v-for="policy in COMMIT_OVERAGE_POLICIES" :key="policy" :value="policy">{{ policy }}</option>
      </select>
    </div>
    <PolicyAdvancedFields :form="createAdvanced" id-prefix="cp-adv" mode="create" />
  </FormDialog>

  <FormDialog
    v-if="editingPolicy"
    wide
    title="Edit Policy"
    submit-label="Save Changes"
    :loading="editLoading"
    :error="editError"
    @submit="$emit('submitEdit')"
    @cancel="$emit('cancelEdit')"
  >
    <div>
      <label for="ep-name" class="form-label">Name</label>
      <input id="ep-name" v-model="editForm.name" required maxlength="256" class="form-input" />
    </div>
    <div>
      <span class="form-label">Scope pattern</span>
      <p data-testid="policy-scope-readonly" class="form-input-mono bg-gray-50 dark:bg-gray-800 break-all">
        {{ editingPolicy.scope_pattern }}
      </p>
      <p class="muted-sm mt-1">Scope patterns are immutable after policy creation.</p>
    </div>
    <div>
      <label for="ep-desc" class="form-label">Description (optional)</label>
      <input id="ep-desc" v-model="editForm.description" maxlength="1024" class="form-input" />
      <p class="muted-sm mt-1">Leave empty to clear the current description.</p>
    </div>
    <div>
      <label for="ep-priority" class="form-label">Priority</label>
      <input
        id="ep-priority"
        v-model="editForm.priority"
        type="number"
        :min="editingPolicy.priority !== undefined && editingPolicy.priority < 0 ? undefined : 0"
        :aria-describedby="editingPolicy.priority !== undefined && editingPolicy.priority < 0 ? 'ep-priority-legacy-help' : undefined"
        step="1"
        class="form-input-mono"
      />
      <p
        v-if="editingPolicy.priority !== undefined && editingPolicy.priority < 0"
        id="ep-priority-legacy-help"
        data-testid="legacy-priority-warning"
        class="mt-1 text-xs text-amber-700 dark:text-amber-300"
      >
        This legacy priority may remain unchanged, but any replacement must be 0 or greater.
      </p>
    </div>
    <div>
      <label for="ep-cop" class="form-label">Commit overage policy</label>
      <select id="ep-cop" v-model="editForm.commit_overage_policy" class="form-select w-full">
        <option value="" :disabled="!!editingPolicy.commit_overage_policy">— No policy override —</option>
        <option
          v-if="editingPolicy.commit_overage_policy && !isKnownCommitOveragePolicy(editingPolicy.commit_overage_policy)"
          :value="editingPolicy.commit_overage_policy"
        >
          {{ editingPolicy.commit_overage_policy }} (current server value)
        </option>
        <option v-for="policy in COMMIT_OVERAGE_POLICIES" :key="policy" :value="policy">{{ policy }}</option>
      </select>
      <p v-if="editingPolicy.commit_overage_policy" class="muted-sm mt-1">
        The current admin API can replace this override, but cannot clear it.
      </p>
    </div>
    <PolicyAdvancedFields
      :form="editAdvanced"
      :start-open="editHasAdvanced"
      id-prefix="ep-adv"
      mode="edit"
    />
  </FormDialog>
</template>

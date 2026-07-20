<script setup lang="ts">
import type { ApiKey, ApiKeyCreateResponse } from '../types'
import type {
  TenantApiKeyCreateForm,
  TenantApiKeyEditForm,
} from '../composables/useTenantApiKeys'
import { formatDateTime } from '../utils/format'
import ConfirmAction from './ConfirmAction.vue'
import FormDialog from './FormDialog.vue'
import PermissionPicker from './PermissionPicker.vue'
import SecretReveal from './SecretReveal.vue'

defineProps<{
  pendingRevoke: ApiKey | null
  revokeLoading: boolean
  revokeError: string
  showCreate: boolean
  createLoading: boolean
  createError: string
  createForm: TenantApiKeyCreateForm
  createdSecret: ApiKeyCreateResponse | null
  editingKey: ApiKey | null
  editLoading: boolean
  editError: string
  editForm: TenantApiKeyEditForm
  pendingPermissionAdds: string[]
  pendingPermissionRemoves: string[]
}>()

defineEmits<{
  confirmRevoke: []
  cancelRevoke: []
  submitCreate: []
  cancelCreate: []
  closeCreatedSecret: []
  submitEdit: []
  cancelEdit: []
}>()
</script>

<template>
  <ConfirmAction
    v-if="pendingRevoke"
    title="Revoke this API key?"
    :message="`Revoking key '${pendingRevoke.name || pendingRevoke.key_id}' will immediately invalidate it. Any services using this key will lose access. This cannot be undone.`"
    confirm-label="Revoke Key"
    :danger="true"
    :loading="revokeLoading"
    :error="revokeError"
    @confirm="$emit('confirmRevoke')"
    @cancel="$emit('cancelRevoke')"
  />

  <FormDialog
    v-if="showCreate"
    title="Create API Key"
    submit-label="Create Key"
    :loading="createLoading"
    :error="createError"
    @submit="$emit('submitCreate')"
    @cancel="$emit('cancelCreate')"
  >
    <div>
      <label for="ck2-name" class="form-label">Name</label>
      <input
        id="ck2-name"
        v-model="createForm.name"
        required
        maxlength="256"
        class="form-input"
        placeholder="my-service-key"
      />
    </div>
    <fieldset>
      <legend class="form-label">Permissions</legend>
      <PermissionPicker v-model="createForm.permissions" />
    </fieldset>
    <div>
      <label for="ck2-scope" class="form-label">Scope filter (comma-separated, optional)</label>
      <input
        id="ck2-scope"
        v-model="createForm.scope_filter"
        class="form-input-mono"
      />
    </div>
    <div>
      <label for="ck2-expires" class="form-label">Expires at (optional)</label>
      <input
        id="ck2-expires"
        v-model="createForm.expires_at"
        type="datetime-local"
        class="form-input"
      />
    </div>
  </FormDialog>

  <SecretReveal
    v-if="createdSecret"
    title="API Key Created"
    :secret="createdSecret.key_secret"
    label="API Key Secret"
    @close="$emit('closeCreatedSecret')"
  />

  <!-- The diff chips describe the exact PATCH shape before submission. -->
  <FormDialog
    v-if="editingKey"
    title="Edit API Key"
    submit-label="Save Changes"
    :loading="editLoading"
    :error="editError"
    @submit="$emit('submitEdit')"
    @cancel="$emit('cancelEdit')"
  >
    <div>
      <label for="ek2-name" class="form-label">Name</label>
      <input
        id="ek2-name"
        v-model="editForm.name"
        required
        maxlength="256"
        class="form-input"
      />
    </div>
    <fieldset>
      <legend class="form-label">Permissions</legend>
      <PermissionPicker v-model="editForm.permissions" />
      <div
        v-if="pendingPermissionAdds.length || pendingPermissionRemoves.length"
        class="mt-2 text-xs flex flex-wrap gap-1 items-center"
        aria-live="polite"
      >
        <template v-if="pendingPermissionAdds.length">
          <span class="text-green-700 dark:text-green-300 font-medium">Adding:</span>
          <span
            v-for="permission in pendingPermissionAdds"
            :key="`add:${permission}`"
            class="bg-green-50 text-green-700 border border-green-200 dark:bg-green-950 dark:text-green-300 dark:border-green-800 rounded px-1.5 py-0.5 font-mono"
          >+{{ permission }}</span>
        </template>
        <template v-if="pendingPermissionRemoves.length">
          <span
            class="text-red-700 dark:text-red-300 font-medium"
            :class="pendingPermissionAdds.length ? 'ml-3' : ''"
          >Removing:</span>
          <span
            v-for="permission in pendingPermissionRemoves"
            :key="`remove:${permission}`"
            class="bg-red-50 text-red-700 border border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800 rounded px-1.5 py-0.5 font-mono"
          >−{{ permission }}</span>
        </template>
      </div>
    </fieldset>
    <div>
      <label for="ek2-scope" class="form-label">Scope filter (comma-separated)</label>
      <input
        id="ek2-scope"
        v-model="editForm.scope_filter"
        class="form-input-mono"
      />
    </div>
    <div>
      <span class="form-label">Expires at</span>
      <p class="text-sm text-gray-700 dark:text-gray-200">
        {{ editingKey.expires_at ? formatDateTime(editingKey.expires_at) : 'Never' }}
      </p>
      <p class="muted-sm mt-0.5">Expiry is immutable — revoke and recreate the key to change it.</p>
    </div>
  </FormDialog>
</template>

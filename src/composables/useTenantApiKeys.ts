import { computed, readonly, ref, type Ref } from 'vue'
import {
  createApiKey as createApiKeyDefault,
  revokeApiKey as revokeApiKeyDefault,
  updateApiKey as updateApiKeyDefault,
} from '../api/client'
import type {
  ApiKey,
  ApiKeyCreateRequest,
  ApiKeyCreateResponse,
  ApiKeyUpdateRequest,
} from '../types'
import { PERMISSIONS } from '../types'
import { toMessage } from '../utils/errors'
import type { TenantDetailRefreshResult } from './useTenantDetailData'

export interface TenantApiKeyCreateForm {
  name: string
  permissions: string[]
  scope_filter: string
  expires_at: string
}

export interface TenantApiKeyEditForm {
  name: string
  permissions: string[]
  scope_filter: string
}

export interface TenantApiKeyNotifications {
  success: (message: string) => void
  warning: (message: string) => void
  error: (message: string) => void
}

export interface UseTenantApiKeysOptions {
  tenantId: string
  apiKeys: Readonly<Ref<ApiKey[]>>
  error: Readonly<Ref<string>>
  refreshApiKeys: () => Promise<TenantDetailRefreshResult>
  /** Supersede reads before the first write enters the API client. */
  beginMutation: () => void
  /** Publish an authoritative update/revoke response before settlement. */
  commitApiKey: (key: ApiKey) => void
  notify: TenantApiKeyNotifications
  /** Refuse to arm an API-key surface while a sibling owner is armed. */
  canArm?: () => boolean
  /** Focused dependency seams for deterministic protocol tests. */
  create?: typeof createApiKeyDefault
  update?: typeof updateApiKeyDefault
  revoke?: typeof revokeApiKeyDefault
}

const EMPTY_CREATE_FORM = (): TenantApiKeyCreateForm => ({
  name: '',
  permissions: [],
  scope_filter: '',
  expires_at: '',
})

const EMPTY_EDIT_FORM = (): TenantApiKeyEditForm => ({
  name: '',
  permissions: [],
  scope_filter: '',
})

function commaSeparatedValues(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function sameStringSet(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) return false
  const leftValues = new Set(left)
  return right.every(value => leftValues.has(value))
}

/**
 * Owns Tenant Detail's API-key mutation protocol and one-time secret state.
 *
 * The view retains the key table, activity/copy actions, and capability gate.
 * This owner serializes create/edit/revoke surfaces, rejects direct duplicate
 * calls, invalidates older reads before writes, publishes authoritative PATCH
 * responses, and keeps polling excluded through mutation-owned settlement.
 */
export function useTenantApiKeys(options: UseTenantApiKeysOptions) {
  const pendingRevokeState = ref<ApiKey | null>(null)
  const pendingRevoke = computed(() => pendingRevokeState.value)
  const revokeLoading = ref(false)
  const revokeError = ref('')

  const showCreateState = ref(false)
  const showCreate = computed(() => showCreateState.value)
  const createLoading = ref(false)
  const createError = ref('')
  const createForm = ref<TenantApiKeyCreateForm>(EMPTY_CREATE_FORM())
  const createdSecretState = ref<ApiKeyCreateResponse | null>(null)
  const createdSecret = computed(() => createdSecretState.value)

  const editingKeyState = ref<ApiKey | null>(null)
  const editingKey = computed(() => editingKeyState.value)
  const editLoading = ref(false)
  const editError = ref('')
  const editForm = ref<TenantApiKeyEditForm>(EMPTY_EDIT_FORM())

  const settling = ref(false)
  const isMutationRunning = computed(() => (
    revokeLoading.value || createLoading.value || editLoading.value || settling.value
  ))
  const ownerArmed = computed(() => (
    isMutationRunning.value
    || pendingRevokeState.value !== null
    || showCreateState.value
    || createdSecretState.value !== null
    || editingKeyState.value !== null
  ))

  const pendingPermissionAdds = computed<string[]>(() => {
    const original = editingKeyState.value
    if (!original) return []
    const originalValues = new Set(original.permissions ?? [])
    return editForm.value.permissions.filter(permission => !originalValues.has(permission))
  })
  const pendingPermissionRemoves = computed<string[]>(() => {
    const original = editingKeyState.value
    if (!original) return []
    const currentValues = new Set(editForm.value.permissions)
    return (original.permissions ?? []).filter(permission => !currentValues.has(permission))
  })

  function canOpenSurface(): boolean {
    return !ownerArmed.value && options.canArm?.() !== false
  }

  function externalGateStillAllowsAction(): boolean {
    return options.canArm?.() !== false
  }

  function warnRefreshSettlement(
    result: TenantDetailRefreshResult,
    committedLabel: string,
  ): void {
    if (result === 'applied') return
    if (result === 'failed') {
      options.notify.warning(`${committedLabel}, but refresh failed: ${options.error.value}`)
    } else {
      options.notify.warning(`${committedLabel}; its refresh was superseded by a newer view update`)
    }
  }

  async function settleRefresh(committedLabel: string): Promise<void> {
    try {
      warnRefreshSettlement(await options.refreshApiKeys(), committedLabel)
    } catch (cause) {
      // refreshApiKeys owns errors and normally resolves to a settlement enum.
      // Keep committed writes terminal even if a future/custom seam violates
      // that contract: closing the dialog must never invite a duplicate write.
      options.notify.warning(
        `${committedLabel}, but refresh failed: ${toMessage(cause)}`,
      )
    }
  }

  function requestRevoke(key: ApiKey): boolean {
    if (
      !canOpenSurface()
      || key.tenant_id !== options.tenantId
      || key.status !== 'ACTIVE'
    ) return false
    revokeError.value = ''
    pendingRevokeState.value = key
    return true
  }

  function cancelRevoke(): void {
    if (revokeLoading.value) return
    pendingRevokeState.value = null
    revokeError.value = ''
  }

  async function executeRevoke(): Promise<boolean> {
    const pending = pendingRevokeState.value
    // Keep the guard before visible error/loading mutation so a re-entrant
    // call cannot clear the first request's error or send a second write.
    if (!pending || revokeLoading.value) return false
    if (!externalGateStillAllowsAction()) {
      revokeError.value = 'Revocation is no longer available. Refresh and review the tenant state.'
      return false
    }
    const current = options.apiKeys.value.find(key => key.key_id === pending.key_id)
    if (
      !current
      || current.tenant_id !== options.tenantId
      || current.status !== 'ACTIVE'
    ) {
      revokeError.value = 'This API key is no longer active. Refresh and review its current state.'
      return false
    }

    revokeError.value = ''
    revokeLoading.value = true
    options.beginMutation()
    try {
      let updated: ApiKey
      try {
        updated = await (options.revoke ?? revokeApiKeyDefault)(
          pending.key_id,
          'Revoked via admin dashboard',
        )
      } catch (cause) {
        const message = toMessage(cause)
        revokeError.value = message
        options.notify.error(`Revoke failed: ${message}`)
        return false
      }

      options.commitApiKey(updated)
      pendingRevokeState.value = null
      options.notify.success('API key revoked')
      settling.value = true
      try {
        await settleRefresh('API key revoked')
      } finally {
        settling.value = false
      }
      return true
    } finally {
      revokeLoading.value = false
    }
  }

  function openCreate(): boolean {
    if (!canOpenSurface()) return false
    createForm.value = EMPTY_CREATE_FORM()
    createError.value = ''
    showCreateState.value = true
    return true
  }

  function cancelCreate(): void {
    if (createLoading.value) return
    showCreateState.value = false
    createError.value = ''
  }

  async function submitCreate(): Promise<boolean> {
    if (!showCreateState.value || createLoading.value) return false
    if (!externalGateStillAllowsAction()) {
      createError.value = 'API-key creation is no longer available. Refresh and review the tenant state.'
      return false
    }
    const form = createForm.value
    if (!form.name.trim()) {
      createError.value = 'Name is required.'
      return false
    }

    const body: ApiKeyCreateRequest = {
      tenant_id: options.tenantId,
      name: form.name,
    }
    if (form.permissions.length) body.permissions = [...form.permissions]
    if (form.scope_filter.trim()) body.scope_filter = commaSeparatedValues(form.scope_filter)
    if (form.expires_at) {
      const expiry = new Date(form.expires_at)
      if (!Number.isFinite(expiry.getTime())) {
        createError.value = 'Expires at must be a valid date and time.'
        return false
      }
      body.expires_at = expiry.toISOString()
    }

    createError.value = ''
    createLoading.value = true
    options.beginMutation()
    try {
      try {
        createdSecretState.value = await (options.create ?? createApiKeyDefault)(body)
      } catch (cause) {
        createError.value = toMessage(cause)
        return false
      }
      showCreateState.value = false
      return true
    } finally {
      createLoading.value = false
    }
  }

  async function closeCreatedSecret(): Promise<boolean> {
    if (!createdSecretState.value || settling.value) return false
    // Secret confirmation is terminal: clear it synchronously, then keep the
    // owner/polling gate alive through the refresh settlement.
    settling.value = true
    createdSecretState.value = null
    try {
      await settleRefresh('API key created')
      return true
    } finally {
      settling.value = false
    }
  }

  function openEdit(key: ApiKey): boolean {
    if (
      !canOpenSurface()
      || key.tenant_id !== options.tenantId
      || key.status !== 'ACTIVE'
    ) return false

    // The update schema has a closed permission enum. Drop legacy stored
    // values before diffing so a deliberate save can heal the row instead of
    // round-tripping an invalid value and receiving a 400.
    const allowed = new Set<string>(PERMISSIONS as readonly string[])
    const stored = key.permissions ?? []
    const dropped = stored.filter(permission => !allowed.has(permission))
    editForm.value = {
      name: key.name ?? '',
      permissions: stored.filter(permission => allowed.has(permission)),
      scope_filter: key.scope_filter?.join(', ') ?? '',
    }
    editError.value = ''
    editingKeyState.value = key
    if (dropped.length) {
      options.notify.warning(
        `Unrecognized permissions will be removed on save: ${dropped.join(', ')}`,
      )
    }
    return true
  }

  function cancelEdit(): void {
    if (editLoading.value) return
    editingKeyState.value = null
    editError.value = ''
  }

  async function submitEdit(): Promise<boolean> {
    const original = editingKeyState.value
    if (!original || editLoading.value) return false
    if (!externalGateStillAllowsAction()) {
      editError.value = 'Editing is no longer available. Refresh and review the tenant state.'
      return false
    }
    const current = options.apiKeys.value.find(key => key.key_id === original.key_id)
    if (
      !current
      || current.tenant_id !== options.tenantId
      || current.status !== 'ACTIVE'
    ) {
      editError.value = 'This API key is no longer active. Refresh and review its current state.'
      return false
    }
    if (!editForm.value.name.trim()) {
      editError.value = 'Name is required.'
      return false
    }

    const body: ApiKeyUpdateRequest = {}
    if (editForm.value.name !== (original.name ?? '')) body.name = editForm.value.name
    if (!sameStringSet(editForm.value.permissions, original.permissions)) {
      body.permissions = [...editForm.value.permissions]
    }
    const scopes = editForm.value.scope_filter.trim()
      ? commaSeparatedValues(editForm.value.scope_filter)
      : []
    if (!sameStringSet(scopes, original.scope_filter)) body.scope_filter = scopes
    // expires_at is intentionally absent: immutable per the update schema.
    if (Object.keys(body).length === 0) {
      editingKeyState.value = null
      return true
    }

    editError.value = ''
    editLoading.value = true
    options.beginMutation()
    try {
      try {
        const updated = await (options.update ?? updateApiKeyDefault)(original.key_id, body)
        options.commitApiKey(updated)
      } catch (cause) {
        editError.value = toMessage(cause)
        return false
      }

      editingKeyState.value = null
      options.notify.success('API key updated')
      settling.value = true
      try {
        await settleRefresh('API key updated')
      } finally {
        settling.value = false
      }
      return true
    } finally {
      editLoading.value = false
    }
  }

  return {
    ownerArmed,
    isMutationRunning,
    pendingRevoke,
    revokeLoading: readonly(revokeLoading),
    revokeError: readonly(revokeError),
    requestRevoke,
    cancelRevoke,
    executeRevoke,
    showCreate,
    createLoading: readonly(createLoading),
    createError: readonly(createError),
    createForm,
    createdSecret,
    openCreate,
    cancelCreate,
    submitCreate,
    closeCreatedSecret,
    editingKey,
    editLoading: readonly(editLoading),
    editError: readonly(editError),
    editForm,
    pendingPermissionAdds,
    pendingPermissionRemoves,
    openEdit,
    cancelEdit,
    submitEdit,
  }
}

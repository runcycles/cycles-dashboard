import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import {
  useTenantApiKeys,
  type UseTenantApiKeysOptions,
} from '../composables/useTenantApiKeys'
import type { ApiKey, ApiKeyCreateResponse } from '../types'

function key(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    key_id: 'key-1',
    tenant_id: 'acme',
    key_prefix: 'cyc_key-1',
    name: 'Worker',
    status: 'ACTIVE',
    permissions: ['budgets:read'],
    scope_filter: ['tenant:acme/*'],
    created_at: '2026-07-20T00:00:00Z',
    ...overrides,
  }
}

function created(): ApiKeyCreateResponse {
  return {
    key_id: 'key-2',
    key_secret: 'secret-once',
    key_prefix: 'cyc_key-2',
    tenant_id: 'acme',
    permissions: ['budgets:read'],
    created_at: '2026-07-20T01:00:00Z',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(overrides: Partial<UseTenantApiKeysOptions> = {}) {
  const apiKeys = ref<ApiKey[]>([key()])
  const error = ref('')
  const refreshApiKeys = vi.fn().mockResolvedValue('applied')
  const beginMutation = vi.fn()
  const commitApiKey = vi.fn((next: ApiKey) => {
    apiKeys.value = apiKeys.value.map(current => current.key_id === next.key_id ? next : current)
  })
  const notify = {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
  const create = vi.fn().mockResolvedValue(created())
  const update = vi.fn().mockResolvedValue(key({ name: 'Updated worker' }))
  const revoke = vi.fn().mockResolvedValue(key({ status: 'REVOKED' }))

  const options: UseTenantApiKeysOptions = {
    tenantId: 'acme',
    apiKeys,
    error,
    refreshApiKeys,
    beginMutation,
    commitApiKey,
    notify,
    create,
    update,
    revoke,
    ...overrides,
  }

  return {
    keys: useTenantApiKeys(options),
    apiKeys,
    error,
    refreshApiKeys,
    beginMutation,
    commitApiKey,
    notify,
    create,
    update,
    revoke,
  }
}

describe('useTenantApiKeys', () => {
  it('refuses invalid rows, sibling-blocked arming, and overlapping surfaces', () => {
    const blocked = setup({ canArm: () => false })
    const state = setup()

    expect(blocked.keys.openCreate()).toBe(false)
    expect(state.keys.requestRevoke(key({ tenant_id: 'other' }))).toBe(false)
    expect(state.keys.openEdit(key({ status: 'REVOKED' }))).toBe(false)
    expect(state.keys.openCreate()).toBe(true)
    expect(state.keys.ownerArmed.value).toBe(true)
    expect(state.keys.openEdit(key())).toBe(false)
    expect(state.keys.requestRevoke(key())).toBe(false)

    state.keys.cancelCreate()
    expect(state.keys.ownerArmed.value).toBe(false)
    expect(state.keys.requestRevoke(state.apiKeys.value[0])).toBe(true)
    state.keys.cancelRevoke()
    expect(state.keys.pendingRevoke.value).toBeNull()
  })

  it('validates create name and expiry before acquiring mutation ownership', async () => {
    const state = setup()
    state.keys.openCreate()

    await expect(state.keys.submitCreate()).resolves.toBe(false)
    expect(state.keys.createError.value).toBe('Name is required.')
    state.keys.createForm.value.name = 'Worker'
    state.keys.createForm.value.expires_at = 'not-a-date'
    await expect(state.keys.submitCreate()).resolves.toBe(false)
    expect(state.keys.createError.value).toBe('Expires at must be a valid date and time.')
    expect(state.beginMutation).not.toHaveBeenCalled()
    expect(state.create).not.toHaveBeenCalled()
  })

  it('snapshots the create request, blocks duplicate submits, and owns the secret settlement', async () => {
    const state = setup()
    const request = deferred<ApiKeyCreateResponse>()
    state.create.mockReturnValueOnce(request.promise)
    state.keys.openCreate()
    state.keys.createForm.value = {
      name: 'Worker',
      permissions: ['budgets:read'],
      scope_filter: ' tenant:acme/*, tenant:acme/agent:worker ',
      expires_at: '2026-07-21T09:30',
    }

    const first = state.keys.submitCreate()
    expect(state.keys.isMutationRunning.value).toBe(true)
    await expect(state.keys.submitCreate()).resolves.toBe(false)
    state.keys.cancelCreate()
    expect(state.keys.showCreate.value).toBe(true)
    state.keys.createForm.value.permissions.push('budgets:write')
    request.resolve(created())
    await expect(first).resolves.toBe(true)

    expect(state.beginMutation).toHaveBeenCalledOnce()
    expect(state.create).toHaveBeenCalledWith({
      tenant_id: 'acme',
      name: 'Worker',
      permissions: ['budgets:read'],
      scope_filter: ['tenant:acme/*', 'tenant:acme/agent:worker'],
      expires_at: new Date('2026-07-21T09:30').toISOString(),
    })
    expect(state.keys.showCreate.value).toBe(false)
    expect(state.keys.createdSecret.value?.key_secret).toBe('secret-once')
    expect(state.keys.ownerArmed.value).toBe(true)

    const refresh = deferred<'applied'>()
    state.refreshApiKeys.mockReturnValueOnce(refresh.promise)
    const closing = state.keys.closeCreatedSecret()
    expect(state.keys.createdSecret.value).toBeNull()
    expect(state.keys.isMutationRunning.value).toBe(true)
    await expect(state.keys.closeCreatedSecret()).resolves.toBe(false)
    refresh.resolve('applied')
    await expect(closing).resolves.toBe(true)
    expect(state.keys.ownerArmed.value).toBe(false)
  })

  it('keeps the create dialog retryable when the request fails', async () => {
    const state = setup()
    state.create.mockRejectedValueOnce(new Error('create unavailable'))
    state.keys.openCreate()
    state.keys.createForm.value.name = 'Worker'

    await expect(state.keys.submitCreate()).resolves.toBe(false)

    expect(state.keys.showCreate.value).toBe(true)
    expect(state.keys.createError.value).toBe('create unavailable')
    expect(state.keys.createdSecret.value).toBeNull()
  })

  it('heals legacy permissions and sends only the intended edit diff', async () => {
    const original = key({
      permissions: ['budgets:read', 'legacy:unknown'],
      scope_filter: ['tenant:acme/*'],
    })
    const state = setup()
    state.apiKeys.value = [original]

    expect(state.keys.openEdit(original)).toBe(true)
    expect(state.keys.editForm.value.permissions).toEqual(['budgets:read'])
    expect(state.notify.warning).toHaveBeenCalledWith(
      'Unrecognized permissions will be removed on save: legacy:unknown',
    )
    state.keys.editForm.value.name = 'Renamed worker'
    state.keys.editForm.value.permissions.push('budgets:write')
    state.keys.editForm.value.scope_filter = 'tenant:acme/*, tenant:acme/agent:worker'
    expect(state.keys.pendingPermissionAdds.value).toEqual(['budgets:write'])
    expect(state.keys.pendingPermissionRemoves.value).toEqual(['legacy:unknown'])

    await expect(state.keys.submitEdit()).resolves.toBe(true)

    expect(state.beginMutation).toHaveBeenCalledOnce()
    expect(state.update).toHaveBeenCalledWith('key-1', {
      name: 'Renamed worker',
      permissions: ['budgets:read', 'budgets:write'],
      scope_filter: ['tenant:acme/*', 'tenant:acme/agent:worker'],
    })
    expect(state.commitApiKey).toHaveBeenCalledBefore(state.refreshApiKeys)
    expect(state.keys.editingKey.value).toBeNull()
    expect(state.notify.success).toHaveBeenCalledWith('API key updated')
  })

  it('closes a no-change edit without issuing a write', async () => {
    const state = setup()
    state.keys.openEdit(state.apiKeys.value[0])

    await expect(state.keys.submitEdit()).resolves.toBe(true)

    expect(state.update).not.toHaveBeenCalled()
    expect(state.beginMutation).not.toHaveBeenCalled()
    expect(state.refreshApiKeys).not.toHaveBeenCalled()
    expect(state.keys.editingKey.value).toBeNull()
  })

  it('refuses an edit when the live row became terminal after arming', async () => {
    const state = setup()
    state.keys.openEdit(state.apiKeys.value[0])
    state.keys.editForm.value.name = 'Renamed worker'
    state.apiKeys.value = [key({ status: 'EXPIRED' })]

    await expect(state.keys.submitEdit()).resolves.toBe(false)

    expect(state.keys.editError.value).toContain('no longer active')
    expect(state.update).not.toHaveBeenCalled()
    expect(state.keys.editingKey.value).not.toBeNull()
  })

  it('validates edit names before mutation and supports a guarded normal cancel', async () => {
    const state = setup()
    state.keys.openEdit(state.apiKeys.value[0])
    state.keys.editForm.value.name = '   '

    await expect(state.keys.submitEdit()).resolves.toBe(false)
    expect(state.keys.editError.value).toBe('Name is required.')
    expect(state.beginMutation).not.toHaveBeenCalled()
    state.keys.cancelEdit()
    expect(state.keys.editingKey.value).toBeNull()
    expect(state.keys.editError.value).toBe('')
  })

  it('guards an in-flight edit and keeps failures in the dialog', async () => {
    const state = setup()
    const request = deferred<ApiKey>()
    state.update.mockReturnValueOnce(request.promise)
    state.keys.openEdit(state.apiKeys.value[0])
    state.keys.editForm.value.name = 'Renamed worker'

    const first = state.keys.submitEdit()
    await expect(state.keys.submitEdit()).resolves.toBe(false)
    state.keys.cancelEdit()
    expect(state.keys.editingKey.value).not.toBeNull()
    request.reject(new Error('update unavailable'))
    await expect(first).resolves.toBe(false)

    expect(state.update).toHaveBeenCalledOnce()
    expect(state.keys.editError.value).toBe('update unavailable')
    expect(state.keys.editingKey.value).not.toBeNull()
  })

  it('publishes revoke responses before refresh and blocks cancellation in flight', async () => {
    const state = setup()
    const request = deferred<ApiKey>()
    const refresh = deferred<'applied'>()
    state.revoke.mockReturnValueOnce(request.promise)
    state.refreshApiKeys.mockReturnValueOnce(refresh.promise)
    state.keys.requestRevoke(state.apiKeys.value[0])

    const mutation = state.keys.executeRevoke()
    state.keys.cancelRevoke()
    expect(state.keys.pendingRevoke.value).not.toBeNull()
    await expect(state.keys.executeRevoke()).resolves.toBe(false)
    request.resolve(key({ status: 'REVOKED' }))
    await Promise.resolve()

    expect(state.commitApiKey).toHaveBeenCalledOnce()
    expect(state.apiKeys.value[0].status).toBe('REVOKED')
    expect(state.keys.pendingRevoke.value).toBeNull()
    expect(state.keys.isMutationRunning.value).toBe(true)
    refresh.resolve('applied')
    await expect(mutation).resolves.toBe(true)
    expect(state.revoke).toHaveBeenCalledWith('key-1', 'Revoked via admin dashboard')
    expect(state.notify.success).toHaveBeenCalledWith('API key revoked')
  })

  it('keeps revoke failures retryable with inline and toast feedback', async () => {
    const state = setup()
    state.revoke.mockRejectedValueOnce(new Error('revoke unavailable'))
    state.keys.requestRevoke(state.apiKeys.value[0])

    await expect(state.keys.executeRevoke()).resolves.toBe(false)

    expect(state.keys.pendingRevoke.value).not.toBeNull()
    expect(state.keys.revokeError.value).toBe('revoke unavailable')
    expect(state.notify.error).toHaveBeenCalledWith('Revoke failed: revoke unavailable')
  })

  it('refuses revoke when the live row became terminal after confirmation', async () => {
    const state = setup()
    state.keys.requestRevoke(state.apiKeys.value[0])
    state.apiKeys.value = [key({ status: 'REVOKED' })]

    await expect(state.keys.executeRevoke()).resolves.toBe(false)
    expect(state.keys.revokeError.value).toContain('no longer active')
    expect(state.revoke).not.toHaveBeenCalled()
  })

  it('warns distinctly when committed settlement fails or is superseded', async () => {
    const failed = setup()
    failed.error.value = 'key read failed'
    failed.refreshApiKeys.mockResolvedValueOnce('failed')
    failed.keys.openEdit(failed.apiKeys.value[0])
    failed.keys.editForm.value.name = 'Renamed worker'
    await failed.keys.submitEdit()
    expect(failed.notify.warning).toHaveBeenCalledWith(
      'API key updated, but refresh failed: key read failed',
    )

    const superseded = setup()
    superseded.refreshApiKeys.mockResolvedValueOnce('superseded')
    superseded.keys.openEdit(superseded.apiKeys.value[0])
    superseded.keys.editForm.value.name = 'Renamed worker'
    await superseded.keys.submitEdit()
    expect(superseded.notify.warning).toHaveBeenCalledWith(
      'API key updated; its refresh was superseded by a newer view update',
    )

    const throwing = setup()
    throwing.refreshApiKeys.mockRejectedValueOnce(new Error('refresh crashed'))
    throwing.keys.openEdit(throwing.apiKeys.value[0])
    throwing.keys.editForm.value.name = 'Renamed worker'
    await expect(throwing.keys.submitEdit()).resolves.toBe(true)
    expect(throwing.keys.editingKey.value).toBeNull()
    expect(throwing.notify.warning).toHaveBeenCalledWith(
      'API key updated, but refresh failed: refresh crashed',
    )
  })
})

import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import {
  useTenantPolicies,
  type UseTenantPoliciesOptions,
} from '../composables/useTenantPolicies'
import type { Policy, Tenant } from '../types'

function tenant(status = 'ACTIVE'): Tenant {
  return {
    tenant_id: 'acme',
    name: 'Acme',
    status,
    created_at: '2026-07-20T00:00:00Z',
  }
}

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    policy_id: 'policy-1',
    name: 'Engineering policy',
    description: 'Current description',
    scope_pattern: 'tenant:acme/workspace:eng/*',
    status: 'ACTIVE',
    priority: 10,
    commit_overage_policy: 'REJECT',
    caps: { max_tokens: 1000 },
    rate_limits: { max_commits_per_minute: 20 },
    reservation_ttl_override: { default_ttl_ms: 5000 },
    effective_from: '2026-07-20T12:00:00Z',
    created_at: '2026-07-20T00:00:00Z',
    updated_at: '2026-07-20T01:00:00Z',
    ...overrides,
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

function setup(overrides: Partial<UseTenantPoliciesOptions> = {}) {
  const tenantRef = ref<Tenant | null>(tenant())
  const policies = ref<Policy[]>([policy()])
  const error = ref('')
  const refreshPolicies = vi.fn().mockResolvedValue('applied')
  const beginMutation = vi.fn()
  const commitPolicy = vi.fn((next: Policy) => {
    const index = policies.value.findIndex(item => item.policy_id === next.policy_id)
    policies.value = index < 0
      ? [next, ...policies.value]
      : policies.value.map((item, itemIndex) => itemIndex === index ? next : item)
  })
  const notify = { success: vi.fn(), warning: vi.fn() }
  const create = vi.fn().mockResolvedValue(policy({ policy_id: 'policy-2', name: 'Created' }))
  const update = vi.fn().mockResolvedValue(policy({ name: 'Updated' }))
  const options: UseTenantPoliciesOptions = {
    tenantId: 'acme',
    tenant: tenantRef,
    policies,
    error,
    refreshPolicies,
    beginMutation,
    commitPolicy,
    notify,
    create,
    update,
    ...overrides,
  }
  return {
    policies: useTenantPolicies(options),
    tenant: tenantRef,
    policyRows: policies,
    error,
    refreshPolicies,
    beginMutation,
    commitPolicy,
    notify,
    create,
    update,
  }
}

describe('useTenantPolicies', () => {
  it('refuses closed/sibling-blocked arming and overlapping surfaces', () => {
    const closed = setup()
    closed.tenant.value = tenant('CLOSED')
    expect(closed.policies.openCreate()).toBe(false)
    expect(closed.policies.openEdit(closed.policyRows.value[0])).toBe(false)

    const blocked = setup({ canArm: () => false })
    expect(blocked.policies.openCreate()).toBe(false)

    const state = setup()
    expect(state.policies.openCreate()).toBe(true)
    expect(state.policies.ownerArmed.value).toBe(true)
    expect(state.policies.openEdit(state.policyRows.value[0])).toBe(false)
    expect(state.policies.cancelCreate()).toBe(true)
    expect(state.policies.openEdit(state.policyRows.value[0])).toBe(true)
    expect(state.policies.openCreate()).toBe(false)
  })

  it('validates create fields before acquiring mutation ownership', async () => {
    const state = setup()
    state.policies.openCreate()

    await expect(state.policies.submitCreate()).resolves.toBe(false)
    expect(state.policies.createError.value).toBe('Name is required.')

    state.policies.createForm.value.name = 'x'.repeat(257)
    await expect(state.policies.submitCreate()).resolves.toBe(false)
    expect(state.policies.createError.value).toContain('256 characters')

    state.policies.createForm.value.name = 'Engineering'
    state.policies.createForm.value.scope_pattern = ''
    await expect(state.policies.submitCreate()).resolves.toBe(false)
    expect(state.policies.createError.value).toBe('Scope pattern is required.')
    state.policies.createForm.value.scope_pattern = 'workspace:eng'
    await expect(state.policies.submitCreate()).resolves.toBe(false)
    expect(state.policies.createError.value).toContain("must start with 'tenant:<id>'")
    state.policies.createForm.value.scope_pattern = 'tenant:other/*'
    await expect(state.policies.submitCreate()).resolves.toBe(false)
    expect(state.policies.createError.value).toContain("belong to tenant 'acme'")
    state.policies.createForm.value.scope_pattern = 'tenant:acme/*'
    state.policies.createForm.value.description = 'x'.repeat(1025)
    await expect(state.policies.submitCreate()).resolves.toBe(false)
    expect(state.policies.createError.value).toContain('1,024 characters')
    state.policies.createForm.value.description = ''
    state.policies.createForm.value.priority = '1.5'
    await expect(state.policies.submitCreate()).resolves.toBe(false)
    expect(state.policies.createError.value).toBe('Priority must be a non-negative whole number.')

    state.policies.createForm.value.priority = '-1'
    await expect(state.policies.submitCreate()).resolves.toBe(false)
    expect(state.policies.createError.value).toBe('Priority must be a non-negative whole number.')

    state.policies.createForm.value.priority = '1'
    state.policies.createForm.value.commit_overage_policy = 'FUTURE_POLICY'
    await expect(state.policies.submitCreate()).resolves.toBe(false)
    expect(state.policies.createError.value).toBe('Commit overage policy is invalid.')
    state.policies.createForm.value.commit_overage_policy = ''
    state.policies.createAdvanced.value.max_tokens = '-1'
    await expect(state.policies.submitCreate()).resolves.toBe(false)
    expect(state.policies.createError.value).toBe('Max tokens must be at least 0.')
    expect(state.beginMutation).not.toHaveBeenCalled()
    expect(state.create).not.toHaveBeenCalled()
  })

  it('snapshots create requests, blocks duplicate submits, and publishes before settlement', async () => {
    const state = setup()
    const request = deferred<Policy>()
    state.create.mockReturnValueOnce(request.promise)
    state.policies.openCreate()
    state.policies.createForm.value = {
      name: ' Engineering ',
      description: ' Production defaults ',
      scope_pattern: 'tenant:acme/workspace:eng/*',
      priority: '12',
      commit_overage_policy: 'ALLOW_IF_AVAILABLE',
    }
    state.policies.createAdvanced.value.tool_allowlist = 'search, summarize'

    const first = state.policies.submitCreate()
    expect(state.policies.isMutationRunning.value).toBe(true)
    await expect(state.policies.submitCreate()).resolves.toBe(false)
    expect(state.policies.cancelCreate()).toBe(false)
    state.policies.createAdvanced.value.tool_allowlist = 'changed-after-submit'
    request.resolve(policy({ policy_id: 'policy-2', name: 'Engineering' }))
    await expect(first).resolves.toBe(true)

    expect(state.create).toHaveBeenCalledWith('acme', {
      name: 'Engineering',
      description: 'Production defaults',
      scope_pattern: 'tenant:acme/workspace:eng/*',
      priority: 12,
      commit_overage_policy: 'ALLOW_IF_AVAILABLE',
      caps: { tool_allowlist: ['search', 'summarize'] },
    })
    expect(state.beginMutation).toHaveBeenCalledOnce()
    expect(state.commitPolicy).toHaveBeenCalledBefore(state.refreshPolicies)
    expect(state.policies.showCreate.value).toBe(false)
    expect(state.notify.success).toHaveBeenCalledWith('Policy created')
  })

  it('revalidates the external gate before create and keeps request failures retryable', async () => {
    let allowed = true
    const gated = setup({ canArm: () => allowed })
    gated.policies.openCreate()
    gated.policies.createForm.value.name = 'Engineering'
    allowed = false
    await expect(gated.policies.submitCreate()).resolves.toBe(false)
    expect(gated.create).not.toHaveBeenCalled()
    expect(gated.policies.createError.value).toContain('no longer available')

    const failed = setup()
    failed.create.mockRejectedValueOnce(new Error('create unavailable'))
    failed.policies.openCreate()
    failed.policies.createForm.value.name = 'Engineering'
    await expect(failed.policies.submitCreate()).resolves.toBe(false)
    expect(failed.policies.showCreate.value).toBe(true)
    expect(failed.policies.createError.value).toBe('create unavailable')
  })

  it('prefills visible edit state and emits spec-valid clears for override groups', async () => {
    const state = setup()
    const target = state.policyRows.value[0]
    expect(state.policies.openEdit(target)).toBe(true)
    expect(state.policies.editForm.value).toMatchObject({
      name: 'Engineering policy',
      description: 'Current description',
      priority: 10,
      commit_overage_policy: 'REJECT',
    })
    expect(state.policies.editHasAdvanced.value).toBe(true)

    state.policies.editForm.value.description = ''
    state.policies.editAdvanced.value.max_tokens = ''
    state.policies.editAdvanced.value.max_commits_per_minute = ''
    state.policies.editAdvanced.value.default_ttl_ms = ''
    await expect(state.policies.submitEdit()).resolves.toBe(true)

    expect(state.update).toHaveBeenCalledWith('policy-1', {
      description: '',
      caps: {},
      rate_limits: {},
      reservation_ttl_override: {},
    })
    expect(state.commitPolicy).toHaveBeenCalledBefore(state.refreshPolicies)
    expect(state.policies.editingPolicy.value).toBeNull()
    expect(state.notify.success).toHaveBeenCalledWith('Policy updated')
  })

  it('does not open advanced fields for empty stored replacement groups', () => {
    const state = setup()
    state.policyRows.value = [policy({
      caps: {},
      rate_limits: {},
      reservation_ttl_override: {},
      effective_from: undefined,
      effective_until: undefined,
    })]

    expect(state.policies.openEdit(state.policyRows.value[0])).toBe(true)
    expect(state.policies.editHasAdvanced.value).toBe(false)
  })

  it('keeps immutable/unrepresentable clears explicit and never sends scope_pattern', async () => {
    const priority = setup()
    priority.policies.openEdit(priority.policyRows.value[0])
    priority.policies.editForm.value.priority = ''
    await expect(priority.policies.submitEdit()).resolves.toBe(false)
    expect(priority.policies.editError.value).toContain('Priority cannot be cleared')

    const commit = setup()
    commit.policies.openEdit(commit.policyRows.value[0])
    commit.policies.editForm.value.commit_overage_policy = ''
    await expect(commit.policies.submitEdit()).resolves.toBe(false)
    expect(commit.policies.editError.value).toContain('Commit overage policy cannot be cleared')

    const timestamp = setup()
    timestamp.policies.openEdit(timestamp.policyRows.value[0])
    timestamp.policies.editAdvanced.value.effective_from = ''
    await expect(timestamp.policies.submitEdit()).resolves.toBe(false)
    expect(timestamp.policies.editError.value).toContain('Effective from cannot be cleared')

    const rename = setup()
    rename.policies.openEdit(rename.policyRows.value[0])
    rename.policies.editForm.value.name = 'Renamed policy'
    await rename.policies.submitEdit()
    expect(rename.update.mock.calls[0][1]).not.toHaveProperty('scope_pattern')
  })

  it('validates changed edit fields and serializes supported scalar/schedule replacements', async () => {
    const missingRow = setup()
    expect(missingRow.policies.openEdit(policy({ policy_id: 'missing' }))).toBe(false)

    const canceled = setup()
    canceled.policies.openEdit(canceled.policyRows.value[0])
    expect(canceled.policies.cancelEdit()).toBe(true)
    expect(canceled.policies.editingPolicy.value).toBeNull()

    const blankName = setup()
    blankName.policies.openEdit(blankName.policyRows.value[0])
    blankName.policies.editForm.value.name = ' '
    await expect(blankName.policies.submitEdit()).resolves.toBe(false)
    expect(blankName.policies.editError.value).toBe('Name is required.')

    const longName = setup()
    longName.policies.openEdit(longName.policyRows.value[0])
    longName.policies.editForm.value.name = 'x'.repeat(257)
    await expect(longName.policies.submitEdit()).resolves.toBe(false)
    expect(longName.policies.editError.value).toContain('256 characters')

    const longDescription = setup()
    longDescription.policies.openEdit(longDescription.policyRows.value[0])
    longDescription.policies.editForm.value.description = 'x'.repeat(1025)
    await expect(longDescription.policies.submitEdit()).resolves.toBe(false)
    expect(longDescription.policies.editError.value).toContain('1,024 characters')

    const invalidPriority = setup()
    invalidPriority.policies.openEdit(invalidPriority.policyRows.value[0])
    invalidPriority.policies.editForm.value.priority = '1.5'
    await expect(invalidPriority.policies.submitEdit()).resolves.toBe(false)
    expect(invalidPriority.policies.editError.value)
      .toBe('Priority must be a non-negative whole number.')

    const negativePriority = setup()
    negativePriority.policies.openEdit(negativePriority.policyRows.value[0])
    negativePriority.policies.editForm.value.priority = '-1'
    await expect(negativePriority.policies.submitEdit()).resolves.toBe(false)
    expect(negativePriority.policies.editError.value)
      .toBe('Priority must be a non-negative whole number.')

    const invalidCommit = setup()
    invalidCommit.policies.openEdit(invalidCommit.policyRows.value[0])
    invalidCommit.policies.editForm.value.commit_overage_policy = 'FUTURE_POLICY'
    await expect(invalidCommit.policies.submitEdit()).resolves.toBe(false)
    expect(invalidCommit.policies.editError.value).toBe('Commit overage policy is invalid.')

    const invalidAdvanced = setup()
    invalidAdvanced.policies.openEdit(invalidAdvanced.policyRows.value[0])
    invalidAdvanced.policies.editAdvanced.value.max_tokens = '-1'
    await expect(invalidAdvanced.policies.submitEdit()).resolves.toBe(false)
    expect(invalidAdvanced.policies.editError.value).toContain('Max tokens')

    const valid = setup()
    valid.policies.openEdit(valid.policyRows.value[0])
    valid.policies.editForm.value.priority = '11'
    valid.policies.editForm.value.commit_overage_policy = 'ALLOW_IF_AVAILABLE'
    valid.policies.editAdvanced.value.effective_from = '2026-07-21T12:00'
    valid.policies.editAdvanced.value.effective_until = '2026-07-22T12:00'
    await expect(valid.policies.submitEdit()).resolves.toBe(true)
    expect(valid.update).toHaveBeenCalledWith('policy-1', {
      priority: 11,
      commit_overage_policy: 'ALLOW_IF_AVAILABLE',
      effective_from: new Date('2026-07-21T12:00').toISOString(),
      effective_until: new Date('2026-07-22T12:00').toISOString(),
    })
  })

  it('revalidates the external gate before editing', async () => {
    let allowed = true
    const state = setup({ canArm: () => allowed })
    state.policies.openEdit(state.policyRows.value[0])
    state.policies.editForm.value.name = 'Renamed'
    allowed = false

    await expect(state.policies.submitEdit()).resolves.toBe(false)
    expect(state.policies.editError.value).toContain('no longer available')
    expect(state.update).not.toHaveBeenCalled()
  })

  it('preserves forward-compatible server values during unrelated edits', async () => {
    const state = setup()
    state.policyRows.value = [policy({
      commit_overage_policy: 'FUTURE_POLICY',
      priority: -1,
      caps: { max_tokens: -1 },
    })]
    state.policies.openEdit(state.policyRows.value[0])
    state.policies.editForm.value.name = 'Renamed policy'

    await expect(state.policies.submitEdit()).resolves.toBe(true)
    expect(state.update).toHaveBeenCalledWith('policy-1', { name: 'Renamed policy' })

    const repaired = setup()
    repaired.policyRows.value = [policy({ priority: -1 })]
    repaired.policies.openEdit(repaired.policyRows.value[0])
    repaired.policies.editForm.value.priority = '0'
    await expect(repaired.policies.submitEdit()).resolves.toBe(true)
    expect(repaired.update).toHaveBeenCalledWith('policy-1', { priority: 0 })

    const worsened = setup()
    worsened.policyRows.value = [policy({ priority: -1 })]
    worsened.policies.openEdit(worsened.policyRows.value[0])
    worsened.policies.editForm.value.priority = '-2'
    await expect(worsened.policies.submitEdit()).resolves.toBe(false)
    expect(worsened.policies.editError.value)
      .toBe('Priority must be a non-negative whole number.')
    expect(worsened.update).not.toHaveBeenCalled()
  })

  it('validates only advanced replacement groups entering the PATCH', async () => {
    const state = setup()
    state.policyRows.value = [policy({ caps: { max_tokens: -1 } })]
    state.policies.openEdit(state.policyRows.value[0])
    state.policies.editAdvanced.value.max_commits_per_minute = '21'

    await expect(state.policies.submitEdit()).resolves.toBe(true)
    expect(state.update).toHaveBeenCalledWith('policy-1', {
      rate_limits: { max_commits_per_minute: 21 },
    })
  })

  it('validates a changed schedule boundary against the exact stored counterpart', async () => {
    const state = setup()
    state.policyRows.value = [policy({ effective_until: '2026-07-22T12:00:30.000Z' })]
    state.policies.openEdit(state.policyRows.value[0])
    state.policies.editAdvanced.value.effective_from
      = state.policies.editAdvanced.value.effective_until

    await expect(state.policies.submitEdit()).resolves.toBe(true)
    const displayedMinute = state.update.mock.calls[0][1].effective_from
    expect(new Date(displayedMinute!).getTime()).toBe(
      new Date('2026-07-22T12:00:30.000Z').getTime() - 30_000,
    )
    expect(state.update.mock.calls[0][1]).not.toHaveProperty('effective_until')
  })

  it('rejects no-op, disappeared, and stale-row edits before the write', async () => {
    const noOp = setup()
    noOp.policies.openEdit(noOp.policyRows.value[0])
    await expect(noOp.policies.submitEdit()).resolves.toBe(false)
    expect(noOp.policies.editError.value).toBe('No changes to save.')

    const whitespaceOnly = setup()
    whitespaceOnly.policies.openEdit(whitespaceOnly.policyRows.value[0])
    whitespaceOnly.policies.editForm.value.name = ' Engineering policy '
    whitespaceOnly.policies.editForm.value.description = ' Current description '
    await expect(whitespaceOnly.policies.submitEdit()).resolves.toBe(false)
    expect(whitespaceOnly.policies.editError.value).toBe('No changes to save.')
    expect(whitespaceOnly.update).not.toHaveBeenCalled()

    const normalizedOnly = setup()
    normalizedOnly.policyRows.value = [policy({
      caps: { max_tokens: 1000, tool_allowlist: ['search'] },
    })]
    normalizedOnly.policies.openEdit(normalizedOnly.policyRows.value[0])
    normalizedOnly.policies.editForm.value.priority = '010'
    normalizedOnly.policies.editAdvanced.value.tool_allowlist = ' search\n'
    await expect(normalizedOnly.policies.submitEdit()).resolves.toBe(false)
    expect(normalizedOnly.policies.editError.value).toBe('No changes to save.')
    expect(normalizedOnly.update).not.toHaveBeenCalled()

    const reordered = setup()
    reordered.policyRows.value = [policy({ caps: { max_tokens: 1000, cooldown_ms: 100 } })]
    reordered.policies.openEdit(reordered.policyRows.value[0])
    reordered.policies.editForm.value.name = 'Renamed'
    reordered.policyRows.value = [policy({ caps: { cooldown_ms: 100, max_tokens: 1000 } })]
    await expect(reordered.policies.submitEdit()).resolves.toBe(true)
    expect(reordered.update).toHaveBeenCalledWith('policy-1', { name: 'Renamed' })

    const disappeared = setup()
    disappeared.policies.openEdit(disappeared.policyRows.value[0])
    disappeared.policies.editForm.value.name = 'Renamed'
    disappeared.policyRows.value = []
    await expect(disappeared.policies.submitEdit()).resolves.toBe(false)
    expect(disappeared.policies.editError.value).toContain('no longer available')

    const stale = setup()
    stale.policies.openEdit(stale.policyRows.value[0])
    stale.policies.editForm.value.name = 'Renamed'
    stale.policyRows.value = [policy({ updated_at: '2026-07-20T02:00:00Z' })]
    await expect(stale.policies.submitEdit()).resolves.toBe(false)
    expect(stale.policies.editError.value).toContain('changed after the dialog opened')
    expect(stale.update).not.toHaveBeenCalled()
  })

  it('guards an in-flight edit and keeps failures in the dialog', async () => {
    const state = setup()
    const request = deferred<Policy>()
    state.update.mockReturnValueOnce(request.promise)
    state.policies.openEdit(state.policyRows.value[0])
    state.policies.editForm.value.name = 'Renamed'

    const first = state.policies.submitEdit()
    await expect(state.policies.submitEdit()).resolves.toBe(false)
    expect(state.policies.cancelEdit()).toBe(false)
    request.reject(new Error('update unavailable'))
    await expect(first).resolves.toBe(false)
    expect(state.policies.editingPolicy.value).not.toBeNull()
    expect(state.policies.editError.value).toBe('update unavailable')
  })

  it('warns distinctly when committed settlement fails, is superseded, or throws', async () => {
    const failed = setup()
    failed.error.value = 'policy read failed'
    failed.refreshPolicies.mockResolvedValueOnce('failed')
    failed.policies.openEdit(failed.policyRows.value[0])
    failed.policies.editForm.value.name = 'Renamed'
    await failed.policies.submitEdit()
    expect(failed.notify.warning).toHaveBeenCalledWith(
      'Policy updated, but refresh failed: policy read failed',
    )

    const superseded = setup()
    superseded.refreshPolicies.mockResolvedValueOnce('superseded')
    superseded.policies.openEdit(superseded.policyRows.value[0])
    superseded.policies.editForm.value.name = 'Renamed'
    await superseded.policies.submitEdit()
    expect(superseded.notify.warning).toHaveBeenCalledWith(
      'Policy updated; its refresh was superseded by a newer view update',
    )

    const throwing = setup()
    throwing.refreshPolicies.mockRejectedValueOnce(new Error('refresh crashed'))
    throwing.policies.openEdit(throwing.policyRows.value[0])
    throwing.policies.editForm.value.name = 'Renamed'
    await expect(throwing.policies.submitEdit()).resolves.toBe(true)
    expect(throwing.notify.warning).toHaveBeenCalledWith(
      'Policy updated, but refresh failed: refresh crashed',
    )
  })
})

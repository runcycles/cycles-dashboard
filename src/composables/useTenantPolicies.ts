import { computed, readonly, ref, type Ref } from 'vue'
import {
  createPolicy as createPolicyDefault,
  updatePolicy as updatePolicyDefault,
} from '../api/client'
import type {
  Policy,
  PolicyCreateRequest,
  PolicyUpdateRequest,
  Tenant,
} from '../types'
import { COMMIT_OVERAGE_POLICIES } from '../types'
import {
  emptyPolicyAdvancedForm,
  policyAdvancedToRequest,
  policyToAdvancedForm,
  validatePolicyAdvancedForm,
  type PolicyAdvancedForm,
} from '../utils/policyAdvanced'
import { toMessage } from '../utils/errors'
import { tenantFromScope, validateScope } from '../utils/safe'
import { isTerminalTenant } from '../utils/tenantStatus'
import type { TenantDetailRefreshResult } from './useTenantDetailData'

export interface TenantPolicyForm {
  name: string
  description: string
  priority: number | string
  commit_overage_policy: string
}

export interface TenantPolicyCreateForm extends TenantPolicyForm {
  scope_pattern: string
}

export interface TenantPolicyNotifications {
  success: (message: string) => void
  warning: (message: string) => void
}

export interface UseTenantPoliciesOptions {
  tenantId: string
  tenant: Readonly<Ref<Tenant | null>>
  policies: Readonly<Ref<Policy[]>>
  error: Readonly<Ref<string>>
  refreshPolicies: () => Promise<TenantDetailRefreshResult>
  /** Supersede reads before the first write enters the API client. */
  beginMutation: () => void
  /** Publish an authoritative create/update response before settlement. */
  commitPolicy: (policy: Policy) => void
  notify: TenantPolicyNotifications
  /** Refuse to arm a policy surface while a sibling owner is armed. */
  canArm?: () => boolean
  /** Focused dependency seams for deterministic protocol tests. */
  create?: typeof createPolicyDefault
  update?: typeof updatePolicyDefault
}

const EMPTY_POLICY_FORM = (): TenantPolicyForm => ({
  name: '',
  description: '',
  priority: '',
  commit_overage_policy: '',
})

const EMPTY_CREATE_FORM = (tenantId: string): TenantPolicyCreateForm => ({
  ...EMPTY_POLICY_FORM(),
  scope_pattern: `tenant:${tenantId}/*`,
})

const CAPS_FIELDS = [
  'max_tokens',
  'max_steps_remaining',
  'cooldown_ms',
  'tool_allowlist',
  'tool_denylist',
] as const satisfies readonly (keyof PolicyAdvancedForm)[]

const RATE_LIMIT_FIELDS = [
  'max_reservations_per_minute',
  'max_commits_per_minute',
] as const satisfies readonly (keyof PolicyAdvancedForm)[]

const TTL_FIELDS = [
  'default_ttl_ms',
  'max_ttl_ms',
  'max_extensions',
] as const satisfies readonly (keyof PolicyAdvancedForm)[]

function fieldsChanged(
  next: PolicyAdvancedForm,
  initial: PolicyAdvancedForm,
  fields: readonly (keyof PolicyAdvancedForm)[],
): boolean {
  return fields.some(field => next[field] !== initial[field])
}

function copyFields(
  target: PolicyAdvancedForm,
  source: PolicyAdvancedForm,
  fields: readonly (keyof PolicyAdvancedForm)[],
): void {
  for (const field of fields) target[field] = source[field]
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function replacementChanged(next: object | undefined, current: object | undefined): boolean {
  return canonicalJson(next ?? {}) !== canonicalJson(current ?? {})
}

function policyFingerprint(policy: Policy): string {
  return canonicalJson({
    name: policy.name,
    description: policy.description ?? '',
    priority: policy.priority,
    caps: policy.caps,
    commit_overage_policy: policy.commit_overage_policy,
    rate_limits: policy.rate_limits,
    reservation_ttl_override: policy.reservation_ttl_override,
    effective_from: policy.effective_from,
    effective_until: policy.effective_until,
    status: policy.status,
    updated_at: policy.updated_at,
  })
}

function validCommitOveragePolicy(value: string): boolean {
  return !value || COMMIT_OVERAGE_POLICIES.some(policy => policy === value)
}

/** Owns Tenant Detail's policy create/edit mutation protocol. */
export function useTenantPolicies(options: UseTenantPoliciesOptions) {
  const createPolicy = options.create ?? createPolicyDefault
  const updatePolicy = options.update ?? updatePolicyDefault

  const showCreate = ref(false)
  const createLoading = ref(false)
  const createError = ref('')
  const createForm = ref<TenantPolicyCreateForm>(EMPTY_CREATE_FORM(options.tenantId))
  const createAdvanced = ref<PolicyAdvancedForm>(emptyPolicyAdvancedForm())

  const editingPolicy = ref<Policy | null>(null)
  const editLoading = ref(false)
  const editError = ref('')
  const editForm = ref<TenantPolicyForm>(EMPTY_POLICY_FORM())
  const editAdvanced = ref<PolicyAdvancedForm>(emptyPolicyAdvancedForm())
  const editAdvancedInitial = ref<PolicyAdvancedForm>(emptyPolicyAdvancedForm())
  const editHasAdvanced = ref(false)
  const editFingerprint = ref('')

  const isMutationRunning = computed(() => createLoading.value || editLoading.value)
  const ownerArmed = computed(() => (
    showCreate.value || editingPolicy.value !== null || isMutationRunning.value
  ))

  function externalGateOpen(): boolean {
    return !isTerminalTenant(options.tenant.value) && (options.canArm?.() ?? true)
  }

  function canOpen(): boolean {
    return !ownerArmed.value && externalGateOpen()
  }

  async function settle(committedLabel: string): Promise<void> {
    try {
      const result = await options.refreshPolicies()
      if (result === 'failed') {
        options.notify.warning(`${committedLabel}, but refresh failed: ${options.error.value}`)
      } else if (result === 'superseded') {
        options.notify.warning(`${committedLabel}; its refresh was superseded by a newer view update`)
      }
    } catch (cause) {
      options.notify.warning(`${committedLabel}, but refresh failed: ${toMessage(cause)}`)
    }
  }

  function openCreate(): boolean {
    if (!canOpen()) return false
    createForm.value = EMPTY_CREATE_FORM(options.tenantId)
    createAdvanced.value = emptyPolicyAdvancedForm()
    createError.value = ''
    showCreate.value = true
    return true
  }

  function cancelCreate(): boolean {
    if (createLoading.value) return false
    showCreate.value = false
    createError.value = ''
    return true
  }

  function createRequest(): PolicyCreateRequest | null {
    const name = createForm.value.name.trim()
    if (!name) {
      createError.value = 'Name is required.'
      return null
    }
    if (name.length > 256) {
      createError.value = 'Name must be 256 characters or fewer.'
      return null
    }
    const scopePattern = createForm.value.scope_pattern.trim()
    if (!scopePattern) {
      createError.value = 'Scope pattern is required.'
      return null
    }
    const scopeError = validateScope(scopePattern, {
      fieldName: 'Scope pattern',
      allowWildcards: true,
    })
    if (scopeError) {
      createError.value = scopeError
      return null
    }
    if (tenantFromScope(scopePattern) !== options.tenantId) {
      createError.value = `Scope pattern must belong to tenant '${options.tenantId}'.`
      return null
    }
    const description = createForm.value.description.trim()
    if (description.length > 1024) {
      createError.value = 'Description must be 1,024 characters or fewer.'
      return null
    }
    const priorityText = String(createForm.value.priority).trim()
    const priority = Number(priorityText)
    if (priorityText && (!Number.isFinite(priority) || !Number.isInteger(priority) || priority < 0)) {
      createError.value = 'Priority must be a non-negative whole number.'
      return null
    }
    if (!validCommitOveragePolicy(createForm.value.commit_overage_policy)) {
      createError.value = 'Commit overage policy is invalid.'
      return null
    }
    const advancedError = validatePolicyAdvancedForm(createAdvanced.value)
    if (advancedError) {
      createError.value = advancedError
      return null
    }

    return {
      name,
      scope_pattern: scopePattern,
      ...(description ? { description } : {}),
      ...(priorityText ? { priority } : {}),
      ...(createForm.value.commit_overage_policy
        ? { commit_overage_policy: createForm.value.commit_overage_policy }
        : {}),
      ...policyAdvancedToRequest(createAdvanced.value),
    }
  }

  async function submitCreate(): Promise<boolean> {
    if (createLoading.value || !showCreate.value) return false
    createError.value = ''
    if (!externalGateOpen()) {
      createError.value = 'Policy creation is no longer available for this tenant.'
      return false
    }
    const body = createRequest()
    if (!body) return false

    createLoading.value = true
    options.beginMutation()
    try {
      const created = await createPolicy(options.tenantId, body)
      options.commitPolicy(created)
      showCreate.value = false
      options.notify.success('Policy created')
      await settle('Policy created')
      return true
    } catch (cause) {
      createError.value = toMessage(cause)
      return false
    } finally {
      createLoading.value = false
    }
  }

  function openEdit(policy: Policy): boolean {
    if (!canOpen()) return false
    const live = options.policies.value.find(candidate => candidate.policy_id === policy.policy_id)
    if (!live) return false

    editingPolicy.value = { ...live }
    editForm.value = {
      name: live.name,
      description: live.description ?? '',
      priority: live.priority ?? '',
      commit_overage_policy: live.commit_overage_policy ?? '',
    }
    const advanced = policyToAdvancedForm(live)
    editAdvanced.value = { ...advanced }
    editAdvancedInitial.value = { ...advanced }
    editHasAdvanced.value = !!(
      live.caps
      || live.rate_limits
      || live.reservation_ttl_override
      || live.effective_from
      || live.effective_until
    )
    editFingerprint.value = policyFingerprint(live)
    editError.value = ''
    return true
  }

  function cancelEdit(): boolean {
    if (editLoading.value) return false
    editingPolicy.value = null
    editError.value = ''
    return true
  }

  function editRequest(target: Policy): PolicyUpdateRequest | null {
    const body: PolicyUpdateRequest = {}
    const rawName = editForm.value.name
    const name = rawName.trim()
    if (!name) {
      editError.value = 'Name is required.'
      return null
    }
    if (name.length > 256) {
      editError.value = 'Name must be 256 characters or fewer.'
      return null
    }
    if (rawName !== target.name && name !== target.name) body.name = name

    const rawDescription = editForm.value.description
    const description = rawDescription.trim()
    if (description.length > 1024) {
      editError.value = 'Description must be 1,024 characters or fewer.'
      return null
    }
    const targetDescription = target.description ?? ''
    if (rawDescription !== targetDescription && description !== targetDescription) {
      body.description = description
    }

    const priorityText = String(editForm.value.priority).trim()
    const priorityChanged = priorityText !== String(target.priority ?? '')
    if (priorityChanged) {
      if (!priorityText && target.priority !== undefined) {
        editError.value = 'Priority cannot be cleared by the current admin API.'
        return null
      }
      const priority = Number(priorityText)
      if (!Number.isFinite(priority) || !Number.isInteger(priority) || priority < 0) {
        editError.value = 'Priority must be a non-negative whole number.'
        return null
      }
      if (priority !== target.priority) body.priority = priority
    }

    const commitOverage = editForm.value.commit_overage_policy
    if (commitOverage !== (target.commit_overage_policy ?? '')) {
      if (!commitOverage) {
        editError.value = 'Commit overage policy cannot be cleared by the current admin API.'
        return null
      }
      if (!validCommitOveragePolicy(commitOverage)) {
        editError.value = 'Commit overage policy is invalid.'
        return null
      }
      body.commit_overage_policy = commitOverage
    }

    const parsed = policyAdvancedToRequest(editAdvanced.value)
    const capsChanged = fieldsChanged(editAdvanced.value, editAdvancedInitial.value, CAPS_FIELDS)
      && replacementChanged(parsed.caps, target.caps)
    const rateLimitsChanged = fieldsChanged(
      editAdvanced.value,
      editAdvancedInitial.value,
      RATE_LIMIT_FIELDS,
    ) && replacementChanged(parsed.rate_limits, target.rate_limits)
    const ttlChanged = fieldsChanged(editAdvanced.value, editAdvancedInitial.value, TTL_FIELDS)
      && replacementChanged(parsed.reservation_ttl_override, target.reservation_ttl_override)
    const effectiveFromChanged = editAdvanced.value.effective_from
      !== editAdvancedInitial.value.effective_from
    const effectiveUntilChanged = editAdvanced.value.effective_until
      !== editAdvancedInitial.value.effective_until
    const advancedChanged = capsChanged
      || rateLimitsChanged
      || ttlChanged
      || effectiveFromChanged
      || effectiveUntilChanged
    if (advancedChanged) {
      // Validate only replacement groups entering this PATCH. Unchanged
      // forward-compatible server values must not block an unrelated edit.
      const changedAdvanced = emptyPolicyAdvancedForm()
      if (capsChanged) copyFields(changedAdvanced, editAdvanced.value, CAPS_FIELDS)
      if (rateLimitsChanged) copyFields(changedAdvanced, editAdvanced.value, RATE_LIMIT_FIELDS)
      if (ttlChanged) copyFields(changedAdvanced, editAdvanced.value, TTL_FIELDS)
      if (effectiveFromChanged || effectiveUntilChanged) {
        // datetime-local displays minute precision. Compare a changed boundary
        // with the exact stored counterpart so hidden seconds cannot create a
        // false equal/reversed-window rejection.
        changedAdvanced.effective_from = effectiveFromChanged
          ? editAdvanced.value.effective_from
          : (target.effective_from ?? '')
        changedAdvanced.effective_until = effectiveUntilChanged
          ? editAdvanced.value.effective_until
          : (target.effective_until ?? '')
      }
      const advancedError = validatePolicyAdvancedForm(changedAdvanced)
      if (advancedError) {
        editError.value = advancedError
        return null
      }
    }
    // These schemas have no required properties. A present empty object is
    // therefore the spec-defined way to remove an existing override group.
    if (capsChanged) {
      body.caps = parsed.caps ?? {}
    }
    if (rateLimitsChanged) {
      body.rate_limits = parsed.rate_limits ?? {}
    }
    if (ttlChanged) {
      body.reservation_ttl_override = parsed.reservation_ttl_override ?? {}
    }
    for (const field of ['effective_from', 'effective_until'] as const) {
      if (editAdvanced.value[field] === editAdvancedInitial.value[field]) continue
      if (!editAdvanced.value[field] && target[field]) {
        editError.value = `${field === 'effective_from' ? 'Effective from' : 'Effective until'} cannot be cleared by the current admin API.`
        return null
      }
      const value = parsed[field]
      if (value) body[field] = value
    }

    if (Object.keys(body).length === 0) {
      editError.value = 'No changes to save.'
      return null
    }
    return body
  }

  async function submitEdit(): Promise<boolean> {
    if (editLoading.value || !editingPolicy.value) return false
    editError.value = ''
    if (!externalGateOpen()) {
      editError.value = 'Policy editing is no longer available for this tenant.'
      return false
    }
    const target = editingPolicy.value
    const live = options.policies.value.find(policy => policy.policy_id === target.policy_id)
    if (!live) {
      editError.value = 'This policy is no longer available. Close the dialog and refresh.'
      return false
    }
    if (policyFingerprint(live) !== editFingerprint.value) {
      editError.value = 'This policy changed after the dialog opened. Close and reopen it before saving.'
      return false
    }
    const body = editRequest(target)
    if (!body) return false

    editLoading.value = true
    options.beginMutation()
    try {
      const updated = await updatePolicy(target.policy_id, body)
      options.commitPolicy(updated)
      editingPolicy.value = null
      options.notify.success('Policy updated')
      await settle('Policy updated')
      return true
    } catch (cause) {
      editError.value = toMessage(cause)
      return false
    } finally {
      editLoading.value = false
    }
  }

  return {
    ownerArmed,
    isMutationRunning,
    showCreate: readonly(showCreate),
    createLoading: readonly(createLoading),
    createError: readonly(createError),
    createForm,
    createAdvanced,
    openCreate,
    cancelCreate,
    submitCreate,
    editingPolicy: readonly(editingPolicy),
    editLoading: readonly(editLoading),
    editError: readonly(editError),
    editForm,
    editAdvanced,
    editHasAdvanced: readonly(editHasAdvanced),
    openEdit,
    cancelEdit,
    submitEdit,
  }
}

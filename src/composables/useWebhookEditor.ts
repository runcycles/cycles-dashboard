import { computed, readonly, ref, type Ref } from 'vue'
import { updateWebhook as updateWebhookDefault } from '../api/client'
import {
  EVENT_CATEGORIES,
  EVENT_TYPES,
  TENANT_ALLOWED_EVENT_CATEGORIES,
  TENANT_ALLOWED_EVENT_TYPES,
  type WebhookSubscription,
  type WebhookUpdateRequest,
} from '../types'
import {
  emptyWebhookAdvancedForm,
  webhookAdvancedError,
  webhookAdvancedToRequest,
  webhookToAdvancedForm,
} from '../utils/webhookAdvanced'
import { toMessage } from '../utils/errors'

export interface WebhookEditForm {
  name: string
  description: string
  url: string
  event_types: string[]
  event_categories: string[]
  scope_filter: string
  disable_after_failures: string
  metadata: string
}

export interface WebhookEditorDependencies {
  updateWebhook: typeof updateWebhookDefault
}

export interface UseWebhookEditorOptions {
  webhookId: string
  webhook: Readonly<Ref<WebhookSubscription | null>>
  /** Refuses editor arming while another operation owns the detail surface. */
  canOpen?: () => boolean
  /** Invalidates an older poll before the PATCH starts. */
  beginSubscriptionMutation: () => void
  /** Publishes the authoritative PATCH response into the shared detail owner. */
  publishWebhook: (webhook: WebhookSubscription) => void
  notifySuccess: (message: string) => void
  dependencies?: Partial<WebhookEditorDependencies>
}

const SYSTEM_TENANT_ID = '__system__'

const EMPTY_FORM = (): WebhookEditForm => ({
  name: '',
  description: '',
  url: '',
  event_types: [],
  event_categories: [],
  scope_filter: '',
  disable_after_failures: '',
  metadata: '',
})

function snapshotForm(webhook: WebhookSubscription): WebhookEditForm {
  return {
    name: webhook.name ?? '',
    description: webhook.description ?? '',
    url: webhook.url,
    event_types: [...(webhook.event_types || [])],
    event_categories: [...(webhook.event_categories || [])],
    scope_filter: webhook.scope_filter ?? '',
    disable_after_failures: String(webhook.disable_after_failures ?? 10),
    metadata: webhook.metadata && Object.keys(webhook.metadata).length
      ? JSON.stringify(webhook.metadata, null, 2)
      : '',
  }
}

/**
 * Owns Webhook Detail's security-sensitive editor protocol.
 *
 * The owner snapshots the form and diff baseline independently, enforces the
 * tenant selector boundary (including legacy-row healing), validates metadata
 * and advanced fields, prevents duplicate writes, and publishes the
 * authoritative PATCH response without a fallible settlement GET.
 */
export function useWebhookEditor(options: UseWebhookEditorOptions) {
  const deps: WebhookEditorDependencies = {
    updateWebhook: updateWebhookDefault,
    ...options.dependencies,
  }

  const showEditState = ref(false)
  const showEdit = computed(() => showEditState.value)
  const editLoading = ref(false)
  const editError = ref('')
  const editMetadataError = ref('')
  const editForm = ref<WebhookEditForm>(EMPTY_FORM())
  const editInitial = ref<WebhookEditForm | null>(null)
  const editAdvanced = ref(emptyWebhookAdvancedForm())
  const editAdvancedInitial = ref('')
  const editAdvancedHasConfig = ref(false)
  const hiddenLegacySelectorCount = ref(0)
  const editorArmed = computed(() => showEditState.value || editLoading.value)

  // TENANT-OWNED CATEGORY BOUNDARY (spec revisions 0.1.25.38/.40/.41,
  // updateWebhookSubscription lines 6560-6574): concrete tenant-owned
  // subscriptions may select only tenant-accessible events. System-owned rows
  // retain the full selector set for legitimate admin monitoring.
  const isTenantOwned = computed(() => (
    !!options.webhook.value?.tenant_id
    && options.webhook.value.tenant_id !== SYSTEM_TENANT_ID
  ))
  const editEventTypes = computed<readonly string[]>(() => (
    isTenantOwned.value ? TENANT_ALLOWED_EVENT_TYPES : EVENT_TYPES
  ))
  const editEventCategories = computed<readonly string[]>(() => (
    isTenantOwned.value ? TENANT_ALLOWED_EVENT_CATEGORIES : EVENT_CATEGORIES
  ))

  function openEdit(): boolean {
    const webhook = options.webhook.value
    if (
      !webhook
      || editorArmed.value
      || options.canOpen?.() === false
    ) return false

    // Independent objects are required: v-model mutates editForm while the
    // second snapshot remains a frozen diff baseline.
    editForm.value = snapshotForm(webhook)
    editInitial.value = snapshotForm(webhook)

    // A tenant row created before the .40 boundary may still store admin-only
    // selectors. Strip them from BOTH snapshots so an untouched rename omits
    // selector fields (no phantom diff). When the operator deliberately edits
    // either selector, submitEdit sends both cleaned arrays; an explicit [] is
    // the spec-defined clear operation, while omission means keep.
    hiddenLegacySelectorCount.value = 0
    if (isTenantOwned.value) {
      const allowedTypes = new Set<string>(TENANT_ALLOWED_EVENT_TYPES)
      const allowedCategories = new Set<string>(TENANT_ALLOWED_EVENT_CATEGORIES)
      const before = editForm.value.event_types.length + editForm.value.event_categories.length
      for (const form of [editForm.value, editInitial.value]) {
        form.event_types = form.event_types.filter(eventType => allowedTypes.has(eventType))
        form.event_categories = form.event_categories.filter(category => allowedCategories.has(category))
      }
      hiddenLegacySelectorCount.value = before
        - editForm.value.event_types.length
        - editForm.value.event_categories.length
    }

    editAdvanced.value = webhookToAdvancedForm(webhook)
    editAdvancedInitial.value = JSON.stringify(editAdvanced.value)
    editAdvancedHasConfig.value = !!(webhook.thresholds || webhook.retry_policy)
    editError.value = ''
    editMetadataError.value = ''
    showEditState.value = true
    return true
  }

  function cancelEdit(): boolean {
    if (!showEditState.value || editLoading.value) return false
    showEditState.value = false
    editError.value = ''
    editMetadataError.value = ''
    return true
  }

  async function submitEdit(): Promise<boolean> {
    // Keep the duplicate/direct-call guard before visible state mutation so a
    // re-entrant submit cannot clear the first request's inline error.
    const initial = editInitial.value
    if (!showEditState.value || editLoading.value || !initial) return false

    editError.value = ''
    editMetadataError.value = ''
    const body: WebhookUpdateRequest = {}

    // SELECTOR CLEARING (spec revision 0.1.25.39, WebhookUpdateRequest
    // lines 2781-2813): [] explicitly clears a selector field, while omission
    // preserves it. Only a deliberate selector edit activates the both-empty
    // invariant so rename-only edits still work on legacy rows that strip to
    // an empty picker.
    const selectorsChanged =
      JSON.stringify(editForm.value.event_types) !== JSON.stringify(initial.event_types)
      || JSON.stringify(editForm.value.event_categories) !== JSON.stringify(initial.event_categories)
    if (
      selectorsChanged
      && !editForm.value.event_types.length
      && !editForm.value.event_categories.length
    ) {
      editError.value = 'Select at least one event type or category.'
      return false
    }

    // Send only changed fields so a save cannot overwrite unrelated state. The
    // update schema is non-nullable and the admin DTO ignores JSON null, so an
    // explicit clear uses the schema-valid empty value instead of a false 200.
    if (editForm.value.name !== initial.name) body.name = editForm.value.name
    if (editForm.value.description !== initial.description) body.description = editForm.value.description
    if (editForm.value.url !== initial.url) body.url = editForm.value.url
    if (JSON.stringify(editForm.value.event_types) !== JSON.stringify(initial.event_types)) {
      body.event_types = editForm.value.event_types
    }
    if (JSON.stringify(editForm.value.event_categories) !== JSON.stringify(initial.event_categories)) {
      body.event_categories = editForm.value.event_categories
    }
    // FUNDAMENTAL LEGACY-SELECTOR HEALING RULE: when opening hid any legacy
    // selector and the operator changes either picker, send BOTH cleaned arrays.
    // Otherwise the equal stripped-empty field would be omitted and its hidden
    // admin selectors would remain active server-side.
    if (selectorsChanged && hiddenLegacySelectorCount.value > 0) {
      body.event_types = editForm.value.event_types
      body.event_categories = editForm.value.event_categories
    }
    if (editForm.value.scope_filter !== initial.scope_filter) {
      body.scope_filter = editForm.value.scope_filter
    }
    if (editForm.value.disable_after_failures !== initial.disable_after_failures) {
      body.disable_after_failures = Number(editForm.value.disable_after_failures)
    }
    if (editForm.value.metadata !== initial.metadata) {
      if (editForm.value.metadata.trim() === '') {
        body.metadata = {}
      } else {
        try {
          const parsed: unknown = JSON.parse(editForm.value.metadata)
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            editMetadataError.value = 'Metadata must be a JSON object'
            return false
          }
          body.metadata = parsed as Record<string, unknown>
        } catch {
          editMetadataError.value = 'Invalid JSON'
          return false
        }
      }
    }

    // Advanced objects have replacement semantics. Blank edit fields are
    // omitted (keep the existing server value), so this editor sets/adjusts
    // values but does not imply a reset.
    if (JSON.stringify(editAdvanced.value) !== editAdvancedInitial.value) {
      const advancedError = webhookAdvancedError(editAdvanced.value)
      if (advancedError) {
        editError.value = advancedError
        return false
      }
      Object.assign(body, webhookAdvancedToRequest(editAdvanced.value))
    }
    if (Object.keys(body).length === 0) {
      editError.value = 'No changes to save'
      return false
    }

    editLoading.value = true
    options.beginSubscriptionMutation()
    try {
      const updated = await deps.updateWebhook(options.webhookId, body)
      options.publishWebhook(updated)
      showEditState.value = false
      options.notifySuccess('Webhook updated')
      return true
    } catch (cause) {
      editError.value = toMessage(cause)
      return false
    } finally {
      editLoading.value = false
    }
  }

  return {
    showEdit,
    editLoading: readonly(editLoading),
    editError: readonly(editError),
    editMetadataError: readonly(editMetadataError),
    editForm,
    editAdvanced,
    editAdvancedHasConfig: readonly(editAdvancedHasConfig),
    hiddenLegacySelectorCount: readonly(hiddenLegacySelectorCount),
    isTenantOwned,
    editEventTypes,
    editEventCategories,
    editorArmed,
    openEdit,
    cancelEdit,
    submitEdit,
  }
}

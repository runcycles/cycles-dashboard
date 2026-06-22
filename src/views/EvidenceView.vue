<script setup lang="ts">
/**
 * Evidence viewer. Fetches and renders a signed Cycles evidence envelope
 * (cycles-protocol-v0.yaml §getEvidence) by its content-hash id, plus an
 * honest "signer-key resolution" check against the published JWK Set.
 *
 * Why it lives in the admin dashboard: evidence references ride on
 * runtime responses (reserve / commit / release / error). The dashboard's
 * own force-release flow surfaces a deep link here so an operator can
 * capture/verify proof of an incident-response action. It's also a
 * standalone compliance lookup — paste any evidence_id to retrieve the
 * envelope.
 *
 * NOTE on verification scope: this view resolves the *signer key*
 * (confirms the envelope's signer is a known key within its validity
 * window) but does NOT yet perform full Ed25519 signature verification —
 * that requires reproducing the JCS canonicalization the server signs
 * over, which is deferred. The UI labels this precisely so it never
 * claims more assurance than it delivers.
 */
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getEvidence, getEvidenceJwks, ApiError } from '../api/client'
import type { CyclesEvidenceEnvelope, CyclesEvidenceJwk } from '../types'
import PageHeader from '../components/PageHeader.vue'
import InlineErrorBanner from '../components/InlineErrorBanner.vue'
import LoadingSkeleton from '../components/LoadingSkeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import { formatDateTime } from '../utils/format'
import { safeJsonStringify } from '../utils/safe'
import { useToast } from '../composables/useToast'
import { toMessage } from '../utils/errors'

const route = useRoute()
const router = useRouter()
const toast = useToast()

const evidenceId = ref(typeof route.query.id === 'string' ? route.query.id : '')
const envelope = ref<CyclesEvidenceEnvelope | null>(null)
const loading = ref(false)
const error = ref('')
// Distinguish the "signed asynchronously, not yet available" 404 from a
// genuinely-unknown id so we can offer a retry instead of a dead end.
const notYetAvailable = ref(false)

const ID_RE = /^[0-9a-f]{64}$/

async function fetchEvidence() {
  const id = evidenceId.value.trim().toLowerCase()
  error.value = ''
  notYetAvailable.value = false
  envelope.value = null
  signerResult.value = null
  if (!ID_RE.test(id)) {
    error.value = 'Evidence ID must be 64 lowercase hex characters.'
    return
  }
  // Keep the URL shareable/refresh-safe.
  if (route.query.id !== id) router.replace({ query: { ...route.query, id } })
  loading.value = true
  try {
    envelope.value = await getEvidence(id)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      // Envelope is signed + stored asynchronously after the decision, so
      // a 404 right after a force-release is expected and transient.
      notYetAvailable.value = true
    } else {
      error.value = toMessage(e)
    }
  } finally {
    loading.value = false
  }
}

// ─── Signer-key resolution ──────────────────────────────────────────
interface SignerResult {
  found: boolean
  withinWindow: boolean
  kid?: string
  message: string
}
const signerResult = ref<SignerResult | null>(null)
const signerLoading = ref(false)

// The JWK kid equals the `#<kid>` fragment of a did:cycles signer_did.
function signerKid(signerDid: string): string | undefined {
  const hash = signerDid.indexOf('#')
  return hash >= 0 ? signerDid.slice(hash + 1) : undefined
}

function withinValidity(jwk: CyclesEvidenceJwk, nowMs: number): boolean {
  if (jwk.cycles_nbf_ms != null && nowMs < jwk.cycles_nbf_ms) return false
  if (jwk.cycles_exp_ms != null && nowMs >= jwk.cycles_exp_ms) return false
  return true
}

async function resolveSigner() {
  if (!envelope.value) return
  signerLoading.value = true
  signerResult.value = null
  try {
    const jwks = await getEvidenceJwks()
    const kid = signerKid(envelope.value.signer_did)
    const now = Date.now()
    const match = kid ? jwks.keys.find(k => k.kid === kid) : undefined
    if (!match) {
      signerResult.value = {
        found: false, withinWindow: false, kid,
        message: kid
          ? `No published signer key with kid "${kid}".`
          : 'signer_did carries no key id fragment — cannot resolve against the JWK Set.',
      }
      return
    }
    const ok = withinValidity(match, now)
    signerResult.value = {
      found: true, withinWindow: ok, kid,
      message: ok
        ? `Signer key "${kid}" is published and within its validity window.`
        : `Signer key "${kid}" is published but OUTSIDE its validity window.`,
    }
  } catch (e) {
    signerResult.value = { found: false, withinWindow: false, message: toMessage(e) }
  } finally {
    signerLoading.value = false
  }
}

async function copyEnvelope() {
  if (!envelope.value) return
  try {
    await navigator.clipboard.writeText(safeJsonStringify(envelope.value))
    toast.success('Envelope JSON copied')
  } catch {
    toast.error('Copy failed — clipboard unavailable')
  }
}

onMounted(() => { if (evidenceId.value) fetchEvidence() })
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <PageHeader title="Evidence" subtitle="Retrieve and inspect a signed Cycles evidence envelope" />
    <InlineErrorBanner v-if="error" :message="error" @dismiss="error = ''" />

    <div class="card p-4 mb-4">
      <label for="ev-id" class="form-label">Evidence ID</label>
      <div class="flex gap-2 items-start">
        <input
          id="ev-id"
          v-model="evidenceId"
          class="form-input-mono flex-1"
          placeholder="64-character hex content hash"
          @keyup.enter="fetchEvidence"
        />
        <button
          class="text-sm px-4 py-1.5 rounded bg-gray-900 hover:bg-gray-800 text-white dark:bg-gray-100 dark:text-gray-900 cursor-pointer disabled:opacity-50"
          :disabled="loading"
          @click="fetchEvidence"
        >{{ loading ? 'Fetching…' : 'Fetch' }}</button>
      </div>
      <p class="muted-sm mt-1">Evidence is public and content-addressed — the id alone retrieves the envelope.</p>
    </div>

    <div v-if="loading" class="card p-4"><LoadingSkeleton /></div>

    <!-- Transient 404: envelope is signed asynchronously after the
         decision, so a just-created id may not be available yet. -->
    <div v-else-if="notYetAvailable" class="card p-6">
      <EmptyState
        message="Evidence not available yet"
        hint="The envelope is signed and stored asynchronously after the decision. If you just triggered the action, wait a moment and retry."
      />
      <div class="flex justify-center mt-3">
        <button class="text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50 cursor-pointer" @click="fetchEvidence">Retry</button>
      </div>
    </div>

    <div v-else-if="envelope" class="card p-4 space-y-4 overflow-auto">
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-sm font-semibold">{{ envelope.artifact_type }} envelope</h3>
        <button class="muted-sm hover:text-gray-700 cursor-pointer px-2 py-1 rounded hover:bg-gray-100" @click="copyEnvelope">Copy JSON</button>
      </div>
      <dl class="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div><dt class="form-label">Schema version</dt><dd class="font-mono text-xs">{{ envelope.schema_version }}</dd></div>
        <div><dt class="form-label">Issued at</dt><dd>{{ formatDateTime(new Date(envelope.issued_at_ms).toISOString()) }}</dd></div>
        <div class="sm:col-span-2"><dt class="form-label">Server</dt><dd class="font-mono text-xs break-all">{{ envelope.server_id }}</dd></div>
        <div class="sm:col-span-2"><dt class="form-label">Signer DID</dt><dd class="font-mono text-xs break-all">{{ envelope.signer_did }}</dd></div>
        <div v-if="envelope.trace_id"><dt class="form-label">Trace ID</dt><dd class="font-mono text-xs break-all">{{ envelope.trace_id }}</dd></div>
        <div class="sm:col-span-2"><dt class="form-label">Evidence ID</dt><dd class="font-mono text-xs break-all">{{ envelope.evidence_id }}</dd></div>
        <div class="sm:col-span-2"><dt class="form-label">Signature</dt><dd class="font-mono text-xs break-all">{{ envelope.signature }}</dd></div>
      </dl>

      <div>
        <div class="flex items-center gap-2 mb-1">
          <span class="form-label">Signer-key resolution</span>
          <button
            class="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50 cursor-pointer disabled:opacity-50"
            :disabled="signerLoading"
            @click="resolveSigner"
          >{{ signerLoading ? 'Resolving…' : 'Resolve signer key' }}</button>
        </div>
        <p
          v-if="signerResult"
          class="text-sm rounded px-3 py-2"
          :class="signerResult.found && signerResult.withinWindow
            ? 'bg-green-50 text-green-800 border border-green-200'
            : 'bg-amber-50 text-amber-800 border border-amber-200'"
        >{{ signerResult.message }}</p>
        <p class="muted-sm mt-1">
          Confirms the signer key is published and currently valid. Full
          Ed25519 signature verification is not yet performed in-browser.
        </p>
      </div>

      <div>
        <span class="form-label">Payload</span>
        <pre class="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-3 overflow-auto max-h-96">{{ safeJsonStringify(envelope.payload) }}</pre>
      </div>
    </div>

    <div v-else class="card p-6">
      <EmptyState
        message="No envelope loaded"
        hint="Paste an evidence ID above, or arrive here from a force-release in the Reservations view."
      />
    </div>
  </div>
</template>

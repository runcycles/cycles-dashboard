<script setup lang="ts">
/**
 * Structured builder for canonical Cycles scopes.
 *
 * Replaces a free-text `<input>` with a row-per-segment UI that:
 *   - Locks the first row to `tenant:<tenantId>` (enforces the cross-field
 *     check automatically — users can't submit a scope that targets a
 *     different tenant than the one they're working in).
 *   - Adds deeper segments via an "+ Add level" dropdown that only offers
 *     canonical kinds that (a) aren't yet used and (b) come after the
 *     last-used kind (preserves canonical order: tenant -> workspace ->
 *     app -> workflow -> agent -> toolset).
 *   - Per-row id chooser: a literal id text input OR "any (*)" radio for
 *     id-wildcards (`agent:*` etc). Picking "any" disables deeper rows
 *     (id-wildcards must be terminal per spec).
 *   - Optional terminal `/*` "match everything deeper" checkbox for
 *     policy scope_patterns (allowWildcards=true). Deliberately separate
 *     from per-row "any id" because semantically it's NOT a segment —
 *     it's a catch-all suffix.
 *   - Live `Preview: tenant:acme/agent:*` line in monospace under the
 *     rows so users who already know the format can sanity-check the
 *     serialized output.
 *
 * Parses an existing value on mount (used by the Edit Policy flow). If
 * parsing fails — because the stored scope is legacy non-canonical —
 * falls back to the tenant-locked root and surfaces the original string
 * via the `parseError` ref so the dialog can show a warning.
 */
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  modelValue: string
  tenantId: string
  allowWildcards?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()

// Canonical kinds in priority order. Source of truth for UI and must
// match cycles-server-admin's ScopeValidator CANONICAL_KINDS.
const CANONICAL_KINDS = ['tenant', 'workspace', 'app', 'workflow', 'agent', 'toolset'] as const
type Kind = typeof CANONICAL_KINDS[number]

interface Segment { kind: Kind; id: string; anyId: boolean }

// Segments beyond the locked tenant row. The tenant row is derived
// from props.tenantId (not stored here) so renaming the tenant prop
// propagates automatically.
const extra = ref<Segment[]>([])
const trailingWildcard = ref(false)
const parseError = ref<string | null>(null)

function tenantSegment(): Segment {
  return { kind: 'tenant', id: props.tenantId, anyId: false }
}

function serialize(): string {
  const segs = [tenantSegment(), ...extra.value]
  const parts = segs.map(s => `${s.kind}:${s.anyId ? '*' : s.id}`)
  if (trailingWildcard.value) parts.push('*')
  return parts.join('/')
}

// Parse an incoming string into our state. Accepts canonical forms:
//   tenant:<id>
//   tenant:<id>/<kind>:<id>...
//   tenant:<id>/.../<kind>:*       (id-wildcard terminal)
//   tenant:<id>/.../*              (all-descendants terminal)
// Anything non-canonical is signalled via parseError and reduced to the
// tenant root so the form at least loads instead of silently corrupting.
function parse(raw: string): void {
  parseError.value = null
  extra.value = []
  trailingWildcard.value = false
  if (!raw) return
  const parts = raw.split('/')
  if (parts.length === 0 || !parts[0].startsWith('tenant:')) {
    parseError.value = `Could not parse scope "${raw}". Starting from tenant:${props.tenantId}.`
    return
  }
  // First segment MUST be tenant:<props.tenantId>; otherwise we reject
  // (builder can't represent a cross-tenant scope and cross-check would
  // reject on submit anyway).
  const tenantId = parts[0].slice('tenant:'.length)
  if (tenantId !== props.tenantId) {
    parseError.value = `Scope tenant "${tenantId}" doesn't match current tenant "${props.tenantId}".`
    return
  }
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i]
    if (seg === '*') {
      if (i !== parts.length - 1) {
        parseError.value = `Wildcard '*' must be the final segment.`
        return
      }
      trailingWildcard.value = true
      break
    }
    const colon = seg.indexOf(':')
    if (colon <= 0) { parseError.value = `Malformed segment "${seg}".`; return }
    const kind = seg.slice(0, colon) as Kind
    const id = seg.slice(colon + 1)
    if (!CANONICAL_KINDS.includes(kind) || kind === 'tenant') {
      parseError.value = `Unknown or duplicate kind "${kind}".`
      return
    }
    extra.value.push({ kind, id: id === '*' ? '' : id, anyId: id === '*' })
  }
}

// Kinds the user can still add as a deeper level. Rules:
//   - Never the tenant kind (locked, always first).
//   - Strictly after the last-used kind in canonical order (preserves
//     the invariant the server enforces).
//   - Nothing if the last row is id-wildcarded or we already have a
//     trailing /* — id-wildcard and bare-* wildcards must be terminal.
const availableKinds = computed<Kind[]>(() => {
  if (trailingWildcard.value) return []
  const last = extra.value[extra.value.length - 1]
  if (last?.anyId) return []
  const lastIdx = last
    ? CANONICAL_KINDS.indexOf(last.kind)
    : CANONICAL_KINDS.indexOf('tenant')
  return CANONICAL_KINDS.slice(lastIdx + 1) as Kind[]
})

function addLevel(kind: Kind) {
  extra.value.push({ kind, id: '', anyId: false })
}

function removeRow(index: number) {
  extra.value.splice(index, 1)
  // If the last row was removed and it had anyId, deeper rows don't
  // exist anymore so nothing else to reset.
}

function setAnyId(index: number, anyId: boolean) {
  extra.value[index].anyId = anyId
  if (anyId) {
    // id-wildcards are terminal — drop any deeper rows that would now
    // be invalid. Also clear the trailing /* (redundant with any-id).
    extra.value = extra.value.slice(0, index + 1)
    trailingWildcard.value = false
  }
}

// Sync state -> parent on any change.
watch([extra, trailingWildcard, () => props.tenantId], () => {
  emit('update:modelValue', serialize())
}, { deep: true })

// One-time parse of initial modelValue. We don't watch modelValue
// otherwise — the component owns the UI state once mounted, and
// external programmatic resets (like "open dialog with fresh form")
// remount the component, triggering parse() fresh.
parse(props.modelValue || `tenant:${props.tenantId}`)
// Ensure parent has a valid initial value even if it was empty.
emit('update:modelValue', serialize())

const preview = computed(() => serialize())
</script>

<template>
  <div class="space-y-2">
    <p v-if="parseError" class="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1" role="alert">
      {{ parseError }}
    </p>
    <div class="border border-gray-200 rounded divide-y divide-gray-100 bg-white">
      <!-- Locked tenant row: always first, always editable-id-off. The
           tenant id comes from the route (current tenant detail), which
           makes the admin-on-behalf-of cross-field check trivially pass. -->
      <div class="flex items-center gap-2 px-3 py-2 text-sm bg-gray-50">
        <span class="inline-block w-24 text-xs font-medium text-gray-500">tenant</span>
        <span class="font-mono text-sm flex-1">{{ props.tenantId }}</span>
        <span class="text-xs text-gray-400">locked</span>
      </div>
      <!-- User-added deeper segments. Each row: kind label, id radio +
           text input, remove button. -->
      <div v-for="(seg, i) in extra" :key="i" class="px-3 py-2 text-sm">
        <div class="flex items-center gap-2">
          <span class="inline-block w-24 text-xs font-medium text-gray-500">{{ seg.kind }}</span>
          <div class="flex-1 flex items-center gap-3 flex-wrap">
            <label class="inline-flex items-center gap-1 text-xs cursor-pointer">
              <input type="radio" :name="`seg-${i}-idmode`" :checked="!seg.anyId" @change="setAnyId(i, false)" />
              <span>id:</span>
            </label>
            <input
              :id="`scope-seg-${i}-id`"
              v-model="seg.id"
              :disabled="seg.anyId"
              :required="!seg.anyId"
              class="border border-gray-300 rounded px-2 py-1 text-sm font-mono flex-1 min-w-40 disabled:bg-gray-100 disabled:text-gray-400"
              placeholder="e.g. prod, reviewer, v2.1"
            />
            <label v-if="props.allowWildcards" class="inline-flex items-center gap-1 text-xs cursor-pointer">
              <input type="radio" :name="`seg-${i}-idmode`" :checked="seg.anyId" @change="setAnyId(i, true)" />
              <span>any {{ seg.kind }} (*)</span>
            </label>
          </div>
          <button
            type="button"
            @click="removeRow(i)"
            :aria-label="`Remove ${seg.kind} level`"
            class="text-gray-400 hover:text-red-600 cursor-pointer text-sm"
          >✕</button>
        </div>
      </div>
    </div>
    <!-- Add-level dropdown. Disabled when there are no more kinds to
         add (terminal anyId, trailing /*, or all canonical kinds used). -->
    <div class="flex items-center gap-2">
      <select
        v-if="availableKinds.length > 0"
        class="border border-gray-300 rounded px-2 py-1 text-sm bg-white"
        @change="(e) => { const v = (e.target as HTMLSelectElement).value; if (v) { addLevel(v as Kind); (e.target as HTMLSelectElement).value = '' } }"
      >
        <option value="">+ Add level</option>
        <option v-for="k in availableKinds" :key="k" :value="k">{{ k }}</option>
      </select>
      <span v-else class="text-xs text-gray-400">No more levels available.</span>
    </div>
    <!-- Policy-only: trailing /* for "match everything deeper than the
         last concrete segment." Deliberately below the row list —
         conceptually it isn't a segment, it's a suffix. -->
    <label v-if="props.allowWildcards" class="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
      <input
        type="checkbox"
        v-model="trailingWildcard"
        :disabled="extra.length > 0 && extra[extra.length - 1].anyId"
      />
      <span>Also match everything deeper (append <code class="font-mono">/*</code>)</span>
    </label>
    <!-- Live preview of the serialized scope. Monospace so users who
         already know the format can sanity-check exactly what gets sent. -->
    <div class="text-xs text-gray-500 flex items-baseline gap-2">
      <span>Will create as:</span>
      <code class="font-mono text-gray-800 bg-gray-50 px-2 py-0.5 rounded border border-gray-200 break-all">{{ preview }}</code>
    </div>
  </div>
</template>

<script setup lang="ts">
// Single-control time-range picker modeled on Cloudflare Analytics /
// Grafana / Datadog: one trigger button whose label reflects the
// current selection ("Last 24 hours", "Apr 10 14:00 → Apr 17 09:00",
// "All time"), and a popover with preset radios + an optional Custom
// range section with From/To datetime-local inputs.
//
// Replaces the From + To + Quick-chips triad that used to eat three
// field columns on filter forms. The component is controlled —
// modelValue is the source of truth (datetime-local strings; empty
// string means "unbounded"). Parents usually bind this via a
// `computed({ get, set })` over their existing fromDate / toDate
// refs so server-side filter builders don't need refactoring.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'

export type TimeRangePreset = {
  // Stable id. Used as `data-preset="<id>"` for test targeting.
  id: string
  // Label shown in the preset list and (when selected) on the
  // trigger button.
  label: string
  // Window size in hours from "now". null marks the "all time"
  // preset — emits { from: '', to: '' } meaning unbounded.
  hours: number | null
}

interface Props {
  modelValue: { from: string; to: string }
  presets?: TimeRangePreset[]
  // Show the Custom-range radio + From/To inputs under the preset
  // list. Off for flows where only relative presets make sense
  // (e.g. dashboards pinned to rolling windows).
  allowCustom?: boolean
  // Used to derive stable ids for the trigger button + custom
  // inputs so tests and a11y tooling can target them.
  id?: string
  // aria-label on the trigger button. Screen readers read this
  // alongside the current-value label.
  ariaLabel?: string
}

const props = withDefaults(defineProps<Props>(), {
  // Defaults sized for ops triage — hour-scale for incidents,
  // day-scale for report-style queries, All time as the unfiltered
  // baseline.
  presets: () => [
    { id: '1h',  label: 'Last hour',     hours: 1 },
    { id: '6h',  label: 'Last 6 hours',  hours: 6 },
    { id: '24h', label: 'Last 24 hours', hours: 24 },
    { id: '7d',  label: 'Last 7 days',   hours: 24 * 7 },
    { id: '30d', label: 'Last 30 days',  hours: 24 * 30 },
    { id: 'all', label: 'All time',      hours: null },
  ],
  allowCustom: true,
  id: 'time-range',
  ariaLabel: 'Time range',
})

const emit = defineEmits<{
  (e: 'update:modelValue', v: { from: string; to: string }): void
}>()

const open = ref(false)
// Initial mode + activePresetId derive from props synchronously so
// the first render's trigger label reflects the actual modelValue
// (not the onMounted-flushed value one tick later). Empty modelValue
// → 'all' preset; non-empty → custom mode (we can't reverse-engineer
// which preset produced a given datetime pair because the preset
// window slides with "now").
const allPreset = props.presets.find(p => p.hours === null)
const initialMode: 'preset' | 'custom' =
  !props.modelValue.from && !props.modelValue.to ? 'preset' : 'custom'
const mode = ref<'preset' | 'custom'>(initialMode)
const activePresetId = ref<string>(initialMode === 'preset' && allPreset ? allPreset.id : '')
// Draft values for the Custom-range inputs. Separate from
// modelValue so typing in the From/To fields doesn't commit until
// Apply is clicked — matches Cloudflare's flow where the custom
// range is a two-step interaction.
const draftFrom = ref(props.modelValue.from)
const draftTo = ref(props.modelValue.to)

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatDisplay(s: string): string {
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  const pad = (n: number) => String(n).padStart(2, '0')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const triggerLabel = computed(() => {
  if (mode.value === 'preset') {
    const p = props.presets.find(p => p.id === activePresetId.value)
    if (p) return p.label
  }
  const { from, to } = props.modelValue
  if (from && to) return `${formatDisplay(from)} → ${formatDisplay(to)}`
  if (from)       return `Since ${formatDisplay(from)}`
  if (to)         return `Until ${formatDisplay(to)}`
  return 'All time'
})

function syncFromModelValue() {
  const { from, to } = props.modelValue
  if (!from && !to) {
    // Unbounded — default to the 'all' preset if one exists so the
    // button reads "All time" rather than a raw empty-range string.
    const all = props.presets.find(p => p.hours === null)
    mode.value = 'preset'
    activePresetId.value = all ? all.id : ''
  } else {
    // External values present. Without a round-trip hint there's no
    // way to know which preset produced them (the preset window
    // moves with "now"), so surface the raw range.
    mode.value = 'custom'
    activePresetId.value = ''
  }
  draftFrom.value = from
  draftTo.value = to
}

// If the parent mutates modelValue externally (e.g. URL restore,
// applyQueryParams after a same-route navigation), re-sync so the
// button label tracks. We don't re-sync when the user is mid-edit
// (popover open, mode=custom) — stomping the draft values during
// typing would be user-hostile. The open-popover guard keeps the
// parent-emitted value from overwriting the user's draft.
watch(() => props.modelValue, (v, prev) => {
  if (open.value && mode.value === 'custom') return
  if (v.from === prev.from && v.to === prev.to) return
  syncFromModelValue()
}, { deep: true })

function selectPreset(p: TimeRangePreset) {
  activePresetId.value = p.id
  mode.value = 'preset'
  if (p.hours === null) {
    emit('update:modelValue', { from: '', to: '' })
  } else {
    const now = new Date()
    const from = new Date(now.getTime() - p.hours * 3600_000)
    emit('update:modelValue', { from: toLocalInput(from), to: toLocalInput(now) })
  }
  open.value = false
}

function enterCustom() {
  mode.value = 'custom'
  activePresetId.value = ''
  draftFrom.value = props.modelValue.from
  draftTo.value = props.modelValue.to
}

function applyCustom() {
  emit('update:modelValue', { from: draftFrom.value, to: draftTo.value })
  open.value = false
}

function toggle() {
  open.value = !open.value
}

// Close on click-outside + Escape. Listeners attach on mount so
// there's no resource leak between open/close cycles — the cost is
// one document listener for the component's lifetime, which is
// negligible vs. the perf of re-binding per open.
const rootRef = ref<HTMLElement | null>(null)
function onDocClick(e: MouseEvent) {
  if (!open.value) return
  const target = e.target as Node | null
  if (rootRef.value && target && !rootRef.value.contains(target)) {
    open.value = false
  }
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    open.value = false
  }
}
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="rootRef" class="relative">
    <button
      type="button"
      :id="id"
      :aria-haspopup="'dialog'"
      :aria-expanded="open"
      :aria-label="ariaLabel"
      :data-testid="`${id}-trigger`"
      @click="toggle"
      class="form-input flex items-center justify-between gap-2 cursor-pointer text-left"
    >
      <span class="truncate">{{ triggerLabel }}</span>
      <svg class="w-4 h-4 shrink-0 muted-sm" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    </button>

    <div
      v-if="open"
      role="dialog"
      :aria-label="ariaLabel"
      :data-testid="`${id}-popover`"
      class="absolute right-0 mt-1 z-20 w-72 card p-3 shadow-lg"
    >
      <div role="radiogroup" :aria-label="`${ariaLabel} presets`" class="flex flex-col gap-0.5">
        <button
          v-for="p in presets"
          :key="p.id"
          type="button"
          role="radio"
          :data-preset="p.id"
          :aria-checked="mode === 'preset' && activePresetId === p.id"
          @click="selectPreset(p)"
          class="w-full text-left text-sm px-2 py-1.5 rounded cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800"
          :class="mode === 'preset' && activePresetId === p.id
            ? 'bg-gray-100 dark:bg-gray-800 font-medium'
            : ''"
        >{{ p.label }}</button>
      </div>
      <template v-if="allowCustom">
        <div class="border-t border-gray-200 dark:border-gray-700 mt-3 pt-3">
          <button
            type="button"
            role="radio"
            data-preset="custom"
            :aria-checked="mode === 'custom'"
            @click="enterCustom"
            class="w-full text-left text-sm px-2 py-1.5 rounded cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800"
            :class="mode === 'custom' ? 'bg-gray-100 dark:bg-gray-800 font-medium' : ''"
          >Custom range…</button>
          <div v-if="mode === 'custom'" class="mt-2 space-y-2">
            <div>
              <label :for="`${id}-custom-from`" class="form-label">From</label>
              <input :id="`${id}-custom-from`" v-model="draftFrom" type="datetime-local" class="form-input" />
            </div>
            <div>
              <label :for="`${id}-custom-to`" class="form-label">To</label>
              <input :id="`${id}-custom-to`" v-model="draftTo" type="datetime-local" class="form-input" />
            </div>
            <div class="flex justify-end">
              <button
                type="button"
                :data-testid="`${id}-custom-apply`"
                @click="applyCustom"
                class="bg-gray-900 text-white px-3 py-1 rounded text-xs hover:bg-gray-800 cursor-pointer"
              >Apply</button>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

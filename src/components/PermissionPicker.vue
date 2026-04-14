<script setup lang="ts">
import { computed } from 'vue'
import { PERMISSION_GROUPS } from '../types'

const props = defineProps<{ modelValue: string[] }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string[]): void }>()

// Normalize model to a Set for fast membership checks during render.
const selectedSet = computed(() => new Set(props.modelValue))

// Display label = tail after the last colon. In the Reservations section
// "reservations:create" renders as "create"; in the wildcard plane
// "admin:read" renders as "read". The heading above each section provides
// the context, so the tail alone is unambiguous inside the picker.
function displayLabel(perm: string): string {
  const idx = perm.lastIndexOf(':')
  return idx >= 0 ? perm.slice(idx + 1) : perm
}

function toggleOne(perm: string) {
  const next = new Set(props.modelValue)
  if (next.has(perm)) next.delete(perm)
  else next.add(perm)
  emit('update:modelValue', Array.from(next))
}

// Tristate bulk toggle: if every item in `items` is already selected,
// clear them all; otherwise select them all. Matches the "checkbox on a
// header row" idiom — one click fills, another click empties.
function toggleGroup(items: readonly string[]) {
  const allSelected = items.every(p => selectedSet.value.has(p))
  const next = new Set(props.modelValue)
  if (allSelected) {
    for (const p of items) next.delete(p)
  } else {
    for (const p of items) next.add(p)
  }
  emit('update:modelValue', Array.from(next))
}

function countSelected(items: readonly string[]): number {
  let n = 0
  for (const p of items) if (selectedSet.value.has(p)) n++
  return n
}

// 'none' | 'some' | 'all' — drives the checkbox visual state. Vue's
// native indeterminate binding needs a direct DOM ref, so we compute the
// state and bind indeterminate via :indeterminate and :checked separately.
function groupState(items: readonly string[]): 'none' | 'some' | 'all' {
  const n = countSelected(items)
  if (n === 0) return 'none'
  if (n === items.length) return 'all'
  return 'some'
}
</script>

<template>
  <!--
    Layout note: tried side-by-side columns for the three planes in a
    prior revision, but the edit dialog width (~600-700px in practice)
    isn't enough to fit three columns of nested content — section
    headers wrap awkwardly, the internal grid-cols-2 of checkboxes
    compresses, and counts ("3/5") fall to the next line. Stacked
    single-column is the honest fit for this dialog size. If someone
    later widens the dialog materially, revisit.
  -->
  <div class="border border-gray-200 rounded p-2 space-y-3 max-h-[28rem] overflow-y-auto">
    <div v-for="plane in PERMISSION_GROUPS" :key="plane.plane" class="space-y-1.5">
      <!-- Plane header: aggregate bulk-select across all sections in the plane -->
      <label class="flex items-center gap-2 text-xs font-medium text-gray-700 bg-gray-50 px-2 py-1 rounded cursor-pointer">
        <input
          type="checkbox"
          class="rounded"
          :checked="groupState(plane.sections.flatMap(s => s.items)) === 'all'"
          :indeterminate.prop="groupState(plane.sections.flatMap(s => s.items)) === 'some'"
          @change="toggleGroup(plane.sections.flatMap(s => s.items))"
        />
        <span class="flex-1">{{ plane.plane }}</span>
        <span class="text-gray-400 font-normal">
          {{ countSelected(plane.sections.flatMap(s => s.items)) }}
          /
          {{ plane.sections.flatMap(s => s.items).length }}
        </span>
      </label>

      <!-- Sections within the plane -->
      <div v-for="(section, si) in plane.sections" :key="si" class="ml-4 space-y-1">
        <!-- Section sub-header (omitted when label is null, e.g. admin wildcards) -->
        <label
          v-if="section.label"
          class="flex items-center gap-2 text-xs text-gray-600 cursor-pointer"
        >
          <input
            type="checkbox"
            class="rounded"
            :checked="groupState(section.items) === 'all'"
            :indeterminate.prop="groupState(section.items) === 'some'"
            @change="toggleGroup(section.items)"
          />
          <span class="flex-1">{{ section.label }}</span>
          <span class="text-gray-400">
            {{ countSelected(section.items) }} / {{ section.items.length }}
          </span>
        </label>

        <!-- Individual permission checkboxes -->
        <div class="grid grid-cols-2 gap-x-3 gap-y-1" :class="section.label ? 'ml-5' : ''">
          <label
            v-for="p in section.items"
            :key="p"
            class="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer"
          >
            <input
              type="checkbox"
              class="rounded"
              :value="p"
              :checked="selectedSet.has(p)"
              @change="toggleOne(p)"
            />
            <span class="font-mono">{{ displayLabel(p) }}</span>
          </label>
        </div>
      </div>
    </div>
  </div>
</template>

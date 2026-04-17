<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'

// Declarative row-level action menu (kebab ⋮). Replaces the inline
// btn-row-* button flex patterns that inflated tables like ApiKeysView.
//
// Design matches GitHub / Stripe Dashboard / Linear / Vercel: a single
// overflow trigger per row; destructive items grouped after a
// separator; no focus-trap (menu, not modal); Esc/click-outside to
// dismiss. A labeled variant (triggerLabel) is used for detail-view
// headers (WebhookDetailView) where a bare kebab reads as too
// mysterious next to the inline primary action.
//
// Teleports to <body> so the popover is not clipped by the parent
// virtualized grid's overflow:hidden — tables in this app use
// @tanstack/vue-virtual which relies on that clip.

export interface RowActionItem {
  label?: string
  onClick?: () => void
  to?: RouteLocationRaw
  disabled?: boolean
  disabledReason?: string
  danger?: boolean
  hidden?: boolean
  separator?: true
}

const props = withDefaults(defineProps<{
  items: RowActionItem[]
  ariaLabel?: string
  align?: 'left' | 'right'
  triggerLabel?: string
}>(), {
  ariaLabel: 'Row actions',
  align: 'right',
})

const open = ref(false)
const triggerEl = ref<HTMLButtonElement | null>(null)
const menuEl = ref<HTMLUListElement | null>(null)
const activeIdx = ref<number>(-1)
const menuStyle = ref<Record<string, string>>({})

// Drop hidden items and collapse leading/trailing/duplicate separators
// so a section whose entire contents got hidden (e.g. by status gate)
// doesn't leave a floating divider.
const visibleItems = computed(() => {
  const filtered = props.items.filter(i => !i.hidden)
  return filtered.filter((it, i, arr) => {
    if (!it.separator) return true
    if (i === 0 || i === arr.length - 1) return false
    if (arr[i - 1]?.separator) return false
    return true
  })
})

const interactiveIdxs = computed<number[]>(() =>
  visibleItems.value
    .map((it, i) => (!it.separator && !it.disabled ? i : -1))
    .filter(i => i >= 0),
)

// When every item is hidden (e.g. canManage=true but status doesn't
// permit any action right now), render nothing at all rather than an
// inert kebab that opens an empty menu.
const hasAny = computed(() => visibleItems.value.some(i => !i.separator))

function computePosition() {
  const t = triggerEl.value
  if (!t) return
  const rect = t.getBoundingClientRect()
  const top = rect.bottom + 4
  menuStyle.value =
    props.align === 'right'
      ? { position: 'fixed', top: `${top}px`, right: `${window.innerWidth - rect.right}px` }
      : { position: 'fixed', top: `${top}px`, left: `${rect.left}px` }
}

// Flip above the trigger if the natural below-placement would overflow
// the viewport. Measured after the menu renders (otherwise we have no
// height to check against).
function adjustOverflow() {
  const m = menuEl.value
  const t = triggerEl.value
  if (!m || !t) return
  const mRect = m.getBoundingClientRect()
  const tRect = t.getBoundingClientRect()
  if (mRect.bottom > window.innerHeight - 8) {
    menuStyle.value = {
      ...menuStyle.value,
      top: `${Math.max(8, tRect.top - mRect.height - 4)}px`,
    }
  }
}

async function openMenu(focusFirst: boolean) {
  computePosition()
  open.value = true
  await nextTick()
  adjustOverflow()
  const idxs = interactiveIdxs.value
  if (idxs.length === 0) return
  activeIdx.value = focusFirst ? idxs[0] : idxs[idxs.length - 1]
  focusActive()
}

function close(returnFocus = false) {
  open.value = false
  activeIdx.value = -1
  if (returnFocus) triggerEl.value?.focus()
}

function toggle() {
  if (open.value) close()
  else openMenu(true)
}

function focusActive() {
  const el = menuEl.value?.querySelector<HTMLElement>(`[data-idx="${activeIdx.value}"]`)
  el?.focus()
}

function onTriggerKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    openMenu(true)
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    openMenu(true)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    openMenu(false)
  }
}

function onMenuKeydown(e: KeyboardEvent) {
  const idxs = interactiveIdxs.value
  if (idxs.length === 0) return
  const cur = idxs.indexOf(activeIdx.value)
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIdx.value = cur < idxs.length - 1 ? idxs[cur + 1] : idxs[0]
    focusActive()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIdx.value = cur > 0 ? idxs[cur - 1] : idxs[idxs.length - 1]
    focusActive()
  } else if (e.key === 'Home') {
    e.preventDefault()
    activeIdx.value = idxs[0]
    focusActive()
  } else if (e.key === 'End') {
    e.preventDefault()
    activeIdx.value = idxs[idxs.length - 1]
    focusActive()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    close(true)
  } else if (e.key === 'Tab') {
    // Let Tab proceed naturally — closing returns focus to trigger
    // first, which means the next Tab moves past it. That matches
    // native <select> dismissal behavior.
    close(true)
  }
}

function onDocumentMousedown(e: MouseEvent) {
  if (!open.value) return
  const target = e.target as Node
  if (triggerEl.value?.contains(target)) return
  if (menuEl.value?.contains(target)) return
  close()
}

function onWindowScroll() {
  // Scrolling drifts the trigger's bounding rect — rather than recompute
  // continuously, dismiss. Matches native <select> behavior.
  if (open.value) close()
}

function onWindowResize() {
  if (open.value) close()
}

watch(open, v => {
  if (v) {
    document.addEventListener('mousedown', onDocumentMousedown)
    // `true` (capture) so scrolls on any ancestor — including the
    // virtualized grid's internal scroll container — trigger dismiss.
    window.addEventListener('scroll', onWindowScroll, true)
    window.addEventListener('resize', onWindowResize)
  } else {
    document.removeEventListener('mousedown', onDocumentMousedown)
    window.removeEventListener('scroll', onWindowScroll, true)
    window.removeEventListener('resize', onWindowResize)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMousedown)
  window.removeEventListener('scroll', onWindowScroll, true)
  window.removeEventListener('resize', onWindowResize)
})

function onItemClick(item: RowActionItem) {
  if (item.disabled || item.separator) return
  item.onClick?.()
  close(true)
}
</script>

<template>
  <button
    v-if="hasAny"
    ref="triggerEl"
    type="button"
    :class="triggerLabel ? 'btn-pill-secondary inline-flex items-center gap-1' : 'btn-row-kebab'"
    :aria-label="ariaLabel"
    aria-haspopup="menu"
    :aria-expanded="open"
    @click.stop="toggle"
    @keydown="onTriggerKeydown"
  >
    <template v-if="triggerLabel">
      {{ triggerLabel }}
      <svg aria-hidden="true" class="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5l3 3 3-3" /></svg>
    </template>
    <svg v-else aria-hidden="true" viewBox="0 0 16 16" class="w-4 h-4" fill="currentColor">
      <circle cx="8" cy="3" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="8" cy="13" r="1.4" />
    </svg>
  </button>

  <Teleport v-if="open" to="body">
    <ul
      ref="menuEl"
      role="menu"
      :aria-label="ariaLabel"
      :style="menuStyle"
      class="row-actions-menu"
      @keydown="onMenuKeydown"
    >
      <template v-for="(item, idx) in visibleItems" :key="idx">
        <li v-if="item.separator" role="separator" class="row-actions-separator" />
        <li v-else role="none">
          <RouterLink
            v-if="item.to && !item.disabled"
            :to="item.to"
            role="menuitem"
            tabindex="-1"
            :data-idx="idx"
            class="row-actions-item"
            :class="{ 'row-actions-item-danger': item.danger }"
            @click="close()"
          >{{ item.label }}</RouterLink>
          <button
            v-else
            type="button"
            role="menuitem"
            tabindex="-1"
            :data-idx="idx"
            :disabled="item.disabled"
            :aria-disabled="item.disabled || undefined"
            :title="item.disabled ? item.disabledReason : undefined"
            class="row-actions-item"
            :class="{ 'row-actions-item-danger': item.danger && !item.disabled }"
            @click="onItemClick(item)"
          >{{ item.label }}</button>
        </li>
      </template>
    </ul>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useCommandPalette } from '../composables/useCommandPalette'
import { useDebouncedRef } from '../composables/useDebouncedRef'
import type { Tenant } from '../types'

// W3: global "Find tenant" palette (Cmd/Ctrl-K). Operator workflow at
// scale is "I have a tenant_id or name, show me everything" — this
// lets them jump straight to /tenants/:id without navigating each
// list view and typing into its per-view search input.
//
// Filter is client-side over the cached tenant set (see
// useCommandPalette). Debounced 150ms: substring + id match against
// names and tenant_ids is cheap for the cached window (≤150 tenants),
// but debouncing still smooths paint during fast typing.

const router = useRouter()
const { isOpen, close, loadInitial, loadMore } = useCommandPalette()

const input = ref<HTMLInputElement | null>(null)
const query = ref('')
const debouncedQuery = useDebouncedRef(query, 150)
const tenants = ref<Tenant[]>([])
const hasMore = ref(false)
const loading = ref(false)
const loadingMore = ref(false)
const error = ref<string | null>(null)
const activeIndex = ref(0)
const listboxId = 'command-palette-listbox'

const filtered = computed<Tenant[]>(() => {
  const q = debouncedQuery.value.trim().toLowerCase()
  if (!q) return tenants.value.slice(0, 50)
  const matches: Tenant[] = []
  for (const t of tenants.value) {
    const name = (t.name || '').toLowerCase()
    const id = t.tenant_id.toLowerCase()
    if (name.includes(q) || id.includes(q)) matches.push(t)
    if (matches.length >= 50) break
  }
  return matches
})

watch(filtered, () => {
  // Clamp active index whenever the filtered set shrinks or grows so
  // arrow-key navigation never points past the end of the list.
  activeIndex.value = 0
})

async function open() {
  loading.value = true
  error.value = null
  try {
    const cache = await loadInitial()
    tenants.value = cache.tenants
    hasMore.value = cache.hasMore
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
  await nextTick()
  input.value?.focus()
}

async function onLoadMore() {
  if (loadingMore.value || !hasMore.value) return
  loadingMore.value = true
  try {
    const cache = await loadMore()
    if (cache) {
      tenants.value = cache.tenants
      hasMore.value = cache.hasMore
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loadingMore.value = false
  }
}

function select(t: Tenant) {
  close()
  query.value = ''
  router.push({ name: 'tenant-detail', params: { id: t.tenant_id } })
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (filtered.value.length === 0) return
    activeIndex.value = (activeIndex.value + 1) % filtered.value.length
    scrollActiveIntoView()
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (filtered.value.length === 0) return
    activeIndex.value = (activeIndex.value - 1 + filtered.value.length) % filtered.value.length
    scrollActiveIntoView()
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    const pick = filtered.value[activeIndex.value]
    if (pick) select(pick)
  }
}

const listEl = ref<HTMLElement | null>(null)
function scrollActiveIntoView() {
  nextTick(() => {
    const node = listEl.value?.querySelector<HTMLElement>(`[data-index="${activeIndex.value}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  })
}

watch(isOpen, (v) => {
  if (v) void open()
  else {
    query.value = ''
    activeIndex.value = 0
  }
})

onMounted(() => {
  if (isOpen.value) void open()
})

function activeDescendantId(): string | undefined {
  if (filtered.value.length === 0) return undefined
  return `${listboxId}-option-${activeIndex.value}`
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-100 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="isOpen"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        class="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] px-4 bg-black/40"
        @click.self="close"
      >
        <div
          class="w-full max-w-xl bg-white dark:bg-gray-900 rounded-lg shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden"
          @keydown="onKeydown"
        >
          <div class="flex items-center gap-2 border-b border-gray-200 dark:border-gray-700 px-3">
            <svg class="w-4 h-4 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <label id="command-palette-title" class="sr-only" for="command-palette-input">Search tenants</label>
            <input
              id="command-palette-input"
              ref="input"
              v-model="query"
              type="search"
              role="combobox"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              :aria-expanded="filtered.length > 0"
              :aria-controls="listboxId"
              :aria-activedescendant="activeDescendantId()"
              placeholder="Search tenants by name or ID…"
              class="flex-1 py-3 bg-transparent text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none"
            />
            <kbd class="hidden sm:inline-block text-xs text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5">Esc</kbd>
          </div>

          <div
            :id="listboxId"
            ref="listEl"
            role="listbox"
            aria-label="Tenant results"
            class="max-h-80 overflow-y-auto overflow-x-hidden"
          >
            <div v-if="error" role="alert" class="p-4 text-sm text-red-700 dark:text-red-400">{{ error }}</div>
            <div v-else-if="loading" class="p-6 text-sm text-center text-gray-500 dark:text-gray-400">Loading tenants…</div>
            <div v-else-if="filtered.length === 0" class="p-6 text-sm text-center text-gray-500 dark:text-gray-400">
              <template v-if="tenants.length === 0">No tenants available</template>
              <template v-else-if="query">No tenants match "{{ query }}"</template>
              <template v-else>No tenants</template>
            </div>
            <div v-else>
              <button
                v-for="(t, i) in filtered"
                :key="t.tenant_id"
                type="button"
                role="option"
                :id="`${listboxId}-option-${i}`"
                :data-index="i"
                :aria-selected="i === activeIndex"
                :class="[
                  'w-full text-left px-3 py-2 flex items-center gap-3 cursor-pointer transition-colors',
                  i === activeIndex
                    ? 'bg-blue-50 dark:bg-blue-900/30'
                    : 'hover:bg-gray-50 dark:hover:bg-gray-800',
                ]"
                @mouseenter="activeIndex = i"
                @click="select(t)"
              >
                <div class="flex-1 min-w-0">
                  <div class="text-sm text-gray-900 dark:text-gray-100 truncate">{{ t.name || t.tenant_id }}</div>
                  <div class="text-xs text-gray-500 dark:text-gray-400 font-mono truncate">{{ t.tenant_id }}</div>
                </div>
                <span
                  class="text-xs px-1.5 py-0.5 rounded shrink-0"
                  :class="t.status === 'ACTIVE'
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                    : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'"
                >{{ t.status }}</span>
              </button>
            </div>
          </div>

          <div v-if="hasMore && !loading && filtered.length > 0" class="border-t border-gray-200 dark:border-gray-700 px-3 py-2 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
            <span>Showing {{ tenants.length }} loaded tenants</span>
            <button
              type="button"
              @click="onLoadMore"
              :disabled="loadingMore"
              class="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 cursor-pointer"
            >{{ loadingMore ? 'Loading…' : 'Load more' }}</button>
          </div>

          <div class="border-t border-gray-200 dark:border-gray-700 px-3 py-1.5 flex items-center gap-4 text-[11px] text-gray-500 dark:text-gray-400">
            <span><kbd class="border border-gray-200 dark:border-gray-700 rounded px-1">↑↓</kbd> navigate</span>
            <span><kbd class="border border-gray-200 dark:border-gray-700 rounded px-1">↵</kbd> open</span>
            <span><kbd class="border border-gray-200 dark:border-gray-700 rounded px-1">Esc</kbd> close</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

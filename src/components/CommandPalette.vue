<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter, type Router } from 'vue-router'
import { useCommandPalette } from '../composables/useCommandPalette'
import { useDebouncedRef } from '../composables/useDebouncedRef'
import type { Tenant } from '../types'

// W3: global "Find tenant" palette (Cmd/Ctrl-K). Operator workflow at
// scale is "I have a tenant_id or name, show me everything" — this
// lets them jump straight to /tenants/:id without navigating each
// list view and typing into its per-view search input.
//
// O2 extension: slash-command scoping so the palette also handles
// non-tenant resources. Operators paste a webhook ID, key ID, audit
// log ID, etc. from logs and need to jump there. ID prefixes (`wh_`,
// `key_`, `bgt_`) are NOT a stable convention in this codebase
// (server lets the caller pick the ID), so prefix-classification of
// raw IDs is unreliable. Slash commands are the Linear/Slack
// convention — explicit scope, fully discoverable via `/` alone.
//
// Default mode (no leading `/`) preserves the original tenant fuzzy
// search and all of its tests.

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

// ── Slash commands ──────────────────────────────────────────────
//
// Each command's `execute` performs a router.push to the relevant
// detail or pre-filtered list view. Filter routing relies on the
// destination view reading the query param on mount (verified for
// AuditView `key_id`/`search`, EventsView `search`); reservations
// and budgets are intentionally omitted — those views don't yet
// honor URL filters and would need their own change first.
type CommandDef = {
  name: string
  aliases?: string[]
  label: string
  argLabel: string
  help: string
  execute: (arg: string, router: Router) => void
}

const COMMANDS: CommandDef[] = [
  {
    name: 'wh',
    aliases: ['webhook'],
    label: 'Open webhook',
    argLabel: 'subscription_id',
    help: 'Jump straight to a webhook detail page.',
    execute: (id, r) => r.push({ name: 'webhook-detail', params: { id } }),
  },
  {
    name: 'tenant',
    aliases: ['t'],
    label: 'Open tenant',
    argLabel: 'tenant_id',
    help: 'Open a tenant by exact ID (skips fuzzy search).',
    execute: (id, r) => r.push({ name: 'tenant-detail', params: { id } }),
  },
  {
    name: 'key',
    label: 'Find API key activity',
    argLabel: 'key_id',
    help: 'Audit log filtered by key_id.',
    execute: (id, r) => r.push({ name: 'audit', query: { key_id: id } }),
  },
  {
    name: 'audit',
    label: 'Search audit log',
    argLabel: 'log_id or resource_id',
    help: 'Audit log search by log_id or resource_id substring.',
    execute: (id, r) => r.push({ name: 'audit', query: { search: id } }),
  },
  {
    name: 'event',
    label: 'Search events',
    argLabel: 'event_id',
    help: 'Events list filtered by event_id substring.',
    execute: (id, r) => r.push({ name: 'events', query: { search: id } }),
  },
]

function findCommand(name: string): CommandDef | undefined {
  const lower = name.toLowerCase()
  return COMMANDS.find(c => c.name === lower || c.aliases?.includes(lower))
}

type ParsedInput =
  | { mode: 'search'; query: string }
  | { mode: 'commands-list'; filter: string }
  | { mode: 'command-needs-arg'; cmd: CommandDef }
  | { mode: 'command-ready'; cmd: CommandDef; arg: string }
  | { mode: 'unknown-command'; name: string }

function parseInput(raw: string): ParsedInput {
  if (!raw.startsWith('/')) return { mode: 'search', query: raw }
  const rest = raw.slice(1)
  const sp = rest.search(/\s/)
  const cmdName = (sp === -1 ? rest : rest.slice(0, sp)).trim()
  const arg = sp === -1 ? '' : rest.slice(sp + 1).trim()
  if (cmdName === '') return { mode: 'commands-list', filter: '' }
  const def = findCommand(cmdName)
  if (def) {
    if (!arg) return { mode: 'command-needs-arg', cmd: def }
    return { mode: 'command-ready', cmd: def, arg }
  }
  // Unknown command name. If the user is still typing it (no space yet),
  // show the commands list filtered by prefix so they can discover the
  // right name. Once they've typed a space, we know they finished the
  // name and it's truly unknown.
  if (sp === -1) {
    const matches = COMMANDS.filter(
      c =>
        c.name.startsWith(cmdName.toLowerCase()) ||
        c.aliases?.some(a => a.startsWith(cmdName.toLowerCase())),
    )
    if (matches.length > 0) return { mode: 'commands-list', filter: cmdName }
  }
  return { mode: 'unknown-command', name: cmdName }
}

const parsed = computed<ParsedInput>(() => parseInput(debouncedQuery.value))

// ── Commands-list filtering (when in `/<prefix>` discovery mode) ──
const visibleCommands = computed<CommandDef[]>(() => {
  if (parsed.value.mode !== 'commands-list') return []
  const f = parsed.value.filter.toLowerCase()
  if (!f) return COMMANDS
  return COMMANDS.filter(
    c => c.name.startsWith(f) || c.aliases?.some(a => a.startsWith(f)),
  )
})

// ── Tenant search (default mode) ──
const filteredTenants = computed<Tenant[]>(() => {
  if (parsed.value.mode !== 'search') return []
  const q = parsed.value.query.trim().toLowerCase()
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

// Total selectable items in the current mode — drives ArrowDown/Up
// wraparound and the "no results" empty state.
const selectableCount = computed(() => {
  switch (parsed.value.mode) {
    case 'search': return filteredTenants.value.length
    case 'commands-list': return visibleCommands.value.length
    case 'command-ready':
    case 'command-needs-arg':
      return 1
    case 'unknown-command':
      return 0
  }
})

watch(parsed, () => {
  // Reset highlight whenever the result set switches mode or shrinks.
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

function selectTenant(t: Tenant) {
  close()
  query.value = ''
  router.push({ name: 'tenant-detail', params: { id: t.tenant_id } })
}

function executeCommand(cmd: CommandDef, arg: string) {
  close()
  query.value = ''
  cmd.execute(arg, router)
}

function pickCommandForCompletion(cmd: CommandDef) {
  // Single-click on a command-help row — pre-fill the input with
  // `/<name> ` so the operator can type the arg next. Avoids
  // forcing them to memorize the slash-command vocabulary.
  query.value = `/${cmd.name} `
  nextTick(() => {
    input.value?.focus()
    input.value?.setSelectionRange(query.value.length, query.value.length)
  })
}

function activate() {
  // Enter dispatch — what fires depends on the current mode.
  const p = parsed.value
  if (p.mode === 'search') {
    const pick = filteredTenants.value[activeIndex.value]
    if (pick) selectTenant(pick)
    return
  }
  if (p.mode === 'commands-list') {
    const pick = visibleCommands.value[activeIndex.value]
    if (pick) pickCommandForCompletion(pick)
    return
  }
  if (p.mode === 'command-ready') {
    executeCommand(p.cmd, p.arg)
    return
  }
  // command-needs-arg / unknown-command: nothing actionable yet.
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (selectableCount.value === 0) return
    activeIndex.value = (activeIndex.value + 1) % selectableCount.value
    scrollActiveIntoView()
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (selectableCount.value === 0) return
    activeIndex.value = (activeIndex.value - 1 + selectableCount.value) % selectableCount.value
    scrollActiveIntoView()
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    activate()
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
  if (selectableCount.value === 0) return undefined
  return `${listboxId}-option-${activeIndex.value}`
}

const placeholder = computed(() => {
  switch (parsed.value.mode) {
    case 'commands-list':
      return 'Pick a command…'
    case 'command-needs-arg':
      return `Enter ${parsed.value.cmd.argLabel}…`
    case 'command-ready':
      return 'Press Enter to open'
    case 'unknown-command':
      return 'Unknown command — type / to see options'
    default:
      return 'Search tenants by name or ID, or type / for commands…'
  }
})
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
            <label id="command-palette-title" class="sr-only" for="command-palette-input">Search tenants or run a command</label>
            <input
              id="command-palette-input"
              ref="input"
              v-model="query"
              type="search"
              role="combobox"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              :aria-expanded="selectableCount > 0"
              :aria-controls="listboxId"
              :aria-activedescendant="activeDescendantId()"
              :placeholder="placeholder"
              class="flex-1 py-3 bg-transparent text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none"
            />
            <kbd class="hidden sm:inline-block text-xs text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5">Esc</kbd>
          </div>

          <div
            :id="listboxId"
            ref="listEl"
            role="listbox"
            aria-label="Command palette results"
            class="max-h-80 overflow-y-auto overflow-x-hidden"
          >
            <!-- Tenant search mode (default) -->
            <template v-if="parsed.mode === 'search'">
              <div v-if="error" role="alert" class="p-4 text-sm text-red-700 dark:text-red-400">{{ error }}</div>
              <div v-else-if="loading" class="p-6 text-sm text-center text-gray-500 dark:text-gray-400">Loading tenants…</div>
              <div v-else-if="filteredTenants.length === 0" class="p-6 text-sm text-center text-gray-500 dark:text-gray-400">
                <template v-if="tenants.length === 0">No tenants available</template>
                <template v-else-if="query">No tenants match "{{ query }}"</template>
                <template v-else>No tenants</template>
              </div>
              <div v-else>
                <button
                  v-for="(t, i) in filteredTenants"
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
                  @click="selectTenant(t)"
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
            </template>

            <!-- Commands-list mode (input is `/` or `/<prefix>`) -->
            <template v-else-if="parsed.mode === 'commands-list'">
              <div v-if="visibleCommands.length === 0" class="p-6 text-sm text-center text-gray-500 dark:text-gray-400">
                No commands match
              </div>
              <button
                v-for="(c, i) in visibleCommands"
                :key="c.name"
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
                @click="pickCommandForCompletion(c)"
              >
                <kbd class="text-xs font-mono text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 shrink-0">/{{ c.name }}</kbd>
                <div class="flex-1 min-w-0">
                  <div class="text-sm text-gray-900 dark:text-gray-100 truncate">{{ c.label }}</div>
                  <div class="text-xs text-gray-500 dark:text-gray-400 truncate">{{ c.help }}</div>
                </div>
                <span class="text-xs text-gray-400 dark:text-gray-500 font-mono truncate shrink-0">&lt;{{ c.argLabel }}&gt;</span>
              </button>
            </template>

            <!-- Command-needs-arg mode (e.g. `/wh ` typed but no ID yet) -->
            <template v-else-if="parsed.mode === 'command-needs-arg'">
              <div class="p-4 flex items-center gap-3 text-sm">
                <kbd class="text-xs font-mono text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 shrink-0">/{{ parsed.cmd.name }}</kbd>
                <span class="text-gray-700 dark:text-gray-200">{{ parsed.cmd.label }} —</span>
                <span class="text-gray-500 dark:text-gray-400 font-mono">enter &lt;{{ parsed.cmd.argLabel }}&gt;</span>
              </div>
            </template>

            <!-- Command-ready mode — single execute row -->
            <template v-else-if="parsed.mode === 'command-ready'">
              <button
                type="button"
                role="option"
                :id="`${listboxId}-option-0`"
                :data-index="0"
                :aria-selected="true"
                class="w-full text-left px-3 py-2 flex items-center gap-3 cursor-pointer transition-colors bg-blue-50 dark:bg-blue-900/30"
                @click="executeCommand(parsed.cmd, parsed.arg)"
              >
                <kbd class="text-xs font-mono text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 shrink-0">/{{ parsed.cmd.name }}</kbd>
                <div class="flex-1 min-w-0">
                  <div class="text-sm text-gray-900 dark:text-gray-100 truncate">{{ parsed.cmd.label }}</div>
                  <div class="text-xs text-gray-500 dark:text-gray-400 font-mono truncate">{{ parsed.arg }}</div>
                </div>
                <span class="text-xs text-blue-700 dark:text-blue-300 shrink-0">↵ open</span>
              </button>
            </template>

            <!-- Unknown command -->
            <template v-else-if="parsed.mode === 'unknown-command'">
              <div class="p-4 text-sm text-gray-700 dark:text-gray-200">
                Unknown command <code class="font-mono text-red-600 dark:text-red-400">/{{ parsed.name }}</code>.
                Type <kbd class="text-xs font-mono border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5">/</kbd> to list available commands.
              </div>
            </template>
          </div>

          <div v-if="parsed.mode === 'search' && hasMore && !loading && filteredTenants.length > 0" class="border-t border-gray-200 dark:border-gray-700 px-3 py-2 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
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
            <span><kbd class="border border-gray-200 dark:border-gray-700 rounded px-1">/</kbd> commands</span>
            <span><kbd class="border border-gray-200 dark:border-gray-700 rounded px-1">Esc</kbd> close</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

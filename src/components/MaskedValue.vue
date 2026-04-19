<script setup lang="ts">
import { ref, onUnmounted } from 'vue'
import CheckIcon from './icons/CheckIcon.vue'
import CopyIcon from './icons/CopyIcon.vue'
import EyeIcon from './icons/EyeIcon.vue'
import EyeOffIcon from './icons/EyeOffIcon.vue'

const props = defineProps<{ value: string; visibleChars?: number }>()
const revealed = ref(false)
const copied = ref(false)

const masked = () => {
  const n = props.visibleChars ?? 4
  if (props.value.length <= n) return props.value
  return '•'.repeat(Math.min(8, props.value.length - n)) + props.value.slice(-n)
}

// W5 (scale-hardening): both the short "Copied!" badge timer and the
// long clipboard-clear timer are tracked refs. Previously the badge
// timer was anonymous — rapid re-clicks leaked timers and unmounting
// during the 1.5s window fired setTimeout on a dead instance.
let clipboardClearTimer: ReturnType<typeof setTimeout> | null = null
let copiedBadgeTimer: ReturnType<typeof setTimeout> | null = null

function copy() {
  navigator.clipboard.writeText(props.value)
  copied.value = true
  if (copiedBadgeTimer) clearTimeout(copiedBadgeTimer)
  copiedBadgeTimer = setTimeout(() => { copied.value = false }, 1500)
  // Auto-clear clipboard after 30s for security
  if (clipboardClearTimer) clearTimeout(clipboardClearTimer)
  clipboardClearTimer = setTimeout(() => {
    navigator.clipboard.readText().then(text => {
      if (text === props.value) navigator.clipboard.writeText('')
    }).catch(() => {})
  }, 30_000)
}

onUnmounted(() => {
  if (clipboardClearTimer) clearTimeout(clipboardClearTimer)
  if (copiedBadgeTimer) clearTimeout(copiedBadgeTimer)
})
</script>

<template>
  <span class="inline-flex items-center gap-1 font-mono text-xs">
    <span>{{ revealed ? value : masked() }}</span>
    <button type="button" @click.stop="revealed = !revealed" :title="revealed ? 'Hide' : 'Reveal'" :aria-label="revealed ? 'Hide credential' : 'Reveal credential'" class="muted hover:text-gray-600 cursor-pointer">
      <EyeIcon v-if="!revealed" class="w-3.5 h-3.5" />
      <EyeOffIcon v-else class="w-3.5 h-3.5" />
    </button>
    <button type="button" @click.stop="copy" :title="copied ? 'Copied!' : 'Copy'" :aria-label="copied ? 'Copied to clipboard' : 'Copy credential to clipboard'" class="muted hover:text-gray-600 cursor-pointer">
      <CopyIcon v-if="!copied" class="w-3.5 h-3.5" />
      <CheckIcon v-else class="w-3.5 h-3.5 text-green-500" />
    </button>
  </span>
</template>

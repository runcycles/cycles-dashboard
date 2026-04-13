<script setup lang="ts">
import { ref, onUnmounted } from 'vue'

const props = defineProps<{ value: string; visibleChars?: number }>()
const revealed = ref(false)
const copied = ref(false)

const masked = () => {
  const n = props.visibleChars ?? 4
  if (props.value.length <= n) return props.value
  return '•'.repeat(Math.min(8, props.value.length - n)) + props.value.slice(-n)
}

let clipboardClearTimer: ReturnType<typeof setTimeout> | null = null

function copy() {
  navigator.clipboard.writeText(props.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
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
})
</script>

<template>
  <span class="inline-flex items-center gap-1 font-mono text-xs">
    <span>{{ revealed ? value : masked() }}</span>
    <button type="button" @click.stop="revealed = !revealed" :title="revealed ? 'Hide' : 'Reveal'" :aria-label="revealed ? 'Hide credential' : 'Reveal credential'" class="text-gray-400 hover:text-gray-600 cursor-pointer">
      <svg v-if="!revealed" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
      </svg>
      <svg v-else class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
      </svg>
    </button>
    <button type="button" @click.stop="copy" :title="copied ? 'Copied!' : 'Copy'" :aria-label="copied ? 'Copied to clipboard' : 'Copy credential to clipboard'" class="text-gray-400 hover:text-gray-600 cursor-pointer">
      <svg v-if="!copied" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
      </svg>
      <svg v-else class="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    </button>
  </span>
</template>

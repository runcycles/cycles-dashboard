<script setup lang="ts">
import { toasts } from '../composables/useToast'
</script>

<template>
  <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
    <transition-group name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        :class="t.type === 'success' ? 'bg-green-700 text-white' : 'bg-red-700 text-white'"
        class="px-4 py-2.5 rounded-lg shadow-lg text-sm pointer-events-auto max-w-sm"
      >
        {{ t.message }}
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.toast-enter-active { transition: all 0.2s ease-out; }
.toast-leave-active { transition: all 0.15s ease-in; }
.toast-enter-from { opacity: 0; transform: translateY(8px); }
.toast-leave-to { opacity: 0; transform: translateX(16px); }
</style>

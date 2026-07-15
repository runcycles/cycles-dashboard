<script setup lang="ts">
import { toasts, dismissToast } from '../composables/useToast'
import CloseIcon from './icons/CloseIcon.vue'
</script>

<template>
  <!-- aria-live="polite" + role="status" on the container announces
       incoming toasts to screen readers without interrupting current
       speech. Error toasts additionally carry role="alert" (assertive)
       — a failed mutation must not be missed. Warning toasts are
       advisories, not failures: role="status" (polite), amber, and
       they auto-dismiss like success. -->
  <div
    class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
    aria-live="polite"
    role="status"
  >
    <transition-group name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        :role="t.type === 'error' ? 'alert' : t.type === 'warning' ? 'status' : undefined"
        :class="t.type === 'success' ? 'bg-green-700 text-white' : t.type === 'warning' ? 'bg-amber-600 text-white' : 'bg-red-700 text-white'"
        class="pl-4 pr-2 py-2.5 rounded-lg shadow-lg text-sm pointer-events-auto max-w-sm flex items-start gap-2"
      >
        <span class="flex-1">{{ t.message }}</span>
        <button
          type="button"
          aria-label="Dismiss"
          class="shrink-0 p-1 -my-0.5 rounded text-white/80 hover:text-white hover:bg-white/20 cursor-pointer focus:outline-none focus:ring-2 focus:ring-white/60"
          @click="dismissToast(t.id)"
        >
          <CloseIcon class="w-3.5 h-3.5" />
        </button>
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

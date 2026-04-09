import { ref } from 'vue'

export interface Toast {
  id: number
  message: string
  type: 'success' | 'error'
}

let nextId = 0
export const toasts = ref<Toast[]>([])

export function useToast() {
  function show(message: string, type: 'success' | 'error' = 'success') {
    const id = nextId++
    toasts.value.push({ id, message, type })
    setTimeout(() => {
      toasts.value = toasts.value.filter(t => t.id !== id)
    }, 4000)
  }

  function success(message: string) { show(message, 'success') }
  function error(message: string) { show(message, 'error') }

  return { toasts, success, error }
}

import { ref } from 'vue'

const KEY = 'cycles_dark_mode'
let initialized = false

function getSystemPreference(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function getStored(): boolean | null {
  const v = localStorage.getItem(KEY)
  if (v === 'true') return true
  if (v === 'false') return false
  return null
}

function apply(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark)
  isDark.value = dark
}

export const isDark = ref(false)

export function useDarkMode() {
  if (!initialized) {
    initialized = true
    const stored = getStored()
    apply(stored !== null ? stored : getSystemPreference())

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (getStored() === null) apply(e.matches)
    })
  }

  function toggle() {
    const next = !isDark.value
    localStorage.setItem(KEY, String(next))
    apply(next)
  }

  return { isDark, toggle }
}

import { describe, it, expect, beforeEach, vi } from 'vitest'

// useDarkMode is a singleton (module-level `initialized`), so each test
// has to dynamically re-import it after resetting the module registry,
// otherwise subsequent tests would see the state from the first run.
async function loadModule() {
  vi.resetModules()
  return await import('../composables/useDarkMode')
}

describe('useDarkMode', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    vi.restoreAllMocks()
  })

  it('defaults to light when no stored preference and system is light', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false,
      media: '(prefers-color-scheme: dark)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    const { useDarkMode, isDark } = await loadModule()
    const dm = useDarkMode()
    expect(isDark.value).toBe(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(dm).toHaveProperty('toggle')
  })

  it('defaults to dark when system prefers dark and no stored preference', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: true,
      media: '(prefers-color-scheme: dark)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    const { useDarkMode, isDark } = await loadModule()
    useDarkMode()
    expect(isDark.value).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('respects stored preference over system preference', async () => {
    localStorage.setItem('cycles_dark_mode', 'false')
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: true, // system says dark
      media: '(prefers-color-scheme: dark)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    const { useDarkMode, isDark } = await loadModule()
    useDarkMode()
    expect(isDark.value).toBe(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('toggle() flips state and persists to localStorage', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false,
      media: '(prefers-color-scheme: dark)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    const { useDarkMode, isDark } = await loadModule()
    const { toggle } = useDarkMode()
    expect(isDark.value).toBe(false)

    toggle()
    expect(isDark.value).toBe(true)
    expect(localStorage.getItem('cycles_dark_mode')).toBe('true')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    toggle()
    expect(isDark.value).toBe(false)
    expect(localStorage.getItem('cycles_dark_mode')).toBe('false')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})

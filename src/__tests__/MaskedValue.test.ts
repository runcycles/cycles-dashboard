import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import MaskedValue from '../components/MaskedValue.vue'
import { toasts } from '../composables/useToast'

describe('MaskedValue clipboard behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    toasts.value = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not claim success when the clipboard write fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error('denied')),
        readText: vi.fn(),
      },
    })
    const w = mount(MaskedValue, { props: { value: 'key-secret-id' } })

    await w.get('button[aria-label="Copy credential to clipboard"]').trigger('click')
    await flushPromises()

    expect(w.find('button[aria-label="Copied to clipboard"]').exists()).toBe(false)
    expect(toasts.value.at(-1)).toMatchObject({
      type: 'error',
      message: 'Copy failed — clipboard unavailable',
    })
  })

  it('keeps the security wipe scheduled after the value unmounts', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const readText = vi.fn().mockResolvedValue('key-secret-id')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText },
    })
    const w = mount(MaskedValue, { props: { value: 'key-secret-id' } })

    await w.get('button[aria-label="Copy credential to clipboard"]').trigger('click')
    await flushPromises()
    writeText.mockClear()
    w.unmount()

    vi.advanceTimersByTime(30_000)
    await Promise.resolve()
    await Promise.resolve()
    expect(readText).toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith('')
  })
})

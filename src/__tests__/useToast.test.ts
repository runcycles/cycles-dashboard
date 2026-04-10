import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useToast, toasts } from '../composables/useToast'

describe('useToast', () => {
  beforeEach(() => {
    toasts.value = []
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    toasts.value = []
  })

  it('shows a success toast', () => {
    const t = useToast()
    t.success('Saved!')
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0].message).toBe('Saved!')
    expect(toasts.value[0].type).toBe('success')
  })

  it('shows an error toast', () => {
    const t = useToast()
    t.error('Failed to save')
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0].type).toBe('error')
  })

  it('auto-dismisses after 4 seconds', () => {
    const t = useToast()
    t.success('Temporary')
    expect(toasts.value).toHaveLength(1)

    vi.advanceTimersByTime(3_999)
    expect(toasts.value).toHaveLength(1)

    vi.advanceTimersByTime(2)
    expect(toasts.value).toHaveLength(0)
  })

  it('stacks multiple toasts', () => {
    const t = useToast()
    t.success('One')
    t.success('Two')
    t.error('Three')
    expect(toasts.value).toHaveLength(3)
    expect(toasts.value.map(x => x.message)).toEqual(['One', 'Two', 'Three'])
  })

  it('each toast dismisses independently (FIFO by default)', () => {
    const t = useToast()
    t.success('first')
    vi.advanceTimersByTime(1000)
    t.success('second')

    // At t=3999, first is still alive (just), second is at 2999
    vi.advanceTimersByTime(2_999)
    expect(toasts.value.map(x => x.message)).toEqual(['first', 'second'])

    // At t=4001, first expired, second still alive
    vi.advanceTimersByTime(2)
    expect(toasts.value.map(x => x.message)).toEqual(['second'])

    // At t=5001, second also expired
    vi.advanceTimersByTime(1000)
    expect(toasts.value).toHaveLength(0)
  })

  it('each toast has a unique id', () => {
    const t = useToast()
    t.success('a')
    t.success('b')
    t.success('c')
    const ids = toasts.value.map(x => x.id)
    expect(new Set(ids).size).toBe(3)
  })

  it('exposes toasts via the return value', () => {
    const t = useToast()
    t.success('hi')
    expect(t.toasts.value).toHaveLength(1)
    expect(t.toasts.value[0].message).toBe('hi')
  })
})

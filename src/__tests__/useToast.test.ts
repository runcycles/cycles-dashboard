import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useToast, toasts, dismissToast } from '../composables/useToast'

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

  it('auto-dismisses success toasts after 4 seconds', () => {
    const t = useToast()
    t.success('Temporary')
    expect(toasts.value).toHaveLength(1)

    vi.advanceTimersByTime(3_999)
    expect(toasts.value).toHaveLength(1)

    vi.advanceTimersByTime(2)
    expect(toasts.value).toHaveLength(0)
  })

  it('error toasts persist until manually dismissed', () => {
    const t = useToast()
    t.error('Something broke')
    expect(toasts.value).toHaveLength(1)

    // Well past the success auto-dismiss window — still there.
    vi.advanceTimersByTime(60_000)
    expect(toasts.value).toHaveLength(1)

    t.dismiss(toasts.value[0].id)
    expect(toasts.value).toHaveLength(0)
  })

  it('dismiss removes only the targeted toast', () => {
    const t = useToast()
    t.error('first error')
    t.error('second error')
    const firstId = toasts.value[0].id
    t.dismiss(firstId)
    expect(toasts.value.map(x => x.message)).toEqual(['second error'])
  })

  it('dismiss on an unknown id is a no-op', () => {
    const t = useToast()
    t.error('keep me')
    t.dismiss(99999)
    expect(toasts.value).toHaveLength(1)
  })

  it('a success toast can be dismissed early, and its later timer is a safe no-op', () => {
    const t = useToast()
    t.success('quick read')
    const id = toasts.value[0].id
    t.dismiss(id)
    expect(toasts.value).toHaveLength(0)
    // The auto-dismiss timer still fires — must not throw or remove others.
    t.error('unrelated')
    vi.advanceTimersByTime(4_001)
    expect(toasts.value.map(x => x.message)).toEqual(['unrelated'])
  })

  it('exports dismissToast for the container component', () => {
    const t = useToast()
    t.error('via module fn')
    dismissToast(toasts.value[0].id)
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

  it('success toasts dismiss independently (FIFO by default), errors stay', () => {
    const t = useToast()
    t.success('first')
    vi.advanceTimersByTime(1000)
    t.success('second')
    t.error('sticky')

    // At t=3999, first is still alive (just), second is at 2999
    vi.advanceTimersByTime(2_999)
    expect(toasts.value.map(x => x.message)).toEqual(['first', 'second', 'sticky'])

    // At t=4001, first expired, second still alive
    vi.advanceTimersByTime(2)
    expect(toasts.value.map(x => x.message)).toEqual(['second', 'sticky'])

    // At t=5001, second also expired — error remains
    vi.advanceTimersByTime(1000)
    expect(toasts.value.map(x => x.message)).toEqual(['sticky'])
  })

  it('each toast has a unique id', () => {
    const t = useToast()
    t.success('a')
    t.success('b')
    t.error('c')
    const ids = toasts.value.map(x => x.id)
    expect(new Set(ids).size).toBe(3)
  })

  it('exposes toasts via the return value', () => {
    const t = useToast()
    t.success('hi')
    expect(t.toasts.value).toHaveLength(1)
    expect(t.toasts.value[0].message).toBe('hi')
  })

  it('shows a warning toast', () => {
    const t = useToast()
    t.warning('Heads up')
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0].message).toBe('Heads up')
    expect(toasts.value[0].type).toBe('warning')
  })

  it('warning toasts auto-dismiss like success (advisories, not failures)', () => {
    const t = useToast()
    t.warning('Will be removed on save')
    expect(toasts.value).toHaveLength(1)

    vi.advanceTimersByTime(3_999)
    expect(toasts.value).toHaveLength(1)

    vi.advanceTimersByTime(2)
    expect(toasts.value).toHaveLength(0)
  })

  it('caps the stack at 5 — an all-error stack drops the oldest error (persistent errors cannot grow unbounded)', () => {
    const t = useToast()
    for (let i = 0; i < 7; i++) t.error(`err-${i}`)
    expect(toasts.value).toHaveLength(5)
    // Oldest two dropped; newest five remain in order.
    expect(toasts.value.map(x => x.message)).toEqual(['err-2', 'err-3', 'err-4', 'err-5', 'err-6'])
  })

  it('cap evicts the oldest non-error before any error', () => {
    const t = useToast()
    t.success('old-success')
    for (let i = 0; i < 5; i++) t.error(`err-${i}`)
    expect(toasts.value).toHaveLength(5)
    expect(toasts.value.map(x => x.message)).toEqual(['err-0', 'err-1', 'err-2', 'err-3', 'err-4'])
    // The dropped success's auto-dismiss timer firing later is a no-op.
    vi.advanceTimersByTime(4_001)
    expect(toasts.value.map(x => x.message)).toEqual(['err-0', 'err-1', 'err-2', 'err-3', 'err-4'])
  })

  it('a success arriving on 5 persistent errors soft-overflows — no error is evicted', () => {
    // F4: a transient must never evict an unacknowledged error. The
    // stack briefly holds 6 toasts; the success auto-dismisses in 4s,
    // restoring the cap on its own.
    const t = useToast()
    for (let i = 0; i < 5; i++) t.error(`err-${i}`)
    t.success('done')
    expect(toasts.value).toHaveLength(6)
    expect(toasts.value.map(x => x.message)).toEqual(['err-0', 'err-1', 'err-2', 'err-3', 'err-4', 'done'])

    // Auto-dismiss restores the hard cap with all five errors intact.
    vi.advanceTimersByTime(4_001)
    expect(toasts.value).toHaveLength(5)
    expect(toasts.value.map(x => x.message)).toEqual(['err-0', 'err-1', 'err-2', 'err-3', 'err-4'])
  })

  it('an error arriving on 5 errors evicts the oldest error (hard cap among errors)', () => {
    const t = useToast()
    for (let i = 0; i < 5; i++) t.error(`err-${i}`)
    t.error('err-new')
    expect(toasts.value).toHaveLength(5)
    expect(toasts.value.map(x => x.message)).toEqual(['err-1', 'err-2', 'err-3', 'err-4', 'err-new'])
  })

  it('a warning arriving on 5 errors also soft-overflows (transients never evict errors)', () => {
    const t = useToast()
    for (let i = 0; i < 5; i++) t.error(`err-${i}`)
    t.warning('advisory')
    expect(toasts.value).toHaveLength(6)
    vi.advanceTimersByTime(4_001)
    expect(toasts.value.map(x => x.message)).toEqual(['err-0', 'err-1', 'err-2', 'err-3', 'err-4'])
  })

  it('a success arriving on 4 errors + 1 warning evicts the warning, not an error', () => {
    const t = useToast()
    t.error('err-0')
    t.error('err-1')
    t.warning('advisory')
    t.error('err-2')
    t.error('err-3')
    t.success('done')
    expect(toasts.value).toHaveLength(5)
    // The warning (oldest non-error) goes; all four errors survive.
    expect(toasts.value.map(x => x.message)).toEqual(['err-0', 'err-1', 'err-2', 'err-3', 'done'])
  })

  // F4 (round 5): the single-eviction cap logic let interleaved
  // (transient, error) pairs inside the 4s window ratchet the
  // persistent-error population past the cap — the incoming error
  // evicted ONE transient from the soft-overflowed 6-stack and pushed,
  // converting each overflow slot into a permanent 6th/7th/8th error.
  it('an error arriving on a soft-overflowed stack (5 errors + success) stays at exactly 5 errors', () => {
    const t = useToast()
    for (let i = 0; i < 5; i++) t.error(`err-${i}`)
    t.success('done') // soft overflow — 6 toasts
    expect(toasts.value).toHaveLength(6)

    t.error('err-new') // before the success auto-dismisses
    expect(toasts.value).toHaveLength(5)
    expect(toasts.value.every(x => x.type === 'error')).toBe(true)
    // The transient went first; then the oldest error made room.
    expect(toasts.value.map(x => x.message)).toEqual(['err-1', 'err-2', 'err-3', 'err-4', 'err-new'])
  })

  it('repeated (success, error) pairs within the dismiss window never grow the error population past the cap', () => {
    const t = useToast()
    for (let i = 0; i < 5; i++) t.error(`err-${i}`)
    for (let i = 0; i < 4; i++) {
      t.success(`ok-${i}`)
      t.error(`late-${i}`)
      const errors = toasts.value.filter(x => x.type === 'error')
      expect(errors.length).toBeLessThanOrEqual(5)
      expect(toasts.value.length).toBeLessThanOrEqual(5)
    }
    expect(toasts.value.filter(x => x.type === 'error')).toHaveLength(5)
    // Newest failure always survives.
    expect(toasts.value.at(-1)!.message).toBe('late-3')
  })

  it('stack below the cap is untouched by the cap logic', () => {
    const t = useToast()
    for (let i = 0; i < 5; i++) t.error(`err-${i}`)
    expect(toasts.value).toHaveLength(5)
    expect(toasts.value[0].message).toBe('err-0')
  })
})

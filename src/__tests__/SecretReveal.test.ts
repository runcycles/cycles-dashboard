// SecretReveal is the compliance-audit surface: the one-shot modal
// operators see after rotating or creating a secret. Tests lock in
// the non-obvious behaviors a buyer will verify manually during a
// security review:
//   - the secret is visible in the DOM (selectable/copyable)
//   - the close button is gated on the "I copied this" checkbox so
//     operators can't dismiss the dialog before acknowledging they
//     retained the credential
//   - Escape key closes the dialog ONLY after the checkbox is checked
//     (same rationale — prevents accidental dismissal before copy)
//   - the clipboard is wiped ~60s after copy so the secret doesn't
//     linger on the system clipboard for the rest of the session

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import SecretReveal from '../components/SecretReveal.vue'

const baseProps = {
  title: 'API key created',
  secret: 'ck_test_1a2b3c4d5e6f7g8h',
  label: 'Key secret',
}

describe('SecretReveal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // JSDOM doesn't provide a real clipboard; stub it. Individual tests
    // replace these when they need to assert against the stubs.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue(''),
      },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders the secret inline so operators can copy it', () => {
    const w = mount(SecretReveal, { props: baseProps })
    expect(w.text()).toContain(baseProps.secret)
    // The <code> element holds the secret with select-all class so
    // triple-click selects the whole thing.
    const codeEl = w.find('code')
    expect(codeEl.exists()).toBe(true)
    expect(codeEl.classes()).toContain('select-all')
  })

  it('displays a prominent "will not be shown again" warning', () => {
    const w = mount(SecretReveal, { props: baseProps })
    expect(w.text().toLowerCase()).toContain('will not be shown again')
  })

  // Compliance-grade: operator must acknowledge they copied before the
  // dialog can be dismissed. Without this, a stray click that dismisses
  // a SUCCESS dialog loses the secret irrecoverably.
  it('Close button is disabled until the "I have copied" checkbox is checked', async () => {
    const w = mount(SecretReveal, { props: baseProps })
    const closeBtn = w.findAll('button').find(b => b.text() === 'Close')!
    expect(closeBtn.attributes('disabled')).toBeDefined()

    const checkbox = w.find('input[type="checkbox"]')
    await checkbox.setValue(true)

    expect(closeBtn.attributes('disabled')).toBeUndefined()
  })

  it('emits close when the Close button is clicked after acknowledgement', async () => {
    const w = mount(SecretReveal, { props: baseProps })
    await w.find('input[type="checkbox"]').setValue(true)
    await w.findAll('button').find(b => b.text() === 'Close')!.trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })

  // Escape-key handler is attached to document, not the component root.
  it('Escape key closes the dialog only after acknowledgement', async () => {
    const w = mount(SecretReveal, { props: baseProps, attachTo: document.body })

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.emitted('close')).toBeUndefined()

    await w.find('input[type="checkbox"]').setValue(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.emitted('close')).toHaveLength(1)

    w.unmount()
  })

  it('clicking Copy calls navigator.clipboard.writeText with the secret', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText: vi.fn().mockResolvedValue('') },
    })
    const w = mount(SecretReveal, { props: baseProps })
    await w.findAll('button').find(b => b.text() === 'Copy')!.trigger('click')
    expect(writeText).toHaveBeenCalledWith(baseProps.secret)
  })

  it('copy button flips to "Copied!" briefly and reverts after 2s', async () => {
    const w = mount(SecretReveal, { props: baseProps })
    const copyBtn = () => w.findAll('button').find(b => b.text() === 'Copy' || b.text() === 'Copied!')!
    await copyBtn().trigger('click')
    expect(copyBtn().text()).toBe('Copied!')
    vi.advanceTimersByTime(2000)
    await w.vm.$nextTick()
    expect(copyBtn().text()).toBe('Copy')
  })

  // 60-second clipboard wipe — guards against a secret lingering on
  // the system clipboard long after the dialog closes.
  it('schedules a clipboard wipe ~60s after copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const readText = vi.fn().mockResolvedValue(baseProps.secret)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText },
    })
    const w = mount(SecretReveal, { props: baseProps })
    await w.findAll('button').find(b => b.text() === 'Copy')!.trigger('click')

    writeText.mockClear()
    vi.advanceTimersByTime(60_000)
    // The wipe reads the clipboard first, then writes '' iff the
    // contents are still the secret — we mocked readText to return
    // the secret, so the wipe should fire.
    await Promise.resolve() // let the async .then() resolve
    await Promise.resolve()
    expect(readText).toHaveBeenCalled()
    // The wipe calls writeText('') — a regression that skipped the
    // wipe would leave writeText uncalled after the copy's initial call.
    expect(writeText).toHaveBeenCalledWith('')
  })

  it('does NOT wipe the clipboard if the user replaced its contents before 60s', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    // User copied something else during the 60s window — the guard
    // reads the clipboard and skips the wipe if it's no longer our
    // secret, so the operator's new clipboard content is preserved.
    const readText = vi.fn().mockResolvedValue('something-else-the-user-copied')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText },
    })
    const w = mount(SecretReveal, { props: baseProps })
    await w.findAll('button').find(b => b.text() === 'Copy')!.trigger('click')

    writeText.mockClear()
    vi.advanceTimersByTime(60_000)
    await Promise.resolve()
    await Promise.resolve()
    expect(readText).toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('role="dialog" with aria-modal=true so assistive tech treats it as a modal', () => {
    const w = mount(SecretReveal, { props: baseProps })
    const dialog = w.find('[role="dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect(dialog.attributes('aria-label')).toBe(baseProps.title)
  })
})

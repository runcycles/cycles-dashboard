// Unit coverage for the shared writeClipboardText / writeClipboardJson
// helpers introduced in v0.1.25.40. Every Copy as JSON kebab item across
// the seven list views uses writeClipboardJson, so the helper is the
// single point where a failure (denied permission, insecure context,
// non-serializable payload) has to stay a caught boolean — not an
// uncaught promise rejection — for the call sites to stay terse.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { writeClipboardText, writeClipboardJson } from '../utils/clipboard'

let writeTextMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  writeTextMock = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: writeTextMock },
    writable: true,
    configurable: true,
  })
})

describe('writeClipboardText', () => {
  it('resolves true on success and forwards the value verbatim', async () => {
    const ok = await writeClipboardText('hello')
    expect(ok).toBe(true)
    expect(writeTextMock).toHaveBeenCalledWith('hello')
  })

  it('resolves false when writeText rejects (denied permission)', async () => {
    writeTextMock.mockRejectedValueOnce(new Error('denied'))
    const ok = await writeClipboardText('x')
    expect(ok).toBe(false)
  })

  it('resolves false when the Async Clipboard API is absent', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      writable: true,
      configurable: true,
    })
    const ok = await writeClipboardText('x')
    expect(ok).toBe(false)
  })
})

describe('writeClipboardJson', () => {
  it('serializes plain objects via JSON and resolves true', async () => {
    const ok = await writeClipboardJson({ a: 1, b: 'two' })
    expect(ok).toBe(true)
    const payload = JSON.parse(writeTextMock.mock.calls[0][0] as string)
    expect(payload).toEqual({ a: 1, b: 'two' })
  })

  it('serializes cycles without throwing (safeJsonStringify contract)', async () => {
    type Cyc = { name: string; self?: Cyc }
    const obj: Cyc = { name: 'root' }
    obj.self = obj
    const ok = await writeClipboardJson(obj)
    expect(ok).toBe(true)
    // safeJsonStringify replaces cycles with "[Circular]" (or similar);
    // the key assertion is just that we got a string and wrote it.
    expect(typeof writeTextMock.mock.calls[0][0]).toBe('string')
  })

  it('serializes BigInt without throwing', async () => {
    const ok = await writeClipboardJson({ amount: BigInt('9007199254740993') })
    expect(ok).toBe(true)
    expect(typeof writeTextMock.mock.calls[0][0]).toBe('string')
  })

  it('resolves false if clipboard write rejects', async () => {
    writeTextMock.mockRejectedValueOnce(new Error('denied'))
    const ok = await writeClipboardJson({ a: 1 })
    expect(ok).toBe(false)
  })
})

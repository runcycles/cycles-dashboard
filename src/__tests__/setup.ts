// Vitest setup — jsdom polyfills for features missing from its baseline.
// ResizeObserver is required by vue-echarts' autoresize behavior; jsdom
// doesn't ship one. A no-op stub is sufficient — charts aren't expected
// to visually reflow under unit tests.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = ResizeObserverStub
}

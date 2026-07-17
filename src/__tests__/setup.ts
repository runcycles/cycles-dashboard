import { config } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

// Vitest setup — shared component defaults and jsdom polyfills.

// Most component tests do not need a live router. A shared anchor stub keeps
// nested RouterLink users (for example dialogs and the sidebar) renderable;
// navigation-focused suites can still override it at mount time.
config.global.stubs = {
  ...config.global.stubs,
  RouterLink: defineComponent({
    name: 'RouterLinkStub',
    props: {
      to: { type: [String, Object], required: false, default: '#' },
    },
    setup(props, { attrs, slots }) {
      return () => h('a', {
        ...attrs,
        href: typeof props.to === 'string' ? props.to : '#',
        'data-to': JSON.stringify(props.to),
      }, slots.default?.())
    },
  }),
}

// Vue warnings usually mean a broken test double, invalid component contract,
// or unresolved dependency. Failing at the source prevents warning floods from
// hiding a new regression in otherwise-green CI output.
config.global.config = {
  ...config.global.config,
  warnHandler(message, _instance, trace) {
    throw new Error(`[Vue warn]: ${message}${trace}`)
  },
}

// JSDOM reports unsupported browser operations (such as accidental anchor
// navigation) through a virtual-console side channel that otherwise only
// prints to stderr. Promote those diagnostics to failures as well.
type TestDom = {
  virtualConsole: {
    removeAllListeners(event: string): void
    on(event: string, listener: (error: Error) => void): void
  }
}
const testDom = (globalThis as typeof globalThis & { jsdom?: TestDom }).jsdom
testDom?.virtualConsole.removeAllListeners('jsdomError')
testDom?.virtualConsole.on('jsdomError', (error) => { throw error })

// ResizeObserver is required by vue-echarts' autoresize behavior; jsdom
// doesn't ship one. A no-op stub is sufficient — charts aren't expected
// to visually reflow under unit tests.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: ResizeObserverStub,
  })
}

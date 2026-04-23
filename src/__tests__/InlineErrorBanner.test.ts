// P1-M3: shared top-of-view error banner. Must be visible, render the
// message verbatim, and emit `dismiss` on close-button click.

import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import InlineErrorBanner from '../components/InlineErrorBanner.vue'

describe('InlineErrorBanner', () => {
  it('renders the message', () => {
    const w = mount(InlineErrorBanner, { props: { message: 'request failed' } })
    expect(w.text()).toContain('request failed')
  })

  it('has role="alert" so SRs announce it', () => {
    const w = mount(InlineErrorBanner, { props: { message: 'x' } })
    expect(w.find('[role="alert"]').exists()).toBe(true)
  })

  it('emits dismiss on close-button click', async () => {
    const w = mount(InlineErrorBanner, { props: { message: 'x' } })
    await w.get('button[aria-label="Dismiss error"]').trigger('click')
    expect(w.emitted('dismiss')).toHaveLength(1)
  })
})

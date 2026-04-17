// Non-spec scale polish: SortHeader must activate via keyboard.
//
// Columnheaders carry `tabindex=0` so keyboard users can focus them,
// but pre-fix pressing Enter / Space only fired on the <th> by
// accident of browser defaults — not on the `<div role="columnheader">`
// variant used by virtualized grids. These tests pin the explicit
// keydown behavior so regressions surface loudly.

import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SortHeader from '../components/SortHeader.vue'

describe('SortHeader keyboard activation', () => {
  it('emits sort on Enter keydown', async () => {
    const w = mount(SortHeader, {
      props: {
        label: 'Name',
        column: 'name',
        activeColumn: 'name',
        direction: 'asc',
        as: 'div',
      },
    })
    await w.trigger('keydown', { key: 'Enter' })
    expect(w.emitted('sort')).toEqual([['name']])
  })

  it('emits sort on Space keydown', async () => {
    const w = mount(SortHeader, {
      props: {
        label: 'Created',
        column: 'created_at',
        activeColumn: 'name',
        direction: 'asc',
        as: 'div',
      },
    })
    await w.trigger('keydown', { key: ' ' })
    expect(w.emitted('sort')).toEqual([['created_at']])
  })

  it('still emits sort on click (regression guard)', async () => {
    const w = mount(SortHeader, {
      props: {
        label: 'Status',
        column: 'status',
        activeColumn: 'name',
        direction: 'asc',
      },
    })
    await w.trigger('click')
    expect(w.emitted('sort')).toEqual([['status']])
  })

  it('exposes tabindex=0 and aria-sort for a11y tooling', () => {
    const w = mount(SortHeader, {
      props: {
        label: 'Name',
        column: 'name',
        activeColumn: 'name',
        direction: 'desc',
        as: 'div',
      },
    })
    const el = w.find('[role="columnheader"]')
    expect(el.attributes('tabindex')).toBe('0')
    expect(el.attributes('aria-sort')).toBe('descending')
  })
})

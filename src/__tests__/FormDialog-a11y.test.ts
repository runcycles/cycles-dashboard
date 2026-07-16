import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import FormDialog from '../components/FormDialog.vue'

describe('FormDialog — async error feedback', () => {
  it('announces errors and preserves error contrast in dark mode', () => {
    const w = mount(FormDialog, {
      props: { title: 'Create resource', error: 'Save failed' },
      slots: { default: '<input aria-label="Name" />' },
    })

    const alert = w.get('[role="alert"]')
    expect(alert.text()).toBe('Save failed')
    expect(alert.attributes('aria-live')).toBe('assertive')
    expect(alert.attributes('aria-atomic')).toBe('true')
    expect(alert.classes()).toContain('dark:bg-red-950')
    expect(alert.classes()).toContain('dark:text-red-300')
    w.unmount()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import LoginView from '../views/LoginView.vue'

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
}))

describe('LoginView authentication failures', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('reports service unavailability without advancing the invalid-key lockout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    const wrapper = mount(LoginView)
    await wrapper.get('input').setValue('retry-key')

    for (let attempt = 0; attempt < 3; attempt++) {
      await wrapper.get('form').trigger('submit')
      await flushPromises()
    }

    expect(wrapper.get('[role="alert"]').text()).toContain('Unable to reach the admin server')
    expect(wrapper.get('button').text()).toBe('Login')
    expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
    expect(sessionStorage.getItem('cycles_admin_key')).toBe('retry-key')
    wrapper.unmount()
  })

  it('prefills a retained key so a restore-time outage is directly retryable', () => {
    sessionStorage.setItem('cycles_admin_key', 'saved-retry-key')
    const wrapper = mount(LoginView)

    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('saved-retry-key')
    expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
})

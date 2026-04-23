// NotFoundView + router catch-all. Covers the adaptive CTA (Overview
// when authenticated, Login when not), the echoed attempted path, and
// the catch-all route wiring itself.

import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { setActivePinia, createPinia } from 'pinia'
import NotFoundView from '../views/NotFoundView.vue'
import { useAuthStore } from '../stores/auth'
import type { Capabilities } from '../types'

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'overview', component: { template: '<div />' } },
      { path: '/login', name: 'login', component: { template: '<div />' }, meta: { public: true } },
      { path: '/:pathMatch(.*)*', name: 'not-found', component: NotFoundView, meta: { public: true } },
    ],
  })
}

const caps: Capabilities = {
  view_overview: true, view_budgets: true, view_events: true,
  view_webhooks: true, view_audit: true, view_tenants: true,
  view_api_keys: true, view_policies: true,
}

describe('NotFoundView', () => {
  beforeEach(() => { setActivePinia(createPinia()) })

  it('renders 404 + the attempted path', async () => {
    const router = makeRouter()
    router.push('/does/not/exist?x=1')
    await router.isReady()
    const w = mount(NotFoundView, { global: { plugins: [router] } })
    await flushPromises()
    expect(w.text()).toContain('404')
    expect(w.text()).toContain('Page not found')
    expect(w.text()).toContain('/does/not/exist?x=1')
  })

  it('shows Login CTA when unauthenticated', async () => {
    const router = makeRouter()
    router.push('/bad')
    await router.isReady()
    const w = mount(NotFoundView, { global: { plugins: [router] } })
    await flushPromises()
    expect(w.text()).toContain('Go to Login')
    expect(w.text()).not.toContain('Back to Overview')
  })

  it('shows Overview CTA when authenticated', async () => {
    const auth = useAuthStore()
    auth.apiKey = 'k'
    auth.capabilities = caps
    const router = makeRouter()
    router.push('/bad')
    await router.isReady()
    const w = mount(NotFoundView, { global: { plugins: [router] } })
    await flushPromises()
    expect(w.text()).toContain('Back to Overview')
    expect(w.text()).not.toContain('Go to Login')
  })

  it('router catch-all resolves unknown paths to not-found', async () => {
    const router = makeRouter()
    router.push('/totally/unknown')
    await router.isReady()
    expect(router.currentRoute.value.name).toBe('not-found')
  })
})

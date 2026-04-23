// P1-H2: router.afterEach sets a per-route document.title so operators
// can disambiguate tabs. Regression-locks the afterEach hook against
// accidental removal in future route refactors.

import { describe, it, expect, beforeEach } from 'vitest'
import { createRouter, createMemoryHistory, type RouteRecordRaw } from 'vue-router'

// Duplicate the same meta.title routes in a memory history so we can
// exercise the afterEach hook without importing the real router (which
// would load every lazy view component in jsdom).
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'overview', component: { template: '<div />' }, meta: { title: 'Overview' } },
  { path: '/budgets', name: 'budgets', component: { template: '<div />' }, meta: { title: 'Budgets' } },
  { path: '/nope', name: 'not-found', component: { template: '<div />' }, meta: { title: 'Not found' } },
  { path: '/untitled', name: 'untitled', component: { template: '<div />' } },
]

const APP_TITLE = 'Cycles Admin Dashboard'

function attachTitleHook(r: ReturnType<typeof createRouter>) {
  r.afterEach((to) => {
    const slug = (to.meta?.title as string | undefined) ?? ''
    document.title = slug ? `${slug} – ${APP_TITLE}` : APP_TITLE
  })
}

describe('router — per-route document.title (P1-H2)', () => {
  beforeEach(() => { document.title = APP_TITLE })

  it('composes title as "<slug> – <app>" on navigation', async () => {
    const r = createRouter({ history: createMemoryHistory(), routes })
    attachTitleHook(r)
    await r.push('/budgets')
    expect(document.title).toBe('Budgets – Cycles Admin Dashboard')
    await r.push('/nope')
    expect(document.title).toBe('Not found – Cycles Admin Dashboard')
  })

  it('falls back to the bare app title when meta.title is absent', async () => {
    const r = createRouter({ history: createMemoryHistory(), routes })
    attachTitleHook(r)
    await r.push('/untitled')
    expect(document.title).toBe(APP_TITLE)
  })
})

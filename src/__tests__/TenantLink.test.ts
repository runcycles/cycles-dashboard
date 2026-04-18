// TenantLink — sentinel-value handling.
//
// Real tenant IDs render as a clickable router-link into the
// tenant-detail view. Server-emitted sentinels (platform-scope
// placeholders that have no tenant-detail page to land on) render as
// italic plain text so operators don't click through to a 404.
//
// Two sentinel conventions coexist on the wire:
//  - `__system__` / `__root__` — underscore-wrapped, platform-scoped
//    operations.
//  - `<unauthenticated>` — angle-bracket-wrapped, audit rows whose
//    pre-auth request 401'd before the key → tenant lookup ran.
//
// This spec pins both forms + verifies real IDs still drill down.

import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import TenantLink from '../components/TenantLink.vue'

function renderWith(tenantId: string) {
  return mount(TenantLink, {
    props: { tenantId },
    global: {
      stubs: {
        RouterLink: { props: ['to'], template: '<a :data-to="JSON.stringify(to)"><slot /></a>' },
      },
    },
  })
}

describe('TenantLink', () => {
  it('drills down on a real tenant_id', () => {
    const w = renderWith('acme-corp')
    const a = w.find('a')
    expect(a.exists()).toBe(true)
    const to = JSON.parse(a.attributes('data-to')!)
    expect(to).toEqual({ name: 'tenant-detail', params: { id: 'acme-corp' } })
    expect(a.text()).toBe('acme-corp')
  })

  it('renders __system__ as non-drillable italic text', () => {
    const w = renderWith('__system__')
    expect(w.find('a').exists()).toBe(false)
    expect(w.find('span').text()).toBe('__system__')
    expect(w.find('span').classes()).toContain('italic')
  })

  it('renders __root__ as non-drillable italic text', () => {
    const w = renderWith('__root__')
    expect(w.find('a').exists()).toBe(false)
    expect(w.find('span').text()).toBe('__root__')
  })

  it('renders <unauthenticated> as non-drillable italic text (angle-bracket sentinel)', () => {
    // Audit rows where a pre-auth request 401'd before key→tenant
    // resolution emit `<unauthenticated>` in the tenant_id column.
    // Must not render as a router-link — tenant-detail /acme would
    // 404 on the literal "<unauthenticated>" id.
    const w = renderWith('<unauthenticated>')
    expect(w.find('a').exists()).toBe(false)
    expect(w.find('span').text()).toBe('<unauthenticated>')
    expect(w.find('span').classes()).toContain('italic')
  })

  it('renders any other angle-bracket-wrapped sentinel as non-drillable', () => {
    // Defensive — if the server introduces a new `<something>` placeholder
    // in the future (e.g. `<anonymous>`, `<system>`), it should default
    // to non-drillable rather than a broken link.
    const w = renderWith('<anonymous>')
    expect(w.find('a').exists()).toBe(false)
    expect(w.find('span').text()).toBe('<anonymous>')
  })
})

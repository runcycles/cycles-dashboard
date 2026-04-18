// Unit tests for the cycles-governance-admin v0.1.25.30 bulk-action
// audit detail renderer. The component sits inside AuditView's
// expanded row panel and surfaces structured succeeded/failed/skipped
// outcomes plus filter echo + duration. The old raw-JSON <pre> still
// ships as a collapsible fallback (covered at the AuditView level).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'
import BulkActionAuditDetail from '../components/BulkActionAuditDetail.vue'

// TenantLink is a <router-link> for real tenants — memory router is
// enough; the component is pure-render and doesn't navigate in tests.
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/tenants/:id', name: 'tenant-detail', component: { template: '<div />' } },
  ],
})

function mountWith(props: { operation: string; metadata: Record<string, unknown> }) {
  return mount(BulkActionAuditDetail, { props, global: { plugins: [router] } })
}

describe('BulkActionAuditDetail', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('renders nothing when metadata lacks the v0.1.25.30 shape (pre-.30 fallback)', () => {
    const w = mountWith({
      operation: 'bulkActionTenants',
      metadata: { actor_type: 'ADMIN_ON_BEHALF_OF' },
    })
    expect(w.find('[data-testid="bulk-action-audit-detail"]').exists()).toBe(false)
  })

  it('renders nothing when operation is non-bulk even if metadata has the keys', () => {
    const w = mountWith({
      operation: 'createBudget',
      metadata: { succeeded_ids: ['x'], duration_ms: 100 },
    })
    expect(w.find('[data-testid="bulk-action-audit-detail"]').exists()).toBe(false)
  })

  it('renders header with action verb, noun, duration, and three-count summary', () => {
    const w = mountWith({
      operation: 'bulkActionBudgets',
      metadata: {
        action: 'DEBIT',
        duration_ms: 1234,
        succeeded_ids: ['b-1', 'b-2', 'b-3'],
        failed_rows: [{ id: 'b-4', error_code: 'BUDGET_EXCEEDED' }],
        skipped_rows: [],
      },
    })
    const text = w.text()
    expect(text).toContain('Debit budgets')
    expect(text).toContain('1.23s')
    expect(text).toContain('3 succeeded')
    expect(text).toContain('1 failed')
    expect(text).toContain('0 skipped')
  })

  it('formats sub-second duration as ms', () => {
    const w = mountWith({
      operation: 'bulkActionTenants',
      metadata: { action: 'SUSPEND', duration_ms: 87, succeeded_ids: ['t-1'] },
    })
    expect(w.text()).toContain('87ms')
  })

  it('falls back to noun-only header when action is absent', () => {
    const w = mountWith({
      operation: 'bulkActionWebhooks',
      metadata: { succeeded_ids: ['w-1'] },
    })
    expect(w.text()).toContain('webhooks bulk action')
  })

  it('renders filter echo with tenant_id via TenantLink (drillable)', () => {
    const w = mountWith({
      operation: 'bulkActionBudgets',
      metadata: {
        filter: { tenant_id: 'acme', over_limit: true, unit: 'USD' },
        succeeded_ids: ['b-1'],
      },
    })
    // TenantLink renders the id as a router-link for non-sentinel ids.
    const link = w.find('a')
    expect(link.exists()).toBe(true)
    expect(link.text()).toBe('acme')
    // Non-tenant filter entries render as plain mono text.
    expect(w.text()).toContain('over_limit')
    expect(w.text()).toContain('true')
    expect(w.text()).toContain('unit')
    expect(w.text()).toContain('USD')
  })

  it('skips empty / null / undefined filter entries but keeps false and 0', () => {
    const w = mountWith({
      operation: 'bulkActionBudgets',
      metadata: {
        filter: {
          tenant_id: 'acme',
          scope_prefix: '',
          has_debt: false,
          utilization_min: 0,
          unit: null,
        },
        succeeded_ids: ['b-1'],
      },
    })
    const text = w.text()
    expect(text).toContain('has_debt')
    expect(text).toContain('false')
    expect(text).toContain('utilization_min')
    // scope_prefix and unit were empty/null and must not appear.
    expect(text).not.toContain('scope_prefix')
    expect(text).not.toContain('unit')
  })

  it('failed section is open by default and renders error_code chip + prose', () => {
    const w = mountWith({
      operation: 'bulkActionBudgets',
      metadata: {
        failed_rows: [{
          id: 'b-42',
          error_code: 'BUDGET_EXCEEDED',
          message: 'requested 100, remaining 42',
        }],
      },
    })
    const details = w.findAll('details')
    // Exactly one section for failed; no succeeded / skipped sections
    // should be emitted when their arrays are absent/empty.
    expect(details.length).toBe(1)
    expect(details[0].attributes('open')).toBeDefined()
    expect(w.text()).toContain('BUDGET_EXCEEDED')
    expect(w.text()).toContain('Budget exceeded — requested 100, remaining 42')
  })

  it('renders unknown error_codes verbatim for forward-compat', () => {
    const w = mountWith({
      operation: 'bulkActionBudgets',
      metadata: {
        failed_rows: [{ id: 'b-1', error_code: 'FUTURE_CODE', message: 'new spec' }],
      },
    })
    expect(w.text()).toContain('FUTURE_CODE: new spec')
  })

  it('renders skipped rows with their reason', () => {
    const w = mountWith({
      operation: 'bulkActionTenants',
      metadata: {
        skipped_rows: [{ id: 't-skip', reason: 'already SUSPENDED' }],
      },
    })
    expect(w.text()).toContain('t-skip')
    expect(w.text()).toContain('already SUSPENDED')
  })

  it('succeeded section has a Copy-all button that writes comma-joined ids', async () => {
    const w = mountWith({
      operation: 'bulkActionBudgets',
      metadata: { succeeded_ids: ['b-1', 'b-2', 'b-3'] },
    })
    const btn = w.find('button[aria-label="Copy all succeeded IDs"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('b-1,b-2,b-3')
    await nextTick()
    await Promise.resolve()
    await nextTick()
    expect(btn.text()).toBe('Copied')
  })

  it('per-row Copy button writes the single id to the clipboard', async () => {
    const w = mountWith({
      operation: 'bulkActionBudgets',
      metadata: { failed_rows: [{ id: 'budget-xyz', error_code: 'INTERNAL_ERROR' }] },
    })
    const btn = w.find('button[aria-label="Copy ID budget-xyz"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('budget-xyz')
  })

  it('renders when only filter is present (no row arrays) — shape gate is permissive', () => {
    const w = mountWith({
      operation: 'bulkActionWebhooks',
      metadata: { filter: { tenant_id: 'acme', status: 'ACTIVE' }, duration_ms: 50 },
    })
    expect(w.find('[data-testid="bulk-action-audit-detail"]').exists()).toBe(true)
    expect(w.text()).toContain('50ms')
    expect(w.text()).toContain('0 succeeded')
  })
})

// Per-row outcome dialog. Opens after a filter-apply bulk submit returns
// any failed[] or skipped[] rows; renders a succeeded summary badge plus
// collapsible failed/skipped sections with copy-to-clipboard on each row.
//
// Covers:
//   - succeeded summary count
//   - failed rows show id, error_code → human prose, Copy ID button
//   - skipped rows show id + reason
//   - failed defaults open, skipped defaults closed when failures exist
//   - Escape + overlay click + Close button all emit 'close'
//   - unknown error_code forward-compat (renders `code: message`)

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import BulkActionResultDialog from '../components/BulkActionResultDialog.vue'
import type { BulkActionRowOutcome } from '../types'

function outcome(id: string, extras: Partial<BulkActionRowOutcome> = {}): BulkActionRowOutcome {
  return { id, ...extras }
}

const baseResponse = {
  succeeded: [outcome('t-ok-1'), outcome('t-ok-2')],
  failed: [],
  skipped: [],
  total_matched: 2,
}

describe('BulkActionResultDialog', () => {
  beforeEach(() => {
    // Global clipboard stub — jsdom ships it undefined.
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('renders succeeded-count summary', () => {
    const w = mount(BulkActionResultDialog, {
      props: { actionVerb: 'Suspend', itemNounPlural: 'tenants', response: baseResponse },
    })
    expect(w.text()).toContain('Suspend tenants — results')
    // Count + noun are in adjacent spans inside a <summary>; w.text() flattens the
    // whitespace between them. Match the same pattern the failed/skipped specs use.
    expect(w.text()).toMatch(/2\s*succeeded/)
    expect(w.text()).toContain('2 rows processed')
  })

  it('renders failed rows with canonical prose for known error_codes', () => {
    const response = {
      succeeded: [],
      failed: [
        outcome('t-bad', { error_code: 'BUDGET_EXCEEDED', message: 'requested 100, remaining 42' }),
      ],
      skipped: [],
      total_matched: 1,
    }
    const w = mount(BulkActionResultDialog, {
      props: { actionVerb: 'Debit', itemNounPlural: 'budgets', response },
    })
    expect(w.text()).toMatch(/1\s*failed/)
    expect(w.text()).toContain('t-bad')
    expect(w.text()).toContain('Budget exceeded — requested 100, remaining 42')
  })

  it('renders unknown error_codes verbatim for forward-compat', () => {
    const response = {
      succeeded: [],
      failed: [outcome('x', { error_code: 'FUTURE_CODE', message: 'new spec' })],
      skipped: [],
      total_matched: 1,
    }
    const w = mount(BulkActionResultDialog, {
      props: { actionVerb: 'Pause', itemNounPlural: 'webhooks', response },
    })
    expect(w.text()).toContain('FUTURE_CODE: new spec')
  })

  it('renders skipped rows with their reason', () => {
    const response = {
      succeeded: [],
      failed: [],
      skipped: [outcome('t-skip', { reason: 'already SUSPENDED' })],
      total_matched: 1,
    }
    const w = mount(BulkActionResultDialog, {
      props: { actionVerb: 'Suspend', itemNounPlural: 'tenants', response },
    })
    expect(w.text()).toMatch(/1\s*skipped/)
    expect(w.text()).toContain('t-skip')
    expect(w.text()).toContain('already SUSPENDED')
  })

  it('failed section opens by default when both failed and skipped rows exist', () => {
    const response = {
      succeeded: [],
      failed: [outcome('f1', { error_code: 'INTERNAL_ERROR' })],
      skipped: [outcome('s1', { reason: 'no-op' })],
      total_matched: 2,
    }
    const w = mount(BulkActionResultDialog, {
      props: { actionVerb: 'Suspend', itemNounPlural: 'tenants', response },
    })
    const details = w.findAll('details')
    expect(details.length).toBe(2)
    // First details is failed (open); second is skipped (closed).
    expect(details[0].attributes('open')).toBeDefined()
    expect(details[1].attributes('open')).toBeUndefined()
  })

  it('skipped section opens by default when no failures exist', () => {
    const response = {
      succeeded: [],
      failed: [],
      skipped: [outcome('s1', { reason: 'no-op' })],
      total_matched: 1,
    }
    const w = mount(BulkActionResultDialog, {
      props: { actionVerb: 'Suspend', itemNounPlural: 'tenants', response },
    })
    const details = w.findAll('details')
    expect(details.length).toBe(1)
    expect(details[0].attributes('open')).toBeDefined()
  })

  it('Copy ID button writes the row id to the clipboard', async () => {
    const response = {
      succeeded: [],
      failed: [outcome('tenant-alpha', { error_code: 'INTERNAL_ERROR' })],
      skipped: [],
      total_matched: 1,
    }
    const w = mount(BulkActionResultDialog, {
      props: { actionVerb: 'Suspend', itemNounPlural: 'tenants', response },
    })
    const copyBtn = w.find('button[aria-label="Copy ID tenant-alpha"]')
    expect(copyBtn.exists()).toBe(true)
    await copyBtn.trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('tenant-alpha')
    await nextTick()
    // Await the resolved writeText promise flush.
    await Promise.resolve()
    await nextTick()
    expect(copyBtn.text()).toBe('Copied')
  })

  it('emits close on Close button click', async () => {
    const w = mount(BulkActionResultDialog, {
      props: { actionVerb: 'Suspend', itemNounPlural: 'tenants', response: baseResponse },
    })
    // Close is the last button in the footer.
    const buttons = w.findAll('button')
    await buttons[buttons.length - 1].trigger('click')
    expect(w.emitted('close')).toBeTruthy()
  })

  it('emits close on Escape key', async () => {
    const w = mount(BulkActionResultDialog, {
      props: { actionVerb: 'Suspend', itemNounPlural: 'tenants', response: baseResponse },
      attachTo: document.body,
    })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(w.emitted('close')).toBeTruthy()
    w.unmount()
  })

  it('emits close on overlay click (outside dialog)', async () => {
    const w = mount(BulkActionResultDialog, {
      props: { actionVerb: 'Suspend', itemNounPlural: 'tenants', response: baseResponse },
    })
    // Overlay is the root; click.self fires only when the click target IS
    // the overlay — trigger on the outer div directly.
    await w.trigger('click')
    expect(w.emitted('close')).toBeTruthy()
  })

  it('embeds total_matched in the header when rows are truncated', () => {
    const response = {
      succeeded: [outcome('a')],
      failed: [],
      skipped: [],
      total_matched: 500,
    }
    const w = mount(BulkActionResultDialog, {
      props: { actionVerb: 'Suspend', itemNounPlural: 'tenants', response },
    })
    expect(w.text()).toContain('1 row processed of 500 matched')
  })

  it('succeeded rows render behind a collapsed <details> so the default view stays focused on failed rows', () => {
    const response = {
      succeeded: [outcome('budget-a'), outcome('budget-b')],
      failed: [outcome('budget-c', { error_code: 'BUDGET_EXCEEDED', message: 'over limit' })],
      skipped: [],
      total_matched: 3,
    }
    const w = mount(BulkActionResultDialog, {
      props: { actionVerb: 'Debit', itemNounPlural: 'budgets', response },
    })
    // Two <details>: succeeded (closed) + failed (open).
    const details = w.findAll('details')
    expect(details.length).toBe(2)
    // succeeded is rendered first in the template; defaults closed so
    // the operator's attention lands on the failed block below.
    const succeeded = details[0]
    expect(succeeded.attributes('open')).toBeUndefined()
    expect(succeeded.text()).toContain('2')
    expect(succeeded.text()).toContain('succeeded')
    // The succeeded ids are still in the DOM (collapsed), so operator
    // can expand to see exactly which rows went through.
    expect(succeeded.text()).toContain('budget-a')
    expect(succeeded.text()).toContain('budget-b')
    // Second details is failed, opened by default.
    expect(details[1].attributes('open')).toBeDefined()
  })

  it('labelById renders scope as primary and the id as a secondary mono line on every enumerated row', () => {
    const response = {
      succeeded: [outcome('uuid-1')],
      failed: [outcome('uuid-2', { error_code: 'INVALID_TRANSITION', message: 'unit mismatch' })],
      skipped: [outcome('uuid-3', { reason: 'no-op' })],
      total_matched: 3,
    }
    const labelById = {
      'uuid-1': 'tenant:acme/app:batch',
      'uuid-2': 'tenant:acme/agent:reviewer',
      'uuid-3': 'tenant:acme/workspace:prod',
    }
    const w = mount(BulkActionResultDialog, {
      props: { actionVerb: 'Credit', itemNounPlural: 'budgets', response, labelById },
    })
    const text = w.text()
    // Every row's scope is rendered alongside its id.
    expect(text).toContain('tenant:acme/app:batch')
    expect(text).toContain('uuid-1')
    expect(text).toContain('tenant:acme/agent:reviewer')
    expect(text).toContain('uuid-2')
    expect(text).toContain('tenant:acme/workspace:prod')
    expect(text).toContain('uuid-3')
  })

  it('omits scope lines when labelById is absent — preserves the tenants/webhooks behaviour where ids are human-readable', () => {
    const response = {
      succeeded: [],
      failed: [outcome('acme-corp', { error_code: 'INVALID_TRANSITION', message: 'already SUSPENDED' })],
      skipped: [],
      total_matched: 1,
    }
    const w = mount(BulkActionResultDialog, {
      // No labelById prop.
      props: { actionVerb: 'Suspend', itemNounPlural: 'tenants', response },
    })
    // The failed row still renders — id is the only identifier, and there's
    // no extra scope line above it.
    expect(w.text()).toContain('acme-corp')
  })

  // Triage deep-links — budgets-only. Ledger ids are opaque UUIDs the
  // operator can't search for anywhere (server's audit search doesn't
  // match on ledger_id, and BudgetsView's list search matches only
  // tenant_id + scope). The dialog must therefore offer a pair of
  // router-links per row: View budget lands on the specific ledger
  // row in BudgetsView (via scope-based search), View audit lands on
  // the bulk invocation audit entry (whose metadata expands to the
  // per-row outcome list).
  const RouterLinkStub = {
    props: ['to'],
    template: '<a :data-to="JSON.stringify(to)" :aria-label="$attrs[\'aria-label\']"><slot /></a>',
  }

  it('renders View budget + View audit links per row when itemNounPlural=budgets and tenantId is provided', () => {
    const response = {
      succeeded: [outcome('uuid-ok')],
      failed: [outcome('uuid-bad', { error_code: 'BUDGET_EXCEEDED', message: 'over limit' })],
      skipped: [outcome('uuid-skip', { reason: 'no-op' })],
      total_matched: 3,
    }
    const labelById = {
      'uuid-ok': 'tenant:acme/app:batch',
      'uuid-bad': 'tenant:acme/agent:reviewer',
      'uuid-skip': 'tenant:acme/workspace:prod',
    }
    const w = mount(BulkActionResultDialog, {
      props: {
        actionVerb: 'Credit',
        itemNounPlural: 'budgets',
        response,
        labelById,
        tenantId: 'acme',
      },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })
    // Three router-links in each row × 2 (View budget + View audit) = 6 links.
    const links = w.findAll('a[data-to]')
    expect(links.length).toBe(6)
    // Failed row's View budget target carries the scope — not the UUID —
    // because the server's search endpoint matches tenant_id + scope.
    const targets = links.map((l) => JSON.parse(l.attributes('data-to')!))
    const viewBudgetFailed = targets.find(
      (t) => t.path === '/budgets' && t.query.search === 'tenant:acme/agent:reviewer',
    )
    expect(viewBudgetFailed).toBeDefined()
    expect(viewBudgetFailed.query.tenant_id).toBe('acme')
    // Every View audit link targets the same invocation entry (filter
    // by tenant + operation, since the bulk endpoint writes one audit
    // row with resource_id='bulk-action').
    const viewAudit = targets.filter(
      (t) => t.path === '/audit' && t.query.operation === 'bulkActionBudgets',
    )
    expect(viewAudit.length).toBe(3)
    expect(viewAudit.every((t) => t.query.tenant_id === 'acme')).toBe(true)
  })

  it('omits triage links when tenantId is absent — guards against cross-tenant deep-links that would 400', () => {
    const response = {
      succeeded: [],
      failed: [outcome('uuid-bad', { error_code: 'BUDGET_EXCEEDED', message: 'over limit' })],
      skipped: [],
      total_matched: 1,
    }
    const w = mount(BulkActionResultDialog, {
      props: {
        actionVerb: 'Debit',
        itemNounPlural: 'budgets',
        response,
        labelById: { 'uuid-bad': 'tenant:acme/app:batch' },
        // No tenantId.
      },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })
    expect(w.findAll('a[data-to]').length).toBe(0)
    // Copy ID still available as the fallback triage path.
    expect(w.find('button[aria-label="Copy ID uuid-bad"]').exists()).toBe(true)
  })

  it('omits triage links when itemNounPlural is not budgets — tenants/webhooks ids are already human-readable and searchable', () => {
    const response = {
      succeeded: [],
      failed: [outcome('acme-corp', { error_code: 'INVALID_TRANSITION', message: 'already SUSPENDED' })],
      skipped: [],
      total_matched: 1,
    }
    const w = mount(BulkActionResultDialog, {
      props: {
        actionVerb: 'Suspend',
        itemNounPlural: 'tenants',
        response,
        tenantId: 'acme',
      },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })
    expect(w.findAll('a[data-to]').length).toBe(0)
  })

  it('emits close when a triage router-link is clicked — prevents the dialog from overlaying the filtered list', async () => {
    const response = {
      succeeded: [],
      failed: [outcome('uuid-bad', { error_code: 'BUDGET_EXCEEDED', message: 'over' })],
      skipped: [],
      total_matched: 1,
    }
    const w = mount(BulkActionResultDialog, {
      props: {
        actionVerb: 'Debit',
        itemNounPlural: 'budgets',
        response,
        labelById: { 'uuid-bad': 'tenant:acme/app:batch' },
        tenantId: 'acme',
      },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })
    const viewBudget = w.find('a[data-to]')
    expect(viewBudget.exists()).toBe(true)
    await viewBudget.trigger('click')
    expect(w.emitted('close')).toBeTruthy()
  })

  // Save JSON — operators need to retain triage context after the
  // dialog closes (enumerated rows, per-row error codes, scope labels
  // aren't reconstructable from the toast summary or refreshed list).
  it('Save JSON button creates a downloadable blob with the full response + context', async () => {
    // jsdom doesn't implement URL.createObjectURL / revokeObjectURL —
    // stub them so the button click doesn't throw. The returned value
    // is opaque; we assert the Blob payload via createObjectURL's arg.
    let capturedBlob: Blob | null = null
    const createSpy = vi.fn((b: Blob) => {
      capturedBlob = b
      return 'blob:test-url'
    })
    const revokeSpy = vi.fn()
    globalThis.URL.createObjectURL = createSpy
    globalThis.URL.revokeObjectURL = revokeSpy

    const response = {
      succeeded: [outcome('uuid-ok')],
      failed: [outcome('uuid-bad', { error_code: 'BUDGET_EXCEEDED', message: 'over' })],
      skipped: [outcome('uuid-skip', { reason: 'no-op' })],
      total_matched: 3,
    }
    const labelById = {
      'uuid-ok': 'tenant:acme/app:batch',
      'uuid-bad': 'tenant:acme/agent:reviewer',
      'uuid-skip': 'tenant:acme/workspace:prod',
    }
    const w = mount(BulkActionResultDialog, {
      props: {
        actionVerb: 'Credit',
        itemNounPlural: 'budgets',
        response,
        labelById,
        tenantId: 'acme',
      },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })

    const saveBtn = w.find('button[aria-label="Save results as JSON"]')
    expect(saveBtn.exists()).toBe(true)
    await saveBtn.trigger('click')

    expect(createSpy).toHaveBeenCalledOnce()
    expect(revokeSpy).toHaveBeenCalledOnce()
    expect(capturedBlob).toBeInstanceOf(Blob)
    expect((capturedBlob as unknown as Blob | null)?.type).toBe('application/json')
    const text = await (capturedBlob as unknown as Blob).text()
    const payload = JSON.parse(text)
    expect(payload.actionVerb).toBe('Credit')
    expect(payload.itemNounPlural).toBe('budgets')
    expect(payload.tenantId).toBe('acme')
    expect(payload.labelById).toEqual(labelById)
    expect(payload.response).toEqual(response)
    expect(typeof payload.exportedAt).toBe('string')
    // ISO timestamp — parsable as a date.
    expect(Number.isNaN(Date.parse(payload.exportedAt))).toBe(false)
  })
})

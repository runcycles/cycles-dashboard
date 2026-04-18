// cycles-governance-admin v0.1.25.24 filter DSL — dashboard wire-up.
//
// AuditView gains two new filter surfaces:
//   1. Error Code input — comma-separated IN-list, datalist typeahead over the
//      ErrorCode enum.
//   2. Status select — 5 preset bands that translate to status_min/status_max.
//
// Plus the existing Search field now advertises the wider match set
// (resource_id + log_id + error_code + operation) in its placeholder and
// aria-label, and applyQueryParams accepts error_code + status_band from the
// URL so OverviewView's Recent Denials pill can deep-link.
//
// These specs stub listAuditLogs and assert the wire-format sent by
// buildFilterParams under each form state + URL-param drive.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import AuditView from '../views/AuditView.vue'
import { ERROR_CODES } from '../types'

const listAuditLogsMock = vi.fn<(params: Record<string, string>) => Promise<unknown>>()

vi.mock('../api/client', () => ({
  listAuditLogs: (params: Record<string, string>) => listAuditLogsMock(params),
  ApiError: class ApiError extends Error {},
}))

const routeQuery: Record<string, string> = {}
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useRoute: () => ({ query: routeQuery }),
  RouterLink: { template: '<a><slot /></a>' },
}))

beforeEach(() => {
  setActivePinia(createPinia())
  for (const k of Object.keys(routeQuery)) delete routeQuery[k]
  listAuditLogsMock.mockReset()
  listAuditLogsMock.mockResolvedValue({ logs: [], has_more: false, next_cursor: undefined })
})

async function mountAndSubmit(fill: (w: ReturnType<typeof mount>) => Promise<void>) {
  const wrapper = mount(AuditView)
  await flushPromises()
  listAuditLogsMock.mockClear()
  await fill(wrapper)
  await wrapper.find('form').trigger('submit')
  await flushPromises()
  return { wrapper, lastCall: listAuditLogsMock.mock.calls.at(-1)?.[0] ?? {} }
}

describe('AuditView — v0.1.25.24 error_code IN-list filter', () => {
  it('does not send error_code when the input is empty', async () => {
    const { lastCall } = await mountAndSubmit(async () => {})
    expect(lastCall.error_code).toBeUndefined()
  })

  it('sends a single code verbatim', async () => {
    const { lastCall } = await mountAndSubmit(async w => {
      await w.find('#audit-error-code').setValue('BUDGET_EXCEEDED')
    })
    expect(lastCall.error_code).toBe('BUDGET_EXCEEDED')
  })

  it('normalizes comma-separated list: trim, drop empties, dedupe', async () => {
    const { lastCall } = await mountAndSubmit(async w => {
      await w.find('#audit-error-code').setValue(' BUDGET_EXCEEDED , POLICY_VIOLATION , BUDGET_EXCEEDED ')
    })
    expect(lastCall.error_code).toBe('BUDGET_EXCEEDED,POLICY_VIOLATION')
  })

  it('accepts whitespace separation too (pasted lists from logs)', async () => {
    const { lastCall } = await mountAndSubmit(async w => {
      await w.find('#audit-error-code').setValue('BUDGET_EXCEEDED  POLICY_VIOLATION')
    })
    expect(lastCall.error_code).toBe('BUDGET_EXCEEDED,POLICY_VIOLATION')
  })

  it('exposes the full ErrorCode enum via <datalist> for typeahead', () => {
    const wrapper = mount(AuditView)
    const options = wrapper.findAll('#audit-error-code-options option')
    expect(options.length).toBe(ERROR_CODES.length)
    const values = options.map(o => o.attributes('value'))
    expect(values).toContain('BUDGET_EXCEEDED')
    expect(values).toContain('POLICY_VIOLATION')
    expect(values).toContain('INSUFFICIENT_PERMISSIONS')
  })
})

describe('AuditView — v0.1.25.24 status_min/status_max range filter', () => {
  it('does not send range params when status is All', async () => {
    const { lastCall } = await mountAndSubmit(async () => {})
    expect(lastCall.status_min).toBeUndefined()
    expect(lastCall.status_max).toBeUndefined()
  })

  it('2xx Success band maps to [200, 299]', async () => {
    const { lastCall } = await mountAndSubmit(async w => {
      await w.find('[data-band="success"]').trigger('click')
    })
    expect(lastCall.status_min).toBe('200')
    expect(lastCall.status_max).toBe('299')
  })

  it('4xx + 5xx Errors band maps to [400, 599]', async () => {
    const { lastCall } = await mountAndSubmit(async w => {
      await w.find('[data-band="errors"]').trigger('click')
    })
    expect(lastCall.status_min).toBe('400')
    expect(lastCall.status_max).toBe('599')
  })

  it('4xx Client Errors band maps to [400, 499]', async () => {
    const { lastCall } = await mountAndSubmit(async w => {
      await w.find('[data-band="4xx"]').trigger('click')
    })
    expect(lastCall.status_min).toBe('400')
    expect(lastCall.status_max).toBe('499')
  })

  it('5xx Server Errors band maps to [500, 599]', async () => {
    const { lastCall } = await mountAndSubmit(async w => {
      await w.find('[data-band="5xx"]').trigger('click')
    })
    expect(lastCall.status_min).toBe('500')
    expect(lastCall.status_max).toBe('599')
  })

  it('never sends exact `status` (dashboard sidesteps the spec mutex)', async () => {
    const { lastCall } = await mountAndSubmit(async w => {
      await w.find('[data-band="errors"]').trigger('click')
      await w.find('#audit-error-code').setValue('BUDGET_EXCEEDED')
    })
    expect(lastCall.status).toBeUndefined()
    expect(lastCall.status_min).toBe('400')
    expect(lastCall.error_code).toBe('BUDGET_EXCEEDED')
  })

  it('renders the five preset bands as a radiogroup of chips', () => {
    const wrapper = mount(AuditView)
    const group = wrapper.find('#audit-status')
    expect(group.attributes('role')).toBe('radiogroup')
    const chips = wrapper.findAll('#audit-status [role="radio"]')
    expect(chips.length).toBe(5)
    const bands = chips.map(c => c.attributes('data-band'))
    expect(bands).toEqual(['', 'success', 'errors', '4xx', '5xx'])
    // Default state: All chip is the active radio.
    expect(wrapper.find('[data-band=""]').attributes('aria-checked')).toBe('true')
  })

  it('clicking a band updates aria-checked for the chip group', async () => {
    const wrapper = mount(AuditView)
    await wrapper.find('[data-band="errors"]').trigger('click')
    expect(wrapper.find('[data-band="errors"]').attributes('aria-checked')).toBe('true')
    expect(wrapper.find('[data-band=""]').attributes('aria-checked')).toBe('false')
    expect(wrapper.find('[data-band="success"]').attributes('aria-checked')).toBe('false')
  })
})

describe('AuditView — search field advertises the v0.1.25.24 widened match set', () => {
  it('placeholder lists all four matched fields', () => {
    const wrapper = mount(AuditView)
    const placeholder = wrapper.find('#audit-search').attributes('placeholder') ?? ''
    expect(placeholder).toContain('resource_id')
    expect(placeholder).toContain('log_id')
    expect(placeholder).toContain('error_code')
    expect(placeholder).toContain('operation')
  })

  it('aria-label matches the widened match set', () => {
    const wrapper = mount(AuditView)
    const label = wrapper.find('#audit-search').attributes('aria-label') ?? ''
    expect(label.toLowerCase()).toContain('resource_id')
    expect(label.toLowerCase()).toContain('log_id')
    expect(label.toLowerCase()).toContain('error_code')
    expect(label.toLowerCase()).toContain('operation')
  })
})

describe('AuditView — v0.1.25.24 error_code_exclude (NOT-IN-list) filter', () => {
  it('does not send error_code_exclude when the input is empty', async () => {
    const { lastCall } = await mountAndSubmit(async () => {})
    expect(lastCall.error_code_exclude).toBeUndefined()
  })

  it('sends a single exclude code verbatim', async () => {
    const { lastCall } = await mountAndSubmit(async w => {
      await w.find('#audit-error-code-exclude').setValue('INTERNAL_ERROR')
    })
    expect(lastCall.error_code_exclude).toBe('INTERNAL_ERROR')
  })

  it('normalizes comma-separated list: trim, drop empties, dedupe', async () => {
    const { lastCall } = await mountAndSubmit(async w => {
      await w.find('#audit-error-code-exclude').setValue(' INTERNAL_ERROR , TIMEOUT , INTERNAL_ERROR ')
    })
    expect(lastCall.error_code_exclude).toBe('INTERNAL_ERROR,TIMEOUT')
  })

  it('can combine with error_code (AND-composed narrow-then-exclude)', async () => {
    const { lastCall } = await mountAndSubmit(async w => {
      await w.find('#audit-error-code').setValue('BUDGET_EXCEEDED,POLICY_VIOLATION')
      await w.find('#audit-error-code-exclude').setValue('INTERNAL_ERROR')
    })
    expect(lastCall.error_code).toBe('BUDGET_EXCEEDED,POLICY_VIOLATION')
    expect(lastCall.error_code_exclude).toBe('INTERNAL_ERROR')
  })

  it('reuses the error_code datalist for typeahead', () => {
    const wrapper = mount(AuditView)
    // Both error_code and error_code_exclude inputs point at the same datalist id
    expect(wrapper.find('#audit-error-code').attributes('list')).toBe('audit-error-code-options')
    expect(wrapper.find('#audit-error-code-exclude').attributes('list')).toBe('audit-error-code-options')
  })
})

describe('AuditView — v0.1.25.24 operation array<string>', () => {
  it('sends a single operation verbatim (one-element list, scalar back-compat)', async () => {
    const { lastCall } = await mountAndSubmit(async w => {
      await w.find('#audit-operation').setValue('createBudget')
    })
    expect(lastCall.operation).toBe('createBudget')
  })

  it('normalizes comma-separated operations', async () => {
    const { lastCall } = await mountAndSubmit(async w => {
      await w.find('#audit-operation').setValue('createBudget, updatePolicy, createBudget')
    })
    expect(lastCall.operation).toBe('createBudget,updatePolicy')
  })

  it('accepts whitespace separation (pasted from logs)', async () => {
    const { lastCall } = await mountAndSubmit(async w => {
      await w.find('#audit-operation').setValue('createBudget  updatePolicy')
    })
    expect(lastCall.operation).toBe('createBudget,updatePolicy')
  })
})

describe('AuditView — v0.1.25.24 resource_type array<string>', () => {
  it('resource_type input offers a datalist of known types', () => {
    const wrapper = mount(AuditView)
    expect(wrapper.find('#audit-resource').attributes('list')).toBe('audit-resource-type-options')
    const options = wrapper.findAll('#audit-resource-type-options option')
    const values = options.map(o => o.attributes('value'))
    expect(values).toContain('tenant')
    expect(values).toContain('budget')
    expect(values).toContain('api_key')
    expect(values).toContain('policy')
    expect(values).toContain('webhook')
    expect(values).toContain('config')
  })

  it('sends a single resource_type verbatim (scalar back-compat)', async () => {
    const { lastCall } = await mountAndSubmit(async w => {
      await w.find('#audit-resource').setValue('tenant')
    })
    expect(lastCall.resource_type).toBe('tenant')
  })

  it('normalizes comma-separated resource_types', async () => {
    const { lastCall } = await mountAndSubmit(async w => {
      await w.find('#audit-resource').setValue('tenant, budget, tenant')
    })
    expect(lastCall.resource_type).toBe('tenant,budget')
  })

  it('does not send resource_type when the input is empty', async () => {
    const { lastCall } = await mountAndSubmit(async () => {})
    expect(lastCall.resource_type).toBeUndefined()
  })
})

describe('AuditView — URL param wiring (deep-link from Overview)', () => {
  it('pre-fills error_code from ?error_code= on mount', async () => {
    routeQuery.error_code = 'BUDGET_EXCEEDED'
    const wrapper = mount(AuditView)
    await flushPromises()
    expect((wrapper.find('#audit-error-code').element as HTMLInputElement).value).toBe('BUDGET_EXCEEDED')
    const firstCall = listAuditLogsMock.mock.calls[0]?.[0] ?? {}
    expect(firstCall.error_code).toBe('BUDGET_EXCEEDED')
  })

  it('pre-fills status band from ?status_band= on mount', async () => {
    routeQuery.status_band = 'errors'
    const wrapper = mount(AuditView)
    await flushPromises()
    expect(wrapper.find('[data-band="errors"]').attributes('aria-checked')).toBe('true')
    const firstCall = listAuditLogsMock.mock.calls[0]?.[0] ?? {}
    expect(firstCall.status_min).toBe('400')
    expect(firstCall.status_max).toBe('599')
  })

  it('ignores unknown status_band values (defensive against stale links)', async () => {
    routeQuery.status_band = 'bogus'
    const wrapper = mount(AuditView)
    await flushPromises()
    // Unknown band → All chip remains the active radio (defensive default).
    expect(wrapper.find('[data-band=""]').attributes('aria-checked')).toBe('true')
    const firstCall = listAuditLogsMock.mock.calls[0]?.[0] ?? {}
    expect(firstCall.status_min).toBeUndefined()
    expect(firstCall.status_max).toBeUndefined()
  })

  it('combines error_code + status_band from the URL into one request', async () => {
    routeQuery.error_code = 'BUDGET_EXCEEDED'
    routeQuery.status_band = 'errors'
    mount(AuditView)
    await flushPromises()
    const firstCall = listAuditLogsMock.mock.calls[0]?.[0] ?? {}
    expect(firstCall.error_code).toBe('BUDGET_EXCEEDED')
    expect(firstCall.status_min).toBe('400')
    expect(firstCall.status_max).toBe('599')
  })

  it('pre-fills error_code_exclude from ?error_code_exclude= on mount', async () => {
    routeQuery.error_code_exclude = 'INTERNAL_ERROR,TIMEOUT'
    const wrapper = mount(AuditView)
    await flushPromises()
    expect((wrapper.find('#audit-error-code-exclude').element as HTMLInputElement).value).toBe('INTERNAL_ERROR,TIMEOUT')
    const firstCall = listAuditLogsMock.mock.calls[0]?.[0] ?? {}
    expect(firstCall.error_code_exclude).toBe('INTERNAL_ERROR,TIMEOUT')
  })
})

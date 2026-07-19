import { describe, expect, it, vi } from 'vitest'
import { isReadonly } from 'vue'
import { ApiError } from '../api/client'
import {
  useTenantFilterBulk,
  type TenantFilterBulkFilters,
  type UseTenantFilterBulkOptions,
} from '../composables/useTenantFilterBulk'
import type { Tenant, TenantBulkActionResponse } from '../types'

type ListFn = NonNullable<UseTenantFilterBulkOptions['list']>
type SubmitFn = NonNullable<UseTenantFilterBulkOptions['submit']>

function tenant(id: string, status = 'ACTIVE', parentTenantId?: string): Tenant {
  return {
    tenant_id: id,
    name: `Tenant ${id}`,
    status,
    ...(parentTenantId ? { parent_tenant_id: parentTenantId } : {}),
    created_at: '2026-07-18T00:00:00Z',
  }
}

function response(overrides: Partial<TenantBulkActionResponse> = {}): TenantBulkActionResponse {
  return {
    action: 'SUSPEND',
    total_matched: 1,
    succeeded: [{ id: 'one' }],
    failed: [],
    skipped: [],
    idempotency_key: 'idem-1',
    ...overrides,
  }
}

function createHarness(initialFilters: TenantFilterBulkFilters = {
  search: '',
  parentTenantId: '',
  status: '',
}) {
  let filters = initialFilters
  const list = vi.fn<ListFn>().mockResolvedValue({ tenants: [tenant('one')], has_more: false })
  const submit = vi.fn<SubmitFn>().mockResolvedValue(response())
  const refresh = vi.fn<() => Promise<unknown>>().mockResolvedValue(true)
  const onResult = vi.fn()
  const onSuccess = vi.fn()
  const onError = vi.fn()
  const bulk = useTenantFilterBulk({
    getFilters: () => filters,
    refresh,
    onResult,
    onSuccess,
    onError,
    list,
    submit,
    createIdempotencyKey: () => 'idem-fixed',
  })

  async function preview(action: 'SUSPEND' | 'REACTIVATE' = 'SUSPEND'): Promise<void> {
    bulk.open(action)
    await vi.waitFor(() => expect(bulk.preview.previewLoading.value).toBe(false))
  }

  return {
    bulk,
    list,
    submit,
    refresh,
    onResult,
    onSuccess,
    onError,
    setFilters: (next: TenantFilterBulkFilters) => { filters = next },
    preview,
  }
}

describe('useTenantFilterBulk', () => {
  it('does not resolve preview or mutation callables until used', () => {
    const options: UseTenantFilterBulkOptions = {
      getFilters: () => ({ search: '', parentTenantId: '', status: '' }),
      refresh: async () => true,
      onResult: vi.fn(),
    }
    Object.defineProperties(options, {
      list: { get: () => { throw new Error('list resolved eagerly') } },
      submit: { get: () => { throw new Error('writer resolved eagerly') } },
    })

    expect(() => useTenantFilterBulk(options)).not.toThrow()
  })

  it('refuses the root-level pseudo-filter because the server cannot represent it', () => {
    const h = createHarness({ search: '', parentTenantId: '__root__', status: '' })

    expect(h.bulk.canOpen('SUSPEND')).toBe(false)
    expect(h.bulk.unsupportedReason('SUSPEND')).toContain('root-level filter')
    h.bulk.open('SUSPEND')

    expect(h.bulk.action.value).toBeNull()
    expect(h.list).not.toHaveBeenCalled()
  })

  it('reuses one immutable search/parent/status tuple across cursor pages and submit', async () => {
    const h = createHarness({ search: ' old ', parentTenantId: 'parent-a', status: 'ACTIVE' })
    h.list
      .mockImplementationOnce(async () => {
        h.setFilters({ search: 'new', parentTenantId: 'parent-b', status: 'SUSPENDED' })
        return {
          tenants: [tenant('one', 'ACTIVE', 'parent-a')],
          has_more: true,
          next_cursor: 'cursor-1',
        }
      })
      .mockResolvedValueOnce({
        tenants: [tenant('two', 'ACTIVE', 'parent-a')],
        has_more: false,
      })
    h.submit.mockResolvedValue(response({
      total_matched: 2,
      succeeded: [{ id: 'one' }, { id: 'two' }],
    }))

    await h.preview()

    expect(h.list.mock.calls).toEqual([
      [{ status: 'ACTIVE', limit: '100', parent_tenant_id: 'parent-a', search: 'old' }],
      [{ status: 'ACTIVE', limit: '100', parent_tenant_id: 'parent-a', search: 'old', cursor: 'cursor-1' }],
    ])
    expect(h.bulk.summary.value).toBe('status=ACTIVE AND parent_tenant_id=parent-a AND search="old"')

    await expect(h.bulk.execute()).resolves.toBe(true)
    expect(h.submit).toHaveBeenCalledWith({
      filter: { status: 'ACTIVE', parent_tenant_id: 'parent-a', search: 'old' },
      action: 'SUSPEND',
      expected_count: 2,
      idempotency_key: 'idem-fixed',
    })
    expect(h.onSuccess).toHaveBeenCalledWith('2/2 tenants suspended')
    expect(h.refresh).toHaveBeenCalledOnce()
  })

  it('derives SUSPENDED for REACTIVATE and reports skipped rows for triage', async () => {
    const h = createHarness({ search: '', parentTenantId: '', status: 'SUSPENDED' })
    h.list.mockResolvedValue({ tenants: [tenant('one', 'SUSPENDED')], has_more: false })
    h.submit.mockResolvedValue(response({
      action: 'REACTIVATE',
      succeeded: [],
      skipped: [{ id: 'one', reason: 'already active' }],
    }))

    await h.preview('REACTIVATE')
    await h.bulk.execute()

    expect(h.list).toHaveBeenCalledWith({ status: 'SUSPENDED', limit: '100' })
    expect(h.submit.mock.calls[0]?.[0]).toMatchObject({
      filter: { status: 'SUSPENDED' },
      action: 'REACTIVATE',
      expected_count: 1,
    })
    expect(h.onResult).toHaveBeenCalledWith(expect.objectContaining({ actionVerb: 'Reactivate' }))
  })

  it('blocks submission when has_more lacks a usable continuation cursor', async () => {
    const h = createHarness()
    h.list.mockResolvedValue({ tenants: [tenant('one')], has_more: true })

    await h.preview()
    expect(h.bulk.preview.previewError.value).toContain('omitted a continuation cursor')
    expect(h.bulk.preview.cappedAtPages.value).toBe(false)
    expect(h.bulk.preview.reachedEnd.value).toBe(false)

    await expect(h.bulk.execute()).resolves.toBe(false)
    expect(h.submit).not.toHaveBeenCalled()
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('rejects actions that conflict with the visible status filter', () => {
    const h = createHarness({ search: '', parentTenantId: '', status: 'SUSPENDED' })

    expect(h.bulk.canOpen('SUSPEND')).toBe(false)
    expect(h.bulk.unsupportedReason('SUSPEND')).toContain('only applies to ACTIVE tenants')
    expect(h.bulk.canOpen('REACTIVATE')).toBe(true)

    h.bulk.open('SUSPEND')
    expect(h.bulk.action.value).toBeNull()
    expect(h.list).not.toHaveBeenCalled()
  })

  it('exposes the captured action as readonly and rejects execution before Preview', async () => {
    const h = createHarness()

    expect(isReadonly(h.bulk.action)).toBe(true)
    expect(h.bulk.action.value).toBeNull()

    await expect(h.bulk.execute()).resolves.toBe(false)

    expect(h.submit).not.toHaveBeenCalled()
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('blocks submission when a later preview page fails after finding matches', async () => {
    const h = createHarness()
    h.list
      .mockResolvedValueOnce({ tenants: [tenant('one')], has_more: true, next_cursor: 'cursor-1' })
      .mockRejectedValueOnce(new Error('page two unavailable'))

    await h.preview()

    expect(h.bulk.preview.previewCount.value).toBe(1)
    expect(h.bulk.preview.previewError.value).toBe('page two unavailable')
    await expect(h.bulk.execute()).resolves.toBe(false)
    expect(h.submit).not.toHaveBeenCalled()
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('rejects a positive count without an exact or intentional page-capped terminal state', async () => {
    const h = createHarness()
    await h.preview()
    h.bulk.preview.reachedEnd.value = false

    await expect(h.bulk.execute()).resolves.toBe(false)
    expect(h.submit).not.toHaveBeenCalled()
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('humanizes count drift and keeps the captured preview retryable', async () => {
    const h = createHarness()
    h.submit.mockRejectedValue(new ApiError(409, 'changed', 'COUNT_MISMATCH', 'req-1'))
    await h.preview()

    await expect(h.bulk.execute()).resolves.toBe(false)

    expect(h.bulk.submitError.value).toContain('list changed between preview and submit')
    expect(h.bulk.action.value).toBe('SUSPEND')
    expect(h.bulk.preview.previewCount.value).toBe(1)
    expect(h.refresh).toHaveBeenCalledOnce()
  })

  it('keeps generic mutation failures retryable with action context', async () => {
    const h = createHarness()
    h.submit.mockRejectedValue(new Error('network unavailable'))
    await h.preview()

    await expect(h.bulk.execute()).resolves.toBe(false)

    expect(h.bulk.submitError.value).toBe('Bulk SUSPEND failed: network unavailable')
    expect(h.bulk.action.value).toBe('SUSPEND')
    expect(h.refresh).toHaveBeenCalledOnce()
  })

  it('blocks a re-entrant submit while the first mutation is in flight', async () => {
    const h = createHarness()
    let resolveSubmit: (value: TenantBulkActionResponse) => void = () => {}
    h.submit.mockImplementationOnce(() => new Promise(resolve => { resolveSubmit = resolve }))
    await h.preview()

    const first = h.bulk.execute()
    await vi.waitFor(() => expect(h.bulk.running.value).toBe(true))
    expect(h.bulk.canOpen('SUSPEND')).toBe(true)
    h.bulk.open('REACTIVATE')
    expect(h.bulk.action.value).toBe('SUSPEND')
    await expect(h.bulk.execute()).resolves.toBe(false)
    expect(h.submit).toHaveBeenCalledOnce()

    resolveSubmit(response())
    await expect(first).resolves.toBe(true)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import {
  useWebhookFilterBulk,
  type UseWebhookFilterBulkOptions,
  type WebhookFilterBulkFilters,
} from '../composables/useWebhookFilterBulk'
import type { WebhookBulkActionResponse, WebhookSubscription } from '../types'

type ListFn = NonNullable<UseWebhookFilterBulkOptions['list']>
type SubmitFn = NonNullable<UseWebhookFilterBulkOptions['submit']>

function webhook(
  id: string,
  status = 'ACTIVE',
  tenantId = 'acme',
): WebhookSubscription {
  return {
    subscription_id: id,
    tenant_id: tenantId,
    url: `https://example.test/${id}`,
    event_types: ['budget.updated'],
    status,
    created_at: '2026-07-18T00:00:00Z',
  }
}

function response(overrides: Partial<WebhookBulkActionResponse> = {}): WebhookBulkActionResponse {
  return {
    action: 'PAUSE',
    total_matched: 1,
    succeeded: [{ id: 'one' }],
    failed: [],
    skipped: [],
    idempotency_key: 'idem-1',
    ...overrides,
  }
}

function createHarness(initialFilters: WebhookFilterBulkFilters = {
  tenantId: '',
  search: '',
  failingOnly: false,
}) {
  let filters = initialFilters
  const list = vi.fn<ListFn>().mockResolvedValue({ subscriptions: [webhook('one')], has_more: false })
  const submit = vi.fn<SubmitFn>().mockResolvedValue(response())
  const refresh = vi.fn<() => Promise<unknown>>().mockResolvedValue(true)
  const onResult = vi.fn()
  const onSuccess = vi.fn()
  const onError = vi.fn()
  const bulk = useWebhookFilterBulk({
    getFilters: () => filters,
    refresh,
    onResult,
    onSuccess,
    onError,
    list,
    submit,
    createIdempotencyKey: () => 'idem-fixed',
  })

  async function preview(action: 'PAUSE' | 'RESUME' = 'PAUSE'): Promise<void> {
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
    setFilters: (next: WebhookFilterBulkFilters) => { filters = next },
    preview,
  }
}

describe('useWebhookFilterBulk', () => {
  it.each([
    { filters: { tenantId: '__system__', search: '', failingOnly: false }, label: 'system pseudo-tenant' },
    { filters: { tenantId: '', search: '*.internal', failingOnly: false }, label: 'wildcard search' },
    { filters: { tenantId: '', search: '', failingOnly: true }, label: 'failing-only predicate' },
  ] satisfies Array<{ filters: WebhookFilterBulkFilters; label: string }>)('refuses an unrepresentable $label filter', ({ filters }) => {
    const h = createHarness(filters)

    expect(h.bulk.canOpen()).toBe(false)
    h.bulk.open('PAUSE')

    expect(h.bulk.action.value).toBeNull()
    expect(h.list).not.toHaveBeenCalled()
  })

  it('reuses one immutable tenant/search tuple across cursor pages and submit', async () => {
    const h = createHarness({ tenantId: 'acme', search: ' old ', failingOnly: false })
    h.list
      .mockImplementationOnce(async () => {
        h.setFilters({ tenantId: 'beta', search: 'new', failingOnly: false })
        return {
          subscriptions: [webhook('one', 'ACTIVE', 'acme')],
          has_more: true,
          next_cursor: 'cursor-1',
        }
      })
      .mockResolvedValueOnce({
        subscriptions: [webhook('two', 'ACTIVE', 'acme')],
        has_more: false,
      })
    h.submit.mockResolvedValue(response({
      total_matched: 2,
      succeeded: [{ id: 'one' }, { id: 'two' }],
    }))

    await h.preview()

    expect(h.list.mock.calls).toEqual([
      [{ search: 'old' }],
      [{ search: 'old', cursor: 'cursor-1' }],
    ])
    expect(h.bulk.summary.value).toBe('status=ACTIVE AND tenant_id=acme AND search="old"')

    await expect(h.bulk.execute()).resolves.toBe(true)
    expect(h.submit).toHaveBeenCalledWith({
      filter: { status: 'ACTIVE', tenant_id: 'acme', search: 'old' },
      action: 'PAUSE',
      expected_count: 2,
      idempotency_key: 'idem-fixed',
    })
    expect(h.onSuccess).toHaveBeenCalledWith('2/2 webhooks paused')
  })

  it('derives PAUSED for RESUME and exposes failed rows for triage', async () => {
    const h = createHarness({ tenantId: 'acme', search: '', failingOnly: false })
    h.list.mockResolvedValue({ subscriptions: [webhook('one', 'PAUSED')], has_more: false })
    h.submit.mockResolvedValue(response({
      action: 'RESUME',
      succeeded: [],
      failed: [{ id: 'one', error_code: 'INVALID_TRANSITION', message: 'changed' }],
    }))

    await h.preview('RESUME')
    await h.bulk.execute()

    expect(h.submit.mock.calls[0]?.[0]).toMatchObject({
      filter: { status: 'PAUSED', tenant_id: 'acme' },
      action: 'RESUME',
      expected_count: 1,
    })
    expect(h.onError).toHaveBeenCalledWith('0/1 webhooks resumed, 1 failed — see details')
    expect(h.onResult).toHaveBeenCalledWith(expect.objectContaining({ actionVerb: 'Resume' }))
  })

  it('rejects direct execution without an owned preview snapshot', async () => {
    const h = createHarness()
    h.bulk.action.value = 'PAUSE'
    h.bulk.preview.previewCount.value = 1

    await expect(h.bulk.execute()).resolves.toBe(false)

    expect(h.bulk.submitError.value).toContain('Preview this webhook selection')
    expect(h.submit).not.toHaveBeenCalled()
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('humanizes LIMIT_EXCEEDED and retains the preview for correction', async () => {
    const h = createHarness()
    h.submit.mockRejectedValue(new ApiError(
      400,
      'too many',
      'LIMIT_EXCEEDED',
      'req-1',
      { total_matched: 700 },
    ))
    await h.preview()

    await expect(h.bulk.execute()).resolves.toBe(false)

    expect(h.bulk.submitError.value).toContain('server matched 700')
    expect(h.bulk.action.value).toBe('PAUSE')
    expect(h.bulk.preview.previewCount.value).toBe(1)
    expect(h.refresh).toHaveBeenCalledOnce()
  })

  it('keeps generic failures retryable and Cancel clears the owned snapshot', async () => {
    const h = createHarness()
    h.submit.mockRejectedValue(new Error('network unavailable'))
    await h.preview()

    await expect(h.bulk.execute()).resolves.toBe(false)
    expect(h.bulk.submitError.value).toBe('Bulk PAUSE failed: network unavailable')
    expect(h.bulk.action.value).toBe('PAUSE')

    h.bulk.cancel()
    expect(h.bulk.action.value).toBeNull()
    expect(h.bulk.preview.previewCount.value).toBe(0)
    expect(h.bulk.submitError.value).toBe('')
  })

  it('blocks a re-entrant submit while the first mutation is in flight', async () => {
    const h = createHarness()
    let resolveSubmit: (value: WebhookBulkActionResponse) => void = () => {}
    h.submit.mockImplementationOnce(() => new Promise(resolve => { resolveSubmit = resolve }))
    await h.preview()

    const first = h.bulk.execute()
    await vi.waitFor(() => expect(h.bulk.running.value).toBe(true))
    await expect(h.bulk.execute()).resolves.toBe(false)
    expect(h.submit).toHaveBeenCalledOnce()

    resolveSubmit(response())
    await expect(first).resolves.toBe(true)
  })
})

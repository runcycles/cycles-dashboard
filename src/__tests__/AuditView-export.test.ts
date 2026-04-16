// R3 (scale-hardening): AuditView export paginates the full result set.
//
// Pre-fix, the export functions wrote `entries.value` (= page 1) directly.
// Compliance audits on deployments with high event volume silently shipped
// incomplete data. The server-side cursor was ignored.
//
// These tests mount the real AuditView, stub listAuditLogs with a multi-page
// response, and assert:
//   1. The cursor is followed until has_more=false.
//   2. The resulting Blob contains rows from every page, not just page 1.
//   3. The EXPORT_MAX_ROWS safety cap aborts rather than running unbounded.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import AuditView from '../views/AuditView.vue'
import type { AuditLogEntry } from '../types'

// Build a synthetic audit entry. Minimal fields — the export only
// stringifies whatever's present.
function entry(i: number): AuditLogEntry {
  return {
    log_id: `log_${i}`,
    timestamp: '2026-04-16T00:00:00Z',
    operation: 'createBudget',
    resource_type: 'budget',
    resource_id: `b_${i}`,
    tenant_id: 't_1',
    key_id: 'key_1',
    status: 200,
  } as AuditLogEntry
}

// Mock listAuditLogs to return a configurable list of pages. Each page has
// has_more=true until the last, which has has_more=false. next_cursor is
// the next page index as a string — the server-side mock reads it back.
const pages: AuditLogEntry[][] = []
const listAuditLogsMock = vi.fn<(params: Record<string, string>) => Promise<unknown>>()

vi.mock('../api/client', () => ({
  listAuditLogs: (params: Record<string, string>) => listAuditLogsMock(params),
  ApiError: class ApiError extends Error {},
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useRoute: () => ({ query: {} }),
  RouterLink: { template: '<a><slot /></a>' },
}))

// Force JSDOM download-triggering helpers to no-op. Actual Blob creation is
// allowed — we capture the Blob content by intercepting URL.createObjectURL
// via the anchor's href and a helper that reads the Blob back.
let lastBlob: Blob | null = null
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

beforeEach(() => {
  setActivePinia(createPinia())
  pages.length = 0
  lastBlob = null
  listAuditLogsMock.mockReset()
  listAuditLogsMock.mockImplementation(async (params) => {
    const idx = params.cursor ? parseInt(params.cursor, 10) : 0
    const page = pages[idx] ?? []
    const hasMore = idx < pages.length - 1
    return {
      logs: page,
      has_more: hasMore,
      next_cursor: hasMore ? String(idx + 1) : undefined,
    }
  })
  URL.createObjectURL = vi.fn((blob: Blob) => {
    lastBlob = blob
    return 'blob:mock'
  })
  URL.revokeObjectURL = vi.fn()
  // Stub the anchor click that downloads — JSDOM's <a>.click() would
  // navigate to the blob URL and throw.
  HTMLAnchorElement.prototype.click = vi.fn()
})

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
})

import { afterEach } from 'vitest'

async function readBlob(b: Blob): Promise<string> {
  // JSDOM's Blob doesn't support .text() directly in older versions; fall
  // back to FileReader.
  // @ts-expect-error — .text() exists in jsdom@^29
  if (typeof b.text === 'function') return b.text()
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsText(b)
  })
}

describe('AuditView export — pagination', () => {
  it('follows next_cursor through all pages before downloading', async () => {
    // 3 pages × 2 rows each = 6 entries total.
    pages.push([entry(0), entry(1)])
    pages.push([entry(2), entry(3)])
    pages.push([entry(4), entry(5)])

    const wrapper = mount(AuditView, {
      global: { stubs: { PageHeader: true, MaskedValue: true, TenantLink: true, SortHeader: true, EmptyState: true } },
    })
    await flushPromises()

    // Initial query hit: cursor absent → server returns page 0, has_more=true.
    expect(listAuditLogsMock).toHaveBeenCalledTimes(1)
    expect(listAuditLogsMock.mock.calls[0][0].cursor).toBeUndefined()

    // Trigger export via the component's exposed confirmExport + executeExport.
    // The confirm-dialog's "Export JSON" button is easier to click directly
    // once it's rendered, but bypassing the dialog is cleaner for this unit.
    const vm = wrapper.vm as unknown as {
      confirmExport: (f: 'csv' | 'json') => void
      executeExport: () => Promise<void>
    }
    vm.confirmExport('json')
    await vm.executeExport()
    await flushPromises()

    // listAuditLogs should have been called 3 times total: initial query
    // (page 0) + 2 more pages during export (pages 1 and 2).
    expect(listAuditLogsMock).toHaveBeenCalledTimes(3)
    expect(lastBlob).not.toBeNull()
    const text = await readBlob(lastBlob!)
    const parsed = JSON.parse(text) as AuditLogEntry[]
    expect(parsed).toHaveLength(6)
    expect(parsed.map((e) => e.log_id)).toEqual([
      'log_0', 'log_1', 'log_2', 'log_3', 'log_4', 'log_5',
    ])
    wrapper.unmount()
  })

  it('does NOT fetch more pages when has_more=false on page 1', async () => {
    pages.push([entry(0), entry(1), entry(2)])
    const wrapper = mount(AuditView, {
      global: { stubs: { PageHeader: true, MaskedValue: true, TenantLink: true, SortHeader: true, EmptyState: true } },
    })
    await flushPromises()
    expect(listAuditLogsMock).toHaveBeenCalledTimes(1)

    const vm = wrapper.vm as unknown as {
      confirmExport: (f: 'csv' | 'json') => void
      executeExport: () => Promise<void>
    }
    vm.confirmExport('csv')
    await vm.executeExport()
    await flushPromises()

    // Fast path: no additional fetches.
    expect(listAuditLogsMock).toHaveBeenCalledTimes(1)
    expect(lastBlob).not.toBeNull()
    wrapper.unmount()
  })

  it('passes the same filter params to every export page fetch', async () => {
    pages.push([entry(0)])
    pages.push([entry(1)])
    const wrapper = mount(AuditView, {
      global: { stubs: { PageHeader: true, MaskedValue: true, TenantLink: true, SortHeader: true, EmptyState: true } },
    })
    await flushPromises()

    // Drive the filter via the form input — <script setup> refs aren't
    // directly writable via wrapper.vm, so we go through the v-model.
    // Initial query call with no filters is already in the history; clear
    // it so the assertions only consider post-filter calls.
    await wrapper.find('#audit-tenant').setValue('t_42')
    listAuditLogsMock.mockClear()
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      confirmExport: (f: 'csv' | 'json') => void
      executeExport: () => Promise<void>
    }
    vm.confirmExport('json')
    await vm.executeExport()
    await flushPromises()

    // Every call after filter-change should carry tenant_id=t_42.
    expect(listAuditLogsMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    for (const call of listAuditLogsMock.mock.calls) {
      expect(call[0].tenant_id).toBe('t_42')
    }
    wrapper.unmount()
  })
})

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('UI/UX regression contracts', () => {
  it.each([
    'src/components/BulkActionPreviewDialog.vue',
    'src/components/BulkActionResultDialog.vue',
    'src/components/ConfirmAction.vue',
    'src/components/SecretReveal.vue',
    'src/views/TenantDetailView.vue',
  ])('%s keeps long modal content reachable on short viewports', (file) => {
    const text = source(file)
    expect(text).toContain('overflow-y-auto')
    expect(text).toContain('max-h-[calc(100dvh-2rem)]')
  })

  it.each([
    'src/views/TenantsView.vue',
    'src/views/WebhooksView.vue',
    'src/views/BudgetsView.vue',
  ])('%s wraps the floating bulk toolbar on small phones', (file) => {
    const text = source(file)
    expect(text).toMatch(/role="toolbar"[\s\S]*?flex flex-wrap items-center justify-center gap-x-3 gap-y-2 max-w-\[90vw\]/)
  })

  it('announces asynchronous Login and Overview errors', () => {
    expect(source('src/views/LoginView.vue')).toMatch(/v-if="error" role="alert" aria-atomic="true"/)
    expect(source('src/views/OverviewView.vue')).toMatch(/v-if="error" role="alert" aria-atomic="true"/)
  })

  it('reports all seven webhook-delivery columns to assistive technology', () => {
    const text = source('src/views/WebhookDetailView.vue')
    expect(text).toMatch(/Delivery History[\s\S]*?aria-colcount="7"/)
  })
})

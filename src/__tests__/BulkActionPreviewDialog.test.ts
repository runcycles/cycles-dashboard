// O1 (UI/UX P0): preview dialog rendered before a filter-apply bulk
// action commits. Verifies the four user-visible states (loading, empty,
// ready, capped) and the Confirm-disabled invariants that prevent an
// operator from sending a no-op or guaranteed-LIMIT_EXCEEDED submit.

import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import BulkActionPreviewDialog from '../components/BulkActionPreviewDialog.vue'
import type { PreviewSample } from '../composables/useBulkActionPreview'

function sample(id: string, primary = `name-${id}`, status = 'ACTIVE'): PreviewSample {
  return { id, primary, status }
}

const baseProps = {
  actionVerb: 'Suspend',
  itemNounPlural: 'tenants',
  filterDescription: 'status=ACTIVE AND parent_tenant_id=acme',
  loading: false,
  count: 0,
  samples: [] as PreviewSample[],
  cappedAtMax: false,
  cappedAtPages: false,
  reachedEnd: false,
  submitting: false,
}

describe('BulkActionPreviewDialog', () => {
  it('shows the filter description verbatim', () => {
    const w = mount(BulkActionPreviewDialog, { props: baseProps })
    expect(w.text()).toContain('status=ACTIVE AND parent_tenant_id=acme')
    expect(w.text()).toContain('Suspend tenants matching filter')
  })

  describe('loading state (cursor walk in progress)', () => {
    it('renders a spinner and live count', () => {
      const w = mount(BulkActionPreviewDialog, { props: { ...baseProps, loading: true, count: 17 } })
      expect(w.find('svg.animate-spin').exists()).toBe(true)
      expect(w.text()).toContain('Counting matches')
      expect(w.text()).toContain('17 found so far')
    })

    it('disables Confirm while loading', () => {
      const w = mount(BulkActionPreviewDialog, { props: { ...baseProps, loading: true } })
      // Last button is Confirm.
      const buttons = w.findAll('button')
      expect(buttons[buttons.length - 1].attributes('disabled')).toBeDefined()
    })

    it('Confirm label reads "Counting…" while loading', () => {
      const w = mount(BulkActionPreviewDialog, { props: { ...baseProps, loading: true } })
      const buttons = w.findAll('button')
      expect(buttons[buttons.length - 1].text()).toContain('Counting')
    })
  })

  describe('empty result state', () => {
    it('shows a "no matches" hint and disables Confirm', () => {
      const w = mount(BulkActionPreviewDialog, { props: { ...baseProps, count: 0, reachedEnd: true } })
      expect(w.text()).toContain('No tenants match the current filter')
      const buttons = w.findAll('button')
      expect(buttons[buttons.length - 1].attributes('disabled')).toBeDefined()
    })
  })

  describe('ready state (exact count + samples)', () => {
    const samples = [sample('a-1'), sample('b-2'), sample('c-3')]
    const props = { ...baseProps, count: 3, samples, reachedEnd: true }

    it('renders the count and the sample list', () => {
      const w = mount(BulkActionPreviewDialog, { props })
      expect(w.text()).toContain('3 tenants will be affected')
      expect(w.text()).toContain('a-1')
      expect(w.text()).toContain('b-2')
      expect(w.text()).toContain('c-3')
    })

    it('Confirm label includes the count and the action verb', () => {
      const w = mount(BulkActionPreviewDialog, { props })
      const buttons = w.findAll('button')
      expect(buttons[buttons.length - 1].text()).toContain('Suspend 3 tenants')
    })

    it('Confirm is enabled and emits confirm when clicked', async () => {
      const w = mount(BulkActionPreviewDialog, { props })
      const buttons = w.findAll('button')
      const confirmBtn = buttons[buttons.length - 1]
      expect(confirmBtn.attributes('disabled')).toBeUndefined()
      await confirmBtn.trigger('click')
      expect(w.emitted('confirm')).toHaveLength(1)
    })

    it('shows "Showing first N of M" hint when count > samples.length', () => {
      const w = mount(BulkActionPreviewDialog, { props: { ...props, count: 247 } })
      expect(w.text()).toContain('Showing first 3 of 247')
    })
  })

  describe('capped at max-matches state (>500 matches)', () => {
    const samples = Array.from({ length: 10 }, (_, i) => sample(`r${i}`))
    const props = { ...baseProps, count: 501, samples, cappedAtMax: true }

    it('renders the "500+" indicator instead of the raw count', () => {
      const w = mount(BulkActionPreviewDialog, { props })
      expect(w.text()).toContain('500+')
    })

    it('renders the cap warning and disables Confirm', () => {
      const w = mount(BulkActionPreviewDialog, { props })
      expect(w.text()).toContain('maximum of 500')
      expect(w.text()).toContain('Narrow the filter')
      const buttons = w.findAll('button')
      expect(buttons[buttons.length - 1].attributes('disabled')).toBeDefined()
    })

    it('Confirm label reads "Too many matches" so the operator understands why', () => {
      const w = mount(BulkActionPreviewDialog, { props })
      const buttons = w.findAll('button')
      expect(buttons[buttons.length - 1].text()).toContain('Too many matches')
    })
  })

  describe('capped at max-pages state (partial count)', () => {
    it('annotates the count as a partial total', () => {
      const w = mount(BulkActionPreviewDialog, {
        props: { ...baseProps, count: 12, samples: [sample('a'), sample('b')], cappedAtPages: true },
      })
      expect(w.text()).toContain('partial count')
      expect(w.text()).toContain('narrow the filter')
    })
  })

  describe('submitting state (after Confirm click)', () => {
    it('shows a spinner inside the Confirm button', () => {
      const w = mount(BulkActionPreviewDialog, {
        props: { ...baseProps, count: 5, samples: [sample('a')], reachedEnd: true, submitting: true },
      })
      const buttons = w.findAll('button')
      const confirmBtn = buttons[buttons.length - 1]
      expect(confirmBtn.find('svg.animate-spin').exists()).toBe(true)
    })

    it('disables Cancel while submitting (no abandoning an in-flight POST)', () => {
      const w = mount(BulkActionPreviewDialog, {
        props: { ...baseProps, count: 5, reachedEnd: true, submitting: true },
      })
      const buttons = w.findAll('button')
      // Cancel is the first button.
      expect(buttons[0].attributes('disabled')).toBeDefined()
    })

    it('marks dialog aria-busy="true"', () => {
      const w = mount(BulkActionPreviewDialog, {
        props: { ...baseProps, count: 5, reachedEnd: true, submitting: true },
      })
      expect(w.find('[role="dialog"]').attributes('aria-busy')).toBe('true')
    })
  })

  describe('error surfaces', () => {
    it('renders walk-error inline (network-during-count)', () => {
      const w = mount(BulkActionPreviewDialog, { props: { ...baseProps, error: 'network down' } })
      expect(w.find('[role="alert"]').text()).toContain('network down')
    })

    it('renders submit-error inline (LIMIT_EXCEEDED / COUNT_MISMATCH)', () => {
      const w = mount(BulkActionPreviewDialog, {
        props: { ...baseProps, count: 5, samples: [sample('a')], reachedEnd: true,
          submitError: 'Filter matches more than 500 tenants — narrow the filter before retrying.' },
      })
      expect(w.text()).toContain('more than 500 tenants')
    })
  })

  describe('Cancel and backdrop', () => {
    it('emits cancel when Cancel button clicked', async () => {
      const w = mount(BulkActionPreviewDialog, { props: baseProps })
      const buttons = w.findAll('button')
      await buttons[0].trigger('click')
      expect(w.emitted('cancel')).toHaveLength(1)
    })

    it('emits cancel on backdrop click when not submitting', async () => {
      const w = mount(BulkActionPreviewDialog, { props: baseProps })
      await w.find('.fixed.inset-0').trigger('click.self')
      expect(w.emitted('cancel')).toHaveLength(1)
    })

    it('does NOT emit cancel on backdrop click while submitting', async () => {
      const w = mount(BulkActionPreviewDialog, {
        props: { ...baseProps, count: 5, reachedEnd: true, submitting: true },
      })
      await w.find('.fixed.inset-0').trigger('click.self')
      expect(w.emitted('cancel')).toBeUndefined()
    })
  })
})

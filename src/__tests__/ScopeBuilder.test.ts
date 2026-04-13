import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ScopeBuilder from '../components/ScopeBuilder.vue'

/**
 * The builder owns the UI but serializes to a plain scope string via
 * `update:modelValue`. Tests assert on the emitted value rather than
 * DOM layout — keeps the suite resilient to CSS / markup tweaks while
 * locking the behavioral contract the parent form depends on.
 */

function lastEmitted(w: ReturnType<typeof mount>): string | undefined {
  const events = w.emitted('update:modelValue')
  return events ? (events[events.length - 1][0] as string) : undefined
}

describe('ScopeBuilder', () => {
  describe('initial render', () => {
    it('emits the locked tenant-only scope when modelValue is empty', () => {
      const w = mount(ScopeBuilder, { props: { modelValue: '', tenantId: 'acme' } })
      expect(lastEmitted(w)).toBe('tenant:acme')
    })

    it('shows the tenant row as locked (no remove, no editable id)', () => {
      const w = mount(ScopeBuilder, { props: { modelValue: '', tenantId: 'acme' } })
      expect(w.text()).toContain('tenant')
      expect(w.text()).toContain('acme')
      expect(w.text()).toContain('locked')
    })

    it('renders a live preview of the serialized scope', () => {
      const w = mount(ScopeBuilder, { props: { modelValue: '', tenantId: 'acme' } })
      expect(w.text()).toContain('Will create as:')
      expect(w.find('code').text()).toBe('tenant:acme')
    })
  })

  describe('parsing an existing value', () => {
    it('parses a deep canonical scope and emits it unchanged', () => {
      const w = mount(ScopeBuilder, {
        props: {
          modelValue: 'tenant:acme/workspace:prod/agent:reviewer',
          tenantId: 'acme',
        },
      })
      expect(lastEmitted(w)).toBe('tenant:acme/workspace:prod/agent:reviewer')
    })

    it('parses policy pattern with trailing /* when wildcards allowed', () => {
      const w = mount(ScopeBuilder, {
        props: { modelValue: 'tenant:acme/*', tenantId: 'acme', allowWildcards: true },
      })
      expect(lastEmitted(w)).toBe('tenant:acme/*')
    })

    it('parses id-wildcard (agent:*) when wildcards allowed', () => {
      const w = mount(ScopeBuilder, {
        props: { modelValue: 'tenant:acme/agent:*', tenantId: 'acme', allowWildcards: true },
      })
      expect(lastEmitted(w)).toBe('tenant:acme/agent:*')
    })

    it('surfaces a parse error when tenant in the scope doesn\'t match props.tenantId', () => {
      // Mismatch would fail server cross-check anyway — better to flag
      // in the form than let the user try to submit and get a 400.
      const w = mount(ScopeBuilder, {
        props: { modelValue: 'tenant:corp/agent:a', tenantId: 'acme' },
      })
      expect(w.text()).toContain('doesn\'t match current tenant')
      // Falls back to tenant-only root so the form still works.
      expect(lastEmitted(w)).toBe('tenant:acme')
    })

    it('surfaces a parse error and falls back for unknown kinds (legacy scopes)', () => {
      const w = mount(ScopeBuilder, {
        props: { modelValue: 'tenant:acme/agentic:codex', tenantId: 'acme' },
      })
      expect(w.text()).toContain('Unknown or duplicate kind')
      expect(lastEmitted(w)).toBe('tenant:acme')
    })

    it('falls back cleanly when the scope doesn\'t start with tenant:', () => {
      const w = mount(ScopeBuilder, {
        props: { modelValue: 'workspace:eng', tenantId: 'acme' },
      })
      expect(w.text()).toContain('Could not parse scope')
      expect(lastEmitted(w)).toBe('tenant:acme')
    })
  })

  describe('adding + removing levels', () => {
    it('adds a workspace row via the dropdown and serializes correctly', async () => {
      const w = mount(ScopeBuilder, { props: { modelValue: 'tenant:acme', tenantId: 'acme' } })
      const addSelect = w.find('select')
      await addSelect.setValue('workspace')
      // Now there's an editable workspace id field.
      const idInput = w.find('input[id^="scope-seg-"]')
      await idInput.setValue('prod')
      expect(lastEmitted(w)).toBe('tenant:acme/workspace:prod')
    })

    it('only offers kinds AFTER the last used kind in canonical order', async () => {
      const w = mount(ScopeBuilder, {
        props: { modelValue: 'tenant:acme/workspace:prod', tenantId: 'acme' },
      })
      const options = w.findAll('select option').map(o => o.attributes('value'))
      // Already have tenant + workspace. Dropdown should offer app,
      // workflow, agent, toolset — never tenant or workspace again.
      expect(options).not.toContain('tenant')
      expect(options).not.toContain('workspace')
      expect(options).toContain('app')
      expect(options).toContain('workflow')
      expect(options).toContain('agent')
      expect(options).toContain('toolset')
    })

    it('removing a middle row leaves deeper rows intact (canonical order still preserved)', async () => {
      const w = mount(ScopeBuilder, {
        props: {
          modelValue: 'tenant:acme/workspace:prod/agent:reviewer',
          tenantId: 'acme',
        },
      })
      // Find the remove button on the workspace row (first removable row).
      const removeButtons = w.findAll('button[aria-label^="Remove"]')
      expect(removeButtons.length).toBe(2)
      await removeButtons[0].trigger('click')
      expect(lastEmitted(w)).toBe('tenant:acme/agent:reviewer')
    })
  })

  describe('wildcards (allowWildcards=true)', () => {
    it('picking "any <kind> (*)" on a row emits the id-wildcard form', async () => {
      const w = mount(ScopeBuilder, {
        props: {
          modelValue: 'tenant:acme/agent:reviewer',
          tenantId: 'acme',
          allowWildcards: true,
        },
      })
      // The "any agent (*)" radio is the second radio in the row.
      const radios = w.findAll('input[type="radio"]')
      const anyRadio = radios.find(r => r.attributes('name') === 'seg-0-idmode' && !(r.element as HTMLInputElement).checked)
      expect(anyRadio).toBeTruthy()
      await anyRadio!.setValue(true)
      expect(lastEmitted(w)).toBe('tenant:acme/agent:*')
    })

    it('trailing /* checkbox emits the bare-wildcard terminal', async () => {
      const w = mount(ScopeBuilder, {
        props: {
          modelValue: 'tenant:acme',
          tenantId: 'acme',
          allowWildcards: true,
        },
      })
      const checkbox = w.find('input[type="checkbox"]')
      await checkbox.setValue(true)
      expect(lastEmitted(w)).toBe('tenant:acme/*')
    })

    it('picking "any id" disables the trailing /* checkbox (redundant + conflicting)', async () => {
      const w = mount(ScopeBuilder, {
        props: {
          modelValue: 'tenant:acme/agent:reviewer',
          tenantId: 'acme',
          allowWildcards: true,
        },
      })
      const radios = w.findAll('input[type="radio"]')
      const anyRadio = radios.find(r => r.attributes('name') === 'seg-0-idmode' && !(r.element as HTMLInputElement).checked)
      await anyRadio!.setValue(true)
      const checkbox = w.find('input[type="checkbox"]')
      expect(checkbox.attributes('disabled')).toBeDefined()
    })

    it('wildcard controls are NOT rendered when allowWildcards is false (budgets)', () => {
      const w = mount(ScopeBuilder, {
        props: { modelValue: 'tenant:acme/agent:reviewer', tenantId: 'acme' },
      })
      // No "any agent" radio visible.
      expect(w.text()).not.toContain('(*)')
      // No trailing /* checkbox.
      expect(w.find('input[type="checkbox"]').exists()).toBe(false)
    })
  })

  describe('add-level dropdown gating', () => {
    it('hides the dropdown when trailing /* is active (no more rows possible)', async () => {
      const w = mount(ScopeBuilder, {
        props: {
          modelValue: 'tenant:acme/*',
          tenantId: 'acme',
          allowWildcards: true,
        },
      })
      expect(w.find('select').exists()).toBe(false)
      expect(w.text()).toContain('No more levels available.')
    })

    it('hides the dropdown after the last row is id-wildcarded', async () => {
      const w = mount(ScopeBuilder, {
        props: {
          modelValue: 'tenant:acme/agent:*',
          tenantId: 'acme',
          allowWildcards: true,
        },
      })
      expect(w.find('select').exists()).toBe(false)
    })
  })
})

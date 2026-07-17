import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, isRef } from 'vue'
import { createPollingMock } from './helpers/createPollingMock'

describe('shared test harness', () => {
  it('returns genuine refs and preserves the polling callback result', async () => {
    const callback = async () => false
    const polling = createPollingMock(callback)

    expect(isRef(polling.isPolling)).toBe(true)
    expect(isRef(polling.isLoading)).toBe(true)
    expect(isRef(polling.lastSuccessAt)).toBe(true)
    await expect(polling.refresh()).resolves.toBe(false)
  })

  it('promotes Vue warnings to test failures', () => {
    const WarnsOnInvalidProp = defineComponent({
      props: { loading: { type: Boolean, required: true } },
      template: '<div />',
    })

    expect(() => mount(WarnsOnInvalidProp, {
      props: { loading: {} as unknown as boolean },
    })).toThrow(/Invalid prop: type check failed for prop "loading"/)
  })
})

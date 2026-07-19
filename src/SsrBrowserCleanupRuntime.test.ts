// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { hydrateSsrApplication } from './SsrBrowserRuntime'
import { getSsrStateElementId } from './SsrSerialization'
import { createTestDomain } from './SsrTestFixtures'

describe('browser hydration cleanup', () => {
  it('disposes registered plugin state when mounting fails', async () => {
    const dispose = vi.fn()
    document.body.innerHTML = '<div id="app"></div>'
    const state = document.createElement('script')
    state.id = getSsrStateElementId('browser-failure')
    state.type = 'application/json'
    state.textContent = JSON.stringify({
      version: 1,
      applicationId: 'browser-failure',
      publicConfig: {},
      domain: createTestDomain('browser-failure.test'),
      application: {},
      plugins: { demo: { restored: true } },
    })
    document.body.append(state)

    await expect(hydrateSsrApplication({
      id: 'browser-failure',
      rootComponent: defineComponent({
        setup() { throw new Error('mount failed') },
      }),
      install: ({ hydration }) => hydration.onDispose(dispose),
    })).rejects.toThrow('mount failed')
    expect(dispose).toHaveBeenCalledTimes(1)
    // The serialized state element is preserved so a retry can re-hydrate.
    expect(document.getElementById(state.id)).toBe(state)
  })
})

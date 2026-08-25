// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { hydrateSsrApplication } from './SsrBrowserRuntime'
import { getSsrStateElementId } from './SsrSerialization'
import { createTestDomain } from './SsrTestFixtures'

describe('browser hydration cleanup', () => {
  it('does not remove rendered CSS merely because the router is ready', async () => {
    document.body.innerHTML = [
      '<link rel="stylesheet" href="/src/AsyncCard.vue?vue&type=style" data-vue-ssr-lite-rendered-style="async">',
      '<div id="app"><main>ready</main></div>',
    ].join('')
    const state = document.createElement('script')
    state.id = getSsrStateElementId('async')
    state.type = 'application/json'
    state.textContent = JSON.stringify({
      version: 1,
      applicationId: 'async',
      publicConfig: {},
      domain: createTestDomain('async.test'),
      application: {},
    })
    document.body.append(state)
    const Root = defineComponent({ setup: () => () => 'ready' })

    await hydrateSsrApplication({
      id: 'async',
      root: Root,
      routes: [{ path: '/', component: Root }],
    })

    expect(
      document.querySelector('link[data-vue-ssr-lite-rendered-style="async"]')
    ).not.toBeNull()
  })

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
      root: defineComponent({
        setup() { throw new Error('mount failed') },
      }),
      install: ({ hydration }) => hydration.onDispose(dispose),
    })).rejects.toThrow('mount failed')
    expect(dispose).toHaveBeenCalledTimes(1)
    // The serialized state element is preserved so a retry can re-hydrate.
    expect(document.getElementById(state.id)).toBe(state)
  })
})

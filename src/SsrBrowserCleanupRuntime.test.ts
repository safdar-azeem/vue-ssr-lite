// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { hydrateSsrApplication, mountSpaApplication } from './SsrBrowserRuntime'
import { usePublicConfig } from './SsrPublicConfig'
import { getSsrStateElementId } from './SsrSerialization'
import { createTestDomain } from './SsrTestFixtures'

describe('browser hydration cleanup', () => {
  it('normalizes relative SPA targets at the browser request boundary', async () => {
    const cases = [
      ['/relative?preview=1', new URL('/relative?preview=1', window.location.href).href],
      ['https://absolute.test/path?preview=1', 'https://absolute.test/path?preview=1'],
    ] as const

    for (let index = 0; index < cases.length; index += 1) {
      const [url, expected] = cases[index]!
      document.body.innerHTML = '<div id="request-boundary-app"></div>'
      let requestUrl: string | undefined
      const mounted = await mountSpaApplication(
        {
          id: `request-boundary-${index}`,
          root: defineComponent({ setup: () => () => h('main') }),
          install: ({ context }) => {
            requestUrl = context.request.url
          },
        },
        {
          mountSelector: '#request-boundary-app',
          url,
          domain: createTestDomain('localhost', { protocol: 'http' }),
          publicConfig: {},
        }
      )

      expect(requestUrl).toBe(expected)
      mounted.unmount()
    }
  })

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

    expect(document.querySelector('link[data-vue-ssr-lite-rendered-style="async"]')).not.toBeNull()
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

    await expect(
      hydrateSsrApplication({
        id: 'browser-failure',
        root: defineComponent({
          setup() {
            throw new Error('mount failed')
          },
        }),
        install: ({ hydration }) => hydration.onDispose(dispose),
      })
    ).rejects.toThrow('mount failed')
    expect(dispose).toHaveBeenCalledTimes(1)
    // The serialized state element is preserved so a retry can re-hydrate.
    expect(document.getElementById(state.id)).toBe(state)
  })

  it('mounts a SPA with the server-injected request-aware public config', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    const state = document.createElement('script')
    state.id = 'vue-ssr-lite-domain'
    state.type = 'application/json'
    state.textContent = JSON.stringify({
      version: 1,
      applicationId: 'spa',
      publicConfig: { host: 'tenant.test', pathname: '/checkout' },
      domain: createTestDomain('tenant.test'),
    })
    document.body.append(state)

    const mounted = await mountSpaApplication({
      id: 'spa',
      root: defineComponent({
        setup() {
          const config = usePublicConfig<{
            host: string
            pathname: string
          }>()
          return () => h('main', `${config.host}:${config.pathname}`)
        },
      }),
    })

    expect(document.querySelector('#app')?.textContent).toBe('tenant.test:/checkout')
    expect(document.getElementById(state.id)).toBeNull()
    mounted.unmount()
  })
})

import { describe, expect, it } from 'vitest'
import { defineComponent, h, inject, onServerPrefetch, ref, useSSRContext } from 'vue'
import { defineApplication } from './index'
import { SSR_REQUEST_RESOLUTION } from './SsrRequestResolution'
import { ssrWatch } from './SsrReactivityRuntime'
import { renderSsrApplication } from './SsrRenderRuntime'
import { createTestRenderRequest } from './SsrTestFixtures'

const baseRequest = (host = 'app.test') => createTestRenderRequest(host)

/** A generic async store that resolves work OUTSIDE any component prefetch. */
const createDeferredStore = (loadDelayMs: number) => {
  const state = { loaded: false, value: 'DATA' }
  return {
    state,
    load: () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          state.loaded = true
          resolve()
        }, loadDelayMs)
      ),
  }
}

describe('renderSsrApplication resolution passes', () => {
  it('completes a fully resolvable page in a single pass', async () => {
    const application = defineApplication({
      id: 'one-pass',
      root: defineComponent({
        setup: () => () => h('main', 'ready'),
      }),
    })
    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.metrics.renderPasses).toBe(1)
    expect(rendered.html).toContain('ready')
  })

  it('re-renders when a plugin resolves work after the first pass', async () => {
    const store = createDeferredStore(5)
    const application = defineApplication({
      id: 'resolve-later',
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          if (resolution.server && !store.state.loaded) {
            resolution.track(store.load())
            resolution.requestAdditionalPass()
          }
          return () =>
            h('main', store.state.loaded ? store.state.value : 'LOADING')
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest(), {
      resolutionDeadlineMs: 1_000,
    })
    expect(rendered.html).toContain('DATA')
    expect(rendered.html).not.toContain('LOADING')
    expect(rendered.metrics.renderPasses).toBe(2)
  })

  it('returns modules from only the final accepted render pass', async () => {
    const store = createDeferredStore(5)
    const application = defineApplication({
      id: 'final-assets',
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          const ssrContext = useSSRContext<{ modules?: Set<string> }>()
          if (!store.state.loaded) {
            ssrContext.modules ??= new Set()
            ssrContext.modules.add('src/Discarded.vue')
            resolution.track(store.load())
            resolution.requestAdditionalPass()
          } else {
            ssrContext.modules ??= new Set()
            ssrContext.modules.add('src/Final.vue')
          }
          return () => h('main', store.state.loaded ? 'final' : 'discarded')
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest(), {
      resolutionDeadlineMs: 1_000,
    })
    expect(rendered.renderedModules).toEqual(['src/Final.vue'])
  })

  it('is bounded: never exceeds maxResolutionPasses when work never settles', async () => {
    const application = defineApplication({
      id: 'never-settles',
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          if (resolution.server) {
            resolution.track(new Promise<void>((r) => setTimeout(r, 1)))
            resolution.requestAdditionalPass()
          }
          return () => h('main', 'still-loading')
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest(), {
      maxResolutionPasses: 2,
      resolutionDeadlineMs: 50,
    })
    expect(rendered.metrics.renderPasses).toBe(2)
    expect(rendered.html).toContain('still-loading')
  })
})

describe('ssrWatch under server render', () => {
  it('is active during SSR: reacts to state settled in onServerPrefetch', async () => {
    const application = defineApplication({
      id: 'ssr-watch',
      root: defineComponent({
        setup() {
          const source = ref(0)
          const captured = ref('initial')
          ssrWatch(source, (value) => {
            captured.value = `watched:${value}`
          })
          onServerPrefetch(async () => {
            source.value = 42
          })
          return () => h('main', captured.value)
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('watched:42')
  })
})

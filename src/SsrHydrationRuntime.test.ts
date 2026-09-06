// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://ex.test/"}
import {
  defineComponent,
  h,
  inject,
  onServerPrefetch,
  ref,
  type App,
  type InjectionKey,
  type Ref,
} from 'vue'
import { describe, expect, it, vi } from 'vitest'
import {
  createSsrHydrationController,
  SSR_HYDRATION_CONTEXT,
  type SsrHydrationContext,
} from './SsrHydrationRuntime'
import { renderSsrApplication } from './SsrRenderRuntime'
import { hydrateSsrApplication } from './SsrBrowserRuntime'
import { getSsrStateElementId } from './SsrSerialization'
import { createTestDomain, createTestRenderRequest } from './SsrTestFixtures'

/**
 * A fake, framework-neutral "data client" plugin. It demonstrates that the
 * generic hydration contract supports exactly the pattern a real API client
 * (Apollo, etc.) needs — server prefetch, cache contribution, browser restore —
 * WITHOUT `vue-ssr-lite` importing or understanding that client.
 */
interface DemoStore {
  value: Ref<string | null>
}
const DEMO_STORE: InjectionKey<DemoStore> = Symbol('demo-store')

const createDemoClient = (fetcher: () => Promise<string>) => {
  const store: DemoStore = { value: ref(null) }
  return {
    store,
    install(app: App) {
      app.provide(DEMO_STORE, store)
      // Locate the generic host WITHOUT importing anything about it beyond the
      // shared Symbol.for key — the identical integration a real client uses.
      const host = app.runWithContext(() =>
        inject<SsrHydrationContext | null>(SSR_HYDRATION_CONTEXT, null)
      )
      if (!host) return
      if (host.server) {
        host.contribute('demo', () => ({ value: store.value.value }))
      } else {
        const restored = host.read<{ value: string | null }>('demo')
        if (restored) store.value.value = restored.value
      }
    },
  }
}

const useDemoData = (fetcher: () => Promise<string>) => {
  const store = inject(DEMO_STORE)!
  // Native Vue server-prefetch; the render awaits it, and it never runs in the
  // browser (the restored value is already present).
  onServerPrefetch(async () => {
    store.value.value = await fetcher()
  })
  return store.value
}

const request = () =>
  createTestRenderRequest('demo.test', { requestId: 'demo' })

describe('generic hydration lifecycle', () => {
  it('validates final contributions without validating intermediate reactivity checkpoints', () => {
    const hydration = createSsrHydrationController(undefined, true)
    hydration.contribute('state', () => ({ value: 1 }))
    const validate = vi.fn(() => { throw new Error('incompatible snapshots') })
    hydration.onValidate(validate)
    expect(hydration.collect(false)).toEqual({ state: { value: 1 } })
    expect(validate).not.toHaveBeenCalled()
    expect(() => hydration.collect()).toThrow('incompatible snapshots')
    hydration.dispose()
    expect(hydration.collect()).toBeUndefined()
  })

  it('keeps request-local reconciliation metadata out of serializable hydration state', () => {
    const first = createSsrHydrationController(undefined, true)
    first.contribute('public', () => ({ data: 'safe' }))
    first.contributeReconciliation('private', () => ({ fingerprint: 'secret-fingerprint' }))
    expect(first.collect()).toEqual({ public: { data: 'safe' } })
    expect(first.collectReconciliation()).toEqual({
      private: { fingerprint: 'secret-fingerprint' },
    })

    const resumed = createSsrHydrationController(
      first.collect(),
      true,
      first.collectReconciliation()
    )
    expect(resumed.read('private')).toBeUndefined()
    expect(resumed.readReconciliation('private')).toEqual({
      fingerprint: 'secret-fingerprint',
    })
    first.dispose()
    resumed.dispose()
  })

  it('completes the initial transaction once and forgets only owned continuation state', () => {
    const restored = { temporary: { value: 1 }, plugin: { value: 2 } }
    const hydration = createSsrHydrationController(restored, false)
    const complete = vi.fn(() => hydration.forget('temporary'))
    hydration.onHydrated(complete)
    hydration.completeHydration()
    hydration.completeHydration()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(hydration.read('temporary')).toBeUndefined()
    expect(hydration.read('plugin')).toEqual({ value: 2 })
    expect(restored.temporary).toEqual({ value: 1 })
    const cleanup = vi.fn(() => expect(hydration.read('plugin')).toEqual({ value: 2 }))
    hydration.onDispose(cleanup)
    hydration.dispose()
    hydration.completeHydration()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('discards pending hydration completion callbacks on failure or disposal', () => {
    const hydration = createSsrHydrationController(undefined, false)
    const complete = vi.fn()
    hydration.onHydrated(complete)
    hydration.dispose()
    hydration.completeHydration()
    expect(complete).not.toHaveBeenCalled()
  })

  it('waits for a plugin server-prefetch, renders real data, and serializes contributed state', async () => {
    const fetcher = vi.fn(async () => 'prefetched-value')
    const demo = createDemoClient(fetcher)
    const Root = defineComponent({
      setup() {
        const value = useDemoData(fetcher)
        return () => h('main', value.value ?? 'pending')
      },
    })

    const rendered = await renderSsrApplication({
      id: 'demo-app',
      root: Root,
      install: ({ app }) => {
        app.use(demo)
      },
    }, request())

    // Real data made it into the HTML — not the "pending" placeholder.
    expect(rendered.html).toContain('prefetched-value')
    expect(rendered.html).not.toContain('pending')
    // The plugin's contributed cache is embedded generically under its key.
    expect(rendered.hydrationState.plugins?.demo).toEqual({ value: 'prefetched-value' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('restores contributed state on the browser without re-running the prefetch', async () => {
    // The file's environment installs the DOM before Vue is imported, keeping
    // runtime-dom and its constructor checks in the hydrated nodes' realm.
    document.body.innerHTML = '<div id="app"><main>prefetched-value</main></div>'
    let mounted: App | undefined

    try {
      const stateElement = window.document.createElement('script')
      stateElement.id = getSsrStateElementId('demo-app')
      stateElement.type = 'application/json'
      stateElement.textContent = JSON.stringify({
        version: 1,
        applicationId: 'demo-app',
        publicConfig: {},
        domain: createTestDomain('demo.test'),
        siteOrigin: 'https://ex.test',
        application: {},
        plugins: { demo: { value: 'prefetched-value' } },
      })
      window.document.body.append(stateElement)

      const fetcher = vi.fn(async () => 'should-not-run')
      const demo = createDemoClient(fetcher)
      const Root = defineComponent({
        setup() {
          const value = useDemoData(fetcher)
          return () => h('main', value.value ?? 'pending')
        },
      })

      await hydrateSsrApplication({
        id: 'demo-app',
        root: Root,
        install: ({ app }) => {
          mounted = app
          app.use(demo)
        },
      })

      expect(window.document.querySelector('#app')?.textContent).toContain(
        'prefetched-value'
      )
      // The restored value avoided any browser fetch/prefetch.
      expect(fetcher).not.toHaveBeenCalled()
      expect(window.document.getElementById(stateElement.id)).toBeNull()
    } finally {
      mounted?.unmount()
      document.body.innerHTML = ''
    }
  })
})

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
import { SSR_HYDRATION_CONTEXT, type SsrHydrationContext } from './SsrHydrationRuntime'
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
      rootComponent: Root,
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
    // @vitest-environment jsdom is not set globally; emulate the DOM the browser
    // hydration path needs directly.
    const dom = await import('jsdom')
    const { window } = new dom.JSDOM(
      '<!doctype html><html><body><div id="app"><main>prefetched-value</main></div></body></html>'
    )
    const previous = {
      window: globalThis.window,
      document: globalThis.document,
    }
    ;(globalThis as any).window = window
    ;(globalThis as any).document = window.document

    try {
      const stateElement = window.document.createElement('script')
      stateElement.id = getSsrStateElementId('demo-app')
      stateElement.type = 'application/json'
      stateElement.textContent = JSON.stringify({
        version: 1,
        applicationId: 'demo-app',
        publicConfig: {},
        domain: createTestDomain('demo.test'),
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
        rootComponent: Root,
        install: ({ app }) => {
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
      ;(globalThis as any).window = previous.window
      ;(globalThis as any).document = previous.document
    }
  })
})

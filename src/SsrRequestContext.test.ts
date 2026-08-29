import { renderToString } from 'vue/server-renderer'
import { defineComponent, h, inject, type InjectionKey, type Plugin } from 'vue'
import { describe, expect, it } from 'vitest'
import { createSsrApplication } from './SsrApplicationRuntime'
import {
  SSR_REQUEST_CONTEXT as MODULE_REQUEST_CONTEXT,
  useSsrRequestContext,
} from './SsrRequestContext'
import type { SsrRequestContext } from './SsrRuntimeTypes'
import { createTestRenderRequest } from './SsrTestFixtures'

const REQUEST_CONTEXT_SYMBOL_KEY = 'vue-ssr:request-context'

// Represents a separately evaluated compatible package copy. It intentionally
// derives the key independently instead of importing the package's value.
const COMPATIBLE_REQUEST_CONTEXT = Symbol.for(
  REQUEST_CONTEXT_SYMBOL_KEY
) as InjectionKey<SsrRequestContext<any, any>>

const request = createTestRenderRequest('identity.test', {
  requestId: 'request-context-regression',
  url: 'https://identity.test/catalog',
  publicConfig: { label: 'identity' },
})

describe('SSR request context identity', () => {
  it('uses one globally registered identity across public and compatible module entries', () => {
    expect(Symbol.keyFor(MODULE_REQUEST_CONTEXT)).toBe(
      REQUEST_CONTEXT_SYMBOL_KEY
    )
    expect(COMPATIBLE_REQUEST_CONTEXT).toBe(MODULE_REQUEST_CONTEXT)
  })

  it('installs the exact request-specific context before root setup renders', async () => {
    let received: SsrRequestContext<any, any> | undefined
    const Root = defineComponent({
      setup() {
        received = useSsrRequestContext()
        return () => h('main', received?.request.requestId)
      },
    })
    const created = await createSsrApplication(
      { id: 'request-context-hook', root: Root },
      { server: true, request }
    )

    try {
      const html = await renderToString(created.app)
      expect(received).toBe(created.context)
      expect(received?.applicationId).toBe('request-context-hook')
      expect(html).toContain(request.requestId)
    } finally {
      created.hydration.dispose()
    }
  })

  it('installs generic application plugins after request context and before root setup', async () => {
    let pluginContext: SsrRequestContext<any, any> | undefined
    const contextPlugin: Plugin = {
      install(app) {
        pluginContext = app.runWithContext(() => inject(MODULE_REQUEST_CONTEXT))
      },
    }
    const Root = defineComponent({
      setup() {
        const context = useSsrRequestContext()
        return () => h('main', context.applicationId)
      },
    })
    const created = await createSsrApplication(
      {
        id: 'plugin-managed-application',
        root: Root,
        plugins: [contextPlugin],
      },
      { server: true, request }
    )

    try {
      expect(await renderToString(created.app)).toContain(
        'plugin-managed-application'
      )
      expect(pluginContext).toBe(created.context)
    } finally {
      created.hydration.dispose()
    }
  })

  it('allows a separately evaluated compatible consumer to inject the provided context', async () => {
    let received: SsrRequestContext<any, any> | undefined
    const Root = defineComponent({
      setup() {
        received = inject(COMPATIBLE_REQUEST_CONTEXT)
        return () => h('main', received?.host)
      },
    })
    const created = await createSsrApplication(
      { id: 'request-context-compatible-copy', root: Root },
      { server: true, request }
    )

    try {
      const html = await renderToString(created.app)
      expect(received).toBe(created.context)
      expect(html).toContain(request.host)
    } finally {
      created.hydration.dispose()
    }
  })

  it('records property-membership reads as render observations', async () => {
    const Root = defineComponent({
      setup() {
        const context = useSsrRequestContext<{ feature?: boolean }>()
        return () => h('main', 'feature' in context.state ? 'on' : 'off')
      },
    })
    const created = await createSsrApplication(
      {
        id: 'request-context-membership-observation',
        createInitialState: () => ({ feature: true }),
        root: Root,
      },
      { server: true, request }
    )
    const register =
      created.resolution.registerReactivityObservation.bind(created.resolution)
    let observations = 0
    created.resolution.registerReactivityObservation = () => {
      observations += 1
      register()
    }

    try {
      expect(await renderToString(created.app)).toContain('on')
      expect(observations).toBeGreaterThan(0)
    } finally {
      created.hydration.dispose()
    }
  })

  it('observes Map and Set interior reads and mutations', async () => {
    type CollectionState = {
      cache: Map<string, string>
      flags: Set<string>
    }
    const Root = defineComponent({
      setup() {
        const context = useSsrRequestContext<CollectionState>()
        const cache = context.state.cache
        const flags = context.state.flags
        cache.set('phase', 'ready')
        flags.add('enabled')
        return () =>
          h(
            'main',
            `${cache.get('phase')}:${flags.has('enabled') ? 'on' : 'off'}`
          )
      },
    })
    const created = await createSsrApplication(
      {
        id: 'request-context-collection-observation',
        createInitialState: () => ({ cache: new Map(), flags: new Set() }),
        root: Root,
      },
      { server: true, request }
    )
    const registerObservation =
      created.resolution.registerReactivityObservation.bind(created.resolution)
    let observations = 0
    created.resolution.registerReactivityObservation = () => {
      observations += 1
      registerObservation()
    }

    try {
      expect(await renderToString(created.app)).toContain('ready:on')
      expect(observations).toBeGreaterThan(0)
      expect(created.context.state.cache.get('phase')).toBe('ready')
      expect(created.context.state.flags.has('enabled')).toBe(true)
    } finally {
      created.hydration.dispose()
    }
  })
})

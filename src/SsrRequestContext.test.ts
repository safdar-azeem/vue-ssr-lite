import { renderToString } from '@vue/server-renderer'
import { defineComponent, h, inject, type InjectionKey, type Plugin } from 'vue'
import { describe, expect, it } from 'vitest'
import {
  createSsrApplication,
  SSR_REQUEST_CONTEXT as PUBLIC_REQUEST_CONTEXT,
  useSsrRequestContext,
} from './index'
import { SSR_REQUEST_CONTEXT as MODULE_REQUEST_CONTEXT } from './SsrRequestContext'
import type { SsrRequestContext } from './SsrRuntimeTypes'

const REQUEST_CONTEXT_SYMBOL_KEY = 'vue-ssr:request-context'

// Represents a separately evaluated compatible package copy. It intentionally
// derives the key independently instead of importing the package's value.
const COMPATIBLE_REQUEST_CONTEXT = Symbol.for(
  REQUEST_CONTEXT_SYMBOL_KEY
) as InjectionKey<SsrRequestContext<any, any, any>>

const request = {
  requestId: 'request-context-regression',
  url: 'https://identity.test/catalog',
  host: 'identity.test',
  protocol: 'https' as const,
  method: 'GET',
  headers: {},
  publicConfig: { label: 'identity' },
  signal: new AbortController().signal,
}

describe('SSR request context identity', () => {
  it('uses one globally registered identity across public and compatible module entries', () => {
    expect(Symbol.keyFor(PUBLIC_REQUEST_CONTEXT)).toBe(
      REQUEST_CONTEXT_SYMBOL_KEY
    )
    expect(MODULE_REQUEST_CONTEXT).toBe(PUBLIC_REQUEST_CONTEXT)
    expect(COMPATIBLE_REQUEST_CONTEXT).toBe(PUBLIC_REQUEST_CONTEXT)
  })

  it('installs the exact request-specific context before root setup renders', async () => {
    let received: SsrRequestContext<any, any, any> | undefined
    const Root = defineComponent({
      setup() {
        received = useSsrRequestContext()
        return () => h('main', received?.request.requestId)
      },
    })
    const created = await createSsrApplication(
      { id: 'request-context-hook', rootComponent: Root },
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
    let pluginContext: SsrRequestContext<any, any, any> | undefined
    const contextPlugin: Plugin = {
      install(app) {
        pluginContext = app.runWithContext(() => inject(PUBLIC_REQUEST_CONTEXT))
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
        rootComponent: Root,
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
    let received: SsrRequestContext<any, any, any> | undefined
    const Root = defineComponent({
      setup() {
        received = inject(COMPATIBLE_REQUEST_CONTEXT)
        return () => h('main', received?.host)
      },
    })
    const created = await createSsrApplication(
      { id: 'request-context-compatible-copy', rootComponent: Root },
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
})

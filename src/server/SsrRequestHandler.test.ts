import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, inject, onServerPrefetch } from 'vue'
import type { SsrCompiledConfig } from '../SsrConfigCompileRuntime'
import type { SsrEndpointDefinition } from '../SsrRuntimeTypes'
import { SSR_REQUEST_RESOLUTION } from '../SsrRequestResolution'
import {
  createSsrAdmissionController,
  type SsrAdmissionController,
} from './SsrAdmissionRuntime'
import {
  createSsrRequestScope,
  handleSsrRequest,
  SsrRequestCancelledError,
  type SsrNormalizedRequest,
  type SsrRequestHandlerRuntime,
  type SsrRequestScope,
} from './SsrRequestHandler'

const normalizedRequest = (url: string): SsrNormalizedRequest =>
  Object.freeze({
    requestId: 'request-handler-test',
    startedAt: 1_700_000_000_000,
    method: 'GET',
    url,
    protocol: 'https',
    headers: Object.freeze({
      host: 'example.test',
      accept: 'application/json',
    }),
  })

const normalizedHtmlRequest = (url: string): SsrNormalizedRequest =>
  Object.freeze({
    ...normalizedRequest(url),
    headers: Object.freeze({
      host: 'example.test',
      accept: 'text/html',
    }),
  })

const Root = defineComponent({ setup: () => () => h('main', 'rendered') })

const compiledDefinition = (
  endpoint?: SsrEndpointDefinition<any>,
  publicConfigFactory?: SsrCompiledConfig['applications'][number]['publicConfigFactory'],
  render: 'spa' | 'ssr' = 'spa'
): SsrCompiledConfig => ({
  name: 'request-handler-test',
  development: true,
  server: {
    root: '/virtual/request-handler-test',
    host: '127.0.0.1',
    trustProxy: false,
    clientOutDir: 'dist/client',
    requestTimeoutMs: 15_000,
    shutdownTimeoutMs: 10_000,
    maxConcurrentSsrRequests: 8,
    maxQueuedSsrRequests: 32,
    healthPath: '/healthz',
    readinessPath: '/readyz',
    maxResolutionPasses: 4,
    resolutionDeadlineMs: 15_000,
    diagnostics: false,
  },
  applications: [
    {
      id: 'app',
      kind: render,
      template: 'index.html',
      templateMissing: false,
      hosts: ['example.test'],
      mountSelector: '#app',
      endpoints: endpoint ? [endpoint] : [],
      cookieAllowlist: [],
      cookieDenylist: [],
      publicConfig: {},
      publicConfigFactory,
      application: render === 'ssr' ? { id: 'app', root: Root } : undefined,
      shell: {
        main: '/virtual/request-handler-test/main.ts',
        root: '/virtual/request-handler-test/App.vue',
      },
      hasRouteRenderOverrides: false,
      domain: {
        development: 'example.test',
        production: 'example.test',
        mode: 'root',
        localAliases: false,
        customDomains: false,
        params: {},
      },
    },
  ],
})

const handlerRuntime = (
  scope: SsrRequestScope,
  definition: SsrCompiledConfig,
  ssrAdmission: SsrAdmissionController = createSsrAdmissionController({
    maxConcurrent: 8,
    maxQueued: 32,
  })
): SsrRequestHandlerRuntime => ({
  production: false,
  scope,
  loadDefinition: async () => definition,
  fallbackDefinition: () => definition,
  shuttingDown: () => false,
  assertReady: async () => undefined,
  ssrAdmission,
  viteBase: '/',
  loadTemplate: async () => '<html><body><div id="app"></div></body></html>',
  loadPreparedSsrTemplate: async () =>
    '<html><head><!--vue-ssr-lite:head--></head><body><!--vue-ssr-lite:teleports--><div id="app"><!--vue-ssr-lite:html--></div><!--vue-ssr-lite:state--></body></html>',
  resolveDevelopmentAssets: async () => [],
  isPrivateProductionAssetPath: () => false,
  serveProductionAsset: async () => false,
})

describe('transport-independent SSR request handler', () => {
  it('returns a normal Core response without Node HTTP request or response objects', async () => {
    const scope = createSsrRequestScope(0)
    try {
      const response = await handleSsrRequest(
        normalizedRequest('/healthz'),
        handlerRuntime(scope, compiledDefinition())
      )

      expect(response?.statusCode).toBe(200)
      expect(response?.headers?.['content-type']).toBe('application/json; charset=utf-8')
      expect(JSON.parse(String(response?.body))).toMatchObject({
        status: 'ok',
        service: 'request-handler-test',
      })
    } finally {
      scope.dispose()
    }
  })

  it('uses the request scope signal everywhere and preserves endpoint header multiplicity', async () => {
    const scope = createSsrRequestScope(0)
    let publicConfigSignal: AbortSignal | undefined
    let endpointRequestSignal: AbortSignal | undefined
    let endpointToolsSignal: AbortSignal | undefined
    const endpoint: SsrEndpointDefinition = {
      id: 'cookies',
      match: (request) => request.pathname === '/endpoint',
      handle: (request, tools) => {
        endpointRequestSignal = request.signal
        endpointToolsSignal = tools.signal
        return {
          statusCode: 202,
          body: 'accepted',
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'set-cookie': ['first=one; Path=/', 'second=two; Path=/'],
          },
        }
      },
    }
    const definition = compiledDefinition(endpoint, (request) => {
      publicConfigSignal = request.signal
      return { source: 'test' }
    })

    try {
      const response = await handleSsrRequest(
        normalizedRequest('/endpoint'),
        handlerRuntime(scope, definition)
      )

      expect(response).toEqual({
        statusCode: 202,
        body: 'accepted',
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'set-cookie': ['first=one; Path=/', 'second=two; Path=/'],
        },
      })
      expect(publicConfigSignal).toBe(scope.signal)
      expect(endpointRequestSignal).toBe(scope.signal)
      expect(endpointToolsSignal).toBe(scope.signal)
    } finally {
      scope.dispose()
    }
  })

  it('derives site origin after trusted proxy normalization', async () => {
    const endpoint: SsrEndpointDefinition = {
      id: 'site-origin',
      match: (request) => request.pathname === '/origin',
      handle: (request) => ({ statusCode: 200, body: request.siteOrigin }),
    }
    const request = Object.freeze({
      ...normalizedRequest('/origin'),
      protocol: 'http' as const,
      headers: Object.freeze({
        host: 'direct.test',
        'x-forwarded-host': 'tenant.test',
        'x-forwarded-proto': 'https',
      }),
    })

    const directDefinition = compiledDefinition(endpoint)
    directDefinition.applications[0]!.hosts = ['*']
    directDefinition.applications[0]!.domain.customDomains = true
    const directScope = createSsrRequestScope(0)
    try {
      const response = await handleSsrRequest(
        request,
        handlerRuntime(directScope, directDefinition),
      )
      expect(response?.body).toBe('http://direct.test')
    } finally {
      directScope.dispose()
    }

    const proxyDefinition = compiledDefinition(endpoint)
    proxyDefinition.server.trustProxy = true
    proxyDefinition.applications[0]!.hosts = ['*']
    proxyDefinition.applications[0]!.domain.customDomains = true
    const proxyScope = createSsrRequestScope(0)
    try {
      const response = await handleSsrRequest(
        request,
        handlerRuntime(proxyScope, proxyDefinition),
      )
      expect(response?.body).toBe('https://tenant.test')
    } finally {
      proxyScope.dispose()
    }
  })

  it('cannot continue Core orchestration after its canonical scope is cancelled', async () => {
    const scope = createSsrRequestScope(0)
    const definition = compiledDefinition()
    const loadDefinition = vi.fn(async () => definition)
    const runtime = {
      ...handlerRuntime(scope, definition),
      loadDefinition,
    }
    scope.cancel()

    try {
      await expect(
        handleSsrRequest(normalizedRequest('/endpoint'), runtime)
      ).rejects.toBeInstanceOf(SsrRequestCancelledError)
      expect(loadDefinition).not.toHaveBeenCalled()
    } finally {
      scope.dispose()
    }
  })

  it('keeps health, custom endpoint, SPA, and production-asset paths outside SSR admission', async () => {
    const admission = createSsrAdmissionController({ maxConcurrent: 1, maxQueued: 0 })
    const held = await admission.acquire({
      signal: new AbortController().signal,
      requestId: 'held',
      entryId: 'app',
    })
    const acquire = vi.spyOn(admission, 'acquire')
    acquire.mockClear()
    const endpoint: SsrEndpointDefinition = {
      id: 'custom',
      match: (request) => request.pathname === '/custom',
      handle: () => ({ statusCode: 204 }),
    }
    const cases = [
      [normalizedRequest('/healthz'), compiledDefinition()],
      [normalizedRequest('/custom'), compiledDefinition(endpoint)],
      [normalizedHtmlRequest('/spa'), compiledDefinition()],
    ] as const

    try {
      for (const [request, definition] of cases) {
        const scope = createSsrRequestScope(0)
        try {
          await handleSsrRequest(request, handlerRuntime(scope, definition, admission))
        } finally {
          scope.dispose()
        }
      }

      const assetScope = createSsrRequestScope(0)
      try {
        const definition = compiledDefinition()
        const runtime = {
          ...handlerRuntime(assetScope, definition, admission),
          production: true,
          serveProductionAsset: async () => true,
        }
        await handleSsrRequest(normalizedRequest('/asset.js'), runtime)
      } finally {
        assetScope.dispose()
      }

      expect(acquire).not.toHaveBeenCalled()
    } finally {
      held.release()
    }
  })

  it('returns an SSR cache hit without acquiring admission', async () => {
    const definition = compiledDefinition(undefined, undefined, 'ssr')
    definition.applications[0]!.responseCache = {
      ttlMs: 1_000,
      store: {
        get: async () => ({
          statusCode: 200,
          body: '<html>cached</html>',
          headers: { 'cache-control': 'public, max-age=60' },
        }),
        set: async () => undefined,
        invalidate: async () => 0,
      },
    }
    const admission = createSsrAdmissionController({ maxConcurrent: 1, maxQueued: 0 })
    const acquire = vi.spyOn(admission, 'acquire')
    const scope = createSsrRequestScope(0)

    try {
      const response = await handleSsrRequest(
        normalizedHtmlRequest('/cached'),
        handlerRuntime(scope, definition, admission)
      )

      expect(response?.statusCode).toBe(200)
      expect(response?.headers?.['server-timing']).toBe('cache;desc="hit"')
      expect(acquire).not.toHaveBeenCalled()
    } finally {
      scope.dispose()
    }
  })

  it('maps queue-capacity exhaustion to a small transport-independent 503', async () => {
    const admission = createSsrAdmissionController({ maxConcurrent: 1, maxQueued: 0 })
    const held = await admission.acquire({
      signal: new AbortController().signal,
      requestId: 'held',
      entryId: 'app',
    })
    const scope = createSsrRequestScope(0)

    try {
      const response = await handleSsrRequest(
        normalizedHtmlRequest('/overloaded'),
        handlerRuntime(scope, compiledDefinition(undefined, undefined, 'ssr'), admission)
      )

      expect(response?.statusCode).toBe(503)
      expect(response?.headers).toMatchObject({
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      expect(JSON.parse(String(response?.body))).toEqual({
        status: 'error',
        service: 'request-handler-test',
        message: 'Service temporarily unavailable.',
      })
    } finally {
      scope.dispose()
      held.release()
    }
  })

  it('uses the canonical request signal to remove queued SSR before it can render', async () => {
    let markQueued!: () => void
    const queued = new Promise<void>((resolve) => {
      markQueued = resolve
    })
    const admission = createSsrAdmissionController({
      maxConcurrent: 1,
      maxQueued: 1,
      onEvent: (event) => {
        if (event.type === 'queued') markQueued()
      },
    })
    const held = await admission.acquire({
      signal: new AbortController().signal,
      requestId: 'held',
      entryId: 'app',
    })
    let renders = 0
    const definition = compiledDefinition(undefined, undefined, 'ssr')
    definition.applications[0]!.application = {
      id: 'app',
      root: defineComponent({
        setup() {
          renders += 1
          return () => h('main', 'must not render')
        },
      }),
    }
    const scope = createSsrRequestScope(0)
    const handling = handleSsrRequest(
      normalizedHtmlRequest('/queued-cancellation'),
      handlerRuntime(scope, definition, admission)
    )

    try {
      await queued
      expect(admission.snapshot()).toEqual({ activeCount: 1, queuedCount: 1 })
      const cancellation = new SsrRequestCancelledError()
      const rejected = expect(handling).rejects.toBe(cancellation)
      scope.cancel(cancellation)
      await rejected
      expect(renders).toBe(0)
      expect(admission.snapshot()).toEqual({ activeCount: 1, queuedCount: 0 })
    } finally {
      scope.dispose()
      held.release()
    }
  })

  it('holds one lease throughout every bounded SSR resolution pass', async () => {
    const admission = createSsrAdmissionController({ maxConcurrent: 1, maxQueued: 1 })
    const activeCounts: number[] = []
    let resolved = false
    const definition = compiledDefinition(undefined, undefined, 'ssr')
    definition.applications[0]!.application = {
      id: 'app',
      root: defineComponent({
        setup() {
          activeCounts.push(admission.snapshot().activeCount)
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          if (!resolved) {
            resolution.track(
              Promise.resolve().then(() => {
                resolved = true
              })
            )
            resolution.requestAdditionalPass()
          }
          return () => h('main', resolved ? 'resolved' : 'pending')
        },
      }),
    }
    const scope = createSsrRequestScope(0)

    try {
      const response = await handleSsrRequest(
        normalizedHtmlRequest('/multi-pass'),
        handlerRuntime(scope, definition, admission)
      )

      expect(response?.statusCode).toBe(200)
      expect(String(response?.body)).toContain('resolved')
      expect(activeCounts).toEqual([1, 1])
      expect(admission.snapshot()).toEqual({ activeCount: 0, queuedCount: 0 })
    } finally {
      scope.dispose()
    }
  })

  it('releases admission when Vue SSR throws', async () => {
    const admission = createSsrAdmissionController({ maxConcurrent: 1, maxQueued: 1 })
    const definition = compiledDefinition(undefined, undefined, 'ssr')
    definition.applications[0]!.application = {
      id: 'app',
      root: defineComponent({
        setup() {
          throw new Error('render failed')
        },
      }),
    }
    const scope = createSsrRequestScope(0)

    try {
      const response = await handleSsrRequest(
        normalizedHtmlRequest('/failure'),
        handlerRuntime(scope, definition, admission)
      )

      expect(response?.statusCode).toBe(500)
      expect(admission.snapshot()).toEqual({ activeCount: 0, queuedCount: 0 })
    } finally {
      scope.dispose()
    }
  })

  it('keeps a cancelled admitted request active until its underlying Vue render settles', async () => {
    let markQueued!: () => void
    const requestBQueued = new Promise<void>((resolve) => {
      markQueued = resolve
    })
    const admission = createSsrAdmissionController({
      maxConcurrent: 1,
      maxQueued: 1,
      onEvent: (event) => {
        if (event.type === 'queued') markQueued()
      },
    })
    let markRequestAStarted!: () => void
    const requestAStarted = new Promise<void>((resolve) => {
      markRequestAStarted = resolve
    })
    let finishRequestARender!: () => void
    const requestARenderGate = new Promise<void>((resolve) => {
      finishRequestARender = resolve
    })
    const definitionA = compiledDefinition(undefined, undefined, 'ssr')
    definitionA.applications[0]!.application = {
      id: 'app',
      root: defineComponent({
        setup() {
          markRequestAStarted()
          onServerPrefetch(() => requestARenderGate)
          return () => h('main', 'request A')
        },
      }),
    }
    let requestBRenders = 0
    const definitionB = compiledDefinition(undefined, undefined, 'ssr')
    definitionB.applications[0]!.application = {
      id: 'app',
      root: defineComponent({
        setup() {
          requestBRenders += 1
          return () => h('main', 'request B')
        },
      }),
    }
    const scopeA = createSsrRequestScope(0)
    const scopeB = createSsrRequestScope(0)
    const handlingA = handleSsrRequest(
      normalizedHtmlRequest('/request-a'),
      handlerRuntime(scopeA, definitionA, admission)
    )
    void handlingA.catch(() => undefined)
    let handlingB: ReturnType<typeof handleSsrRequest> | undefined

    try {
      await requestAStarted
      expect(admission.snapshot()).toEqual({ activeCount: 1, queuedCount: 0 })

      handlingB = handleSsrRequest(
        normalizedHtmlRequest('/request-b'),
        handlerRuntime(scopeB, definitionB, admission)
      )
      void handlingB.catch(() => undefined)
      await requestBQueued
      expect(admission.snapshot()).toEqual({ activeCount: 1, queuedCount: 1 })
      expect(requestBRenders).toBe(0)

      const cancellation = new SsrRequestCancelledError()
      const rejected = expect(handlingA).rejects.toBe(cancellation)
      scopeA.cancel(cancellation)
      await rejected
      expect(admission.snapshot()).toEqual({ activeCount: 1, queuedCount: 1 })
      expect(requestBRenders).toBe(0)

      finishRequestARender()
      const responseB = await handlingB
      expect(responseB?.statusCode).toBe(200)
      expect(String(responseB?.body)).toContain('request B')
      expect(requestBRenders).toBe(1)
      expect(admission.snapshot()).toEqual({ activeCount: 0, queuedCount: 0 })
    } finally {
      finishRequestARender()
      scopeA.dispose()
      scopeB.dispose()
    }
  })
})

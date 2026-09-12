import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, inject, onServerPrefetch } from 'vue'
import { RouterView } from 'vue-router'
import type { SsrCompiledConfig } from '../SsrConfigCompileRuntime'
import type { SsrEndpointDefinition, SsrHttpResponse } from '../SsrRuntimeTypes'
import { SSR_REQUEST_RESOLUTION } from '../SsrRequestResolution'
import { renderSsrApplication } from '../SsrRenderRuntime'
import { defineMiddleware } from '../middleware/defineMiddleware'
import {
  createSsrAdmissionController,
  type SsrAdmissionController,
} from './SsrAdmissionRuntime'
import {
  createSsrRequestScope,
  handleSsrRequest as handleNativeSsrRequest,
  SsrRequestCancelledError,
  type SsrNormalizedRequest,
  type SsrRequestHandlerRuntime,
  type SsrRequestScope,
} from './SsrRequestHandler'

const handleSsrRequest = async (...args: Parameters<typeof handleNativeSsrRequest>): Promise<SsrHttpResponse | undefined> => {
  const result = await handleNativeSsrRequest(...args)
  if (!(result instanceof Response)) return result
  const headers: Record<string, string | string[]> = Object.fromEntries(result.headers)
  const cookies = result.headers.getSetCookie()
  if (cookies.length) headers['set-cookie'] = cookies
  return { statusCode: result.status, headers, body: result.body ? await result.text() : undefined }
}

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
  resolveProductionAssetResponse: async () => null,
})

describe('transport-independent SSR request handler', () => {
  it.each([
    '/@vite/client', '/@id/virtual-module', '/@fs/project/main.ts',
    '/@vue-ssr-lite/client/app', '/src/App.vue', '/src/main.ts',
    '/src/style.css', '/node_modules/.vite/deps/vue.js?v=123', '/favicon.ico',
    '/app/@vite/client', '/app/@vue-ssr-lite/client/app',
    '/products/@vue-ssr-lite/client/app', '/products/src/style.css',
    '/plugin-owned-extensionless-resource',
  ])('gives Vite ownership of %s before any application work', async (url) => {
    const publicConfig = vi.fn(() => ({}))
    const endpoint = { id: 'probe', match: vi.fn(() => false), handle: vi.fn() }
    const definition = compiledDefinition(endpoint, publicConfig)
    const classify = vi.fn(() => 'spa' as const)
    definition.applications[0]!.resolveRouteRender = classify
    const scope = createSsrRequestScope(0)
    const runtime = handlerRuntime(scope, definition)
    const loadDefinition = vi.fn(runtime.loadDefinition)
    const serveViteRequest = vi.fn(async () => true)
    try {
      // Host selection must not gate resource ownership, even on other apps'
      // domains or hosts that have no application at all.
      for (const host of ['example.test', 'admin.localhost', 'portal.custom.test']) {
        const response = await handleSsrRequest({
          ...normalizedRequest(url), headers: { host, accept: '*/*' },
        }, { ...runtime, loadDefinition, serveViteRequest })
        expect(response).toBeUndefined()
      }
      expect(loadDefinition).not.toHaveBeenCalled()
      expect(classify).not.toHaveBeenCalled()
      expect(publicConfig).not.toHaveBeenCalled()
      expect(endpoint.match).not.toHaveBeenCalled()
    } finally {
      scope.dispose()
    }
  })

  it.each(['/users/john.smith', '/releases/2.0', '/projects/example.com', '/docs/api.json'])(
    'classifies dotted HTML route %s after Vite declines it', async (url) => {
      const definition = compiledDefinition()
      const classify = vi.fn(() => 'spa' as const)
      definition.applications[0]!.resolveRouteRender = classify
      const scope = createSsrRequestScope(0)
      const serveViteRequest = vi.fn(async () => false)
      try {
        const response = await handleSsrRequest(normalizedHtmlRequest(url), {
          ...handlerRuntime(scope, definition), serveViteRequest,
        })
        expect(response?.statusCode).toBe(200)
        expect(serveViteRequest).toHaveBeenCalledOnce()
        expect(classify).toHaveBeenCalledWith(url)
      } finally {
        scope.dispose()
      }
    }
  )

  it.each(['/api/report.json', '/download/file.xml'])(
    'serves endpoint %s without page classification after Vite fallthrough', async (url) => {
      const definition = compiledDefinition({
        id: 'download',
        match: (request) => request.pathname === url,
        handle: () => ({ statusCode: 200, body: 'endpoint' }),
      })
      const classify = vi.fn(() => 'spa' as const)
      definition.applications[0]!.resolveRouteRender = classify
      const scope = createSsrRequestScope(0)
      try {
        const response = await handleSsrRequest(normalizedRequest(url), {
          ...handlerRuntime(scope, definition), serveViteRequest: async () => false,
        })
        expect(response?.body).toBe('endpoint')
        expect(classify).not.toHaveBeenCalled()
      } finally {
        scope.dispose()
      }
    }
  )

  it('never invokes development middleware in production', async () => {
    const definition = compiledDefinition()
    const scope = createSsrRequestScope(0)
    const serveViteRequest = vi.fn(async () => true)
    try {
      const response = await handleSsrRequest(normalizedHtmlRequest('/'), {
        ...handlerRuntime(scope, definition), production: true, serveViteRequest,
      })
      expect(response?.statusCode).toBe(200)
      expect(serveViteRequest).not.toHaveBeenCalled()
    } finally {
      scope.dispose()
    }
  })

  it('does not classify a missing favicon after Vite fallthrough', async () => {
    const definition = compiledDefinition()
    const classify = vi.fn(() => 'spa' as const)
    definition.applications[0]!.resolveRouteRender = classify
    const scope = createSsrRequestScope(0)
    try {
      const response = await handleSsrRequest(normalizedRequest('/favicon.ico'), {
        ...handlerRuntime(scope, definition), serveViteRequest: async () => false,
      })
      expect(response?.statusCode).toBe(404)
      expect(classify).not.toHaveBeenCalled()
    } finally {
      scope.dispose()
    }
  })

  it('uses the renderer carried by the application module graph', async () => {
    const definition = compiledDefinition(undefined, undefined, 'ssr')
    const graphRenderer = vi.fn(renderSsrApplication)
    definition.renderApplication = graphRenderer
    const scope = createSsrRequestScope(0)

    try {
      const response = await handleSsrRequest(
        normalizedHtmlRequest('/'),
        handlerRuntime(scope, definition)
      )

      expect(response?.statusCode).toBe(200)
      expect(graphRenderer).toHaveBeenCalledOnce()
    } finally {
      scope.dispose()
    }
  })

  it('returns a real middleware redirect and preserves multiple Set-Cookie values', async () => {
    let protectedSetups = 0
    const definition = compiledDefinition(undefined, undefined, 'ssr')
    const auth = defineMiddleware(({ cookies, to }) => {
      cookies.set('attempted', to.fullPath, { sameSite: 'lax' })
      cookies.set('flash', 'login-required', { httpOnly: true })
      return { path: '/login', query: { redirect: to.fullPath } }
    })
    definition.applications[0]!.application = {
      id: 'app',
      root: defineComponent({ setup: () => () => h(RouterView) }),
      routes: [
        {
          path: '/private',
          component: defineComponent({
            setup() {
              protectedSetups += 1
              return () => h('main', 'private')
            },
          }),
          meta: { middleware: [auth] },
        },
        { path: '/login', component: Root },
      ],
    }
    const scope = createSsrRequestScope(0)
    try {
      const response = await handleSsrRequest(
        normalizedHtmlRequest('/private'),
        handlerRuntime(scope, definition)
      )
      expect(response).toMatchObject({
        statusCode: 302,
        headers: {
          location: 'https://example.test/login?redirect=/private',
          'cache-control': 'no-store',
        },
      })
      expect(response?.headers?.['set-cookie']).toEqual([
        'attempted=%2Fprivate; Path=/; SameSite=Lax',
        'flash=login-required; Path=/; HttpOnly',
      ])
      expect(response?.body).toBeUndefined()
      expect(protectedSetups).toBe(0)
    } finally {
      scope.dispose()
    }
  })

  it('returns 421 when no application owns the request host', async () => {
    const scope = createSsrRequestScope(0)
    const request = Object.freeze({
      ...normalizedRequest('/'),
      headers: Object.freeze({
        host: 'unknown.test',
        accept: 'application/json',
      }),
    })
    try {
      const response = await handleSsrRequest(
        request,
        handlerRuntime(scope, compiledDefinition())
      )

      expect(response?.statusCode).toBe(421)
      expect(JSON.parse(String(response?.body))).toMatchObject({
        status: 'error',
        message: 'No application serves this host.',
      })
    } finally {
      scope.dispose()
    }
  })

  it('renders the canonical 421 document for an unmatched HTML host and keeps HEAD bodyless', async () => {
    const scope = createSsrRequestScope(0)
    const request = Object.freeze({
      ...normalizedHtmlRequest('/'),
      headers: Object.freeze({
        host: 'unknown.test',
        accept: 'text/html',
      }),
    })
    try {
      const response = await handleSsrRequest(
        request,
        { ...handlerRuntime(scope, compiledDefinition()), production: true }
      )
      expect(response?.statusCode).toBe(421)
      expect(response?.headers?.['content-type']).toBe('text/html; charset=utf-8')
      expect(String(response?.body)).toContain('421 · Misdirected Request')
      expect(String(response?.body)).toContain('Host not available')
      expect(String(response?.body)).toContain('This host is not available.')
      expect(String(response?.body)).not.toContain('No application serves this host.')
      expect(String(response?.body)).not.toContain('request-handler-test')
      expect(String(response?.body)).not.toContain('Error ID:')

      const head = await handleSsrRequest(
        Object.freeze({ ...request, method: 'HEAD' }),
        { ...handlerRuntime(scope, compiledDefinition()), production: true }
      )
      expect(head?.statusCode).toBe(421)
      expect(head?.body).toBeUndefined()
    } finally {
      scope.dispose()
    }
  })

  it('uses the canonical 400 document only for invalid-host HTML navigation', async () => {
    const scope = createSsrRequestScope(0)
    const invalidHtml = Object.freeze({
      ...normalizedHtmlRequest('/'),
      headers: Object.freeze({ host: 'bad host', accept: 'text/html' }),
    })
    const invalidJson = Object.freeze({
      ...normalizedRequest('/'),
      headers: Object.freeze({ host: 'bad host', accept: 'application/json' }),
    })
    try {
      const html = await handleSsrRequest(
        invalidHtml,
        { ...handlerRuntime(scope, compiledDefinition()), production: true }
      )
      expect(html?.statusCode).toBe(400)
      expect(html?.headers?.['content-type']).toBe('text/html; charset=utf-8')
      expect(String(html?.body)).toContain('400 · Bad Request')
      expect(String(html?.body)).toContain('Invalid request')
      expect(String(html?.body)).toContain('The request could not be processed.')
      expect(String(html?.body)).not.toContain('Host header')
      expect(String(html?.body)).not.toContain('Error ID:')

      const json = await handleSsrRequest(
        invalidJson,
        { ...handlerRuntime(scope, compiledDefinition()), production: true }
      )
      expect(json?.headers?.['content-type']).toBe('application/json; charset=utf-8')
      expect(JSON.parse(String(json?.body))).toEqual({
        status: 'error',
        message: 'Invalid Host header.',
      })

      const head = await handleSsrRequest(
        Object.freeze({ ...invalidHtml, method: 'HEAD' }),
        { ...handlerRuntime(scope, compiledDefinition()), production: true }
      )
      expect(head?.statusCode).toBe(400)
      expect(head?.body).toBeUndefined()
    } finally {
      scope.dispose()
    }
  })

  it('uses the canonical 400 document for a malformed HTML request path', async () => {
    const scope = createSsrRequestScope(0)
    try {
      const response = await handleSsrRequest(
        normalizedHtmlRequest('/products/%invalid'),
        { ...handlerRuntime(scope, compiledDefinition()), production: true }
      )
      expect(response?.statusCode).toBe(400)
      expect(response?.headers?.['content-type']).toBe('text/html; charset=utf-8')
      expect(String(response?.body)).toContain('400 · Bad Request')
      expect(String(response?.body)).toContain('Invalid request')
      expect(String(response?.body)).toContain('The request could not be processed.')
      expect(String(response?.body)).not.toContain('Malformed percent encoding')
      expect(String(response?.body)).not.toContain('Error ID:')

      const api = await handleSsrRequest(
        normalizedRequest('/products/%invalid'),
        { ...handlerRuntime(scope, compiledDefinition()), production: true }
      )
      expect(api?.statusCode).toBe(400)
      expect(api?.body).toBeUndefined()
    } finally {
      scope.dispose()
    }
  })

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
          resolveProductionAssetResponse: async () => new Response('asset'),
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

  it('maps queue-capacity exhaustion to canonical HTML without inventing an error id', async () => {
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
        {
          ...handlerRuntime(scope, compiledDefinition(undefined, undefined, 'ssr'), admission),
          production: true,
        }
      )

      expect(response?.statusCode).toBe(503)
      expect(response?.headers).toMatchObject({
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      expect(String(response?.body)).toContain('503 · Service Unavailable')
      expect(String(response?.body)).toContain('Service unavailable')
      expect(String(response?.body)).toContain(
        'The service is temporarily unavailable. Please try again later.'
      )
      expect(String(response?.body)).not.toContain('SSR admission capacity is exhausted')
      expect(String(response?.body)).not.toContain('request-handler-test')
      expect(String(response?.body)).not.toContain('Error ID:')

      const head = await handleSsrRequest(
        Object.freeze({ ...normalizedHtmlRequest('/overloaded'), method: 'HEAD' }),
        {
          ...handlerRuntime(scope, compiledDefinition(undefined, undefined, 'ssr'), admission),
          production: true,
        }
      )
      expect(head?.statusCode).toBe(503)
      expect(head?.body).toBeUndefined()
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

  it('renders a development HTML error document with message, stack, path and error id', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const definition = compiledDefinition({
      id: 'boom',
      match: (request) => request.pathname === '/boom',
      handle: () => {
        throw new TypeError('Cannot read properties of undefined (reading "x")')
      },
    })
    const scope = createSsrRequestScope(0)
    try {
      const response = await handleSsrRequest(
        normalizedHtmlRequest('/boom'),
        handlerRuntime(scope, definition)
      )
      expect(response?.statusCode).toBe(500)
      const html = String(response?.body)
      expect(html).toContain('background:#000')
      expect(html).toContain('Application error')
      expect(html).toContain('<p class="pill">TypeError</p>')
      expect(html).toContain('Cannot read properties of undefined (reading &quot;x&quot;)')
      expect(html).not.toContain('Path: /boom')
      expect(html).not.toContain('class="source"')
      expect(html).toContain('<details>')
      expect(html).not.toContain('<details open')
      expect(html).not.toContain('<div class="meta">')
      expect(html).toContain('Request: /boom')
      expect(html).toMatch(/Error ID: vssl_[a-f0-9]{16}/)
      expect(html.indexOf('<summary>Show details</summary>'))
        .toBeLessThan(html.indexOf('Request: /boom'))
      expect(html.indexOf('Request: /boom'))
        .toBeLessThan(html.search(/Error ID: vssl_[a-f0-9]{16}/))
      expect(html).toContain('TypeError: Cannot read properties of undefined')
    } finally {
      scope.dispose()
    }
  })

  it('renders Vite compiler metadata on the development error page', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const definition = compiledDefinition({
      id: 'hero',
      match: (request) => request.pathname === '/',
      handle: () => {
        throw Object.assign(
          new SyntaxError('Single file component can contain only one <template> element'),
          {
            plugin: 'vite:vue',
            pluginCode: '<script>alert(1)</script>',
            id: '/project/src/modules/Public/components/HomeHero.vue?vue&type=template',
            loc: { file: '/project/src/modules/Public/components/HomeHero.vue', line: 10, column: 1 },
            frame: '  8 | <template>\n  9 | <script>alert(1)</script>',
            stack: 'SyntaxError: Single file component can contain only one <template> element\n    at compile',
          }
        )
      },
    })
    definition.server.root = '/project'
    const scope = createSsrRequestScope(0)
    try {
      const response = await handleSsrRequest(
        normalizedHtmlRequest('/'),
        { ...handlerRuntime(scope, definition), root: '/project' }
      )
      const html = String(response?.body)
      expect(html).toContain('Application error')
      expect(html).toContain('vite:vue · SyntaxError')
      expect(html).not.toContain('[plugin:vite:vue]')
      expect(html).toContain('Single file component can contain only one &lt;template&gt; element')
      expect(html).toContain('src/modules/Public/components/HomeHero.vue:10:1')
      expect(html).toContain('href="/__open-in-editor?file=src%2Fmodules%2FPublic%2Fcomponents%2FHomeHero.vue%3A10%3A1"')
      expect(html).toContain('data-ssr-open-source')
      expect(html).not.toContain('vscode:')
      expect(html).not.toContain('Source:')
      expect(html).not.toContain('Location:')
      expect(html).not.toContain('Open in VS Code')
      expect(html).toContain('<details>')
      expect(html).not.toContain('<details open')
      expect(html).not.toContain('<div class="meta">')
      expect(html).toContain('Request: /')
      expect(html).toMatch(/Error ID: vssl_[a-f0-9]{16}/)
      expect(html.indexOf('<summary>Show details</summary>'))
        .toBeLessThan(html.indexOf('Request: /'))
      expect(html.indexOf('Request: /'))
        .toBeLessThan(html.search(/Error ID: vssl_[a-f0-9]{16}/))
      expect(html).toContain('  8 | &lt;template&gt;')
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
      expect(html).toContain('at compile')
      expect(html).not.toContain('Path: /')
      expect(html).not.toContain('<script>alert(1)</script>')
    } finally {
      scope.dispose()
    }
  })

  it('does not expose Vite compiler metadata on production error pages', async () => {
    const logger = { error: vi.fn() }
    const definition = compiledDefinition({
      id: 'hero',
      match: (request) => request.pathname === '/',
      handle: () => {
        throw Object.assign(
          new SyntaxError('Single file component can contain only one <template> element'),
          {
            plugin: 'vite:vue',
            id: '/project/src/HomeHero.vue',
            loc: { file: '/project/src/HomeHero.vue', line: 10, column: 1 },
            frame: '  8 | <template>\n  9 | <template>',
            stack: 'SyntaxError: Single file component can contain only one <template> element',
          }
        )
      },
    })
    Object.assign(definition.server, { logger })
    const scope = createSsrRequestScope(0)
    try {
      const response = await handleSsrRequest(
        normalizedHtmlRequest('/'),
        { ...handlerRuntime(scope, definition), production: true }
      )
      const html = String(response?.body)
      expect(html).toContain('500 · Internal Server Error')
      expect(html).toContain('Something went wrong')
      expect(html).toContain('The request could not be completed.')
      expect(html).toMatch(/Error ID: vssl_[a-f0-9]{16}/)
      expect(html).not.toContain('vite:vue')
      expect(html).not.toContain('SyntaxError')
      expect(html).not.toContain('HomeHero.vue')
      expect(html).not.toContain('vscode:')
      expect(html).not.toContain('__open-in-editor')
      expect(html).not.toContain('data-ssr-open-source')
      expect(html).not.toContain('<template>')
      expect(html).not.toContain('plugin')
      expect(html).not.toContain('Show details')
      expect(html).not.toContain('Source:')
      expect(html).not.toContain('Location:')
      expect(html).not.toContain('Request:')
      expect(html).not.toContain('Path:')
      const details = logger.error.mock.calls.find(([event]) => event === 'ssr.request.failed')?.[1] as
        | Record<string, unknown>
        | undefined
      expect(details).toMatchObject({
        errorType: 'SyntaxError',
        message: 'Single file component can contain only one <template> element',
      })
      expect(details).not.toHaveProperty('plugin')
      expect(details).not.toHaveProperty('source')
      expect(details).not.toHaveProperty('frame')
      expect(details).not.toHaveProperty('location')
    } finally {
      scope.dispose()
    }
  })

  it('still renders a development page when Vite-like getters are hostile', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const error = new TypeError('Cannot read properties of undefined (reading "x")')
    for (const key of ['plugin', 'id', 'loc', 'frame']) {
      Object.defineProperty(error, key, { get() { throw new Error(`hostile ${key}`) } })
    }
    const definition = compiledDefinition({
      id: 'hostile',
      match: (request) => request.pathname === '/hostile',
      handle: () => { throw error },
    })
    const scope = createSsrRequestScope(0)
    try {
      const response = await handleSsrRequest(
        normalizedHtmlRequest('/hostile'),
        handlerRuntime(scope, definition)
      )
      const html = String(response?.body)
      expect(response?.statusCode).toBe(500)
      expect(html).toContain('Application error')
      expect(html).toContain('TypeError')
      expect(html).toContain('Request: /hostile')
      expect(html).toMatch(/Error ID: vssl_[a-f0-9]{16}/)
      expect(html.indexOf('<summary>Show details</summary>'))
        .toBeLessThan(html.indexOf('Request: /hostile'))
      expect(html.indexOf('Request: /hostile'))
        .toBeLessThan(html.search(/Error ID: vssl_[a-f0-9]{16}/))
    } finally {
      scope.dispose()
    }
  })

  it('escapes hostile development error text and represents string throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const definition = compiledDefinition({
      id: 'inject',
      match: (request) => request.pathname === '/inject',
      handle: () => {
        throw new Error('<script>alert(1)</script>')
      },
    })
    const stringDefinition = compiledDefinition({
      id: 'string',
      match: (request) => request.pathname === '/string',
      handle: () => {
        throw 'plain string failure'
      },
    })
    const scope = createSsrRequestScope(0)
    try {
      const injected = await handleSsrRequest(
        normalizedHtmlRequest('/inject'),
        handlerRuntime(scope, definition)
      )
      expect(String(injected?.body)).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
      expect(String(injected?.body)).not.toContain('<script>alert(1)</script>')
      const thrown = await handleSsrRequest(
        normalizedHtmlRequest('/string'),
        handlerRuntime(scope, stringDefinition)
      )
      expect(String(thrown?.body)).toContain('plain string failure')
      expect(String(thrown?.body)).not.toContain('[object Object]')
    } finally {
      scope.dispose()
    }
  })

  it('keeps production HTML generic while logging the original error id', async () => {
    const logger = { error: vi.fn() }
    const definition = compiledDefinition({
      id: 'boom',
      match: (request) => request.pathname === '/boom',
      handle: () => {
        throw new TypeError('Cannot read properties of undefined (reading "x")')
      },
    })
    Object.assign(definition.server, { logger })
    const scope = createSsrRequestScope(0)
    try {
      const response = await handleSsrRequest(
        normalizedHtmlRequest('/boom'),
        { ...handlerRuntime(scope, definition), production: true }
      )
      const html = String(response?.body)
      expect(html).toContain('500 · Internal Server Error')
      expect(html).toContain('Something went wrong')
      expect(html).toContain('The request could not be completed.')
      expect(html).not.toContain('Cannot read properties')
      expect(logger.error).toHaveBeenCalledWith('ssr.request.failed', expect.objectContaining({
        errorType: 'TypeError',
        message: 'Cannot read properties of undefined (reading "x")',
        errorId: expect.stringMatching(/^vssl_[a-f0-9]{16}$/),
      }))
      const details = logger.error.mock.calls[0]![1] as Record<string, unknown>
      expect(html).toContain(`Error ID: ${details.errorId}`)
    } finally {
      scope.dispose()
    }
  })

  it('preserves the structured non-HTML production error response', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const definition = compiledDefinition({
      id: 'api-failure',
      match: (request) => request.pathname === '/api-failure',
      handle: () => {
        throw new Error('private API failure')
      },
    })
    const scope = createSsrRequestScope(0)
    try {
      const response = await handleSsrRequest(
        normalizedRequest('/api-failure'),
        { ...handlerRuntime(scope, definition), production: true }
      )
      expect(response?.statusCode).toBe(500)
      expect(response?.headers?.['content-type']).toBe('application/json; charset=utf-8')
      expect(JSON.parse(String(response?.body))).toEqual({
        status: 'error',
        service: 'request-handler-test',
        errorId: expect.stringMatching(/^vssl_[a-f0-9]{16}$/),
      })
      expect(String(response?.body)).not.toContain('private API failure')
      expect(String(response?.body)).not.toContain('<html')
    } finally {
      scope.dispose()
    }
  })

  it('uses one generic 503 presentation for an internal SEO service failure', async () => {
    const logger = { error: vi.fn() }
    const definition = compiledDefinition({
      id: 'sitemap',
      match: (request) => request.pathname === '/sitemap.xml',
      handle: () => {
        throw new Error('Private sitemap provider token expired')
      },
    })
    Object.assign(definition.server, { logger })
    const scope = createSsrRequestScope(0)
    try {
      const response = await handleSsrRequest(
        normalizedHtmlRequest('/sitemap.xml'),
        { ...handlerRuntime(scope, definition), production: true }
      )
      const html = String(response?.body)
      expect(response?.statusCode).toBe(503)
      expect(html).toContain('503 · Service Unavailable')
      expect(html).toContain('Service unavailable')
      expect(html).toContain(
        'The service is temporarily unavailable. Please try again later.'
      )
      expect(html).not.toContain('sitemap provider')
      expect(html).not.toContain('token expired')
      const details = logger.error.mock.calls.find(
        ([event]) => event === 'ssr.request.failed'
      )![1] as Record<string, unknown>
      expect(details.message).toBe('Private sitemap provider token expired')
      expect(html).toContain(`Error ID: ${details.errorId}`)
    } finally {
      scope.dispose()
    }
  })

  it('passes the original error and error id to renderError', async () => {
    const thrown = new Error('original failure')
    const renderError = vi.fn(() => ({ statusCode: 418, body: 'custom' }))
    const definition = compiledDefinition({
      id: 'boom',
      match: (request) => request.pathname === '/boom',
      handle: () => {
        throw thrown
      },
    })
    Object.assign(definition.server, { renderError })
    const scope = createSsrRequestScope(0)
    try {
      const response = await handleSsrRequest(
        normalizedHtmlRequest('/boom'),
        handlerRuntime(scope, definition)
      )
      expect(response?.statusCode).toBe(418)
      expect(response?.body).toBe('custom')
      expect(renderError).toHaveBeenCalledWith(expect.objectContaining({
        error: thrown,
        errorId: expect.stringMatching(/^vssl_[a-f0-9]{16}$/),
        kind: 'internal',
        production: false,
      }))
    } finally {
      scope.dispose()
    }
  })

  it('omits an HTML error body for HEAD', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const definition = compiledDefinition({
      id: 'boom',
      match: (request) => request.pathname === '/boom',
      handle: () => {
        throw new Error('hidden from head')
      },
    })
    const scope = createSsrRequestScope(0)
    try {
      const production = await handleSsrRequest(
        Object.freeze({ ...normalizedHtmlRequest('/boom'), method: 'HEAD' }),
        { ...handlerRuntime(scope, definition), production: true }
      )
      expect(production?.statusCode).toBe(500)
      expect(production?.body).toBeUndefined()
      expect(production?.headers).toMatchObject({ 'cache-control': 'no-store' })
      const development = await handleSsrRequest(
        Object.freeze({ ...normalizedHtmlRequest('/boom'), method: 'HEAD' }),
        handlerRuntime(scope, definition)
      )
      expect(development?.statusCode).toBe(500)
      expect(development?.body).toBeUndefined()
      expect(development?.headers).toMatchObject({
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
      })
    } finally {
      scope.dispose()
    }
  })

  it('keeps a production timeout HEAD response bodyless', async () => {
    vi.useFakeTimers()
    const definition = compiledDefinition({
      id: 'timeout',
      match: (request) => request.pathname === '/timeout',
      handle: () => new Promise<SsrHttpResponse>(() => undefined),
    })
    const scope = createSsrRequestScope(20)
    try {
      const pending = handleSsrRequest(
        Object.freeze({ ...normalizedHtmlRequest('/timeout'), method: 'HEAD' }),
        { ...handlerRuntime(scope, definition), production: true }
      )
      await vi.advanceTimersByTimeAsync(20)
      const response = await pending
      expect(response?.statusCode).toBe(504)
      expect(response?.headers?.['content-type']).toBe('text/html; charset=utf-8')
      expect(response?.body).toBeUndefined()
    } finally {
      scope.dispose()
      vi.useRealTimers()
    }
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { SsrCompiledConfig } from '../SsrConfigCompileRuntime'
import type { SsrEndpointDefinition } from '../SsrRuntimeTypes'
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

const compiledDefinition = (
  endpoint?: SsrEndpointDefinition<any>,
  publicConfigFactory?: SsrCompiledConfig['applications'][number]['publicConfigFactory']
): SsrCompiledConfig => ({
  name: 'request-handler-test',
  development: true,
  resolveSiteUrl: (request) => `${request.protocol}://${request.host}`,
  server: {
    root: '/virtual/request-handler-test',
    host: '127.0.0.1',
    role: 'unified',
    trustProxy: false,
    clientOutDir: 'dist/client',
    requestTimeoutMs: 15_000,
    shutdownTimeoutMs: 10_000,
    healthPath: '/healthz',
    readinessPath: '/readyz',
    maxResolutionPasses: 4,
    resolutionDeadlineMs: 15_000,
    diagnostics: false,
  },
  applications: [
    {
      id: 'app',
      kind: 'spa',
      template: 'index.html',
      templateMissing: false,
      hosts: ['example.test'],
      mountSelector: '#app',
      endpoints: endpoint ? [endpoint] : [],
      cookieAllowlist: [],
      cookieDenylist: [],
      publicConfig: {},
      publicConfigFactory,
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
  definition: SsrCompiledConfig
): SsrRequestHandlerRuntime => ({
  production: false,
  scope,
  loadDefinition: async () => definition,
  fallbackDefinition: () => definition,
  shuttingDown: () => false,
  assertReady: async () => undefined,
  viteBase: '/',
  loadTemplate: async () => '<html><body><div id="app"></div></body></html>',
  loadPreparedSsrTemplate: async () =>
    '<html><body><div id="app"><!--vue-ssr-lite:html--></div></body></html>',
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
})

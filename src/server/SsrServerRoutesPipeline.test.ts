import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { compileSsrConfig, type SsrCompiledConfig } from '../SsrConfigCompileRuntime'
import { defineApplication, defineServer, defineServerMiddleware, defineServerRoutes } from '../index'
import { withSsrShells } from '../SsrTestFixtures'
import { createSsrMemoryResponseCache } from './SsrResponseCacheRuntime'
import { createSsrAdmissionController } from './SsrAdmissionRuntime'
import { createSsrRequestScope, handleSsrRequest, type SsrNormalizedRequest, type SsrRequestHandlerRuntime, type SsrRequestScope } from './SsrRequestHandler'
import { ssrHttpResponseToWebResponse } from './SsrWebHttpRuntime'

const scopes: SsrRequestScope[] = []
afterEach(() => { scopes.splice(0).forEach((scope) => scope.dispose()) })
const input = (url: string, overrides: Partial<SsrNormalizedRequest> = {}): SsrNormalizedRequest => ({
  requestId: 'pipeline-test', startedAt: Date.now(), method: 'GET', url,
  protocol: 'http', headers: { host: 'example.test', accept: 'application/json' }, ...overrides,
})
const runtimeFor = (definition: SsrCompiledConfig, overrides: Partial<SsrRequestHandlerRuntime> = {}): SsrRequestHandlerRuntime => {
  const scope = createSsrRequestScope(0)
  scopes.push(scope)
  return {
    production: false, scope, loadDefinition: async () => definition,
    fallbackDefinition: () => definition, shuttingDown: () => false, assertReady: async () => {},
    ssrAdmission: createSsrAdmissionController({ maxConcurrent: 1, maxQueued: 0 }),
    viteBase: '/', loadTemplate: async () => '<html><body><div id="app"></div></body></html>',
    loadPreparedSsrTemplate: async () => '<html><head><!--vue-ssr-lite:head--></head><body><!--vue-ssr-lite:teleports--><div id="app"><!--vue-ssr-lite:html--></div><!--vue-ssr-lite:state--></body></html>',
    resolveDevelopmentAssets: async () => [], isPrivateProductionAssetPath: () => false,
    resolveProductionAssetResponse: async () => null, ...overrides,
  }
}
const respond = async (request: SsrNormalizedRequest, runtime: SsrRequestHandlerRuntime) => {
  const response = await handleSsrRequest(request, runtime)
  if (!response) throw new Error('Expected an application response')
  return response instanceof Response ? response : ssrHttpResponseToWebResponse(response)
}
const compile = (extra: Record<string, unknown> = {}) => compileSsrConfig({ render: 'spa', host: 'example.test', ...extra }, { development: true })

describe('authoritative application HTTP pipeline', () => {
  it.each(['TRACE', 'TRACK', 'CONNECT'])('keeps method-blind ownership and bypasses native middleware for %s', async (method) => {
    const middleware = vi.fn((_request, _context, next) => next())
    const legacy = { id: 'legacy', match: vi.fn(() => false), handle: vi.fn(() => null) }
    const prepare = vi.fn(() => ({}))
    const definition = await compile({ publicConfig: prepare, endpoints: [legacy],
      serverMiddleware: [middleware], serverRoutes: [{ routes: {
        '/api/static': { POST: () => new Response() },
        '/api/:id': { GET: () => new Response() },
      } }],
    })
    const openBody = vi.fn(() => new ReadableStream<Uint8Array>())
    const matched = await respond(input('/api/static', { method, openBody }), runtimeFor(definition))
    expect(matched.status).toBe(405)
    expect(matched.headers.get('allow')).toBe('POST, OPTIONS')
    expect(prepare).not.toHaveBeenCalled()
    expect(legacy.match).not.toHaveBeenCalled()
    expect((await respond(input('/unmatched', { method, openBody }), runtimeFor(definition))).status).toBe(404)
    expect(legacy.match).toHaveBeenCalledOnce()
    expect(middleware).not.toHaveBeenCalled()
    expect(openBody).not.toHaveBeenCalled()
  })

  it.each([false, true])('preserves legacy informational responses with global middleware=%s', async (withMiddleware) => {
    for (const statusCode of [100, 101, 103, 199]) {
      const legacy = { statusCode, headers: { 'x-legacy': ['one', 'two'] } }
      const decorated = vi.fn()
      const finalized = vi.fn()
      const definition = await compile({ endpoints: [{ id: 'informational', match: () => true, handle: () => legacy }],
        serverMiddleware: withMiddleware ? [defineServerMiddleware(async (_request, _context, next) => {
          try { const response = await next(); decorated(); return response } finally { finalized() }
        })] : [],
      })
      const response = await handleSsrRequest(input('/legacy'), runtimeFor(definition))
      expect(response).toBe(legacy)
      expect(decorated).not.toHaveBeenCalled()
      expect(finalized).toHaveBeenCalledTimes(withMiddleware ? 1 : 0)
    }
  })

  it.each([99, 200, 599, 600])('reconciles the legacy validator and transport boundary for status %s', async (statusCode) => {
    for (const withMiddleware of [false, true]) {
      const definition = await compile({ endpoints: [{ id: 'boundary', match: () => true, handle: () => ({ statusCode }) }],
        serverMiddleware: withMiddleware ? [defineServerMiddleware((_request, _context, next) => next())] : [],
      })
      const result = await respond(input('/legacy'), runtimeFor(definition))
      expect(result.status).toBe(statusCode < 100 || statusCode > 599 ? 500 : statusCode)
    }
  })

  it('keeps legacy strings and repeated headers on the original transport without global middleware', async () => {
    const legacy = { statusCode: 200, body: 'endpoint', headers: { 'x-values': ['one', 'two'], 'set-cookie': ['a=1', 'b=2'] } }
    const definition = await compile({ endpoints: [{ id: 'legacy', match: () => true, handle: () => legacy }] })
    expect(await handleSsrRequest(input('/legacy'), runtimeFor(definition))).toBe(legacy)
    expect(legacy.headers).not.toHaveProperty('content-type')
  })

  it('runs global → group → path → method → handler before any application state or admission', async () => {
    const events: string[] = []
    const contexts: object[] = []
    const requestObjects: Request[] = []
    const middleware = (name: string) => defineServerMiddleware(async (req, ctx, next) => {
      contexts.push(ctx); requestObjects.push(req)
      if (name === 'global') expect(Object.keys(ctx)).toEqual(['requestId'])
      events.push(`${name}:before`)
      const response = await next()
      events.push(`${name}:after`)
      return response
    })
    const publicConfig = vi.fn(() => { throw new Error('API must not prepare application state') })
    const legacy = { id: 'opaque', match: vi.fn(() => true), handle: vi.fn(() => null) }
    const definition = await compile({
      publicConfig, endpoints: [legacy],
      serverMiddleware: [middleware('global')],
      serverRoutes: [{ prefix: '/api', middleware: [middleware('group')], routes: {
        '/:id': { middleware: [middleware('path')], GET: { middleware: [middleware('method')], handler(req: Request, ctx: any) {
          events.push('handler'); contexts.push(ctx); requestObjects.push(req)
          expect(ctx.params).toEqual({ id: '42' })
          for (const field of ['domain', 'cookie', 'publicConfig', 'siteSeo']) expect(ctx).not.toHaveProperty(field)
          expect(() => { ctx.requestId = 'changed' }).toThrow()
          expect(() => { ctx.params = {} }).toThrow()
          expect(() => { ctx.params.id = 'changed' }).toThrow()
          return Response.json({ id: ctx.params.id })
        } } },
      } }],
    })
    const runtime = runtimeFor(definition)
    const acquire = vi.spyOn(runtime.ssrAdmission, 'acquire')
    const result = await respond(input('/api/42'), runtime)
    expect(result.status).toBe(200)
    expect(new Set(contexts).size).toBe(1)
    expect(new Set(requestObjects).size).toBe(1)
    expect(events).toEqual(['global:before', 'group:before', 'path:before', 'method:before', 'handler', 'method:after', 'path:after', 'group:after', 'global:after'])
    expect(publicConfig).not.toHaveBeenCalled()
    expect(legacy.match).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
  })

  it.each(['POST', 'OPTIONS'])('wraps automatic %s while skipping route middleware and all fallbacks', async (method) => {
    const statuses: number[] = []
    const routeMiddleware = vi.fn((_r, _c, next: () => Promise<Response>) => next())
    const legacy = { id: 'opaque', match: vi.fn(() => true), handle: () => ({ statusCode: 200 }) }
    const prepare = vi.fn(() => ({}))
    const definition = await compile({
      endpoints: [legacy], publicConfig: prepare,
      serverMiddleware: [defineServerMiddleware(async (_req, _ctx, next) => {
        const response = await next(); statuses.push(response.status); response.headers.set('x-global', 'yes'); return response
      })],
      serverRoutes: [{ middleware: [routeMiddleware], routes: { '/api': { GET: () => new Response('api') } } }],
    })
    const runtime = runtimeFor(definition, { production: true })
    const assets = vi.spyOn(runtime, 'resolveProductionAssetResponse')
    const response = await respond(input('/api', { method }), runtime)
    expect(response.status).toBe(method === 'OPTIONS' ? 204 : 405)
    expect(response.body).toBeNull()
    expect(response.headers.get('x-global')).toBe('yes')
    expect(statuses).toEqual([response.status])
    expect(routeMiddleware).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(legacy.match).not.toHaveBeenCalled()
    expect(assets).not.toHaveBeenCalled()
  })

  it.each(['legacy', 'asset', 'non-html', 'spa', 'ssr', 'cache'])('wraps the %s fallback in global middleware', async (kind) => {
    const Root = defineComponent({ setup: () => () => h('main', 'Vue rendered') })
    const cleanup = vi.fn()
    const prepare = vi.fn(() => ({ publicValue: true }))
    const middleware = vi.fn(async (_req, _ctx, next: () => Promise<Response>) => {
      const response = await next(); response.headers.set('x-global', 'wrapped'); return response
    })
    const definition = await compileSsrConfig(withSsrShells({
      render: kind === 'ssr' || kind === 'cache' ? 'ssr' : 'spa',
      seo: { enabled: false }, publicConfig: prepare, cleanup,
      serverMiddleware: [defineServerMiddleware(middleware)],
      endpoints: kind === 'legacy' ? [{ id: 'old', match: () => true, handle: () => ({ statusCode: 201, body: 'legacy' }) }] : [],
      responseCache: kind === 'cache' ? { ttlMs: 1_000, store: { get: () => ({ statusCode: 200, body: 'cached' }), set: vi.fn(), invalidate: vi.fn() } } : undefined,
    }, { app: { root: Root } }), { development: true })
    const runtime = runtimeFor(definition, {
      production: kind === 'asset',
      resolveProductionAssetResponse: async () => kind === 'asset' ? new Response('asset bytes', { headers: { etag: 'asset' } }) : null,
    })
    const acquire = vi.spyOn(runtime.ssrAdmission, 'acquire')
    const html = ['spa', 'ssr', 'cache'].includes(kind)
    const response = await respond(input(html ? '/page?sort=asc' : '/resource', { headers: { host: 'example.test', accept: html ? 'text/html' : 'application/json' } }), runtime)
    expect(response.headers.get('x-global')).toBe('wrapped')
    expect(response.status).toBe(kind === 'legacy' ? 201 : kind === 'non-html' ? 404 : 200)
    expect(middleware).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledOnce()
    if (kind === 'ssr') {
      expect(await response.text()).toContain('Vue rendered')
      expect(acquire).toHaveBeenCalledOnce()
      expect(cleanup).toHaveBeenCalledOnce()
    } else expect(acquire).not.toHaveBeenCalled()
    if (kind === 'cache') {
      expect(await response.text()).toBe('cached')
      expect(response.headers.get('server-timing')).toBe('cache;desc="hit"')
    }
  })

  it('keeps response-cache entries independent of middleware changes on each request', async () => {
    const store = createSsrMemoryResponseCache()
    const write = vi.spyOn(store, 'set')
    const render = vi.fn(() => () => h('main', 'cached Vue page'))
    const Root = defineComponent({ setup: render })
    const definition = await compileSsrConfig(withSsrShells({
      render: 'ssr', seo: { enabled: false }, cacheControl: 'public, max-age=60',
      responseCache: { store, ttlMs: 60_000 },
      serverMiddleware: [defineServerMiddleware(async (_request, context, next) => {
        const response = await next()
        response.headers.set('x-request', context.requestId)
        return response
      })],
    }, { app: { root: Root } }), { development: true })
    for (const requestId of ['first', 'second']) {
      const response = await respond(input('/page', { requestId, headers: { host: 'example.test', accept: 'text/html' } }), runtimeFor(definition))
      expect(response.headers.get('x-request')).toBe(requestId)
      expect(await response.text()).toContain('cached Vue page')
    }
    expect(render).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0][1].headers).not.toHaveProperty('x-request')
  })

  it.each([
    ['health', '/healthz', 200], ['readiness', '/readyz', 200],
    ['private', '/.vite/manifest.json', 404], ['invalid-host', '/api', 400],
    ['unknown-host', '/api', 421], ['vite', '/@vite/client', 0],
  ])('never opens the application body or runs middleware on %s exits', async (kind, path, status) => {
    const middleware = vi.fn((_r, _c, next: () => Promise<Response>) => next())
    const openBody = vi.fn(() => new ReadableStream<Uint8Array>())
    const prepare = vi.fn(() => ({}))
    const definition = await compile({ publicConfig: prepare, serverMiddleware: [defineServerMiddleware(middleware)] })
    const runtime = runtimeFor(definition, {
      production: kind === 'private', isPrivateProductionAssetPath: (value) => value.startsWith('/.vite'),
      serveViteRequest: async () => kind === 'vite',
    })
    const host = kind === 'invalid-host' ? 'bad host' : kind === 'unknown-host' ? 'unknown.test' : 'example.test'
    const result = await handleSsrRequest(input(path, { method: 'POST', openBody, headers: { host } }), runtime)
    if (status) expect(result instanceof Response ? result.status : result?.statusCode).toBe(status)
    else expect(result).toBeUndefined()
    expect(openBody).not.toHaveBeenCalled()
    expect(middleware).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
  })

  it.each(['json', 'text'])('opens a POST body once and exposes native request.%s()', async (format) => {
    const body = format === 'json' ? '{"value":42}' : 'plain body'
    const openBody = vi.fn(() => new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(body)); controller.close()
    } }))
    const definition = await compile({ serverRoutes: [{ routes: { '/api': { async POST(request: Request) {
      const value = format === 'json' ? await request.json() : await request.text()
      expect(request.bodyUsed).toBe(true)
      await expect(request.text()).rejects.toThrow()
      return Response.json({ value })
    } } } }] })
    const response = await respond(input('/api', { method: 'POST', openBody }), runtimeFor(definition))
    expect(await response.json()).toEqual({ value: format === 'json' ? { value: 42 } : body })
    expect(openBody).toHaveBeenCalledOnce()
  })

  it('constructs trusted absolute URLs and uses the canonical cancellation signal', async () => {
    let seen: Request | undefined
    const definition = await compile({ server: { trustProxy: true }, serverRoutes: [{ routes: { '/api': { GET(request: Request) {
      seen = request; return new Response(request.url)
    } } } }] })
    const runtime = runtimeFor(definition)
    const response = await respond(input('/api?q=yes', { headers: { host: 'internal.test', 'x-forwarded-host': 'example.test', 'x-forwarded-proto': 'https' } }), runtime)
    expect(await response.text()).toBe('https://example.test/api?q=yes')
    expect(seen?.signal.aborted).toBe(false)
    const reason = new Error('disconnect')
    runtime.scope.cancel(reason)
    expect(seen?.signal.aborted).toBe(true)
    expect(seen?.signal.reason).toBe(reason)
  })

  it('keeps a network-path request target on the selected trusted host', async () => {
    let url = ''
    const definition = await compile({ serverMiddleware: [defineServerMiddleware((request) => { url = request.url; return new Response('ok') })] })
    await respond(input('//other.test/path'), runtimeFor(definition))
    expect(new URL(url).host).toBe('example.test')
  })

  it.each(['endpoint', 'asset', '404', 'spa'])('continues legacy null responses into %s', async (target) => {
    const first = vi.fn(() => null)
    const second = vi.fn(() => target === 'endpoint' ? { statusCode: 202, body: 'second' } : null)
    const definition = await compile({ endpoints: [
      { id: 'first', match: () => true, handle: first },
      { id: 'second', match: () => true, handle: second },
    ] })
    const runtime = runtimeFor(definition, { production: true, resolveProductionAssetResponse: async () => target === 'asset' ? new Response('asset') : null })
    const response = await respond(input('/resource', { headers: { host: 'example.test', accept: target === 'spa' ? 'text/html' : 'application/json' } }), runtime)
    expect(response.status).toBe(target === 'endpoint' ? 202 : target === '404' ? 404 : 200)
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it('preserves query-aware Vue route classification', async () => {
    const definition = await compile()
    const classify = vi.fn(() => 'spa' as const)
    definition.applications[0].resolveRouteRender = classify
    await respond(input('/page?mode=preview&sort=asc', { headers: { host: 'example.test', accept: 'text/html' } }), runtimeFor(definition))
    expect(classify).toHaveBeenCalledWith('/page?mode=preview&sort=asc')
  })

  it.each([undefined, null, {}, 'not a Response'])('turns invalid handler and middleware returns into HTTP 500 (%s)', async (value) => {
    for (const global of [false, true]) {
      const definition = await compile({
        serverMiddleware: global ? [() => value] : [],
        serverRoutes: [{ routes: { '/robots.txt': { GET: () => value } } }],
      })
      expect((await respond(input('/robots.txt'), runtimeFor(definition))).status).toBe(500)
    }
  })

  it('reports middleware failures after a legacy SEO response as HTTP 500', async () => {
    const definition = await compile({
      endpoints: [{ id: 'robots', ownedPaths: ['/robots.txt'], match: () => true, handle: () => ({ statusCode: 200, body: 'robots' }) }],
      serverMiddleware: [defineServerMiddleware(async (_req, _ctx, next) => {
        await next()
        throw new Error('HTTP middleware failed during unwind')
      })],
    })
    expect((await respond(input('/robots.txt'), runtimeFor(definition))).status).toBe(500)
  })

  it('returns immediate 400 for malformed params before route middleware or fallback preparation', async () => {
    const routeMiddleware = vi.fn((_r, _c, next: () => Promise<Response>) => next())
    const prepare = vi.fn(() => ({}))
    const definition = await compile({ publicConfig: prepare, serverRoutes: [{ middleware: [routeMiddleware], routes: { '/api/:id': { GET: () => new Response('never') } } }] })
    expect((await respond(input('/api/%E0%A4%A'), runtimeFor(definition))).status).toBe(400)
    expect(routeMiddleware).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
  })

  it('serves HTTP routes while Vue admission is full', async () => {
    const definition = await compile({ serverRoutes: [defineServerRoutes({ routes: { '/api': { GET: () => new Response('api') } } })] })
    const runtime = runtimeFor(definition)
    const lease = await runtime.ssrAdmission.acquire({ signal: runtime.scope.signal, requestId: 'busy', entryId: 'app' })
    try {
      const acquire = vi.spyOn(runtime.ssrAdmission, 'acquire')
      expect(await (await respond(input('/api'), runtime)).text()).toBe('api')
      expect(acquire).not.toHaveBeenCalled()
    } finally { lease.release() }
  })
})

describe('application-local compilation and SEO coexistence', () => {
  it('combines exact SEO ownership with legacy paths without evaluating predicates', async () => {
    const match = vi.fn(() => false)
    const definition = await compile({ seo: { siteUrl: 'https://example.test' },
      endpoints: [{ id: 'legacy-sitemap', ownedPaths: ['/sitemap.xml'], match, handle: () => null }],
      serverRoutes: [defineServerRoutes({ routes: { '/robots.txt': { POST: () => new Response('owned') } } })],
    })
    expect(definition.applications[0].endpoints.map((endpoint) => endpoint.id)).toEqual(['legacy-sitemap'])
    expect(match).not.toHaveBeenCalled()
    expect((await respond(input('/robots.txt'), runtimeFor(definition))).status).toBe(405)
    expect(match).not.toHaveBeenCalled()
  })

  it('suppresses both built-in SEO resources for static server routes', async () => {
    const definition = await compile({ seo: {}, serverRoutes: [{ routes: {
      '/robots.txt': { GET: () => new Response('robots') },
      '/sitemap.xml': { GET: () => new Response('sitemap') },
    } }] })
    expect(definition.applications[0].endpoints).toEqual([])
  })

  it('isolates identical route paths and mutable contexts across concurrent hosts', async () => {
    const seen = new Set<object>()
    const app = (name: string) => defineApplication({ name, host: `${name}.test`, render: 'spa', serverRoutes: [defineServerRoutes({
      routes: { '/api/:id': { async GET(request, context) {
        seen.add(context)
        await Promise.resolve()
        return Response.json({ app: name, id: context.params.id, requestId: context.requestId, host: new URL(request.url).host })
      } } },
    })] })
    const definition = await compileSsrConfig(defineServer({ applications: [app('shop'), app('admin')] }))
    const results = await Promise.all(['shop', 'admin', 'shop'].map(async (name, index) => {
      const response = await respond(input(`/api/${index}`, { requestId: String(index), headers: { host: `${name}.test` } }), runtimeFor(definition))
      return response.json()
    }))
    expect(results).toEqual([
      { app: 'shop', id: '0', requestId: '0', host: 'shop.test' },
      { app: 'admin', id: '1', requestId: '1', host: 'admin.test' },
      { app: 'shop', id: '2', requestId: '2', host: 'shop.test' },
    ])
    expect(seen.size).toBe(3)
  })

  it('enforces single/multi route ownership and global middleware placement for untyped configs', async () => {
    await expect(compileSsrConfig({ applications: [{ name: 'shop', render: 'spa' }], serverRoutes: [] })).rejects.toThrow('single-application field `serverRoutes`')
    await expect(compileSsrConfig({ applications: [{ name: 'shop', render: 'spa', serverMiddleware: [] }] })).rejects.toThrow('serverMiddleware belongs on defineServer()')
  })
})

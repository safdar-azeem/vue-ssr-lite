import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { RouterView } from 'vue-router'
import { defineApplication, defineServer, defineServerMiddleware, redirectTo, useFetch } from '../index'
import { withSsrShells } from '../SsrTestFixtures'
import { useSsrRequestContext } from '../SsrRequestContext'
import { useSeo } from '../extensions/seo/useSeo'
import { createSsrProductionRequestHandler } from './SsrProductionRequestRuntime'
import { createVercelHandler, readVercelRuntimeConfig } from '../deployment/vercel/VercelRuntime'
import { normalizeDeploymentRequest } from '../deployment/DeploymentRequest'
import { SsrRequestCancelledError } from './SsrRequestHandler'
import type { ServerRoutesDefinition } from '../server-routes/SsrServerRouteTypes'

vi.mock('node:http', async (original) => ({
  ...await original<typeof import('node:http')>(),
  createServer: () => { throw new Error('Serverless requests must never create a listener') },
}))

let root = ''
beforeEach(async () => {
  vi.stubEnv('PUBLIC_URL', '')
  vi.stubEnv('NODE_ENV', 'production')
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  root = await mkdtemp(join(tmpdir(), 'ssr-production-request-'))
  await mkdir(join(root, 'dist/client/.vite'), { recursive: true })
  await writeFile(join(root, 'dist/client/index.html'), '<!doctype html><html><head></head><body><div id="app"></div></body></html>')
  await writeFile(join(root, 'dist/client/.vite/manifest.json'), '{}')
  await writeFile(join(root, 'dist/client/.vite/ssr-manifest.json'), '{}')
  await writeFile(join(root, 'dist/client/.vite/vue-ssr-lite-assets.json'), '{"version":1,"immutable":[]}')
  await writeFile(join(root, 'dist/client/favicon.ico'), 'icon')
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

const normalized = (path: string, host = 'a.test', cookie = 'session=A', protocol: 'http' | 'https' = 'https') =>
  normalizeDeploymentRequest({ method: 'GET', url: path, host, protocol, headers: { cookie, accept: 'text/html' } })

const withRequestId = (path: string, requestId: string) =>
  Object.freeze({ ...normalized(path), requestId })

const definition = (options: {
  allowHttpOrigin?: boolean
  fetch?: boolean
  serverRoutes?: ServerRoutesDefinition[]
  timeout?: number
  logger?: { error?: (...args: unknown[]) => void }
  renderError?: (...args: any[]) => any
} = {}) => {
  const Page = defineComponent({
    setup() {
      const context = useSsrRequestContext<Record<string, never>, { marker: string }>()
      const marker = `${context.publicConfig.marker}:${context.domain.hostname}`
      useSeo({ title: marker, meta: [{ name: 'request-marker', content: marker }] })
      const fetched = options.fetch ? useFetch<{ marker: string }>('/upstream', { variables: { marker } }) : undefined
      return () => h('main', `${marker}:${context.request.cookie}:${fetched?.data.value?.marker ?? 'rendered'}`)
    },
  })
  const ErrorPage = defineComponent({ setup() { throw new Error('private-token /private/source.ts') } })
  const TypeErrorPage = defineComponent({
    setup() { throw new TypeError("Cannot read properties of undefined (reading 'items')") },
  })
  const StringErrorPage = defineComponent({ setup() { throw 'plain string failure' } })
  const BoomPage = defineComponent({ setup() { throw 'boom' } })
  const sharedUnavailable = new Error('Database unavailable')
  const SharedErrorPage = defineComponent({ setup() { throw sharedUnavailable } })
  const SpaPage = defineComponent({ setup() { throw new Error('SPA component must not execute on the server') } })
  const RedirectPage = defineComponent({
    setup() {
      redirectTo('/about', { status: 302 })
      return () => null
    },
  })
  const Shell = defineComponent({ setup: () => () => h(RouterView) })
  const apps = ['a', 'b'].map((id) => defineApplication({
    name: id, render: 'ssr', template: 'index.html',
    domain: { production: `${id}.test`, ...(id === 'a' ? { additionalHosts: ['localhost', 'customer.test'] } : {}) },
    cookies: { allow: ['session'] },
    publicConfig: (request) => ({ marker: String(request.headers.cookie || '').split('=')[1] || 'none' }),
    seo: { allowHttpOrigin: options.allowHttpOrigin },
    routes: [
      { path: '/', component: Page }, { path: '/about', component: Page },
      { path: '/dashboard', component: SpaPage, meta: { render: 'spa' } },
      { path: '/error', component: ErrorPage },
      { path: '/type-error', component: TypeErrorPage },
      { path: '/string-error', component: StringErrorPage },
      { path: '/boom', component: BoomPage },
      { path: '/shared-error', component: SharedErrorPage },
      { path: '/redirect', component: RedirectPage },
      { path: '/router-redirect', redirect: '/about' },
    ],
    serverRoutes: options.serverRoutes ?? [{ prefix: '/api', routes: {
      '/echo': { POST: async (request: Request) => new Response(await request.arrayBuffer(), {
        status: 201, headers: [['set-cookie', 'one=1'], ['set-cookie', 'two=2']],
      }) },
    } }],
    endpoints: [{ id: 'legacy', match: (request) => request.pathname === '/legacy', handle: () => ({ statusCode: 202, body: 'legacy' }) }],
  }))
  return withSsrShells(defineServer({
    server: {
      requestTimeoutMs: options.timeout ?? 15000,
      trustProxy: true,
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.renderError ? { renderError: options.renderError } : {}),
    },
    serverMiddleware: [defineServerMiddleware(async (request, _context, next) => {
      const path = new URL(request.url).pathname
      if (path === '/middleware-redirect') return new Response(null, { status: 307, headers: { location: '/about' } })
      if (path === '/middleware-error') throw new Error('Authorization: private-token')
      return next()
    })],
    applications: apps,
  }), { a: { root: Shell }, b: { root: Shell } })
}

const FIXTURE_PACKAGE = 'fixture-runtime-package'
const FIXTURE_EXPORT = 'missingExport'

const lastOperatorDiagnostic = () => {
  const call = vi.mocked(console.error).mock.calls.at(-1)
  expect(String(call?.[0])).toMatch(/^\[vue-ssr-lite\] /)
  return call![1] as Record<string, unknown>
}

describe('shared production executor', () => {
  it.each([
    {
      expectedPhase: 'runtime-load',
      expectedReason: 'runtime-load-failed',
      loadRuntime: async () => { throw new SyntaxError('private load detail /private/runtime.js') },
    },
    {
      expectedPhase: 'runtime-compile',
      expectedReason: undefined,
      loadRuntime: async () => () => { throw new SyntaxError('private compile detail /private/server.ts') },
    },
  ])('classifies $expectedPhase failures without exposing raw exception details', async ({
    expectedPhase,
    expectedReason,
    loadRuntime,
  }) => {
    const execute = createSsrProductionRequestHandler({ root, loadRuntime })
    const response = await execute(normalized('/'), new AbortController().signal)

    expect(response.status).toBe(500)
    const html = await response.text()
    expect(html).toContain('Application unavailable')
    expect(html).not.toMatch(/private (?:load|compile)|runtime\.js|server\.ts/)
    const diagnostic = lastOperatorDiagnostic()
    expect(diagnostic).toMatchObject({ phase: expectedPhase, errorType: 'SyntaxError' })
    expect(diagnostic.reason).toBe(expectedReason)
    expect(diagnostic.errorId).toMatch(/^vssl_[a-f0-9]{16}$/)
    expect(html).toContain(`Error ID: ${diagnostic.errorId}`)
    expect(String(diagnostic.message)).toMatch(/private (?:load|compile)/)
  })

  it.each([
    {
      reason: 'missing-named-export',
      errorType: 'SyntaxError',
      loadRuntime: async () => {
        throw Object.assign(
          new SyntaxError(`The requested module '${FIXTURE_PACKAGE}' does not provide an export named '${FIXTURE_EXPORT}'`),
          {
            stack: `SyntaxError: The requested module '${FIXTURE_PACKAGE}' does not provide an export named '${FIXTURE_EXPORT}'\n    at ModuleJob._instantiate (node:internal/modules/esm/module_job.js:123:9)`,
          }
        )
      },
      expected: { package: FIXTURE_PACKAGE, export: FIXTURE_EXPORT },
    },
    {
      reason: 'missing-runtime-dependency',
      errorType: 'Error',
      loadRuntime: async () => {
        throw Object.assign(
          new Error(`Cannot find package '${FIXTURE_PACKAGE}' imported from /private/build/user/project/SsrRuntime.js`),
          {
            code: 'ERR_MODULE_NOT_FOUND',
            stack: `Error: Cannot find package '${FIXTURE_PACKAGE}' imported from /private/build/user/project/SsrRuntime.js\n    at packageResolve (node:internal/modules/esm/resolve:123:9)`,
          }
        )
      },
      expected: { package: FIXTURE_PACKAGE },
    },
    {
      reason: 'invalid-runtime-export',
      errorType: 'SsrRuntimeLoadError',
      loadRuntime: async () => ({ [Symbol.toStringTag]: 'Module' }),
      expected: {},
    },
    {
      reason: 'invalid-module-export',
      errorType: 'Error',
      loadRuntime: async () => {
        throw Object.assign(
          new Error('Package subpath \'./secret\' is not defined by "exports" in /private/build/node_modules/pkg/package.json'),
          { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }
        )
      },
      expected: {},
    },
    {
      reason: 'module-format-incompatibility',
      errorType: 'Error',
      loadRuntime: async () => {
        throw Object.assign(
          new Error('require() of ES Module /private/build/file.js from /private/build/other.js not supported.'),
          { code: 'ERR_REQUIRE_ESM' }
        )
      },
      expected: {},
    },
    {
      reason: 'module-syntax-error',
      errorType: 'SyntaxError',
      loadRuntime: async () => { throw new SyntaxError("Unexpected token '{'") },
      expected: {},
    },
  ])('distinguishes $reason at runtime-load while returning generic HTML', async ({
    reason,
    errorType,
    loadRuntime,
    expected,
  }) => {
    const execute = createSsrProductionRequestHandler({ root, loadRuntime })
    const response = await execute(normalized('/'), new AbortController().signal)
    const html = await response.text()
    expect(response.status).toBe(500)
    expect(html).toContain('Application unavailable')
    expect(html).not.toContain(FIXTURE_PACKAGE)
    expect(html).not.toContain(FIXTURE_EXPORT)
    expect(html).not.toMatch(/SsrRuntime|private\/build|invalid-runtime-export/)
    const diagnostic = lastOperatorDiagnostic()
    expect(String(vi.mocked(console.error).mock.calls.at(-1)![0])).toBe('[vue-ssr-lite] ssr.runtime.failed')
    expect(diagnostic).toMatchObject({
      phase: 'runtime-load',
      errorType,
      reason,
      ...expected,
    })
    expect(diagnostic.errorId).toMatch(/^vssl_[a-f0-9]{16}$/)
    expect(html).toContain(`Error ID: ${diagnostic.errorId}`)
    if (reason === 'missing-named-export' || reason === 'missing-runtime-dependency') {
      expect(String(diagnostic.message)).toMatch(/does not provide an export named|Cannot find package/)
    }
  })

  it('classifies production template preparation failures without exposing template details', async () => {
    await writeFile(
      join(root, 'dist/client/index.html'),
      '<!doctype html><html><head></head><body>private-template-content</body></html>'
    )
    const execute = createSsrProductionRequestHandler({ root, loadRuntime: async () => definition() })
    const response = await execute(normalized('/'), new AbortController().signal)

    expect(response.status).toBe(500)
    const html = await response.text()
    expect(html).toContain('Application unavailable')
    expect(html).not.toMatch(/private-template-content|dist\/client|index\.html/)
    const diagnostic = lastOperatorDiagnostic()
    expect(diagnostic).toMatchObject({ phase: 'template-preflight', errorType: 'Error' })
    expect(diagnostic.errorId).toMatch(/^vssl_[a-f0-9]{16}$/)
    expect(html).toContain(`Error ID: ${diagnostic.errorId}`)
    expect(JSON.stringify(diagnostic)).not.toMatch(/private-template-content/)
    expect(JSON.stringify(diagnostic)).not.toContain(root)
  })

  it.each([
    { file: 'manifest.json', contents: '{secret', artifact: 'client-manifest', reason: 'invalid-json' },
    { file: 'vue-ssr-lite-assets.json', contents: '{"version":999}', artifact: 'asset-cache-metadata', reason: 'invalid-schema' },
    { file: 'ssr-manifest.json', contents: '{secret', artifact: 'ssr-manifest', reason: 'invalid-json' },
    { file: 'ssr-manifest.json', contents: null, artifact: 'ssr-manifest', reason: 'missing' },
  ])('distinguishes $artifact/$reason at startup while returning generic HTML', async ({ file, contents, artifact, reason }) => {
    const path = join(root, 'dist/client/.vite', file)
    if (contents === null) await rm(path)
    else await writeFile(path, contents)
    const execute = createSsrProductionRequestHandler({ root, loadRuntime: async () => definition() })
    const response = await execute(normalized('/'), new AbortController().signal)
    expect(response.status).toBe(500)
    const html = await response.text()
    expect(html).toContain('Application unavailable')
    expect(html).not.toMatch(/manifest|secret|invalid-json|invalid-schema|SsrProductionArtifactError/)
    const diagnostic = lastOperatorDiagnostic()
    expect(diagnostic).toMatchObject({
      phase: 'artifact-preflight', artifact, reason, code: `${artifact}.${reason}`,
    })
    expect(diagnostic.errorId).toMatch(/^vssl_[a-f0-9]{16}$/)
    expect(html).toContain(`Error ID: ${diagnostic.errorId}`)
    expect(JSON.stringify(diagnostic)).not.toContain(root)
  })

  it('reuses cold/warm infrastructure while SSR, SPA, routes, SEO, errors and host selection remain Core-owned', async () => {
    const loadRuntime = vi.fn(async () => definition())
    const execute = createSsrProductionRequestHandler({ root, loadRuntime })
    const get = (path: string, host?: string) => execute(normalized(path, host), new AbortController().signal)
    for (const path of ['/', '/about']) {
      const response = await get(path)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('<main>A:a.test:session=A:rendered</main>')
    }
    const spa = await get('/dashboard')
    expect(spa.status).toBe(200)
    expect(await spa.text()).toContain('vue-ssr-lite-domain')
    const legacy = await get('/legacy')
    expect(legacy.status).toBe(202)
    expect(await legacy.text()).toBe('legacy')
    const missing = await get('/unknown')
    expect(missing.status).toBe(404)
    await missing.text()
    for (const [path, status] of [['/redirect', 302], ['/middleware-redirect', 307]] as const) {
      const response = await get(path)
      expect(response.status).toBe(status)
      expect(response.headers.get('location')).toMatch(/\/about$/)
      await response.text()
    }
    // Vue Router route-record redirects navigate internally; HTTP redirects
    // are explicitly owned by redirectTo() or server middleware above.
    const routerRedirect = await get('/router-redirect')
    expect(routerRedirect.status).toBe(200)
    expect(routerRedirect.headers.get('location')).toBeNull()
    expect(await routerRedirect.text()).toContain('<main>A:a.test:session=A:rendered</main>')
    for (const path of ['/error', '/middleware-error']) {
      const response = await get(path)
      expect(response.status).toBe(500)
      const html = await response.text()
      expect(html).toContain('Application unavailable')
      expect(html).not.toContain('private-token')
      expect(html).not.toContain('source.ts')
      expect(html).not.toContain('/private/source.ts')
      expect(html).not.toContain('ErrorPage')
      expect(html).not.toContain('Authorization:')
    }
    const unknownHost = await get('/', 'unknown.test')
    expect(unknownHost.status).toBe(421)
    await unknownHost.text()
    for (const path of ['/.vite/manifest.json', '/.%76ite/manifest.json', '/.vue-ssr-lite/a.html']) {
      const response = await get(path)
      expect(response.status).toBe(404)
      await response.text()
    }
    const icon = await get('/favicon.ico')
    expect(await icon.text()).toBe('icon')
    for (const path of ['/robots.txt', '/sitemap.xml', '/healthz', '/readyz']) {
      const response = await get(path)
      expect(response.status).toBe(200)
      await response.text()
    }
    expect(loadRuntime).toHaveBeenCalledOnce()
  })

  it('isolates cookies, hosts, public config, useFetch hydration and SEO across concurrent requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      await Promise.resolve()
      return Response.json({ marker: new URL(request.url).searchParams.get('marker') })
    }))
    const loadRuntime = vi.fn(async () => definition({ fetch: true }))
    const execute = createSsrProductionRequestHandler({ root, loadRuntime })
    const [a, b] = await Promise.all([
      execute(normalized('/', 'customer.test', 'session=alpha'), new AbortController().signal).then((response) => response.text()),
      execute(normalized('/', 'b.test', 'session=beta'), new AbortController().signal).then((response) => response.text()),
    ])
    expect(a).toContain('alpha:customer.test')
    expect(a).toContain('session=alpha')
    expect(a).not.toContain('beta')
    expect(b).toContain('beta:b.test')
    expect(b).toContain('session=beta')
    expect(b).not.toContain('alpha')
    expect(a).toContain('<title data-vue-ssr-lite-head="title">alpha:customer.test</title>')
    expect(b).toContain('<title data-vue-ssr-lite-head="title">beta:b.test</title>')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(loadRuntime).toHaveBeenCalledOnce()
  })

  it('never grants provider requests a local exception from Host or forwarded headers', async () => {
    const secure = createSsrProductionRequestHandler({ root, loadRuntime: async () => definition() })
    for (const host of ['a.test', 'localhost']) {
      for (const path of ['/', '/favicon.ico']) {
        const request = normalized(path, host, '', 'http')
        expect(request.trustedLocalConnection).not.toBe(true)
        const rejected = await secure(request, new AbortController().signal)
        expect(rejected.status).toBe(500)
        await rejected.text()
      }
    }
    const https = await secure(normalized('/'), new AbortController().signal)
    expect(https.status).toBe(200)
    await https.text()
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain('Production HTTP origin rejected')
  })

  it('retains explicit allowHttpOrigin for intentional public and local provider HTTP', async () => {
    const execute = createSsrProductionRequestHandler({ root, loadRuntime: async () => definition({ allowHttpOrigin: true }) })
    for (const host of ['a.test', 'localhost']) {
      const response = await execute(normalized('/', host, '', 'http'), new AbortController().signal)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('<main>')
    }
  })

  it('delivers Core timeouts as 504 and permits later warm requests', async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    let release!: (response: Response) => void
    const blocked = new Promise<Response>((resolve) => { release = resolve })
    const execute = createSsrProductionRequestHandler({ root, loadRuntime: async () => definition({
      timeout: 20, serverRoutes: [{ routes: { '/hang': { GET: () => { entered(); return blocked } } } }],
    }) })
    vi.useFakeTimers()
    const pending = execute(normalized('/hang'), new AbortController().signal)
    await started
    await vi.advanceTimersByTimeAsync(20)
    const response = await pending
    expect(response.status).toBe(504)
    expect(await response.text()).toContain('Request timed out')
    release(new Response('late response'))
    const warm = await execute(normalized('/dashboard'), new AbortController().signal)
    expect(warm.status).toBe(200)
    await warm.text()
  })

  it('keeps the response signal alive until streaming finishes and observes cancellation', async () => {
    let requestSignal: AbortSignal | undefined
    const cancel = vi.fn()
    const execute = createSsrProductionRequestHandler({ root, loadRuntime: async () => definition({
      serverRoutes: [{ routes: { '/stream': { GET: (request: Request) => {
        requestSignal = request.signal
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])) }, cancel }))
      } } } }],
    }) })
    const response = await execute(normalized('/stream'), new AbortController().signal)
    expect(requestSignal?.aborted).toBe(false)
    const reader = response.body!.getReader()
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2]))
    await reader.cancel()
    expect(requestSignal?.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
    const aborted = new AbortController()
    aborted.abort()
    await expect(execute(normalized('/'), aborted.signal)).rejects.toBeInstanceOf(SsrRequestCancelledError)
  })

  it('handles HEAD without publishing a body and preserves response headers', async () => {
    const execute = createSsrProductionRequestHandler({ root, loadRuntime: async () => definition() })
    const head = await execute({ ...normalized('/about'), method: 'HEAD' }, new AbortController().signal)
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toContain('text/html')
    expect(await head.text()).toBe('')
    const asset = await execute({ ...normalized('/favicon.ico'), method: 'HEAD' }, new AbortController().signal)
    expect(asset.headers.get('content-length')).toBe('4')
    expect(await asset.text()).toBe('')
  })

  it('preserves physical SEO files using portable build artifacts without a source public directory', async () => {
    await writeFile(join(root, 'dist/client/robots.txt'), 'User-agent: *\nDisallow: /physical-only\n')
    await writeFile(join(root, 'dist/client/sitemap.xml'), '<urlset><url><loc>https://a.test/physical-only</loc></url></urlset>')
    const execute = createSsrProductionRequestHandler({ root, loadRuntime: async () => definition() })
    for (const path of ['/robots.txt', '/sitemap.xml']) {
      const response = await execute(normalized(path), new AbortController().signal)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('physical-only')
    }
  })

  it('cancels a cold waiter without cancelling shared initialization, and retries failed cold starts', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const loadRuntime = vi.fn(async () => { await gate; return definition() })
    const execute = createSsrProductionRequestHandler({ root, loadRuntime })
    const controller = new AbortController()
    const cancelled = execute(normalized('/'), controller.signal)
    const warm = execute(normalized('/dashboard'), new AbortController().signal)
    const rejected = expect(cancelled).rejects.toBeInstanceOf(SsrRequestCancelledError)
    controller.abort()
    await rejected
    release()
    const response = await warm
    expect(response.status).toBe(200)
    await response.text()
    expect(loadRuntime).toHaveBeenCalledOnce()

    const failing = vi.fn().mockRejectedValueOnce(new Error('private cold-start credentials'))
      .mockImplementation(async () => definition())
    const retry = createSsrProductionRequestHandler({ root, loadRuntime: failing })
    const failure = await retry(normalized('/'), new AbortController().signal)
    expect(failure.status).toBe(500)
    expect(await failure.text()).not.toContain('credentials')
    const recovered = await retry(normalized('/dashboard'), new AbortController().signal)
    expect(recovered.status).toBe(200)
    await recovered.text()
    expect(failing).toHaveBeenCalledTimes(2)
  })

  it('correlates an application TypeError through a generic page and private logs', async () => {
    const execute = createSsrProductionRequestHandler({ root, loadRuntime: async () => definition() })
    const response = await execute(normalized('/type-error'), new AbortController().signal)
    const html = await response.text()
    const diagnostic = lastOperatorDiagnostic()
    expect(response.status).toBe(500)
    expect(html).toContain('Application unavailable')
    expect(html).toContain(`Error ID: ${diagnostic.errorId}`)
    expect(html).not.toContain('Cannot read properties')
    expect(html).not.toContain('TypeError')
    expect(html).not.toContain('TypeErrorPage')
    expect(html).not.toContain("reading 'items'")
    expect(html).not.toMatch(/\bat TypeErrorPage\b/)
    expect(String(diagnostic.errorType)).toMatch(/TypeError|Error/)
    expect(String(diagnostic.message)).toContain('Cannot read properties of undefined')
    expect(String(diagnostic.stack ?? '')).toContain('TypeError')
  })

  it('keeps string throws generic in production HTML and useful in operator logs', async () => {
    const execute = createSsrProductionRequestHandler({ root, loadRuntime: async () => definition() })
    const response = await execute(normalized('/string-error'), new AbortController().signal)
    const html = await response.text()
    const diagnostic = lastOperatorDiagnostic()
    expect(html).toContain('Application unavailable')
    expect(html).not.toContain('plain string failure')
    expect(html).toContain(`Error ID: ${diagnostic.errorId}`)
    expect(String(diagnostic.message)).toMatch(/plain string failure|Non-Error value was thrown/)
  })

  it('returns a bodyless HEAD response for initialization and render failures', async () => {
    const failing = createSsrProductionRequestHandler({
      root,
      loadRuntime: async () => { throw new TypeError("Cannot read properties of undefined (reading 'boot')") },
    })
    const initHead = await failing({ ...normalized('/'), method: 'HEAD' }, new AbortController().signal)
    expect(initHead.status).toBe(500)
    expect(initHead.headers.get('cache-control')).toBe('no-store')
    expect(await initHead.text()).toBe('')
    const execute = createSsrProductionRequestHandler({ root, loadRuntime: async () => definition() })
    const renderHead = await execute({ ...normalized('/error'), method: 'HEAD' }, new AbortController().signal)
    expect(renderHead.status).toBe(500)
    expect(await renderHead.text()).toBe('')
  })

  it('gives a custom logger the correlation id and actionable error fields', async () => {
    const logger = { error: vi.fn() }
    const execute = createSsrProductionRequestHandler({
      root,
      loadRuntime: async () => definition({ logger }),
    })
    const response = await execute(normalized('/type-error'), new AbortController().signal)
    const html = await response.text()
    expect(logger.error).toHaveBeenCalledWith('ssr.request.failed', expect.objectContaining({
      message: expect.stringContaining('Cannot read properties of undefined'),
      errorId: expect.stringMatching(/^vssl_[a-f0-9]{16}$/),
    }))
    const details = logger.error.mock.calls.find(([event]) => event === 'ssr.request.failed')![1] as Record<string, unknown>
    expect(html).toContain(`Error ID: ${details.errorId}`)
    expect(details.stack).toEqual(expect.stringContaining('TypeError'))
  })

  it('passes the original error and error id to custom renderError', async () => {
    const renderError = vi.fn(({ error, errorId }) => ({
      statusCode: 503,
      body: `handled:${errorId}`,
    }))
    const execute = createSsrProductionRequestHandler({
      root,
      loadRuntime: async () => definition({ renderError }),
    })
    const response = await execute(normalized('/error'), new AbortController().signal)
    expect(response.status).toBe(503)
    const body = await response.text()
    expect(renderError).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.any(Error),
      errorId: expect.stringMatching(/^vssl_[a-f0-9]{16}$/),
      kind: 'internal',
      production: true,
    }))
    const context = renderError.mock.calls[0]![0]
    expect(String((context.error as Error).message)).toContain('private-token')
    expect(body).toBe(`handled:${context.errorId}`)
    expect(body).not.toContain('private-token')
  })

  it('correlates a reused Error independently on each request', async () => {
    const logger = { error: vi.fn() }
    const execute = createSsrProductionRequestHandler({
      root,
      loadRuntime: async () => definition({ logger }),
    })
    const first = await execute(normalized('/shared-error'), new AbortController().signal)
    const second = await execute(normalized('/shared-error'), new AbortController().signal)
    const firstHtml = await first.text()
    const secondHtml = await second.text()
    const events = logger.error.mock.calls.filter(([event]) => event === 'ssr.request.failed')
    expect(events).toHaveLength(2)
    const firstId = (events[0]![1] as { errorId: string }).errorId
    const secondId = (events[1]![1] as { errorId: string }).errorId
    expect(firstId).toMatch(/^vssl_[a-f0-9]{16}$/)
    expect(secondId).toMatch(/^vssl_[a-f0-9]{16}$/)
    expect(firstId).not.toBe(secondId)
    expect(firstHtml).toContain(`Error ID: ${firstId}`)
    expect(secondHtml).toContain(`Error ID: ${secondId}`)
    expect(firstHtml).not.toContain('Database unavailable')
    expect(secondHtml).not.toContain('Database unavailable')
  })

  it('correlates a reused Error independently when two HTTP requests share x-request-id', async () => {
    const logger = { error: vi.fn() }
    const execute = createSsrProductionRequestHandler({
      root,
      loadRuntime: async () => definition({ logger }),
    })
    const first = await execute(withRequestId('/shared-error', 'upstream-request'), new AbortController().signal)
    const second = await execute(withRequestId('/shared-error', 'upstream-request'), new AbortController().signal)
    const events = logger.error.mock.calls.filter(([event]) => event === 'ssr.request.failed')
    expect(events).toHaveLength(2)
    const firstId = (events[0]![1] as { errorId: string }).errorId
    const secondId = (events[1]![1] as { errorId: string }).errorId
    expect(firstId).not.toBe(secondId)
    expect(await first.text()).toContain(`Error ID: ${firstId}`)
    expect(await second.text()).toContain(`Error ID: ${secondId}`)
  })

  it('correlates a reused Error independently when supplied request ids sanitize to unknown', async () => {
    const logger = { error: vi.fn() }
    const execute = createSsrProductionRequestHandler({
      root,
      loadRuntime: async () => definition({ logger }),
    })
    const first = await execute(withRequestId('/shared-error', '***'), new AbortController().signal)
    const second = await execute(withRequestId('/shared-error', 'not a valid id'), new AbortController().signal)
    const events = logger.error.mock.calls.filter(([event]) => event === 'ssr.request.failed')
    expect(events).toHaveLength(2)
    expect(events[0]![1]).toMatchObject({ requestId: 'unknown' })
    expect(events[1]![1]).toMatchObject({ requestId: 'unknown' })
    const firstId = (events[0]![1] as { errorId: string }).errorId
    const secondId = (events[1]![1] as { errorId: string }).errorId
    expect(firstId).not.toBe(secondId)
    expect(await first.text()).toContain(`Error ID: ${firstId}`)
    expect(await second.text()).toContain(`Error ID: ${secondId}`)
  })

  it('logs a broken renderError independently from a primitive application throw', async () => {
    const logger = { error: vi.fn() }
    const renderError = vi.fn(() => { throw new Error('boom') })
    const execute = createSsrProductionRequestHandler({
      root,
      loadRuntime: async () => definition({ logger, renderError }),
    })
    const response = await execute(normalized('/boom'), new AbortController().signal)
    const html = await response.text()
    const requestFailed = logger.error.mock.calls.filter(([event]) => event === 'ssr.request.failed')
    const rendererFailed = logger.error.mock.calls.filter(([event]) => event === 'ssr.error-renderer.failed')
    expect(requestFailed).toHaveLength(1)
    expect(rendererFailed).toHaveLength(1)
    const requestId = (requestFailed[0]![1] as { errorId: string }).errorId
    const rendererId = (rendererFailed[0]![1] as { errorId: string }).errorId
    expect(requestId).not.toBe(rendererId)
    expect(renderError).toHaveBeenCalledWith(expect.objectContaining({ error: 'boom', errorId: requestId }))
    expect(html).toContain(`Error ID: ${requestId}`)
    expect(html).not.toContain('boom')
  })

  it('logs two independent primitive throws with the same value in one request', async () => {
    const logger = { error: vi.fn() }
    const renderError = vi.fn(() => { throw 'plain string failure' })
    const execute = createSsrProductionRequestHandler({
      root,
      loadRuntime: async () => definition({ logger, renderError }),
    })
    await execute(normalized('/string-error'), new AbortController().signal)
    const requestFailed = logger.error.mock.calls.filter(([event]) => event === 'ssr.request.failed')
    const rendererFailed = logger.error.mock.calls.filter(([event]) => event === 'ssr.error-renderer.failed')
    expect(requestFailed).toHaveLength(1)
    expect(rendererFailed).toHaveLength(1)
    expect((requestFailed[0]![1] as { errorId: string }).errorId)
      .not.toBe((rendererFailed[0]![1] as { errorId: string }).errorId)
    expect(requestFailed[0]![1]).toMatchObject({ message: 'plain string failure' })
    expect(rendererFailed[0]![1]).toMatchObject({ message: 'plain string failure' })
    expect(renderError).toHaveBeenCalledWith(expect.objectContaining({ error: 'plain string failure' }))
  })

  it('keeps an undefined throw generic in production HTML and useful in operator logs', async () => {
    const execute = createSsrProductionRequestHandler({
      root,
      loadRuntime: async () => definition({
        serverRoutes: [{ routes: { '/undefined-error': { GET: () => { throw undefined } } } }],
      }),
    })
    const response = await execute(normalized('/undefined-error'), new AbortController().signal)
    const html = await response.text()
    const diagnostic = lastOperatorDiagnostic()
    expect(html).toContain('Application unavailable')
    expect(html).toContain(`Error ID: ${diagnostic.errorId}`)
    expect(html).not.toContain('undefined')
    expect(diagnostic).toMatchObject({
      errorType: 'Error',
      message: 'undefined',
      errorId: expect.stringMatching(/^vssl_[a-f0-9]{16}$/),
    })
  })

  it('aborts a pending response stream when the client disconnects', async () => {
    const cancel = vi.fn()
    const execute = createSsrProductionRequestHandler({ root, loadRuntime: async () => definition({
      serverRoutes: [{ routes: { '/stream': { GET: () => new Response(new ReadableStream({ cancel })) } } }],
    }) })
    const controller = new AbortController()
    const response = await execute(normalized('/stream'), controller.signal)
    const read = response.body!.getReader().read()
    const rejected = expect(read).rejects.toBeInstanceOf(SsrRequestCancelledError)
    controller.abort()
    await rejected
    expect(cancel).toHaveBeenCalledOnce()
  })
})

const invokeFailingVercelStream = async (failure: unknown) => {
  const logger = { error: vi.fn() }
  const handler = createVercelHandler({
    root,
    loadRuntime: async () => definition({
      logger,
      serverRoutes: [{ routes: { '/fail-stream': { GET: () => new Response(new ReadableStream({
        pull(controller) { controller.error(failure) },
      })) } } }],
    }),
  })
  const incoming = Object.assign(new PassThrough(), {
    method: 'GET', url: '/fail-stream', headers: {
      host: 'a.test', 'x-forwarded-proto': 'https', accept: 'text/html',
    },
  })
  incoming.end()
  const outgoing = Object.assign(new PassThrough(), {
    statusCode: 200,
    setHeader: () => undefined,
  })
  await handler(incoming as unknown as IncomingMessage, outgoing as unknown as ServerResponse)
  const fromLogger = logger.error.mock.calls.filter(([event]) => event === 'ssr.transport.failed')
  const fromConsole = vi.mocked(console.error).mock.calls.filter((call) =>
    String(call[0]).includes('ssr.transport.failed')
  )
  return {
    fromLogger,
    fromConsole,
    transportEvents: fromLogger.length + fromConsole.length,
    diagnostic: (fromLogger[0]?.[1] ?? fromConsole[0]?.[1]) as Record<string, unknown> | undefined,
  }
}

describe('Vercel Node transport', () => {
  it('passes raw bytes and authoritative hosts to Core and preserves status and multiple cookies without a listener', async () => {
    const handler = createVercelHandler({ root, loadRuntime: async () => definition() })
    const incoming = Object.assign(new PassThrough(), {
      method: 'POST', url: '/api/echo?q=1&q=2', headers: {
        host: 'a.test', 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https',
      },
    })
    incoming.end(Buffer.from([0, 255, 1, 128]))
    const headers = new Map<string, unknown>()
    const outgoing = Object.assign(new PassThrough(), {
      statusCode: 200,
      setHeader: (name: string, value: unknown) => { headers.set(name, value) },
    })
    const chunks: Buffer[] = []
    outgoing.on('data', (chunk) => chunks.push(chunk))
    await handler(incoming as unknown as IncomingMessage, outgoing as unknown as ServerResponse)
    expect(outgoing.statusCode).toBe(201)
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 255, 1, 128]))
    expect(headers.get('set-cookie')).toEqual(['one=1', 'two=2'])
  })

  it('logs a streamed transport failure once when Vercel writes the response', async () => {
    const result = await invokeFailingVercelStream(new TypeError('stream exploded'))
    expect(result.transportEvents).toBe(1)
    expect(result.diagnostic).toMatchObject({
      message: expect.stringContaining('stream exploded'),
    })
  })

  it('does not duplicate a non-extensible streamed transport failure', async () => {
    const result = await invokeFailingVercelStream(
      Object.preventExtensions(new TypeError('stream exploded'))
    )
    expect(result.transportEvents).toBe(1)
    expect(result.diagnostic).toMatchObject({
      message: expect.stringContaining('stream exploded'),
    })
  })

  it('does not duplicate a primitive streamed transport failure', async () => {
    const result = await invokeFailingVercelStream('stream exploded')
    expect(result.transportEvents).toBe(1)
    expect(result.diagnostic).toMatchObject({
      message: expect.stringContaining('stream exploded'),
    })
  })

  it('rejects a loaded runtime that does not expose the generated export contract', async () => {
    await expect(readVercelRuntimeConfig({
      [Symbol.toStringTag]: 'Module',
      default: null,
    })).rejects.toMatchObject({ name: 'SsrRuntimeLoadError' })
    await expect(readVercelRuntimeConfig({
      default: async () => null,
    })).rejects.toMatchObject({ name: 'SsrRuntimeLoadError' })
    await expect(readVercelRuntimeConfig({
      default: { applications: [] },
    })).resolves.toEqual({ applications: [] })
  })
})

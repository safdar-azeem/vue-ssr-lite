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

const definition = (options: { allowHttpOrigin?: boolean; fetch?: boolean; serverRoutes?: ServerRoutesDefinition[]; timeout?: number } = {}) => {
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
      { path: '/error', component: ErrorPage }, { path: '/redirect', component: RedirectPage },
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
    server: { requestTimeoutMs: options.timeout ?? 15000, trustProxy: true },
    serverMiddleware: [defineServerMiddleware(async (request, _context, next) => {
      const path = new URL(request.url).pathname
      if (path === '/middleware-redirect') return new Response(null, { status: 307, headers: { location: '/about' } })
      if (path === '/middleware-error') throw new Error('Authorization: private-token')
      return next()
    })],
    applications: apps,
  }), { a: { root: Shell }, b: { root: Shell } })
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
    expect(await response.text()).toContain('Application unavailable')
    const diagnostic = JSON.parse(String(vi.mocked(console.error).mock.calls.at(-1)![0]))
    expect(diagnostic).toMatchObject({ phase: expectedPhase, errorType: 'SyntaxError' })
    expect(diagnostic.reason).toBe(expectedReason)
    expect(JSON.stringify(diagnostic)).not.toMatch(/private (?:load|compile)|runtime\.js|server\.ts/)
  })

  it.each([
    {
      reason: 'missing-named-export',
      errorType: 'SyntaxError',
      loadRuntime: async () => {
        throw Object.assign(
          new SyntaxError("The requested module 'clickout-lite' does not provide an export named 'onClickOutside'"),
          {
            stack: "SyntaxError: The requested module 'clickout-lite' does not provide an export named 'onClickOutside'\n    at ModuleJob._instantiate (node:internal/modules/esm/module_job.js:123:9)",
          }
        )
      },
      expected: { package: 'clickout-lite', export: 'onClickOutside' },
    },
    {
      reason: 'missing-runtime-dependency',
      errorType: 'Error',
      loadRuntime: async () => {
        throw Object.assign(
          new Error("Cannot find package 'clickout-lite' imported from /private/build/user/project/SsrRuntime.js"),
          {
            code: 'ERR_MODULE_NOT_FOUND',
            stack: "Error: Cannot find package 'clickout-lite' imported from /private/build/user/project/SsrRuntime.js\n    at packageResolve (node:internal/modules/esm/resolve:123:9)",
          }
        )
      },
      expected: { package: 'clickout-lite' },
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
    expect(html).not.toMatch(/clickout-lite|onClickOutside|SsrRuntime|private\/build|invalid-runtime-export/)
    const diagnostic = JSON.parse(String(vi.mocked(console.error).mock.calls.at(-1)![0]))
    expect(diagnostic).toMatchObject({
      event: 'ssr.runtime.failed',
      phase: 'runtime-load',
      errorType,
      reason,
      ...expected,
    })
    expect(JSON.stringify(diagnostic)).not.toMatch(/private\/build|SsrRuntime\.js|Cannot find package|Unexpected token/)
  })

  it('classifies production template preparation failures without exposing template details', async () => {
    await writeFile(
      join(root, 'dist/client/index.html'),
      '<!doctype html><html><head></head><body>private-template-content</body></html>'
    )
    const execute = createSsrProductionRequestHandler({ root, loadRuntime: async () => definition() })
    const response = await execute(normalized('/'), new AbortController().signal)

    expect(response.status).toBe(500)
    expect(await response.text()).toContain('Application unavailable')
    const diagnostic = JSON.parse(String(vi.mocked(console.error).mock.calls.at(-1)![0]))
    expect(diagnostic).toMatchObject({ phase: 'template-preflight', errorType: 'Error' })
    expect(JSON.stringify(diagnostic)).not.toMatch(/private-template-content|dist\/client|index\.html/)
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
    const diagnostic = JSON.parse(String(vi.mocked(console.error).mock.calls.at(-1)![0]))
    expect(diagnostic).toMatchObject({
      phase: 'artifact-preflight', artifact, reason, code: `${artifact}.${reason}`,
    })
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
      expect(html).not.toMatch(/private-token|source\.ts|ErrorPage|stack/)
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

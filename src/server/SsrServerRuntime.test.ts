import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as createHttpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import {
  serializeSsrProductionAssetMetadata,
  SSR_PRODUCTION_ASSET_METADATA_PATH,
} from '../SsrAssetMetadata'
import { defineSsrConfig } from '../SsrConfigRuntime'
import { useSsrRequestContext } from '../SsrRequestContext'
import { useSeo } from '../extensions/seo/useSeo'
import { createSsrMemoryResponseCache } from './SsrResponseCacheRuntime'
import {
  createSsrManagedServer,
  writeSsrProductionAsset,
  type SsrManagedServer,
} from './SsrServerRuntime'
import type { SsrResolvedProductionAsset } from './SsrAssetRuntime'

let managed: SsrManagedServer | undefined
let root = ''

afterEach(async () => {
  await managed?.close().catch(() => undefined)
  if (root) await rm(root, { recursive: true, force: true })
  managed = undefined
  root = ''
})
const spaConfig = () =>
  defineSsrConfig({
    name: 'test-runtime',
    runtime: 'unified',
    // Lifecycle tests must not claim the public development port. Binding to
    // zero keeps them isolated from local managed-server processes and other
    // test workers.
    server: { port: 0 },
    applications: {
      spa: {
        render: 'spa',
        application: {
          module: './SpaApp.ts',
          exportName: 'spaApplication',
        },
        template: 'index.html',
        domain: {
          development: 'localhost',
          production: 'localhost',
          mode: 'root',
          localAliases: true,
          customDomains: true,
        },
        publicConfig: {
          api: { endpoint: 'http://localhost/graphql', timeout: 8000 },
        },
      },
    },
  })

const requestRawPathStatus = (port: number, path: string): Promise<number> =>
  new Promise((resolveStatus, rejectStatus) => {
    const request = createHttpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      headers: { accept: 'application/octet-stream' },
    })
    request.once('response', (response) => {
      response.resume()
      response.once('end', () => resolveStatus(response.statusCode || 0))
    })
    request.once('error', rejectStatus)
    request.end()
  })

describe('managed SSR server lifecycle', () => {
  it('does not open body files for HEAD, 304, pre-abort, or a deleted-file race', async () => {
    const asset: SsrResolvedProductionAsset = {
      filePath: '/temporary/asset.js',
      size: 5,
      contentType: 'text/javascript; charset=utf-8',
      cacheControl: 'public, max-age=3600',
      etag: 'W/"5-123"',
      lastModified: new Date(1_000).toUTCString(),
      mtimeMs: 1_000,
    }
    const response = () =>
      ({
        writeHead: vi.fn(),
        end: vi.fn(),
      }) as unknown as import('node:http').ServerResponse
    const openFile = vi.fn()

    const headResponse = response()
    await expect(
      writeSsrProductionAsset(
        { method: 'HEAD', headers: {} } as any,
        headResponse,
        asset,
        new AbortController().signal,
        openFile as any
      )
    ).resolves.toBe(true)
    expect(openFile).not.toHaveBeenCalled()
    expect(headResponse.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'content-length': '5', etag: asset.etag })
    )

    const notModifiedResponse = response()
    await expect(
      writeSsrProductionAsset(
        {
          method: 'GET',
          headers: { 'if-none-match': asset.etag },
        } as any,
        notModifiedResponse,
        asset,
        new AbortController().signal,
        openFile as any
      )
    ).resolves.toBe(true)
    expect(openFile).not.toHaveBeenCalled()
    expect(notModifiedResponse.writeHead).toHaveBeenCalledWith(
      304,
      expect.objectContaining({ etag: asset.etag })
    )

    const aborted = new AbortController()
    aborted.abort(new Error('cancelled before open'))
    await expect(
      writeSsrProductionAsset(
        { method: 'GET', headers: {} } as any,
        response(),
        asset,
        aborted.signal,
        openFile as any
      )
    ).rejects.toThrow('cancelled before open')
    expect(openFile).not.toHaveBeenCalled()

    const deleted = Object.assign(new Error('deleted'), { code: 'ENOENT' })
    openFile.mockRejectedValueOnce(deleted)
    const deletedResponse = response()
    await expect(
      writeSsrProductionAsset(
        { method: 'GET', headers: {} } as any,
        deletedResponse,
        asset,
        new AbortController().signal,
        openFile as any
      )
    ).resolves.toBe(false)
    expect(deletedResponse.writeHead).not.toHaveBeenCalled()
  })

  it('destroys the source and closes its handle when streaming is aborted', async () => {
    const controller = new AbortController()
    let handleClosed = false
    let reads = 0
    const closeHandle = vi.fn(async () => {
      handleClosed = true
    })
    const source = new Readable({
      read() {
        reads += 1
        this.push(Buffer.alloc(1024, reads))
        if (reads === 1) {
          queueMicrotask(() => controller.abort(new Error('stream cancelled')))
        }
      },
      destroy(error, callback) {
        void closeHandle().then(
          () => callback(error),
          (closeError) => callback(closeError as Error)
        )
      },
    })
    const file = {
      stat: vi.fn().mockResolvedValue({
        size: 1024 * 1024,
        mtime: new Date(1_000),
        mtimeMs: 1_000,
        isFile: () => true,
      }),
      createReadStream: vi.fn(() => source),
      close: closeHandle,
    }
    const openFile = vi.fn().mockResolvedValue(file)
    const response = new PassThrough() as PassThrough & {
      writeHead: ReturnType<typeof vi.fn>
      end: ReturnType<typeof vi.fn>
    }
    response.writeHead = vi.fn()
    const originalEnd = response.end.bind(response)
    response.end = vi.fn(originalEnd) as any
    const asset: SsrResolvedProductionAsset = {
      filePath: '/temporary/large.js',
      size: 1024 * 1024,
      contentType: 'text/javascript; charset=utf-8',
      cacheControl: 'public, max-age=3600',
      etag: 'W/"100000-3e8"',
      lastModified: new Date(1_000).toUTCString(),
      mtimeMs: 1_000,
    }

    await expect(
      writeSsrProductionAsset(
        { method: 'GET', headers: {} } as any,
        response as any,
        asset,
        controller.signal,
        openFile as any
      )
    ).rejects.toThrow()

    expect(source.destroyed).toBe(true)
    expect(handleClosed).toBe(true)
    expect(closeHandle).toHaveBeenCalledTimes(1)
    expect(reads).toBeGreaterThan(0)
    expect(response.writeHead).toHaveBeenCalledTimes(1)
    expect(response.end).not.toHaveBeenCalled()
  })

  it('starts, serves health/SPA/404, checks readiness, and shuts down', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html><body><div id="app"></div></body></html>'
    )
    managed = await createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => ({ default: spaConfig() }),
    })
    await managed.listen()
    const { port } = managed.address()
    const health = await fetch(`http://127.0.0.1:${port}/healthz`)
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`)
    const page = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { accept: 'text/html' },
    })
    const missing = await fetch(`http://127.0.0.1:${port}/missing.json`)

    const pageHtml = await page.text()
    expect(health.status).toBe(200)
    expect(ready.status).toBe(200)
    expect(pageHtml).toContain('<div id="app"></div>')
    expect(pageHtml).toContain('vue-ssr-lite-domain')
    expect(missing.status).toBe(404)
  })

  it('serves SSR redirects and request timeouts predictably', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'site.html'),
      '<!doctype html><html><head></head><body><div id="app"></div></body></html>'
    )
    const Root = defineComponent({
      async setup() {
        const context = useSsrRequestContext()
        if (context.url.pathname === '/redirect') {
          context.response.redirect = { location: '/target', statusCode: 307 }
        }
        if (
          context.url.pathname === '/timeout' ||
          context.url.pathname === '/timeout-hanging-renderer'
        ) {
          await new Promise<never>(() => undefined)
        }
        return () => h('main', 'ready')
      },
    })
    let timeoutRenderKind: string | undefined
    managed = await createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => ({
        default: defineSsrConfig({
          name: 'test-runtime',
          runtime: 'unified',
          // The configured deadline includes development runtime reload work;
          // keep enough headroom for the Vite-free config compiler while still
          // exercising the hanging render timeout below.
          server: {
            port: 0,
            requestTimeoutMs: 100,
            renderError: ({ kind, request }) => {
              timeoutRenderKind = kind
              if (request?.pathname === '/timeout') {
                return { statusCode: 418, body: 'timeout handled' }
              }
              return new Promise<never>(() => undefined)
            },
          },
          applications: {
            ssr: {
              render: 'ssr',
              application: { id: 'test-app', root: Root },
              template: 'site.html',
              domain: {
                development: 'localhost',
                production: 'localhost',
                customDomains: true,
              },
              publicConfig: {
                api: { endpoint: 'http://localhost/graphql', timeout: 8000 },
              },
            },
          },
        }),
      }),
    })
    await managed.listen()
    const { port } = managed.address()
    const redirect = await fetch(`http://127.0.0.1:${port}/redirect`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    })
    const timeout = await fetch(`http://127.0.0.1:${port}/timeout`, {
      headers: { accept: 'text/html' },
    })
    const hangingRenderer = await fetch(`http://127.0.0.1:${port}/timeout-hanging-renderer`, {
      headers: { accept: 'text/html' },
    })

    expect(redirect.status).toBe(307)
    expect(redirect.headers.get('location')).toBe(`http://127.0.0.1:${port}/target`)
    expect(timeout.status).toBe(418)
    expect(await timeout.text()).toBe('timeout handled')
    expect(timeoutRenderKind).toBe('timeout')
    expect(hangingRenderer.status).toBe(504)
  })

  it('uses one deadline across request stages and aborts the completed scope', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'site.html'),
      '<!doctype html><html><head></head><body><div id="app"></div></body></html>'
    )
    let successfulSignal: AbortSignal | undefined
    const Root = defineComponent({
      setup() {
        successfulSignal = useSsrRequestContext().request.signal
        return () => h('main', 'ready')
      },
    })
    let slow = true
    let factoryObservedAbort = false
    let activeFactories = 0
    const cacheSet = vi.fn()
    managed = await createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => ({
        default: defineSsrConfig({
          server: { port: 0, requestTimeoutMs: 60 },
          resolveSiteUrl: async () => {
            if (slow) await new Promise((resolveWait) => setTimeout(resolveWait, 40))
            return 'http://localhost'
          },
          applications: {
            deadline: {
              application: { id: 'deadline', root: Root },
              template: 'site.html',
              domain: { development: 'localhost', customDomains: true },
              cacheControl: 'public, max-age=60',
              responseCache: {
                store: {
                  get: () => null,
                  set: cacheSet,
                  invalidate: () => 0,
                },
                ttlMs: 60_000,
              },
              publicConfig: async ({ signal }) => {
                activeFactories += 1
                try {
                  if (slow) {
                    await new Promise<void>((resolveWait) => {
                      const onAbort = () => {
                        factoryObservedAbort = true
                        resolveWait()
                      }
                      if (signal.aborted) onAbort()
                      else
                        signal.addEventListener('abort', onAbort, {
                          once: true,
                        })
                    })
                  }
                  return {}
                } finally {
                  activeFactories -= 1
                }
              },
            },
          },
        }),
      }),
    })
    await managed.listen()
    const { port } = managed.address()
    const timedOut = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { accept: 'text/html' },
    })
    expect(timedOut.status).toBe(504)
    await timedOut.text()
    await new Promise((resolveWait) => setTimeout(resolveWait, 0))
    expect(factoryObservedAbort).toBe(true)
    expect(activeFactories).toBe(0)
    expect(cacheSet).not.toHaveBeenCalled()

    slow = false
    const successful = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { accept: 'text/html' },
    })
    expect(successful.status).toBe(200)
    await successful.text()
    expect(successfulSignal?.aborted).toBe(true)
  })

  it('keeps valid renders available when observability and cleanup throw', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'site.html'),
      '<!doctype html><html><head></head><body><div id="app"></div></body></html>'
    )
    const fail = () => {
      throw new Error('observability failed')
    }
    managed = await createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => ({
        default: defineSsrConfig({
          server: {
            port: 0,
            logger: { debug: fail, info: fail, warn: fail, error: fail },
            onMetrics: fail,
          },
          applications: {
            observability: {
              application: {
                id: 'observability',
                root: defineComponent({
                  setup: () => () => h('main', 'healthy'),
                }),
                cleanup: () => {
                  throw new Error('cleanup failed')
                },
              },
              template: 'site.html',
              domain: { development: 'localhost', customDomains: true },
            },
          },
        }),
      }),
    })
    await managed.listen()
    const { port } = managed.address()
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { accept: 'text/html' },
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<main>healthy</main>')
  })

  it('serves a production SPA without an SSR canonical origin', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await mkdir(join(root, 'dist', 'client'), { recursive: true })
    await writeFile(
      join(root, 'dist', 'client', 'index.html'),
      '<!doctype html><html><body><div id="app"></div></body></html>'
    )
    const previousPublicUrl = process.env.PUBLIC_URL
    delete process.env.PUBLIC_URL
    try {
      managed = await createSsrManagedServer({
        production: true,
        root,
        loadRuntime: async () => ({ default: spaConfig() }),
      })
      await managed.listen()
      const { port } = managed.address()
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { accept: 'text/html' },
      })
      const explicitTemplate = await fetch(`http://127.0.0.1:${port}/index.html`, {
        headers: { accept: 'text/html' },
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('vue-ssr-lite-domain')
      expect(explicitTemplate.status).toBe(200)
      expect(await explicitTemplate.text()).toContain('vue-ssr-lite-domain')
    } finally {
      if (previousPublicUrl === undefined) delete process.env.PUBLIC_URL
      else process.env.PUBLIC_URL = previousPublicUrl
    }
  })

  it('keeps production SSR head, hydration, domain, and public config request-local', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    const clientRoot = join(root, 'dist', 'client')
    await mkdir(join(clientRoot, '.vite'), { recursive: true })
    const templatePath = join(clientRoot, 'index.html')
    await writeFile(
      templatePath,
      '<!doctype html><html><head><meta name="template-version" content="original"></head><body><div id="app"></div></body></html>'
    )
    await writeFile(join(clientRoot, '.vite', 'ssr-manifest.json'), '{}')

    let requestNumber = 0
    const Root = defineComponent({
      setup() {
        const context = useSsrRequestContext<Record<string, never>, { marker: string }>()
        const marker = `${context.publicConfig.marker}:${context.domain.hostname}`
        useSeo({ meta: [{ name: 'request-marker', content: marker }] })
        return () => h('main', marker)
      },
    })
    managed = await createSsrManagedServer({
      production: true,
      root,
      loadRuntime: async () => ({
        default: defineSsrConfig({
          server: { port: 0, trustProxy: true },
          resolveSiteUrl: () => 'https://example.com',
          applications: {
            site: {
              application: { id: 'site', root: Root },
              template: 'index.html',
              domain: { production: 'example.com', customDomains: true },
              publicConfig: () => ({
                marker: requestNumber++ === 0 ? 'A' : 'B',
              }),
            },
          },
        } as any),
      }),
    })
    await managed.listen()
    const origin = `http://127.0.0.1:${managed.address().port}`
    const navigate = (host: string) =>
      fetch(`${origin}/`, {
        headers: {
          accept: 'text/html',
          'x-forwarded-host': host,
          'x-forwarded-proto': 'https',
        },
      }).then((response) => response.text())

    const first = await navigate('a.test')
    await writeFile(
      templatePath,
      '<!doctype html><html><head><meta name="template-version" content="changed"></head><body><div id="app"></div></body></html>'
    )
    const second = await navigate('b.test')

    expect(first).toContain('content="A:a.test"')
    expect(first).toContain('"marker":"A"')
    expect(first).toContain('"hostname":"a.test"')
    expect(first).not.toContain('B:b.test')
    expect(second).toContain('content="B:b.test"')
    expect(second).toContain('"marker":"B"')
    expect(second).toContain('"hostname":"b.test"')
    expect(second).not.toContain('A:a.test')
    expect(second).toContain('content="original"')
    expect(second).not.toContain('content="changed"')
  })

  it('keeps production SPA domain and public config injection request-local', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    const clientRoot = join(root, 'dist', 'client')
    await mkdir(clientRoot, { recursive: true })
    await writeFile(
      join(clientRoot, 'index.html'),
      '<!doctype html><html><body><div id="app"></div></body></html>'
    )
    managed = await createSsrManagedServer({
      production: true,
      root,
      loadRuntime: async () => ({
        default: defineSsrConfig({
          server: { port: 0, trustProxy: true },
          applications: {
            spa: {
              render: 'spa',
              application: { module: './SpaApp.ts' },
              template: 'index.html',
              domain: { production: 'example.com', customDomains: true },
              publicConfig: ({ host, pathname }) => ({ host, pathname }),
            },
          },
        } as any),
      }),
    })
    await managed.listen()
    const origin = `http://127.0.0.1:${managed.address().port}`
    const navigate = (host: string, pathname: string) =>
      fetch(`${origin}${pathname}`, {
        headers: { accept: 'text/html', 'x-forwarded-host': host },
      }).then((response) => response.text())

    const first = await navigate('a.test', '/alpha')
    const second = await navigate('b.test', '/beta')
    expect(first).toContain('"host":"a.test"')
    expect(first).toContain('"pathname":"/alpha"')
    expect(first).toContain('"hostname":"a.test"')
    expect(second).toContain('"host":"b.test"')
    expect(second).toContain('"pathname":"/beta"')
    expect(second).toContain('"hostname":"b.test"')
    expect(second).not.toContain('"host":"a.test"')
  })

  it('passes normalized request facts to isolated multi-app factories once per request', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await Promise.all([
      writeFile(
        join(root, 'alpha.html'),
        '<!doctype html><html><head></head><body><div id="app"></div></body></html>'
      ),
      writeFile(
        join(root, 'beta.html'),
        '<!doctype html><html><head></head><body><div id="app"></div></body></html>'
      ),
    ])
    const received: Record<string, Array<Record<string, unknown>>> = {
      alpha: [],
      beta: [],
    }
    const invocations = { alpha: 0, beta: 0 }
    const Root = defineComponent({
      setup() {
        const context = useSsrRequestContext()
        if (context.resolution.pass === 1) {
          context.resolution.requestAdditionalPass()
        }
        return () => h('pre', JSON.stringify(context.publicConfig))
      },
    })
    const factory =
      (applicationId: 'alpha' | 'beta') =>
      async (request: import('../SsrRuntimeTypes').SsrPublicConfigRequest) => {
        invocations[applicationId] += 1
        expect(Object.isFrozen(request)).toBe(true)
        expect(Object.isFrozen(request.headers)).toBe(true)
        expect(Object.isFrozen(request.domain)).toBe(true)
        expect(Object.isFrozen(request.domain.params)).toBe(true)
        received[applicationId].push({
          requestId: request.requestId,
          url: request.url,
          host: request.host,
          protocol: request.protocol,
          method: request.method,
          headers: request.headers,
          cookie: request.cookie,
          signal: request.signal,
          domain: request.domain,
          pathname: request.pathname,
          search: request.search,
          entryId: request.entryId,
        })
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, applicationId === 'alpha' ? 5 : 1)
        )
        return {
          requestId: request.requestId,
          applicationId,
          host: request.host,
          pathname: request.pathname,
          search: request.search,
          locale: request.headers['accept-language'],
          tenant: request.domain.params.tenant,
          cookie: request.cookie,
          hostile:
            applicationId === 'alpha' ? '</script><script>alert(1)</script>\u2028\u2029' : 'safe',
        }
      }
    managed = await createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => ({
        default: defineSsrConfig({
          server: {
            port: 0,
            trustProxy: true,
            maxResolutionPasses: 2,
          },
          applications: {
            alpha: {
              application: { id: 'alpha', root: Root },
              template: 'alpha.html',
              host: '*.alpha.test',
              domain: {
                development: 'alpha.test',
                params: { tenant: { source: 'last-subdomain-label' } },
              },
              cookies: { allow: ['locale'] },
              publicConfig: factory('alpha'),
            },
            beta: {
              application: { id: 'beta', root: Root },
              template: 'beta.html',
              host: '*.beta.test',
              domain: {
                development: 'beta.test',
                params: { tenant: { source: 'last-subdomain-label' } },
              },
              cookies: { allow: ['locale'] },
              publicConfig: factory('beta'),
            },
          },
        }),
      }),
    })
    await managed.listen()
    const origin = `http://127.0.0.1:${managed.address().port}`
    const navigate = (host: string, path: string, locale: string, requestId: string) =>
      fetch(`${origin}${path}`, {
        headers: {
          accept: 'text/html',
          'accept-language': locale,
          cookie: `locale=${locale}; session=private`,
          'x-forwarded-host': host,
          'x-forwarded-proto': 'https',
          'x-request-id': requestId,
        },
      }).then((response) => response.text())

    const [alpha, beta] = await Promise.all([
      navigate('one.alpha.test', '/alpha?preview=1', 'en', 'request-alpha'),
      navigate('two.beta.test', '/beta?preview=2', 'ar', 'request-beta'),
    ])

    expect(alpha).toContain('&quot;applicationId&quot;:&quot;alpha&quot;')
    expect(alpha).toContain('&quot;host&quot;:&quot;one.alpha.test&quot;')
    expect(alpha).toContain('"applicationId":"alpha"')
    expect(alpha).toContain('"locale":"en"')
    expect(alpha).toContain('"tenant":"one"')
    expect(alpha).toContain('"cookie":"locale=en"')
    expect(alpha).not.toContain('"applicationId":"beta"')
    expect(alpha).not.toContain('</script><script>alert(1)</script>')
    expect(alpha).toContain('\\u003c/script>')
    expect(alpha).toContain('\\u2028\\u2029')
    expect(beta).toContain('"applicationId":"beta"')
    expect(beta).toContain('"locale":"ar"')
    expect(beta).toContain('"tenant":"two"')
    expect(beta).not.toContain('"applicationId":"alpha"')
    expect(invocations).toEqual({ alpha: 1, beta: 1 })

    expect(received.alpha[0]).toMatchObject({
      requestId: 'request-alpha',
      url: 'https://one.alpha.test/alpha?preview=1',
      host: 'one.alpha.test',
      protocol: 'https',
      method: 'GET',
      cookie: 'locale=en',
      pathname: '/alpha',
      search: '?preview=1',
      entryId: 'alpha',
    })
    expect(received.alpha[0]?.headers).toMatchObject({
      'accept-language': 'en',
      'x-request-id': 'request-alpha',
    })
    expect(received.alpha[0]?.domain).toMatchObject({
      entry: 'alpha',
      hostname: 'one.alpha.test',
      params: { tenant: 'one' },
    })
    expect(received.alpha[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('keys rendered responses by resolved public config while sharing identical output', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'site.html'),
      '<!doctype html><html><head></head><body><div id="app"></div></body></html>'
    )
    const store = createSsrMemoryResponseCache()
    let factoryInvocations = 0
    let renders = 0
    const Root = defineComponent({
      setup() {
        const context = useSsrRequestContext()
        const rendered = ++renders
        return () => h('main', `${context.publicConfig.locale}:render:${rendered}`)
      },
    })
    managed = await createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => ({
        default: defineSsrConfig({
          server: { port: 0 },
          applications: {
            cached: {
              application: { id: 'cached', root: Root },
              template: 'site.html',
              domain: { development: 'localhost', customDomains: true },
              cacheControl: 'public, max-age=60',
              responseCache: {
                store,
                ttlMs: 60_000,
                vary: () => 'publication:v1',
              },
              publicConfig: ({ headers }) => {
                factoryInvocations += 1
                return { locale: headers['accept-language'] || 'en' }
              },
            },
          },
        }),
      }),
    })
    await managed.listen()
    const origin = `http://127.0.0.1:${managed.address().port}`
    const navigate = (locale: string, irrelevant: string) =>
      fetch(`${origin}/cached`, {
        headers: {
          accept: 'text/html',
          'accept-language': locale,
          'x-irrelevant': irrelevant,
        },
      })

    const english = await navigate('en', 'one')
    const englishBody = await english.text()
    const arabic = await navigate('ar', 'one')
    const arabicBody = await arabic.text()
    const englishHit = await navigate('en', 'two')
    const englishHitBody = await englishHit.text()
    const arabicHit = await navigate('ar', 'two')
    const arabicHitBody = await arabicHit.text()

    expect(englishBody).toContain('en:render:1')
    expect(arabicBody).toContain('ar:render:2')
    expect(englishHitBody).toContain('en:render:1')
    expect(arabicHitBody).toContain('ar:render:2')
    expect(englishHit.headers.get('server-timing')).toBe('cache;desc="hit"')
    expect(arabicHit.headers.get('server-timing')).toBe('cache;desc="hit"')
    expect(factoryInvocations).toBe(4)
    expect(renders).toBe(2)
  })

  it.each([
    ['NaN instead of null', { value: Number.NaN }],
    ['undefined property instead of omission', { flag: undefined }],
  ])('rejects cache-colliding public config %s before cache lookup', async (_label, value) => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'site.html'),
      '<!doctype html><html><head></head><body><div id="app"></div></body></html>'
    )
    const cacheGet = vi.fn()
    const cacheSet = vi.fn()
    const cacheVary = vi.fn(() => 'stable')
    managed = await createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => ({
        default: defineSsrConfig({
          server: { port: 0 },
          applications: {
            invalid: {
              application: {
                id: 'invalid',
                root: defineComponent(() => () => h('main', 'unreachable')),
              },
              template: 'site.html',
              domain: { development: 'localhost', customDomains: true },
              cacheControl: 'public, max-age=60',
              responseCache: {
                store: {
                  get: cacheGet,
                  set: cacheSet,
                  invalidate: () => 0,
                },
                ttlMs: 60_000,
                vary: cacheVary,
              },
              publicConfig: () => value,
            },
          },
        }),
      }),
    })
    await managed.listen()

    const response = await fetch(`http://127.0.0.1:${managed.address().port}/`, {
      headers: { accept: 'text/html' },
    })
    expect(response.status).toBe(500)
    await response.text()
    expect(cacheVary).not.toHaveBeenCalled()
    expect(cacheGet).not.toHaveBeenCalled()
    expect(cacheSet).not.toHaveBeenCalled()
  })

  it('reloads development templates on every request', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    const templatePath = join(root, 'index.html')
    await writeFile(
      templatePath,
      '<!doctype html><html><body><div id="app">first</div></body></html>'
    )
    managed = await createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => ({ default: spaConfig() }),
    })
    await managed.listen()
    const origin = `http://127.0.0.1:${managed.address().port}`

    const first = await fetch(`${origin}/`, {
      headers: { accept: 'text/html' },
    })
    expect(await first.text()).toContain('>first</div>')
    await writeFile(
      templatePath,
      '<!doctype html><html><body><div id="app">second</div></body></html>'
    )
    const second = await fetch(`${origin}/`, {
      headers: { accept: 'text/html' },
    })
    expect(await second.text()).toContain('>second</div>')
  })

  it('does not share production templates between managed servers', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    const clientRoot = join(root, 'dist', 'client')
    await mkdir(clientRoot, { recursive: true })
    const templatePath = join(clientRoot, 'index.html')
    const createManaged = () =>
      createSsrManagedServer({
        production: true,
        root,
        loadRuntime: async () => ({ default: spaConfig() }),
      })

    await writeFile(
      templatePath,
      '<!doctype html><html><body><div id="app">server-a</div></body></html>'
    )
    managed = await createManaged()
    await managed.listen()
    const serverA = await fetch(`http://127.0.0.1:${managed.address().port}/`, {
      headers: { accept: 'text/html' },
    })
    expect(await serverA.text()).toContain('>server-a</div>')
    await managed.close()
    managed = undefined

    await writeFile(
      templatePath,
      '<!doctype html><html><body><div id="app">server-b</div></body></html>'
    )
    managed = await createManaged()
    await managed.listen()
    const serverB = await fetch(`http://127.0.0.1:${managed.address().port}/`, {
      headers: { accept: 'text/html' },
    })
    expect(await serverB.text()).toContain('>server-b</div>')
  })

  it('streams production assets with GET, HEAD, validators, and custom-base semantics', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    const clientRoot = join(root, 'dist', 'client')
    await mkdir(join(clientRoot, 'assets', 'nested'), { recursive: true })
    await mkdir(join(clientRoot, '.vite'), { recursive: true })
    await writeFile(
      join(clientRoot, 'index.html'),
      '<!doctype html><html><body><div id="app"></div></body></html>'
    )
    const javascript = 'console.log("streamed asset")\n'
    await writeFile(join(clientRoot, 'assets', 'app-DG71SDF2.js'), javascript)
    await writeFile(join(clientRoot, 'assets', 'nested', 'site.css'), 'body{}')
    await writeFile(join(clientRoot, 'assets', 'robots-generated.txt'), 'mutable')
    await writeFile(join(clientRoot, 'assets', 'empty.bin'), '')
    await writeFile(
      join(clientRoot, '.vite', 'manifest.json'),
      JSON.stringify({
        'src/main.ts': {
          file: 'assets/app-DG71SDF2.js',
          css: ['assets/nested/site.css'],
        },
      })
    )
    await writeFile(
      join(clientRoot, SSR_PRODUCTION_ASSET_METADATA_PATH),
      serializeSsrProductionAssetMetadata(['assets/app-DG71SDF2.js', 'assets/nested/site.css'])
    )

    managed = await createSsrManagedServer({
      production: true,
      root,
      loadRuntime: async () => ({
        default: {
          ...spaConfig(),
          __vueSsrLiteViteBase: '/products/',
        },
      }),
    })
    await managed.listen()
    const { port } = managed.address()
    const origin = `http://127.0.0.1:${port}`
    const assetUrl = `${origin}/products/assets/app-DG71SDF2.js?v=1`

    const get = await fetch(assetUrl)
    const etag = get.headers.get('etag')!
    const lastModified = get.headers.get('last-modified')!
    expect(get.status).toBe(200)
    expect(get.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(get.headers.get('content-length')).toBe(String(Buffer.byteLength(javascript)))
    expect(get.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(etag).toMatch(/^W\/"[a-f\d]+-[a-f\d]+"$/)
    expect(Number.isNaN(Date.parse(lastModified))).toBe(false)
    expect(await get.text()).toBe(javascript)

    const head = await fetch(assetUrl, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(javascript)))
    expect(head.headers.get('etag')).toBe(etag)
    expect((await head.arrayBuffer()).byteLength).toBe(0)

    const etagHit = await fetch(assetUrl, {
      headers: { 'if-none-match': etag },
    })
    expect(etagHit.status).toBe(304)
    expect(etagHit.headers.get('etag')).toBe(etag)
    expect((await etagHit.arrayBuffer()).byteLength).toBe(0)

    const strongEquivalentHit = await fetch(assetUrl, {
      headers: { 'if-none-match': etag.slice(2) },
    })
    expect(strongEquivalentHit.status).toBe(304)

    const dateHit = await fetch(assetUrl, {
      headers: { 'if-modified-since': lastModified },
    })
    expect(dateHit.status).toBe(304)

    const etagPrecedence = await fetch(assetUrl, {
      headers: {
        'if-none-match': '"stale"',
        'if-modified-since': lastModified,
      },
    })
    expect(etagPrecedence.status).toBe(200)
    await etagPrecedence.arrayBuffer()

    const ignoredRange = await fetch(assetUrl, {
      headers: { range: 'bytes=0-3' },
    })
    expect(ignoredRange.status).toBe(200)
    expect(ignoredRange.headers.has('accept-ranges')).toBe(false)
    expect(await ignoredRange.text()).toBe(javascript)

    const [css, mutable, empty, directory, post, missing] = await Promise.all([
      fetch(`${origin}/products/assets/nested/site.css`),
      fetch(`${origin}/products/assets/robots-generated.txt`),
      fetch(`${origin}/products/assets/empty.bin`),
      fetch(`${origin}/products/assets/`, {
        headers: { accept: 'application/octet-stream' },
      }),
      fetch(assetUrl, { method: 'POST' }),
      fetch(`${origin}/products/assets/missing.js`),
    ])
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(mutable.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(empty.status).toBe(200)
    expect(empty.headers.get('content-length')).toBe('0')
    expect(directory.status).toBe(404)
    expect(post.status).toBe(404)
    expect(missing.status).toBe(404)
    await expect(
      requestRawPathStatus(port, '/products/%2e%2e/assets/app-DG71SDF2.js')
    ).resolves.toBe(404)
    await expect(
      requestRawPathStatus(port, '/products/assets/%5c..%5capp-DG71SDF2.js')
    ).resolves.toBe(404)

    const protectedTemplate = await fetch(`${origin}/products/index.html`, {
      headers: { accept: 'text/html' },
    })
    expect(protectedTemplate.status).toBe(200)
    expect(await protectedTemplate.text()).toContain('vue-ssr-lite-domain')
  })

  it('streams concurrent large assets and tears down a disconnected request', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    const clientRoot = join(root, 'dist', 'client')
    await mkdir(join(clientRoot, 'assets'), { recursive: true })
    await writeFile(
      join(clientRoot, 'index.html'),
      '<!doctype html><html><body><div id="app"></div></body></html>'
    )
    const largeAsset = Buffer.alloc(4 * 1024 * 1024, 0x5a)
    await writeFile(join(clientRoot, 'assets', 'large-A1B2C3D4.bin'), largeAsset)

    managed = await createSsrManagedServer({
      production: true,
      root,
      loadRuntime: async () => ({ default: spaConfig() }),
    })
    await managed.listen()
    const origin = `http://127.0.0.1:${managed.address().port}`
    const assetUrl = `${origin}/assets/large-A1B2C3D4.bin`

    const bodies = await Promise.all(
      Array.from({ length: 3 }, async () => {
        const response = await fetch(assetUrl)
        expect(response.headers.get('content-length')).toBe(String(largeAsset.byteLength))
        return Buffer.from(await response.arrayBuffer())
      })
    )
    for (const body of bodies) {
      expect(body.byteLength).toBe(largeAsset.byteLength)
      expect(body[0]).toBe(0x5a)
      expect(body.at(-1)).toBe(0x5a)
    }

    await new Promise<void>((resolveDisconnect, rejectDisconnect) => {
      const request = createHttpRequest(assetUrl)
      request.once('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') {
          resolveDisconnect()
        } else {
          rejectDisconnect(error)
        }
      })
      request.once('response', (response) => {
        response.once('data', () => {
          request.destroy()
          response.destroy()
        })
        response.once('close', resolveDisconnect)
      })
      request.end()
    })

    const health = await fetch(`${origin}/healthz`)
    expect(health.status).toBe(200)
  })

  it('keeps static assets outside the SSR response cache', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    const clientRoot = join(root, 'dist', 'client')
    await mkdir(join(clientRoot, 'assets'), { recursive: true })
    await mkdir(join(clientRoot, '.vite'), { recursive: true })
    await writeFile(
      join(clientRoot, 'index.html'),
      '<!doctype html><html><body><div id="app"></div></body></html>'
    )
    await writeFile(join(clientRoot, '.vite', 'ssr-manifest.json'), '{}')
    await writeFile(join(clientRoot, 'assets', 'cached-A1B2C3D4.js'), 'asset')

    const memoryStore = createSsrMemoryResponseCache()
    let reads = 0
    let writes = 0
    const trackingStore = {
      get: (...args: Parameters<typeof memoryStore.get>) => {
        reads += 1
        return memoryStore.get(...args)
      },
      set: (...args: Parameters<typeof memoryStore.set>) => {
        writes += 1
        return memoryStore.set(...args)
      },
      invalidate: (...args: Parameters<typeof memoryStore.invalidate>) =>
        memoryStore.invalidate(...args),
    }
    const Root = defineComponent({ setup: () => () => h('main', 'SSR') })
    managed = await createSsrManagedServer({
      production: true,
      root,
      loadRuntime: async () => ({
        default: defineSsrConfig({
          server: { port: 0 },
          resolveSiteUrl: () => 'https://example.com',
          applications: {
            cached: {
              application: { id: 'cached', root: Root },
              template: 'index.html',
              responseCache: { store: trackingStore, ttlMs: 60_000 },
              domain: { production: 'localhost', customDomains: true },
            },
          },
        } as any),
      }),
    })
    await managed.listen()
    const response = await fetch(
      `http://127.0.0.1:${managed.address().port}/assets/cached-A1B2C3D4.js`
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('asset')
    expect(reads).toBe(0)
    expect(writes).toBe(0)
  })

  it.each(['./', ''])('allows production SPA-only startup with Vite base %j', async (viteBase) => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await mkdir(join(root, 'dist', 'client'), { recursive: true })
    await writeFile(
      join(root, 'dist', 'client', 'index.html'),
      '<!doctype html><html><body><div id="app"></div></body></html>'
    )
    managed = await createSsrManagedServer({
      production: true,
      root,
      loadRuntime: async () => ({
        default: {
          ...spaConfig(),
          __vueSsrLiteViteBase: viteBase,
        },
      }),
    })

    await expect(managed.listen()).resolves.toBeUndefined()
  })

  it('allows a relative base when the current role enables only SPA applications', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await mkdir(join(root, 'dist', 'client'), { recursive: true })
    await writeFile(
      join(root, 'dist', 'client', 'admin.html'),
      '<!doctype html><html><body><div id="app"></div></body></html>'
    )
    const Root = defineComponent({ setup: () => () => h('main', 'SSR') })
    managed = await createSsrManagedServer({
      production: true,
      root,
      loadRuntime: async () => ({
        default: {
          ...defineSsrConfig({
            runtime: 'admin',
            server: { port: 0 },
            applications: {
              website: {
                render: 'ssr',
                roles: ['website'],
                application: { root: Root },
                template: 'website.html',
                host: 'website.test',
                domain: { production: 'website.test' },
              },
              admin: {
                render: 'spa',
                roles: ['admin'],
                application: { module: './Admin.ts' },
                template: 'admin.html',
                host: 'admin.test',
                domain: { production: 'admin.test' },
              },
            },
          } as any),
          __vueSsrLiteViteBase: './',
        },
      }),
    })

    await expect(managed.listen()).resolves.toBeUndefined()
  })

  it.each(['./', ''])('rejects Vite base %j when production SSR is enabled', async (viteBase) => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    const Root = defineComponent({ setup: () => () => h('main', 'SSR') })
    await expect(
      createSsrManagedServer({
        production: true,
        root,
        loadRuntime: async () => ({
          default: {
            ...defineSsrConfig({
              server: { port: 0 },
              resolveSiteUrl: () => 'https://example.com',
              application: { root: Root },
              domain: { production: 'localhost', customDomains: true },
            } as any),
            __vueSsrLiteViteBase: viteBase,
          },
        }),
      })
    ).rejects.toThrow('does not support Vite relative base')
  })

  it('fails production SSR startup when Vite asset metadata is missing', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await mkdir(join(root, 'dist', 'client'), { recursive: true })
    await writeFile(
      join(root, 'dist', 'client', 'index.html'),
      '<!doctype html><html><head></head><body><div id="app"></div></body></html>'
    )
    const Root = defineComponent({ setup: () => () => h('main', 'SSR') })

    await expect(
      createSsrManagedServer({
        production: true,
        root,
        loadRuntime: async () => ({
          default: defineSsrConfig({
            server: { port: 0 },
            resolveSiteUrl: () => 'https://example.com',
            application: { root: Root },
            domain: { production: 'localhost', customDomains: true },
          } as any),
        }),
      })
    ).rejects.toThrow("requires Vite's generated SSR manifest")
  })

  it('never reads or writes the shared response cache for raw credential headers', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'site.html'),
      '<!doctype html><html><head></head><body><div id="app"></div></body></html>'
    )
    let renders = 0
    const Root = defineComponent({
      setup() {
        const request = useSsrRequestContext().request
        renders += 1
        return () => h('main', `render:${renders};forwarded-cookie:${request.cookie || 'none'}`)
      },
    })
    const responseStore = createSsrMemoryResponseCache()
    managed = await createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => ({
        default: defineSsrConfig({
          server: { port: 0 },
          applications: {
            cached: {
              application: { id: 'cached', root: Root },
              template: 'site.html',
              cacheControl: 'public, max-age=60',
              responseCache: {
                store: responseStore,
                ttlMs: 60_000,
              },
              domain: { development: 'localhost', customDomains: true },
            },
          },
        }),
      }),
    })
    await managed.listen()
    const { port } = managed.address()
    const url = `http://127.0.0.1:${port}/`
    const navigate = (headers: Record<string, string> = {}) =>
      fetch(url, { headers: { accept: 'text/html', ...headers } })

    const first = await navigate()
    expect(await first.text()).toContain('render:1')
    const cached = await navigate()
    expect(await cached.text()).toContain('render:1')
    expect(cached.headers.get('server-timing')).toBe('cache;desc="hit"')

    const cookie = await navigate({ cookie: 'session=private' })
    expect(await cookie.text()).toContain('render:2;forwarded-cookie:none')
    const authorization = await navigate({ authorization: 'Bearer private' })
    expect(await authorization.text()).toContain('render:3')
    const proxyAuthorization = await navigate({
      'proxy-authorization': 'Basic private',
    })
    expect(await proxyAuthorization.text()).toContain('render:4')

    const stillPublic = await navigate()
    expect(await stillPublic.text()).toContain('render:1')
    expect(renders).toBe(4)
  })

  it('selects applications by host specificity and enforces runtime roles with 421', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html><body><div id="app">spa</div></body></html>'
    )
    await writeFile(
      join(root, 'site.html'),
      '<!doctype html><html><head></head><body><div id="app"></div></body></html>'
    )
    const Root = defineComponent({
      setup: () => () => h('main', 'storefront'),
    })
    managed = await createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => ({
        default: defineSsrConfig({
          name: 'host-runtime',
          runtime: 'erp',
          server: { port: 0, trustProxy: true },
          applications: {
            storefront: {
              render: 'ssr',
              application: { id: 'storefront', root: Root },
              template: 'site.html',
              roles: ['unified', 'storefront'],
              domain: {
                development: 'shop.localhost',
                production: 'shop.localhost',
                mode: 'root-and-subdomains',
                customDomains: true,
                params: {
                  storeDomain: { source: 'subdomain-or-hostname' },
                },
              },
              publicConfig: {
                api: { endpoint: 'http://localhost/graphql', timeout: 8000 },
              },
            },
            erp: {
              render: 'spa',
              application: {
                module: './Erp.ts',
                exportName: 'createErpApplication',
              },
              template: 'index.html',
              roles: ['unified', 'erp'],
              domain: {
                development: 'localhost',
                production: 'localhost',
                mode: 'root-and-subdomains',
                localAliases: true,
                params: {
                  workspace: { source: 'last-subdomain-label' },
                },
              },
              publicConfig: {
                api: { endpoint: 'http://localhost/graphql', timeout: 8000 },
              },
            },
          },
        }),
      }),
    })
    await managed.listen()
    const { port } = managed.address()

    const workspace = await fetch(`http://127.0.0.1:${port}/`, {
      headers: {
        accept: 'text/html',
        'x-forwarded-host': 'company1.localhost',
      },
    })
    const shop = await fetch(`http://127.0.0.1:${port}/`, {
      headers: {
        accept: 'text/html',
        'x-forwarded-host': 'classic-modern-7963.shop.localhost',
      },
    })

    expect(workspace.status).toBe(200)
    expect(await workspace.text()).toContain('<div id="app">spa</div>')
    expect(shop.status).toBe(421)
    expect(await shop.text()).toContain('Misdirected request')
  })

  it('coalesces concurrent runtime reloads and keeps the last good config on failure', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html><body><div id="app"></div></body></html>'
    )
    let loads = 0
    let failNext = false
    let releaseReload!: () => void
    const reloadGate = new Promise<void>((resolveGate) => {
      releaseReload = resolveGate
    })
    let reloadStarted!: () => void
    const sawReload = new Promise<void>((resolveStarted) => {
      reloadStarted = resolveStarted
    })
    managed = await createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => {
        loads += 1
        if (loads === 1) return { default: spaConfig() }
        reloadStarted()
        await reloadGate
        if (failNext) throw new Error('hmr reload boom')
        return { default: spaConfig() }
      },
    })
    await managed.listen()
    const { port } = managed.address()

    const pendingA = fetch(`http://127.0.0.1:${port}/healthz`)
    await sawReload
    const pendingB = fetch(`http://127.0.0.1:${port}/healthz`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    expect(loads).toBe(2)
    releaseReload()
    expect((await pendingA).status).toBe(200)
    expect((await pendingB).status).toBe(200)
    expect(loads).toBe(2)

    failNext = true
    const afterFailure = await fetch(`http://127.0.0.1:${port}/healthz`)
    expect(afterFailure.status).toBe(200)
    expect(loads).toBe(3)
  })
})

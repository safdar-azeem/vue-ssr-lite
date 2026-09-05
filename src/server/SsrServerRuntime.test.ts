import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import {
  request as createHttpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
} from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ViteDevServer } from 'vite'
import { defineComponent, h, onServerPrefetch } from 'vue'
import { RouterView } from 'vue-router'
import { defineApplication } from '../index'
import {
  serializeSsrProductionAssetMetadata,
  SSR_PRODUCTION_ASSET_METADATA_PATH,
} from '../SsrAssetMetadata'
import { defineServer } from '../SsrConfigRuntime'
import { withSsrShells } from '../SsrTestFixtures'
import { useSsrRequestContext } from '../SsrRequestContext'
import { useSeo } from '../extensions/seo/useSeo'
import { createSsrMemoryResponseCache } from './SsrResponseCacheRuntime'
import {
  createSsrManagedServer,
  resolveManagedServerHost,
  resolveManagedServerPort,
  writeSsrProductionAsset,
  type SsrManagedServer,
} from './SsrServerRuntime'
import type { SsrResolvedProductionAsset } from './SsrAssetRuntime'

let managed: SsrManagedServer | undefined
let root = ''
const pendingHtmlRequests = new Set<ClientRequest>()

// Lifecycle scenarios replace individual Vite operations, but the managed
// server also needs a watcher and environment inventory for revision tracking.
const createLifecycleVite = (overrides: Record<string, unknown>): ViteDevServer => ({
  config: { root, base: '/' },
  watcher: new EventEmitter(),
  environments: {},
  ...overrides,
}) as unknown as ViteDevServer

const abortPendingHtmlRequests = () => {
  for (const request of pendingHtmlRequests) request.destroy()
  pendingHtmlRequests.clear()
}

afterEach(async () => {
  // A failed controlled-clock assertion must not leave a socket waiting on a
  // deadline that disappears when real timers are restored.
  abortPendingHtmlRequests()
  vi.useRealTimers()
  await managed?.close().catch(() => undefined)
  if (root) await rm(root, { recursive: true, force: true })
  managed = undefined
  root = ''
})
const spaConfig = () =>
  defineServer({
    name: 'test-runtime',
    // Lifecycle tests must not claim the public development port. Binding to
    // zero keeps them isolated from local managed-server processes and other
    // test workers.
    server: { port: 0 },
    applications: [
      defineApplication({
        name: 'spa',
        render: 'spa',
        app: { main: './SpaApp.ts' },
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
      }),
    ],
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

// Use Node's transport for controlled-clock deadline tests: it delivers socket
// events without fetch's pooled-connection housekeeping timers.
const requestHtml = (port: number, path: string) =>
  new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>(
    (resolveResponse, rejectResponse) => {
      const request = createHttpRequest({
        hostname: '127.0.0.1',
        port,
        path,
        agent: false,
        headers: { accept: 'text/html' },
      })
      pendingHtmlRequests.add(request)
      request.once('close', () => pendingHtmlRequests.delete(request))
      request.once('response', (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
        })
        response.once('error', rejectResponse)
        response.once('end', () => {
          resolveResponse({
            status: response.statusCode || 0,
            headers: response.headers,
            body,
          })
        })
      })
      request.once('error', rejectResponse)
      request.end()
    }
  )

const waitForRequestStage = (
  stage: Promise<void>,
  response: ReturnType<typeof requestHtml>,
  label: string
) =>
  Promise.race([
    stage,
    // Observe transport failures immediately while the test waits to advance
    // its clock, instead of leaving a rejected response promise unhandled.
    response.then(() => {
      throw new Error(`The request completed before ${label}.`)
    }),
  ])

describe('managed SSR server lifecycle', () => {
  it('uses a non-empty HOST override and otherwise preserves the configured host', () => {
    const previousHost = process.env.HOST
    try {
      delete process.env.HOST
      expect(resolveManagedServerHost('0.0.0.0')).toBe('0.0.0.0')
      process.env.HOST = ' 127.0.0.1 '
      expect(resolveManagedServerHost('0.0.0.0')).toBe('127.0.0.1')
      process.env.HOST = '   '
      expect(resolveManagedServerHost('0.0.0.0')).toBe('0.0.0.0')
    } finally {
      if (previousHost === undefined) delete process.env.HOST
      else process.env.HOST = previousHost
    }
  })

  it('uses PORT when valid and otherwise preserves the configured port/default', () => {
    const previousPort = process.env.PORT
    try {
      delete process.env.PORT
      expect(resolveManagedServerPort(4302)).toBe(4302)
      expect(resolveManagedServerPort(undefined)).toBe(4173)
      process.env.PORT = '5000'
      expect(resolveManagedServerPort(4302)).toBe(5000)
      process.env.PORT = 'not-a-port'
      expect(resolveManagedServerPort(4302)).toBe(4302)
    } finally {
      if (previousPort === undefined) delete process.env.PORT
      else process.env.PORT = previousPort
    }
  })

  it('completes idle development shutdown promptly and safely before listen', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html><body><div id="app"></div></body></html>'
    )
    managed = await createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => ({
        default: defineServer({
          server: { port: 0, shutdownTimeoutMs: 15_000 },
          render: 'spa',
        }),
      }),
    })

    const beforeListen = managed.close()
    expect(managed.close()).toBe(beforeListen)
    await expect(beforeListen).resolves.toBeUndefined()

    managed = undefined
    const listeningServer = await createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => ({
        default: defineServer({
          server: { port: 0, shutdownTimeoutMs: 15_000 },
          render: 'spa',
        }),
      }),
    })
    managed = listeningServer
    await listeningServer.listen()
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await expect(
        Promise.race([
          listeningServer.close().then(() => 'closed'),
          new Promise((resolveWait) => {
            deadline = setTimeout(() => resolveWait('deadline'), 1_000)
          }),
        ])
      ).resolves.toBe('closed')
    } finally {
      if (deadline) clearTimeout(deadline)
    }
  })

  it('uses one close promise and waits for Vite-owned shutdown', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html><body><div id="app"></div></body></html>'
    )
    let resolveViteClose!: () => void
    const viteClose = new Promise<void>((resolveClose) => {
      resolveViteClose = resolveClose
    })
    let resolveOptimizer!: () => void
    const optimizer = new Promise<void>((resolveWork) => {
      resolveOptimizer = resolveWork
    })
    const closeVite = vi.fn(() => viteClose)
    const vite = createLifecycleVite({
      close: closeVite,
      environments: {
        client: {
          depsOptimizer: {
            scanProcessing: Promise.resolve(),
            metadata: {
              discovered: { vue: { processing: optimizer } },
            },
          },
        },
      },
    })
    managed = await createSsrManagedServer({
      production: false,
      root,
      vite,
      loadRuntime: async () => ({
        default: defineServer({ server: { port: 0 }, render: 'spa' }),
      }),
    })
    await managed.listen()

    const first = managed.close()
    const second = managed.close()
    let settled = false
    void first.then(() => {
      settled = true
    })
    expect(second).toBe(first)
    await Promise.resolve()
    expect(closeVite).not.toHaveBeenCalled()
    resolveOptimizer()
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
    expect(closeVite).toHaveBeenCalledTimes(1)
    expect(managed.nodeServer.listening).toBe(false)
    expect(settled).toBe(false)

    resolveViteClose()
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
  })

  it('waits for optimizer processing created while the dependency scan is pending', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html><body><div id="app"></div></body></html>'
    )
    let resolveScan!: () => void
    const scan = new Promise<void>((resolveWork) => {
      resolveScan = resolveWork
    })
    let resolveProcessing!: () => void
    const processing = new Promise<void>((resolveWork) => {
      resolveProcessing = resolveWork
    })
    const discovered: Record<string, { processing: Promise<void> }> = {}
    const closeVite = vi.fn(async () => undefined)
    const vite = createLifecycleVite({
      close: closeVite,
      environments: {
        client: {
          depsOptimizer: {
            scanProcessing: scan,
            metadata: { discovered },
          },
        },
      },
    })
    managed = await createSsrManagedServer({
      production: false,
      root,
      vite,
      loadRuntime: async () => ({
        default: defineServer({ server: { port: 0 }, render: 'spa' }),
      }),
    })
    await managed.listen()

    const closing = managed.close()
    await Promise.resolve()
    expect(closeVite).not.toHaveBeenCalled()

    // Model Vite discovering and starting an optimization batch as the scan
    // reaches its completion boundary.
    discovered.vue = { processing }
    resolveScan()
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
    expect(closeVite).not.toHaveBeenCalled()

    resolveProcessing()
    await expect(closing).resolves.toBeUndefined()
    expect(closeVite).toHaveBeenCalledTimes(1)
  })

  it('closes Vite and the HTTP server when post-scan optimizer work rejects', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html><body><div id="app"></div></body></html>'
    )
    let resolveScan!: () => void
    const scan = new Promise<void>((resolveWork) => {
      resolveScan = resolveWork
    })
    const discovered: Record<string, { processing: Promise<void> }> = {}
    let rejectOptimizer!: (error: Error) => void
    const optimizer = new Promise<void>((_resolveOptimizer, rejectWork) => {
      rejectOptimizer = rejectWork
    })
    const closeVite = vi.fn(async () => undefined)
    const vite = createLifecycleVite({
      close: closeVite,
      environments: {
        client: {
          depsOptimizer: {
            scanProcessing: scan,
            metadata: { discovered },
          },
        },
      },
    })
    managed = await createSsrManagedServer({
      production: false,
      root,
      vite,
      loadRuntime: async () => ({
        default: defineServer({ server: { port: 0 }, render: 'spa' }),
      }),
    })
    await managed.listen()

    const closing = managed.close()
    const optimizerError = new Error('optimizer failed')
    discovered.vue = { processing: optimizer }
    resolveScan()
    rejectOptimizer(optimizerError)

    await expect(closing).rejects.toThrow('optimizer failed')
    expect(closeVite).toHaveBeenCalledTimes(1)
    expect(managed.nodeServer.listening).toBe(false)
  })

  it('attempts Vite cleanup when post-scan optimizer work is stuck at the shutdown deadline', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html><body><div id="app"></div></body></html>'
    )
    const optimizer = new Promise<never>(() => undefined)
    const closeVite = vi.fn(async () => undefined)
    const vite = createLifecycleVite({
      close: closeVite,
      environments: {
        client: {
          depsOptimizer: {
            scanProcessing: Promise.resolve(),
            metadata: {
              discovered: { vue: { processing: optimizer } },
            },
          },
        },
      },
    })
    managed = await createSsrManagedServer({
      production: false,
      root,
      vite,
      loadRuntime: async () => ({
        default: defineServer({
          server: { port: 0, shutdownTimeoutMs: 50 },
          render: 'spa',
        }),
      }),
    })
    await managed.listen()

    await expect(managed.close()).rejects.toThrow('SSR server graceful shutdown timed out.')
    expect(closeVite).toHaveBeenCalledTimes(1)
    expect(managed.nodeServer.listening).toBe(false)
  })

  it('attempts Vite cleanup when the dependency scan itself is stuck', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html><body><div id="app"></div></body></html>'
    )
    const scan = new Promise<never>(() => undefined)
    const closeVite = vi.fn(async () => undefined)
    const vite = createLifecycleVite({
      close: closeVite,
      environments: {
        client: {
          depsOptimizer: {
            scanProcessing: scan,
            metadata: { discovered: {} },
          },
        },
      },
    })
    managed = await createSsrManagedServer({
      production: false,
      root,
      vite,
      loadRuntime: async () => ({
        default: defineServer({
          server: { port: 0, shutdownTimeoutMs: 50 },
          render: 'spa',
        }),
      }),
    })
    await managed.listen()

    await expect(managed.close()).rejects.toThrow('SSR server graceful shutdown timed out.')
    expect(closeVite).toHaveBeenCalledTimes(1)
    expect(managed.nodeServer.listening).toBe(false)
  })

  it('lets active application work finish while shutdown drains the HTTP server', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html><body><div id="app"></div></body></html>'
    )
    let requestStarted!: () => void
    const started = new Promise<void>((resolveStarted) => {
      requestStarted = resolveStarted
    })
    let releaseRequest!: () => void
    const release = new Promise<void>((resolveRelease) => {
      releaseRequest = resolveRelease
    })
    managed = await createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => ({
        default: defineServer({
          server: { port: 0, shutdownTimeoutMs: 2_000 },
          render: 'spa',
          endpoints: [
            {
              id: 'slow',
              match: (request) => request.pathname === '/slow',
              handle: async () => {
                requestStarted()
                await release
                return { statusCode: 200, body: 'completed' }
              },
            },
          ],
        }),
      }),
    })
    await managed.listen()
    const responsePending = fetch(`http://127.0.0.1:${managed.address().port}/slow`)
    await started
    const closing = managed.close()
    let closed = false
    void closing.then(
      () => {
        closed = true
      },
      () => undefined
    )
    await Promise.resolve()
    expect(closed).toBe(false)

    releaseRequest()
    const response = await responsePending
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('completed')
    await expect(closing).resolves.toBeUndefined()
  })

  it('waits for cancelled HTTP work whose admitted Vue render is still alive', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'site.html'),
      '<!doctype html><html><head></head><body><div id="app"></div></body></html>'
    )
    let markRenderStarted!: () => void
    const renderStarted = new Promise<void>((resolveStarted) => {
      markRenderStarted = resolveStarted
    })
    let releaseRender!: () => void
    const renderGate = new Promise<void>((resolveRender) => {
      releaseRender = resolveRender
    })
    const Root = defineComponent({
      setup() {
        markRenderStarted()
        onServerPrefetch(() => renderGate)
        return () => h('main', 'rendered')
      },
    })
    const closeVite = vi.fn(async () => undefined)
    const vite = createLifecycleVite({
      close: closeVite,
      middlewares: (_request: unknown, _response: unknown, next: () => void) => next(),
      transformIndexHtml: async (_url: string, html: string) => html,
    })
    managed = await createSsrManagedServer({
      production: false,
      root,
      vite,
      loadRuntime: async () => ({
        default: defineServer({
          server: { port: 0, shutdownTimeoutMs: 2_000 },
          applications: [
            defineApplication({
              name: 'site',
              template: 'site.html',
              domain: { development: 'localhost', customDomains: true },
            }),
          ],
        }),
        __vueSsrLiteShells: {
          site: { root: Root, main: { default: () => undefined } },
        },
      }),
    })
    await managed.listen()

    const request = createHttpRequest({
      hostname: '127.0.0.1',
      port: managed.address().port,
      headers: { accept: 'text/html' },
    })
    const disconnected = new Promise<void>((resolveDisconnected) => {
      request.once('error', () => resolveDisconnected())
      request.once('close', () => resolveDisconnected())
    })
    request.end()
    await renderStarted
    request.destroy()
    await disconnected
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))

    const closing = managed.close()
    let closed = false
    void closing.then(
      () => {
        closed = true
      },
      () => undefined
    )
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
    expect(closed).toBe(false)
    expect(closeVite).not.toHaveBeenCalled()

    releaseRender()
    await expect(closing).resolves.toBeUndefined()
    expect(closeVite).toHaveBeenCalledTimes(1)
  })

  it('bounds shutdown when cancelled admitted Vue render work never settles', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'site.html'),
      '<!doctype html><html><head></head><body><div id="app"></div></body></html>'
    )
    let markRenderStarted!: () => void
    const renderStarted = new Promise<void>((resolveStarted) => {
      markRenderStarted = resolveStarted
    })
    const Root = defineComponent({
      setup() {
        markRenderStarted()
        onServerPrefetch(() => new Promise<never>(() => undefined))
        return () => h('main', 'never rendered')
      },
    })
    managed = await createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => ({
        default: defineServer({
          server: { port: 0, shutdownTimeoutMs: 50 },
          applications: [
            defineApplication({
              name: 'site',
              template: 'site.html',
              domain: { development: 'localhost', customDomains: true },
            }),
          ],
        }),
        __vueSsrLiteShells: {
          site: { root: Root, main: { default: () => undefined } },
        },
      }),
    })
    await managed.listen()

    const request = createHttpRequest({
      hostname: '127.0.0.1',
      port: managed.address().port,
      headers: { accept: 'text/html' },
    })
    const disconnected = new Promise<void>((resolveDisconnected) => {
      request.once('error', () => resolveDisconnected())
      request.once('close', () => resolveDisconnected())
    })
    request.end()
    await renderStarted
    request.destroy()
    await disconnected
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))

    await expect(managed.close()).rejects.toThrow(
      'SSR server graceful shutdown timed out.'
    )
    expect(managed.nodeServer.listening).toBe(false)
  })

  it('bounds a genuinely stuck Vite close with the configured timeout', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html><body><div id="app"></div></body></html>'
    )
    const vite = createLifecycleVite({
      close: () => new Promise<never>(() => undefined),
    })
    managed = await createSsrManagedServer({
      production: false,
      root,
      vite,
      loadRuntime: async () => ({
        default: defineServer({
          server: { port: 0, shutdownTimeoutMs: 50 },
          render: 'spa',
        }),
      }),
    })
    await managed.listen()

    await expect(managed.close()).rejects.toThrow('SSR server graceful shutdown timed out.')
  })

  it('restores the original application URL after Vite base rewriting falls through', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(join(root, 'index.html'), '<html><body><div id="app"></div></body></html>')
    const transformedUrls: string[] = []
    const vite = createLifecycleVite({
      close: vi.fn(async () => undefined),
      middlewares: (
        request: import('node:http').IncomingMessage,
        _response: import('node:http').ServerResponse,
        next: () => void
      ) => {
        request.url = '/users/john.smith?rewritten=true'
        next()
      },
      transformIndexHtml: async (_url: string, html: string, originalUrl: string) => {
        transformedUrls.push(originalUrl)
        return html
      },
    })
    managed = await createSsrManagedServer({
      production: false, root, vite,
      loadRuntime: async () => ({ default: spaConfig() }),
    })
    await managed.listen()
    const response = await fetch(
      `http://127.0.0.1:${managed.address().port}/products/users/john.smith?tab=profile`,
      { headers: { accept: 'text/html' } }
    )
    expect(response.status).toBe(200)
    await response.text()
    expect(transformedUrls).toEqual(['/products/users/john.smith?tab=profile'])
  })

  it('finishes request scope when Vite middleware owns the response', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html><body><div id="app"></div></body></html>'
    )
    const requestTimeoutMs = 12_345
    const vite = createLifecycleVite({
      close: vi.fn(async () => undefined),
      middlewares: (
        _request: import('node:http').IncomingMessage,
        response: import('node:http').ServerResponse
      ) => {
        response.writeHead(200, { 'content-type': 'text/javascript' })
        response.end('export default true')
      },
    })
    managed = await createSsrManagedServer({
      production: false,
      root,
      vite,
      loadRuntime: async () => ({
        default: defineServer({
          server: { port: 0, requestTimeoutMs },
          render: 'spa',
        }),
      }),
    })
    await managed.listen()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    try {
      const response = await fetch(`http://127.0.0.1:${managed.address().port}/fixture.js`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('export default true')
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))

      const requestTimerIndex = setTimeoutSpy.mock.calls.findIndex(
        (call) => call[1] === requestTimeoutMs
      )
      expect(requestTimerIndex).toBeGreaterThanOrEqual(0)
      const requestTimer = setTimeoutSpy.mock.results[requestTimerIndex]?.value
      expect(clearTimeoutSpy).toHaveBeenCalledWith(requestTimer)
    } finally {
      setTimeoutSpy.mockRestore()
      clearTimeoutSpy.mockRestore()
    }
  })

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
    let releaseTimedOutRenders!: () => void
    const timedOutRenderGate = new Promise<void>((resolveRender) => {
      releaseTimedOutRenders = resolveRender
    })
    let markTimeoutRenderStarted!: () => void
    const timeoutRenderStarted = new Promise<void>((resolveStarted) => {
      markTimeoutRenderStarted = resolveStarted
    })
    let markHangingRenderStarted!: () => void
    const hangingRenderStarted = new Promise<void>((resolveStarted) => {
      markHangingRenderStarted = resolveStarted
    })
    let markErrorRendererStarted!: () => void
    const errorRendererStarted = new Promise<void>((resolveStarted) => {
      markErrorRendererStarted = resolveStarted
    })
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
          if (context.url.pathname === '/timeout') markTimeoutRenderStarted()
          else markHangingRenderStarted()
          await timedOutRenderGate
        }
        return () => h('main', 'ready')
      },
    })
    let timeoutRenderKind: string | undefined
    managed = await createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => ({
        default: defineServer({
          name: 'test-runtime',
          // Advance this deadline only after the intended render has started.
          // Wall-clock config loading under parallel suite load is unrelated
          // to the redirect and timeout behaviors asserted here.
          server: {
            port: 0,
            requestTimeoutMs: 100,
            renderError: ({ kind, request }) => {
              timeoutRenderKind = kind
              if (request?.pathname === '/timeout') {
                return { statusCode: 418, body: 'timeout handled' }
              }
              markErrorRendererStarted()
              return new Promise<never>(() => undefined)
            },
          },
          applications: [
            defineApplication({
              name: 'ssr',
              render: 'ssr',
              template: 'site.html',
              domain: {
                development: 'localhost',
                production: 'localhost',
                customDomains: true,
              },
              publicConfig: {
                api: { endpoint: 'http://localhost/graphql', timeout: 8000 },
              },
            }),
          ],
        }),
        __vueSsrLiteShells: {
          ssr: { root: Root, main: { default: () => undefined } },
        },
      }),
    })
    await managed.listen()
    const { port } = managed.address()
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout'],
    })

    try {
      const redirect = await requestHtml(port, '/redirect')
      expect(redirect.status).toBe(307)
      expect(redirect.headers.location).toBe(`http://127.0.0.1:${port}/target`)

      const timeoutResponse = requestHtml(port, '/timeout')
      await waitForRequestStage(
        timeoutRenderStarted,
        timeoutResponse,
        'the timeout render'
      )
      await vi.advanceTimersByTimeAsync(100)
      const timeout = await timeoutResponse
      expect(timeout.status).toBe(418)
      expect(timeout.body).toBe('timeout handled')
      expect(timeoutRenderKind).toBe('timeout')

      const hangingResponse = requestHtml(port, '/timeout-hanging-renderer')
      await waitForRequestStage(
        hangingRenderStarted,
        hangingResponse,
        'the hanging render'
      )
      await vi.advanceTimersByTimeAsync(100)
      await waitForRequestStage(
        errorRendererStarted,
        hangingResponse,
        'the error renderer'
      )
      // The error renderer has a separate bounded 250 ms fallback budget.
      await vi.advanceTimersByTimeAsync(250)
      const hangingRenderer = await hangingResponse
      expect(hangingRenderer.status).toBe(504)
    } finally {
      abortPendingHtmlRequests()
      vi.useRealTimers()
      // Timed-out request handlers stop awaiting immediately, while admission
      // remains owned by the actual Vue renders until these fixture gates open.
      releaseTimedOutRenders()
      await managed.close()
      managed = undefined
    }
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
    let siteResolutionObservedAbort = false
    let activeSiteResolutions = 0
    let markSiteResolutionStarted!: () => void
    const siteResolutionStarted = new Promise<void>((resolveStarted) => {
      markSiteResolutionStarted = resolveStarted
    })
    let markFactoryStarted!: () => void
    const factoryStarted = new Promise<void>((resolveStarted) => {
      markFactoryStarted = resolveStarted
    })
    const cacheSet = vi.fn()
    managed = await createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => ({
        default: defineServer({
          server: { port: 0, requestTimeoutMs: 60 },
          resolveSiteUrl: async ({ signal }) => {
            activeSiteResolutions += 1
            try {
              if (slow) {
                markSiteResolutionStarted()
                await new Promise<void>((resolveWait) => {
                  const onAbort = () => {
                    siteResolutionObservedAbort = true
                    resolveWait()
                  }
                  if (signal.aborted) onAbort()
                  else signal.addEventListener('abort', onAbort, { once: true })
                })
              }
              return 'http://localhost'
            } finally {
              activeSiteResolutions -= 1
            }
          },
          applications: [
            defineApplication({
              name: 'deadline',
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
              publicConfig: async () => {
                if (slow) {
                  markFactoryStarted()
                  await new Promise((resolveWait) => setTimeout(resolveWait, 40))
                }
                return {}
              },
            }),
          ],
        }),
        __vueSsrLiteShells: {
          deadline: { root: Root, main: { default: () => undefined } },
        },
      }),
    })
    await managed.listen()
    const { port } = managed.address()
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout'],
    })
    try {
      const timedOutResponse = requestHtml(port, '/')
      // Public configuration runs before site-origin resolution in the request
      // handler. Spend the first 40 ms there, then hold the second stage until
      // the shared deadline aborts it.
      await waitForRequestStage(
        factoryStarted,
        timedOutResponse,
        'public configuration'
      )
      await vi.advanceTimersByTimeAsync(40)
      await waitForRequestStage(
        siteResolutionStarted,
        timedOutResponse,
        'site resolution'
      )
      // The next stage inherits the remaining 20 ms, not a new 60 ms deadline.
      await vi.advanceTimersByTimeAsync(19)
      expect(siteResolutionObservedAbort).toBe(false)
      expect(activeSiteResolutions).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      const timedOut = await timedOutResponse
      expect(timedOut.status).toBe(504)
      expect(siteResolutionObservedAbort).toBe(true)
      expect(activeSiteResolutions).toBe(0)
      expect(cacheSet).not.toHaveBeenCalled()

      slow = false
      const successful = await requestHtml(port, '/')
      expect(successful.status).toBe(200)
      expect(successfulSignal?.aborted).toBe(true)
    } finally {
      abortPendingHtmlRequests()
      vi.useRealTimers()
    }
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
        default: defineServer({
          server: {
            port: 0,
            logger: { debug: fail, info: fail, warn: fail, error: fail },
            onMetrics: fail,
          },
          applications: [
            defineApplication({
              name: 'observability',
              template: 'site.html',
              domain: { development: 'localhost', customDomains: true },
              cleanup: () => {
                throw new Error('cleanup failed')
              },
            }),
          ],
        }),
        __vueSsrLiteShells: {
          observability: {
            root: defineComponent({
              setup: () => () => h('main', 'healthy'),
            }),
            main: { default: () => undefined },
          },
        },
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
      const privateNavigation = await fetch(`http://127.0.0.1:${port}/.vite/manifest.json`, {
        headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
      })
      const privateHead = await fetch(`http://127.0.0.1:${port}/.vite/manifest.json`, {
        method: 'HEAD',
        headers: { accept: 'text/html' },
      })
      expect(privateNavigation.status).toBe(404)
      expect(privateNavigation.headers.get('cache-control')).toBe('no-store')
      expect(await privateNavigation.text()).not.toContain('<!doctype html>')
      expect(privateHead.status).toBe(404)
      expect(privateHead.headers.get('cache-control')).toBe('no-store')
      expect((await privateHead.arrayBuffer()).byteLength).toBe(0)
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
    await writeFile(join(clientRoot, '.vite', 'manifest.json'), '{}')
    await writeFile(join(clientRoot, '.vite', 'ssr-manifest.json'), '{}')
    await writeFile(
      join(clientRoot, SSR_PRODUCTION_ASSET_METADATA_PATH),
      serializeSsrProductionAssetMetadata([])
    )

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
        default: defineServer({
          server: { port: 0, trustProxy: true },
          applications: [
            defineApplication({
              name: 'site',
              template: 'index.html',
              domain: { production: 'example.com', customDomains: true },
              publicConfig: () => ({
                marker: requestNumber++ === 0 ? 'A' : 'B',
              }),
            }),
          ],
        } as any),
        __vueSsrLiteShells: {
          site: { root: Root, main: { default: () => undefined } },
        },
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
    const privateMetadata = await Promise.all([
      fetch(`${origin}/.vite/manifest.json`, {
        headers: { accept: 'text/html' },
      }),
      fetch(`${origin}/.vite/ssr-manifest.json`, {
        headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
      }),
      fetch(`${origin}/.vite/vue-ssr-lite-assets.json`, {
        headers: { accept: 'text/html' },
      }),
      fetch(`${origin}/.vite/manifest.json`, {
        method: 'HEAD',
        headers: { accept: 'text/html' },
      }),
    ])

    expect(first).toContain('content="A:a.test"')
    expect(first).toContain('"marker":"A"')
    expect(first).toContain('"hostname":"a.test"')
    expect(first).toContain('"siteOrigin":"https://a.test"')
    expect(first).not.toContain('B:b.test')
    expect(second).toContain('content="B:b.test"')
    expect(second).toContain('"marker":"B"')
    expect(second).toContain('"hostname":"b.test"')
    expect(second).toContain('"siteOrigin":"https://b.test"')
    expect(second).not.toContain('A:a.test')
    expect(second).toContain('content="original"')
    expect(second).not.toContain('content="changed"')
    expect(privateMetadata.map((response) => response.status)).toEqual([404, 404, 404, 404])
    expect(privateMetadata.map((response) => response.headers.get('cache-control'))).toEqual([
      'no-store',
      'no-store',
      'no-store',
      'no-store',
    ])
    expect(await privateMetadata[0]!.text()).not.toContain('<!doctype html>')
    expect(await privateMetadata[1]!.text()).not.toContain('<!doctype html>')
    expect(await privateMetadata[2]!.text()).not.toContain('<!doctype html>')
    expect((await privateMetadata[3]!.arrayBuffer()).byteLength).toBe(0)
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
        default: defineServer({
          server: { port: 0, trustProxy: true },
          applications: [
            defineApplication({
              name: 'spa',
              render: 'spa',
              app: { main: './SpaApp.ts' },
              template: 'index.html',
              domain: { production: 'example.com', customDomains: true },
              publicConfig: ({ host, pathname }) => ({ host, pathname }),
            }),
          ],
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
        default: defineServer({
          server: {
            port: 0,
            trustProxy: true,
            maxResolutionPasses: 2,
          },
          applications: [
            defineApplication({
              name: 'alpha',
              template: 'alpha.html',
              domain: {
                development: '*.alpha.test',
                params: { tenant: { source: 'last-subdomain-label' } },
              },
              cookies: { allow: ['locale'] },
              publicConfig: factory('alpha'),
            }),
            defineApplication({
              name: 'beta',
              template: 'beta.html',
              domain: {
                development: '*.beta.test',
                params: { tenant: { source: 'last-subdomain-label' } },
              },
              cookies: { allow: ['locale'] },
              publicConfig: factory('beta'),
            }),
          ],
        }),
        __vueSsrLiteShells: {
          alpha: { root: Root, main: { default: () => undefined } },
          beta: { root: Root, main: { default: () => undefined } },
        },
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
        default: defineServer({
          server: { port: 0 },
          applications: [
            defineApplication({
              name: 'cached',
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
            }),
          ],
        }),
        __vueSsrLiteShells: {
          cached: { root: Root, main: { default: () => undefined } },
        },
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

  it('keeps private SEO HTML outside the shared response cache', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'site.html'),
      '<!doctype html><html><head></head><body><div id="app"></div></body></html>'
    )
    const cacheGet = vi.fn(async () => null)
    const cacheSet = vi.fn(async () => undefined)
    const shouldCache = vi.fn(() => true)
    let renders = 0
    const Root = defineComponent({
      setup() {
        const rendered = ++renders
        useSeo({ title: `Private render ${rendered}` })
        return () => h('main', `private-render:${rendered}`)
      },
    })
    managed = await createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => ({
        default: defineServer({
          server: { port: 0 },
          applications: [
            defineApplication({
              name: 'private',
              template: 'site.html',
              domain: { development: 'localhost', customDomains: true },
              cacheControl: 'public, max-age=60',
              responseCache: {
                store: {
                  get: cacheGet,
                  set: cacheSet,
                  invalidate: async () => 0,
                },
                ttlMs: 60_000,
                shouldCache,
              },
              seo: { mode: 'private' },
            }),
          ],
        }),
        __vueSsrLiteShells: {
          private: { root: Root, main: { default: () => undefined } },
        },
      }),
    })
    await managed.listen()
    const origin = `http://127.0.0.1:${managed.address().port}`
    const navigate = (path = '/') =>
      fetch(`${origin}${path}`, { headers: { accept: 'text/html' } })

    const first = await navigate()
    const firstBody = await first.text()
    const second = await navigate()
    const secondBody = await second.text()
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(first.headers.get('cache-control')).toBe('private, no-store')
    expect(second.headers.get('cache-control')).toBe('private, no-store')
    expect(firstBody).toContain('private-render:1')
    expect(secondBody).toContain('private-render:2')
    expect(firstBody).toContain('noindex, nofollow')
    expect(cacheGet).not.toHaveBeenCalled()
    expect(cacheSet).not.toHaveBeenCalled()
    expect(shouldCache).not.toHaveBeenCalled()
    expect(renders).toBe(2)

    const robots = await navigate('/robots.txt')
    expect(robots.status).toBe(200)
    expect(await robots.text()).toContain('Disallow: /')
    expect(cacheGet).not.toHaveBeenCalled()
    expect(cacheSet).not.toHaveBeenCalled()
    expect(shouldCache).not.toHaveBeenCalled()
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
        default: defineServer({
          server: { port: 0 },
          applications: [
            defineApplication({
              name: 'invalid',
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
            }),
          ],
        }),
        __vueSsrLiteShells: {
          invalid: {
            root: defineComponent(() => () => h('main', 'unreachable')),
            main: { default: () => undefined },
          },
        },
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
    await writeFile(join(clientRoot, '.vite', 'ssr-manifest.json'), '{}')
    await writeFile(join(clientRoot, '.vite', 'other-private-file.json'), '{"private":true}')
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
    for (const [index, privatePath] of [
      '/products/.vite/manifest.json',
      '/products/.vite/ssr-manifest.json',
      '/products/.vite/vue-ssr-lite-assets.json',
      '/products/.vite/other-private-file.json',
      '/products/%2evite/manifest.json',
      '/products/.%76ite/ssr-manifest.json',
      '/products/%2e%76ite%2fssr-manifest.json',
    ].entries()) {
      const privateResponse = await fetch(`${origin}${privatePath}`, {
        method: index === 1 ? 'HEAD' : 'GET',
        headers:
          index === 0
            ? { accept: 'text/html', 'sec-fetch-mode': 'navigate' }
            : { accept: 'text/html' },
      })
      expect(privateResponse.status, privatePath).toBe(404)
      expect(privateResponse.headers.get('cache-control'), privatePath).toBe('no-store')
      if (index === 1) {
        expect((await privateResponse.arrayBuffer()).byteLength).toBe(0)
      } else {
        expect(await privateResponse.text()).not.toContain('<!doctype html>')
      }
    }
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
        default: defineServer({
          server: { port: 0 },
          resolveSiteUrl: () => 'https://example.com',
          applications: [
            defineApplication({
              name: 'cached',
              template: 'index.html',
              responseCache: { store: trackingStore, ttlMs: 60_000 },
              domain: { production: 'localhost', customDomains: true },
            }),
          ],
        } as any),
        __vueSsrLiteShells: {
          cached: { root: Root, main: { default: () => undefined } },
        },
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

  it('rejects a relative base when any registered application uses SSR', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await mkdir(join(root, 'dist', 'client'), { recursive: true })
    await writeFile(
      join(root, 'dist', 'client', 'admin.html'),
      '<!doctype html><html><body><div id="app"></div></body></html>'
    )
    const Root = defineComponent({ setup: () => () => h('main', 'SSR') })
    await expect(createSsrManagedServer({
      production: true,
      root,
      loadRuntime: async () => ({
        default: {
          ...defineServer({
            server: { port: 0 },
            applications: [
              defineApplication({
                name: 'website',
                render: 'ssr',
                template: 'website.html',
                host: 'website.test',
              }),
              defineApplication({
                name: 'admin',
                render: 'spa',
                app: { main: './Admin.ts' },
                template: 'admin.html',
                host: 'admin.test',
              }),
            ],
          }),
          __vueSsrLiteViteBase: './',
          __vueSsrLiteShells: {
            website: { root: Root, main: { default: () => undefined } },
          },
        },
      }),
    })).rejects.toThrow('does not support Vite relative base')
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
            ...defineServer({
              server: { port: 0 },
              resolveSiteUrl: () => 'https://example.com',
              domain: { production: 'localhost', customDomains: true },
            } as any),
            __vueSsrLiteViteBase: viteBase,
            __vueSsrLiteShells: {
              app: { root: Root, main: { default: () => undefined } },
            },
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
          default: {
            ...defineServer({
              server: { port: 0 },
              resolveSiteUrl: () => 'https://example.com',
              domain: { production: 'localhost', customDomains: true },
            } as any),
            __vueSsrLiteShells: {
              app: { root: Root, main: { default: () => undefined } },
            },
          },
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
        default: defineServer({
          server: { port: 0 },
          applications: [
            defineApplication({
              name: 'cached',
              template: 'site.html',
              cacheControl: 'public, max-age=60',
              responseCache: {
                store: responseStore,
                ttlMs: 60_000,
              },
              domain: { development: 'localhost', customDomains: true },
            }),
          ],
        }),
        __vueSsrLiteShells: {
          cached: { root: Root, main: { default: () => undefined } },
        },
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

  it('serves every registered application selected by host specificity', async () => {
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
        default: defineServer({
          name: 'host-runtime',
          server: { port: 0, trustProxy: true },
          applications: [
            defineApplication({
              name: 'storefront',
              render: 'ssr',
              template: 'site.html',
              domain: {
                development: 'shop.localhost',
                production: 'shop.localhost',
                mode: 'root-and-subdomains',
                customDomains: true,
                params: {
                  storeDomain: { source: 'subdomain-or-hostname' },
                },
              },
              seo: {
                sitemap: async () => [],
                robots: { allow: ['/'] },
              },
              publicConfig: {
                api: { endpoint: 'http://localhost/graphql', timeout: 8000 },
              },
            }),
            defineApplication({
              name: 'erp',
              render: 'spa',
              app: { main: './Erp.ts' },
              template: 'index.html',
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
            }),
          ],
        }),
        __vueSsrLiteShells: {
          storefront: { root: Root, main: { default: () => undefined } },
        },
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
    const customDomain = await fetch(`http://127.0.0.1:${port}/`, {
      headers: {
        accept: 'text/html',
        'x-forwarded-host': 'customer-store.test',
      },
    })
    const hostedSubdomainRobots = await fetch(`http://127.0.0.1:${port}/robots.txt`, {
      headers: {
        'x-forwarded-host': 'classic-modern-7963.shop.localhost',
        'x-forwarded-proto': 'https',
      },
    })
    const customDomainRobots = await fetch(`http://127.0.0.1:${port}/robots.txt`, {
      headers: {
        'x-forwarded-host': 'customer-store.test',
        'x-forwarded-proto': 'https',
      },
    })

    expect(workspace.status).toBe(200)
    expect(await workspace.text()).toContain('<div id="app">spa</div>')
    expect(shop.status).toBe(200)
    expect(await shop.text()).toContain('storefront')
    expect(customDomain.status).toBe(200)
    expect(await customDomain.text()).toContain('storefront')
    expect(await hostedSubdomainRobots.text()).toContain(
      'Sitemap: https://classic-modern-7963.shop.localhost/sitemap.xml'
    )
    expect(await customDomainRobots.text()).toContain(
      'Sitemap: https://customer-store.test/sitemap.xml'
    )
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

  it('does not Vue-SSR SPA hybrid routes under concurrent mixed traffic', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-hybrid-'))
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html><head></head><body><div id="app"></div></body></html>'
    )
    let ssrRenders = 0
    const Page = defineComponent({
      setup: () => () => h('p', 'ssr-page'),
    })
    const Shell = defineComponent({
      setup() {
        ssrRenders += 1
        return () => h(RouterView)
      },
    })
    managed = await createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => ({
        default: withSsrShells(
          defineServer({
            server: { port: 0 },
            applications: [
              defineApplication({
                name: 'hybrid',
                render: 'ssr',
                template: 'index.html',
                domain: {
                  development: 'localhost',
                  production: 'localhost',
                  customDomains: true,
                },
                routes: [
                  { path: '/', component: Page, meta: { render: 'ssr' } },
                  { path: '/about', component: Page, meta: { render: 'ssr' } },
                  { path: '/go-app', redirect: '/app/projects' },
                  {
                    path: '/app',
                    component: Page,
                    meta: { render: 'spa' },
                    children: [
                      { path: '', component: Page },
                      { path: 'projects', component: Page },
                      { path: 'go-public', redirect: '/about' },
                      { path: 'settings', component: Page },
                    ],
                  },
                  {
                    path: '/admin',
                    component: Page,
                    meta: { render: 'spa' },
                    children: [{ path: 'users', component: Page }],
                  },
                ],
              }),
            ],
          }),
          { hybrid: { root: Shell } }
        ),
      }),
    })
    await managed.listen()
    const origin = `http://127.0.0.1:${managed.address().port}`
    const html = (path: string) =>
      fetch(`${origin}${path}`, { headers: { accept: 'text/html' } })
    const responses = await Promise.all([
      html('/'),
      html('/about'),
      html('/app'),
      html('/app/projects'),
      html('/app/settings'),
      html('/admin'),
      html('/admin/users'),
      html('/about'),
      html('/app/projects'),
      html('/go-app'),
      html('/app/go-public'),
    ])
    const snapshot = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        body: await response.text(),
      }))
    )
    const bodies = snapshot.map((item) => item.body)
    expect(snapshot.every((item) => item.status === 200)).toBe(true)
    expect(bodies[0]).toContain('ssr-page')
    expect(bodies[1]).toContain('ssr-page')
    expect(bodies[2]).not.toContain('ssr-page')
    expect(bodies[3]).not.toContain('ssr-page')
    expect(bodies[9]).not.toContain('ssr-page')
    expect(bodies[10]).toContain('ssr-page')
    expect(ssrRenders).toBe(4)
  })
})

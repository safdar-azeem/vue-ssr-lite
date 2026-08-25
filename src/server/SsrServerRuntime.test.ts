import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { defineSsrConfig } from '../SsrConfigRuntime'
import { useSsrRequestContext } from '../SsrRequestContext'
import { createSsrMemoryResponseCache } from './SsrResponseCacheRuntime'
import { createSsrManagedServer, type SsrManagedServer } from './SsrServerRuntime'

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

describe('managed SSR server lifecycle', () => {
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
    const hangingRenderer = await fetch(
      `http://127.0.0.1:${port}/timeout-hanging-renderer`,
      { headers: { accept: 'text/html' } }
    )

    expect(redirect.status).toBe(307)
    expect(redirect.headers.get('location')).toBe(
      `http://127.0.0.1:${port}/target`
    )
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
              publicConfig: async () => {
                if (slow) {
                  await new Promise((resolveWait) => setTimeout(resolveWait, 40))
                }
                return {}
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
      const explicitTemplate = await fetch(
        `http://127.0.0.1:${port}/index.html`,
        { headers: { accept: 'text/html' } }
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('vue-ssr-lite-domain')
      expect(explicitTemplate.status).toBe(200)
      expect(await explicitTemplate.text()).toContain('vue-ssr-lite-domain')
    } finally {
      if (previousPublicUrl === undefined) delete process.env.PUBLIC_URL
      else process.env.PUBLIC_URL = previousPublicUrl
    }
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
        return () =>
          h(
            'main',
            `render:${renders};forwarded-cookie:${request.cookie || 'none'}`
          )
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
    expect(await cookie.text()).toContain(
      'render:2;forwarded-cookie:none'
    )
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

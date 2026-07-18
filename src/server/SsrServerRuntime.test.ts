import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { useSsrRequestContext } from '../SsrRequestContext'
import { createSsrManagedServer, type SsrManagedServer } from './SsrServerRuntime'

let managed: SsrManagedServer | undefined
let root = ''

afterEach(async () => {
  await managed?.close().catch(() => undefined)
  if (root) await rm(root, { recursive: true, force: true })
  managed = undefined
  root = ''
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
      loadRuntime: async () => ({
        default: {
          name: 'test-runtime',
          entries: [
            {
              id: 'spa',
              kind: 'spa',
              template: 'index.html',
              hosts: ['*'],
            },
          ],
          server: {
            root,
            host: '127.0.0.1',
            port: 0,
            publicConfig: {},
          },
        },
      }),
    })
    await managed.listen()
    const { port } = managed.address()
    const health = await fetch(`http://127.0.0.1:${port}/healthz`)
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`)
    const page = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { accept: 'text/html' },
    })
    const missing = await fetch(`http://127.0.0.1:${port}/missing.json`)

    expect(health.status).toBe(200)
    expect(ready.status).toBe(200)
    expect(await page.text()).toContain('<div id="app"></div>')
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
        if (context.url.pathname === '/timeout') {
          await new Promise<never>(() => undefined)
        }
        return () => h('main', 'ready')
      },
    })
    managed = await createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => ({
        default: {
          name: 'test-runtime',
          entries: [{
            id: 'ssr',
            kind: 'ssr',
            template: 'site.html',
            hosts: ['*'],
            application: { id: 'test-app', rootComponent: Root },
          }],
          server: {
            root,
            host: '127.0.0.1',
            port: 0,
            requestTimeoutMs: 20,
            publicConfig: {},
          },
        },
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

    expect(redirect.status).toBe(307)
    expect(redirect.headers.get('location')).toBe(
      `http://127.0.0.1:${port}/target`
    )
    expect(timeout.status).toBe(504)
  })

  it('transforms a development SSR template by entry filename', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    await writeFile(
      join(root, 'site.html'),
      '<!doctype html><html><head></head><body><div id="app"></div></body></html>'
    )
    const transforms: Array<{ url: string; originalUrl?: string }> = []
    managed = await createSsrManagedServer({
      production: false,
      root,
      vite: {
        async transformIndexHtml(url: string, html: string, originalUrl?: string) {
          transforms.push({ url, originalUrl })
          return html.replace(
            '</body>',
            '<script type="module" src="/@id/virtual:vue-ssr-lite/client/storefront"></script></body>'
          )
        },
      } as any,
      loadRuntime: async () => ({
        default: {
          name: 'test-runtime',
          entries: [
            {
              id: 'storefront',
              kind: 'ssr',
              template: 'site.html',
              hosts: ['*'],
              application: {
                id: 'storefront',
                rootComponent: defineComponent({
                  setup: () => () => h('main', 'interactive'),
                }),
              },
            },
          ],
          server: {
            root,
            host: '127.0.0.1',
            port: 0,
            publicConfig: {},
          },
        },
      }),
    })
    await managed.listen()
    const { port } = managed.address()
    const page = await fetch(`http://127.0.0.1:${port}/products/item?view=full`, {
      headers: { accept: 'text/html' },
    })
    const html = await page.text()

    expect(page.status).toBe(200)
    expect(transforms).toEqual([
      { url: '/site.html', originalUrl: '/products/item?view=full' },
    ])
    expect(html).toContain('virtual:vue-ssr-lite/client/storefront')
    expect(html).toContain('<main>interactive</main>')
  })

  it('serves production assets and hides render failure details', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-'))
    const clientRoot = join(root, 'dist/client')
    await mkdir(join(clientRoot, 'assets'), { recursive: true })
    await writeFile(
      join(clientRoot, 'site.html'),
      '<!doctype html><html><head></head><body><div id="app"></div></body></html>'
    )
    await writeFile(join(clientRoot, 'assets/app-123.js'), 'export default 1')
    const Root = defineComponent({
      setup() {
        throw new Error('secret-internal-render-path')
      },
    })
    managed = await createSsrManagedServer({
      production: true,
      root,
      loadRuntime: async () => ({
        default: {
          name: 'test-runtime',
          entries: [{
            id: 'ssr',
            kind: 'ssr',
            template: 'site.html',
            hosts: ['*'],
            application: { id: 'test-app', rootComponent: Root },
          }],
          server: {
            root,
            host: '127.0.0.1',
            port: 0,
            publicConfig: {},
          },
        },
      }),
    })
    await managed.listen()
    const { port } = managed.address()
    const asset = await fetch(`http://127.0.0.1:${port}/assets/app-123.js`)
    const failed = await fetch(`http://127.0.0.1:${port}/failure`, {
      headers: { accept: 'text/html' },
    })
    const errorHtml = await failed.text()

    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect(failed.status).toBe(500)
    expect(errorHtml).not.toContain('secret-internal-render-path')
  })
})

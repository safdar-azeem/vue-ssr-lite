import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { defineSsrConfig } from '../SsrConfigRuntime'
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

const spaConfig = () =>
  defineSsrConfig({
    name: 'test-runtime',
    runtime: 'unified',
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
        default: defineSsrConfig({
          name: 'test-runtime',
          runtime: 'unified',
          server: { requestTimeoutMs: 20 },
          applications: {
            ssr: {
              render: 'ssr',
              application: { id: 'test-app', rootComponent: Root },
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

    expect(redirect.status).toBe(307)
    expect(redirect.headers.get('location')).toBe(
      `http://127.0.0.1:${port}/target`
    )
    expect(timeout.status).toBe(504)
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
          server: { trustProxy: true },
          applications: {
            storefront: {
              render: 'ssr',
              application: { id: 'storefront', rootComponent: Root },
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
})

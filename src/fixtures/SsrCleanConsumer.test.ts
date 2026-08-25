import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { build, createServer, type ViteDevServer } from 'vite'
import {
  extractSsrViteEntries,
  generateSsrClientModule,
  generateSsrRuntimeModule,
  loadSsrConfigFile,
  normalizeSsrConfig,
  resolveSsrConfigPath,
} from '../SsrConfigCompileRuntime'
import { vueSsrLite } from '../vite/SsrVitePlugin'
import { defineSsrConfig } from '../SsrConfigRuntime'
import {
  createSsrManagedServer,
  type SsrManagedServer,
} from '../server/SsrServerRuntime'

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/clean-consumer'
)

let devServer: ViteDevServer | undefined
let managedServer: SsrManagedServer | undefined
let productionOutDir = ''

afterEach(async () => {
  await devServer?.close()
  await managedServer?.close().catch(() => undefined)
  devServer = undefined
  managedServer = undefined
  if (productionOutDir) {
    await rm(productionOutDir, { recursive: true, force: true })
    productionOutDir = ''
  }
})

describe('zero-config clean consumer fixture', () => {
  it('discovers standard Vue files without ssr.config', async () => {
    expect(await resolveSsrConfigPath(fixtureRoot)).toBeUndefined()
    const config = await loadSsrConfigFile(fixtureRoot)
    const normalized = normalizeSsrConfig(config, { root: fixtureRoot })
    expect(normalized.applications.app).toMatchObject({
      id: 'app',
      render: 'ssr',
      template: './index.html',
      mountSelector: '#app',
      hosts: ['*'],
    })
    expect(normalized.applications.app.application).toEqual({
      module: './src/main.ts',
    })
  })

  it('generates the default SSR browser and server entries', async () => {
    const config = await loadSsrConfigFile(fixtureRoot)
    const entries = extractSsrViteEntries(config, { root: fixtureRoot })
    expect(entries.applications).toEqual([
      expect.objectContaining({
        id: 'app',
        kind: 'ssr',
        definition: './src/main.ts',
        template: './index.html',
        mountSelector: '#app',
      }),
    ])
    const client = generateSsrClientModule(fixtureRoot, entries.applications[0])
    expect(client).toContain('hydrateSsrApplication')
    expect(client).toContain('/src/main.ts')
    expect(client).toContain('link[data-vue-ssr-lite-style]')
    expect(client.indexOf('data-vue-ssr-lite-style')).toBeLessThan(
      client.indexOf('const definition')
    )
    const runtime = generateSsrRuntimeModule(
      fixtureRoot,
      undefined,
      entries.applications
    )
    expect(runtime).toContain('const config = {}')
    expect(runtime).toContain('/src/main.ts')
    expect(runtime).not.toContain('ssr.config')
  })

  it('replaces only main.ts while preserving other module scripts', async () => {
    const plugin = vueSsrLite({ root: fixtureRoot })
    const configHook = plugin.config
    if (typeof configHook !== 'function') throw new Error('Missing config hook.')
    await configHook.call(
      {} as never,
      { root: fixtureRoot },
      {
        command: 'serve',
        mode: 'test',
        isSsrBuild: false,
        isPreview: false,
      }
    )
    const transform = plugin.transformIndexHtml
    if (!transform || typeof transform === 'function' || !transform.handler) {
      throw new Error('Missing HTML transform.')
    }
    const source = `${await readFile(join(fixtureRoot, 'index.html'), 'utf8')}\n<script type="module" src="/analytics.ts"></script>`
    const result = await transform.handler.call(
      {} as never,
      source,
      {
        path: '/index.html',
        filename: join(fixtureRoot, 'index.html'),
      } as never
    )
    const html = typeof result === 'string' ? result : String(result?.html || '')
    expect(html).not.toContain('/src/main.ts')
    expect(html).toContain('/analytics.ts')
    expect(html).not.toContain('data-vue-ssr-lite-style')
    const tags = JSON.stringify(typeof result === 'object' ? result.tags : [])
    expect(tags).toContain('/@vue-ssr-lite/client/app')
    expect(tags).not.toContain('children')
  })

  it('serves the generated browser entry through Vite without an HTML proxy', async () => {
    devServer = await createServer({
      root: fixtureRoot,
      configFile: join(fixtureRoot, 'vite.config.ts'),
      server: {
        middlewareMode: true,
        hmr: { server: createHttpServer() },
      },
      appType: 'custom',
    })

    const source = `${await readFile(join(fixtureRoot, 'index.html'), 'utf8')}
<script type="module" src="/analytics.ts"></script>`
    const html = await devServer.transformIndexHtml('/index.html', source, '/')
    const clientUrl = html.match(
      /src=["'](\/@vue-ssr-lite\/client\/[^"']+)["']/i
    )?.[1]

    expect(html).not.toContain('/src/main.ts')
    expect(html).toContain('/analytics.ts')
    expect(html).toContain(
      '<link rel="stylesheet" href="/src/style.css" data-vue-ssr-lite-style="app">'
    )
    expect(html.indexOf('/src/style.css')).toBeLessThan(html.indexOf(clientUrl!))
    expect(clientUrl?.split(/[?#]/, 1)[0]).toBe('/@vue-ssr-lite/client/app')
    expect(html).not.toContain('?html-proxy&index=')

    const browserEntry = await devServer.transformRequest(clientUrl!)
    expect(browserEntry?.code).toContain('hydrateSsrApplication')
    expect(browserEntry?.code).toContain('/src/main.ts')
    expect(browserEntry?.code).toContain('link[data-vue-ssr-lite-style]')
    expect(browserEntry?.code).not.toContain('?html-proxy&index=')

    const applicationEntry = await devServer.transformRequest('/src/main.ts')
    const stylesheetModule = await devServer.transformRequest(
      '/src/style.css?direct'
    )
    const hmrStylesheetModule = await devServer.transformRequest('/src/style.css')
    expect(applicationEntry?.code).toContain('/src/style.css')
    expect(stylesheetModule?.code).toContain('background: rgb(1 2 3)')
    expect(hmrStylesheetModule?.code).toContain('updateStyle')
    expect(hmrStylesheetModule?.code).toContain('import.meta.hot.accept')
  })

  it('sends entry CSS in the initial managed development SSR document', async () => {
    devServer = await createServer({
      root: fixtureRoot,
      configFile: join(fixtureRoot, 'vite.config.ts'),
      server: {
        middlewareMode: true,
        hmr: { server: createHttpServer() },
      },
      appType: 'custom',
    })
    const applicationModule = await devServer.ssrLoadModule('/src/main.ts')
    managedServer = await createSsrManagedServer({
      production: false,
      root: fixtureRoot,
      vite: devServer,
      loadRuntime: async () => ({
        default: defineSsrConfig({
          server: { port: 0 },
          application: applicationModule.default,
        } as any),
      }),
    })
    await managedServer.listen()

    const response = await fetch(
      `http://127.0.0.1:${managedServer.address().port}/`,
      { headers: { accept: 'text/html' } }
    )
    const html = await response.text()
    const stylesheetIndex = html.indexOf('/src/style.css')
    const clientIndex = html.indexOf('/@vue-ssr-lite/client/app')
    expect(response.status).toBe(200)
    expect(html).toContain('<div>clean-consumer</div>')
    expect(html).toContain('data-vue-ssr-lite-style="app"')
    expect(stylesheetIndex).toBeGreaterThan(-1)
    expect(stylesheetIndex).toBeLessThan(clientIndex)
  })

  it('bundles the generated browser entry as the production HTML entry', async () => {
    productionOutDir = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-client-'))
    await build({
      root: fixtureRoot,
      configFile: join(fixtureRoot, 'vite.config.ts'),
      base: '/products/',
      build: {
        outDir: productionOutDir,
        emptyOutDir: true,
      },
    })

    const builtHtml = await readFile(join(productionOutDir, 'index.html'), 'utf8')
    const manifest = JSON.parse(
      await readFile(join(productionOutDir, '.vite/manifest.json'), 'utf8')
    ) as Record<string, {
      file?: string
      isEntry?: boolean
      css?: string[]
    }>

    expect(builtHtml).toContain('<title>Clean Consumer</title>')
    expect(builtHtml).not.toContain('/src/main.ts')
    expect(builtHtml).not.toContain('/@vue-ssr-lite/client/app')
    expect(builtHtml).not.toContain('?html-proxy&index=')
    expect(builtHtml).toMatch(
      /<script type="module"[^>]+src="\/products\/assets\/[^"']+\.js"/
    )
    const stylesheetHref = builtHtml.match(
      /<link rel="stylesheet"[^>]+href="(\/products\/assets\/[^"']+\.css)"/
    )?.[1]
    expect(stylesheetHref).toBeTruthy()
    expect(
      Object.values(manifest).some((entry) =>
        entry.css?.some((file) => file.endsWith('.css'))
      )
    ).toBe(true)
    expect(
      Object.values(manifest).some(
        (entry) => entry.isEntry && entry.file?.endsWith('.js')
      )
    ).toBe(true)

    const Root = defineComponent({
      setup: () => () => h('main', 'production-clean-consumer'),
    })
    managedServer = await createSsrManagedServer({
      production: true,
      root: fixtureRoot,
      loadRuntime: async () => ({
        default: defineSsrConfig({
          server: {
            port: 0,
            clientOutDir: productionOutDir,
          },
          resolveSiteUrl: () => 'https://example.com',
          application: { root: Root },
          template: './index.html',
          domain: {
            production: 'localhost',
            customDomains: true,
          },
        } as any),
      }),
    })
    await managedServer.listen()
    const response = await fetch(
      `http://127.0.0.1:${managedServer.address().port}/`,
      { headers: { accept: 'text/html', host: 'localhost' } }
    )
    const responseHtml = await response.text()
    expect(response.status).toBe(200)
    expect(responseHtml).toContain(stylesheetHref!)
    expect(responseHtml).toContain('<main>production-clean-consumer</main>')
  })
})

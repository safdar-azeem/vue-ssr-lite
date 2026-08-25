import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import vue from '@vitejs/plugin-vue'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { build, createServer, type ViteDevServer } from 'vite'
import {
  parseSsrProductionAssetMetadata,
  SSR_PRODUCTION_ASSET_METADATA_PATH,
} from '../SsrAssetMetadata'
import {
  extractSsrViteEntries,
  generateSsrClientModule,
  generateSsrRuntimeModule,
  loadSsrConfigFile,
  normalizeSsrConfig,
  resolveSsrConfigPath,
} from '../SsrConfigCompileRuntime'
import { vueSsrLite } from '../vite/SsrVitePlugin'
import { importSsrViteModule } from '../vite/SsrViteModuleRuntime'
import { defineSsrConfig } from '../SsrConfigRuntime'
import {
  createSsrManagedServer,
  type SsrManagedServer,
} from '../server/SsrServerRuntime'

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/clean-consumer'
)
const packageRoot = join(fixtureRoot, '../..')

let devServer: ViteDevServer | undefined
let managedServer: SsrManagedServer | undefined
let productionOutDir = ''
let viteCacheDir = ''
let coldConsumerRoot = ''

afterEach(async () => {
  await devServer?.close()
  await managedServer?.close().catch(() => undefined)
  devServer = undefined
  managedServer = undefined
  if (productionOutDir) {
    await rm(productionOutDir, { recursive: true, force: true })
    productionOutDir = ''
  }
  if (viteCacheDir) {
    await rm(viteCacheDir, { recursive: true, force: true })
    viteCacheDir = ''
  }
  if (coldConsumerRoot) {
    await rm(coldConsumerRoot, { recursive: true, force: true })
    coldConsumerRoot = ''
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
    expect(client).toContain('await Promise.all(__vueSsrLiteRenderedStyles.map')
    expect(client.indexOf('data-vue-ssr-lite-style')).toBeLessThan(
      client.indexOf('const definition')
    )
    expect(client.indexOf('__vueSsrLiteRenderedStyles')).toBeLessThan(
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

  it('uses Vite development paths when configured with a CDN base', async () => {
    const cdnBase = 'https://cdn.example.com/products/'
    devServer = await createServer({
      root: fixtureRoot,
      configFile: join(fixtureRoot, 'vite.config.ts'),
      base: cdnBase,
      server: {
        middlewareMode: true,
        hmr: { server: createHttpServer() },
      },
      appType: 'custom',
    })

    const source = await readFile(join(fixtureRoot, 'index.html'), 'utf8')
    const transformedHtml = await devServer.transformIndexHtml(
      '/index.html',
      source,
      '/lazy'
    )
    const clientUrl = transformedHtml.match(
      /src=["'](\/products\/@vue-ssr-lite\/client\/[^"']+)["']/i
    )?.[1]

    expect(devServer.config.base).toBe('/products/')
    expect(transformedHtml).toContain('/products/@vue-ssr-lite/client/app')
    expect(clientUrl?.split(/[?#]/, 1)[0]).toBe(
      '/products/@vue-ssr-lite/client/app'
    )
    expect(transformedHtml).toContain(
      'href="/products/src/style.css" data-vue-ssr-lite-style="app"'
    )
    expect(transformedHtml).not.toContain(cdnBase)

    const browserEntry = await devServer.transformRequest(clientUrl!)
    expect(browserEntry?.code).toContain('hydrateSsrApplication')
    expect(browserEntry?.code).toContain('/src/main.ts')

    const applicationModule = await importSsrViteModule(devServer, '/src/main.ts')
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
    const origin = `http://127.0.0.1:${managedServer.address().port}`
    const [home, lazy] = await Promise.all([
      fetch(`${origin}/`, { headers: { accept: 'text/html' } }).then(
        (response) => response.text()
      ),
      fetch(`${origin}/lazy`, { headers: { accept: 'text/html' } }).then(
        (response) => response.text()
      ),
    ])

    expect(home).not.toContain('LazyPage.vue?vue')
    expect(home).not.toContain('AsyncCard.vue?vue')
    expect(lazy).toContain('lazy-consumer')
    expect(lazy).toContain('async-card')
    expect(lazy).toContain('/products/@vue-ssr-lite/client/app')
    expect(lazy).toContain('/products/src/style.css')
    expect(lazy).toContain('/products/src/LazyPage.vue?vue')
    expect(lazy).toContain('/products/src/AsyncCard.vue?vue')
    expect(lazy).not.toContain(cdnBase)

    const renderedStylesheets = [...lazy.matchAll(
      /<link rel="stylesheet" href="([^"]+)" data-vue-ssr-lite-rendered-style="app">/g
    )].map((match) => match[1].replaceAll('&amp;', '&'))
    expect(renderedStylesheets).toHaveLength(2)
    for (const stylesheetUrl of renderedStylesheets) {
      const stylesheetResponse = await fetch(`${origin}${stylesheetUrl}`)
      expect(stylesheetResponse.status).toBe(200)
      expect(await stylesheetResponse.text()).toContain('updateStyle')
    }
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
    const applicationModule = await importSsrViteModule(devServer, '/src/main.ts')
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
    expect(html).toContain('class="home-page"')
    expect(html).toContain('clean-consumer</div>')
    expect(html).toContain('data-vue-ssr-lite-style="app"')
    expect(stylesheetIndex).toBeGreaterThan(-1)
    expect(stylesheetIndex).toBeLessThan(clientIndex)
  })

  it('serves concurrent first SSR navigations from a cold Vite optimizer cache', async () => {
    coldConsumerRoot = await mkdtemp(
      join(tmpdir(), 'vue-ssr-lite-cold-consumer-')
    )
    viteCacheDir = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-vite-cache-'))
    await cp(fixtureRoot, coldConsumerRoot, { recursive: true })
    const mainPath = join(coldConsumerRoot, 'src/main.ts')
    await writeFile(
      mainPath,
      (await readFile(mainPath, 'utf8')).replace(
        "../../../src/index",
        'vue-ssr-lite'
      )
    )
    const installedModules = join(coldConsumerRoot, 'node_modules')
    const installedPackage = join(installedModules, 'vue-ssr-lite')
    await mkdir(installedPackage, { recursive: true })
    await Promise.all([
      writeFile(
        join(installedPackage, 'package.json'),
        JSON.stringify({
          name: 'vue-ssr-lite',
          type: 'module',
          exports: {
            '.': './index.mjs',
            './client': './client.mjs',
          },
        })
      ),
      writeFile(
        join(installedPackage, 'index.mjs'),
        'export const defineApplication = (definition) => definition\n'
      ),
      writeFile(
        join(installedPackage, 'client.mjs'),
        'export const hydrateSsrApplication = () => {}\n'
      ),
      symlink(join(packageRoot, 'node_modules/vue'), join(installedModules, 'vue')),
      symlink(
        join(packageRoot, 'node_modules/vue-router'),
        join(installedModules, 'vue-router')
      ),
    ])
    devServer = await createServer({
      root: coldConsumerRoot,
      configFile: false,
      cacheDir: viteCacheDir,
      plugins: [vueSsrLite({ root: coldConsumerRoot }), vue()],
      server: {
        middlewareMode: true,
        hmr: { server: createHttpServer() },
      },
      appType: 'custom',
    })
    const applicationModule = await importSsrViteModule(devServer, '/src/main.ts')
    const clientGraph = devServer.environments.client.moduleGraph
    const hasGeneratedClientEntry = () =>
      [...clientGraph.urlToModuleMap.values()].some((module) =>
        module.url.includes('/@vue-ssr-lite/client/app')
      )
    expect(hasGeneratedClientEntry()).toBe(false)

    managedServer = await createSsrManagedServer({
      production: false,
      root: coldConsumerRoot,
      vite: devServer,
      loadRuntime: async () => ({
        default: defineSsrConfig({
          server: { port: 0 },
          application: applicationModule.default,
        } as any),
      }),
    })
    await managedServer.listen()
    expect(hasGeneratedClientEntry()).toBe(false)
    const origin = `http://127.0.0.1:${managedServer.address().port}`
    const firstWave = await Promise.all(
      ['/', '/', '/lazy'].map(async (path) => {
        const response = await fetch(`${origin}${path}`, {
          headers: { accept: 'text/html' },
        })
        return { path, status: response.status, html: await response.text() }
      })
    )

    for (const { path, status, html } of firstWave) {
      expect(status, path).toBe(200)
      expect(html, path).toContain('/@vue-ssr-lite/client/app')
      expect(html, path).toContain('/src/style.css')
      expect(html, path).toContain('data-vue-ssr-lite-style="app"')
      expect(html, path).not.toContain('Application unavailable')
      expect(html, path).not.toContain(
        'cannot inspect eager imports for untransformed Vite module'
      )
      expect(html.indexOf('/src/style.css'), path).toBeLessThan(
        html.indexOf('/@vue-ssr-lite/client/app')
      )
      if (path === '/lazy') {
        expect(html).toContain('lazy-consumer')
        expect(html).toContain('data-vue-ssr-lite-rendered-style="app"')
      } else {
        expect(html).toContain('class="home-page"')
        expect(html).toContain('clean-consumer</div>')
      }
    }
    const clientModuleUrls = [...clientGraph.urlToModuleMap.values()].map(
      (module) => module.url
    )
    expect(clientModuleUrls).toContainEqual(
      expect.stringContaining('vue-ssr-lite_client.js?v=')
    )

    const subsequent = await fetch(`${origin}/`, {
      headers: { accept: 'text/html' },
    })
    const subsequentHtml = await subsequent.text()
    expect(subsequent.status).toBe(200)
    expect(subsequentHtml).toContain('class="home-page"')
    expect(subsequentHtml).not.toContain('Application unavailable')
  })

  it('injects only the rendered lazy Vue route CSS in development', async () => {
    devServer = await createServer({
      root: fixtureRoot,
      configFile: join(fixtureRoot, 'vite.config.ts'),
      server: {
        middlewareMode: true,
        hmr: { server: createHttpServer() },
      },
      appType: 'custom',
    })
    const applicationModule = await importSsrViteModule(devServer, '/src/main.ts')
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
    const origin = `http://127.0.0.1:${managedServer.address().port}`
    const [home, lazy] = await Promise.all([
      fetch(`${origin}/`, { headers: { accept: 'text/html' } }).then((response) => response.text()),
      fetch(`${origin}/lazy`, { headers: { accept: 'text/html' } }).then((response) => response.text()),
    ])

    expect(home).not.toContain('LazyPage.vue?vue')
    expect(lazy).toContain('lazy-consumer')
    expect(lazy).toContain('LazyPage.vue?vue')
    expect(lazy).toContain('AsyncCard.vue?vue')
    expect(lazy).toContain('data-vue-ssr-lite-rendered-style="app"')
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
    const ssrManifest = JSON.parse(
      await readFile(join(productionOutDir, '.vite/ssr-manifest.json'), 'utf8')
    ) as Record<string, string[]>

    expect(builtHtml).toContain('<title>Clean Consumer</title>')
    expect(builtHtml).not.toContain('/src/main.ts')
    expect(builtHtml).not.toContain('/@vue-ssr-lite/client/app')
    expect(builtHtml).not.toContain('?html-proxy&index=')
    const entryScriptHref = builtHtml.match(
      /<script type="module"[^>]+src="(\/products\/assets\/[^"']+\.js)"/
    )?.[1]
    expect(entryScriptHref).toBeTruthy()
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
      Object.entries(ssrManifest).some(
        ([id, assets]) =>
          id.endsWith('src/LazyPage.vue') &&
          assets.some((asset) => asset.endsWith('.css')) &&
          assets.some((asset) => asset.endsWith('.js'))
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
        default: {
          ...defineSsrConfig({
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
          __vueSsrLiteViteBase: '/products/',
        },
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
    const emittedStylesheet = await readFile(
      join(productionOutDir, stylesheetHref!.replace(/^\/products\//, ''))
    )
    const stylesheetResponse = await fetch(
      `http://127.0.0.1:${managedServer.address().port}${stylesheetHref}`
    )
    expect(stylesheetResponse.status).toBe(200)
    expect(stylesheetResponse.headers.get('content-type')).toBe(
      'text/css; charset=utf-8'
    )
    expect(stylesheetResponse.headers.get('content-length')).toBe(
      String(emittedStylesheet.byteLength)
    )
    // Rollup does not expose hash-substitution provenance for OutputAsset, so
    // CSS stays conservative instead of relying on its hash-looking filename.
    expect(stylesheetResponse.headers.get('cache-control')).toBe(
      'public, max-age=3600'
    )
    expect(Buffer.from(await stylesheetResponse.arrayBuffer())).toEqual(
      emittedStylesheet
    )
    const emittedEntry = await readFile(
      join(productionOutDir, entryScriptHref!.replace(/^\/products\//, ''))
    )
    const entryResponse = await fetch(
      `http://127.0.0.1:${managedServer.address().port}${entryScriptHref}`
    )
    expect(entryResponse.status).toBe(200)
    expect(entryResponse.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable'
    )
    expect(Buffer.from(await entryResponse.arrayBuffer())).toEqual(emittedEntry)

    await managedServer.close()
    managedServer = undefined
    devServer = await createServer({
      root: fixtureRoot,
      configFile: join(fixtureRoot, 'vite.config.ts'),
      server: {
        middlewareMode: true,
        hmr: { server: createHttpServer() },
      },
      appType: 'custom',
    })
    const applicationModule = await importSsrViteModule(devServer, '/src/main.ts')
    managedServer = await createSsrManagedServer({
      production: true,
      root: fixtureRoot,
      loadRuntime: async () => ({
        default: {
          ...defineSsrConfig({
            server: { port: 0, clientOutDir: productionOutDir },
            resolveSiteUrl: () => 'https://example.com',
            application: applicationModule.default,
            template: './index.html',
            domain: { production: 'localhost', customDomains: true },
          } as any),
          __vueSsrLiteViteBase: '/products/',
        },
      }),
    })
    await managedServer.listen()
    const homeResponse = await fetch(
      `http://127.0.0.1:${managedServer.address().port}/`,
      { headers: { accept: 'text/html', host: 'localhost' } }
    )
    const lazyResponse = await fetch(
      `http://127.0.0.1:${managedServer.address().port}/lazy`,
      { headers: { accept: 'text/html', host: 'localhost' } }
    )
    const lazyHtml = await lazyResponse.text()
    const homeHtml = await homeResponse.text()
    const lazyAssets = Object.entries(ssrManifest).find(([id]) =>
      id.endsWith('src/LazyPage.vue')
    )?.[1] ?? []
    const asyncCardAssets = Object.entries(ssrManifest).find(([id]) =>
      id.endsWith('src/AsyncCard.vue')
    )?.[1] ?? []
    const lazyCss = lazyAssets.find((asset) => asset.endsWith('.css'))
    const lazyJs = lazyAssets.find((asset) => asset.endsWith('.js'))
    const asyncCardCss = asyncCardAssets.find((asset) => asset.endsWith('.css'))
    const asyncCardJs = asyncCardAssets.find((asset) => asset.endsWith('.js'))
    expect(lazyCss).toBeTruthy()
    expect(lazyJs).toBeTruthy()
    expect(asyncCardCss).toBeTruthy()
    expect(asyncCardJs).toBeTruthy()
    expect(lazyResponse.status).toBe(200)
    expect(homeResponse.status).toBe(200)
    expect(homeHtml).not.toContain(lazyCss!)
    expect(homeHtml).not.toContain(lazyJs!)
    expect(lazyHtml).toContain('lazy-consumer')
    expect(lazyHtml).toContain('async-card')
    expect(lazyHtml).toContain(`rel="stylesheet" href="${lazyCss}"`)
    expect(lazyHtml).toContain(`rel="modulepreload" href="${lazyJs}"`)
    expect(lazyHtml).toContain(`rel="stylesheet" href="${asyncCardCss}"`)
    expect(lazyHtml).toContain(`rel="modulepreload" href="${asyncCardJs}"`)
  })

  it('keeps manifest-owned stable Vite output names conservatively cached', async () => {
    productionOutDir = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-client-'))
    await build({
      root: fixtureRoot,
      configFile: join(fixtureRoot, 'vite.config.ts'),
      base: '/products/',
      build: {
        outDir: productionOutDir,
        emptyOutDir: true,
        rollupOptions: {
          output: {
            entryFileNames: 'assets/[name].js',
            chunkFileNames: 'assets/[name].js',
            assetFileNames: 'assets/[name][extname]',
          },
        },
      },
    })

    const manifest = JSON.parse(
      await readFile(join(productionOutDir, '.vite/manifest.json'), 'utf8')
    ) as Record<string, { file?: string; isEntry?: boolean }>
    const stableEntry = Object.values(manifest).find(
      (entry) => entry.isEntry && entry.file?.endsWith('.js')
    )?.file
    expect(stableEntry).toBeTruthy()
    expect(stableEntry).not.toMatch(/-[A-Za-z0-9_-]{6,}\.js$/)

    const cacheMetadata = parseSsrProductionAssetMetadata(
      await readFile(
        join(productionOutDir, SSR_PRODUCTION_ASSET_METADATA_PATH),
        'utf8'
      )
    )
    expect(cacheMetadata.has(stableEntry!)).toBe(false)

    const Root = defineComponent({
      setup: () => () => h('main', 'stable-output-consumer'),
    })
    managedServer = await createSsrManagedServer({
      production: true,
      root: fixtureRoot,
      loadRuntime: async () => ({
        default: {
          ...defineSsrConfig({
            server: { port: 0, clientOutDir: productionOutDir },
            resolveSiteUrl: () => 'https://example.com',
            application: { root: Root },
            template: './index.html',
            domain: { production: 'localhost', customDomains: true },
          } as any),
          __vueSsrLiteViteBase: '/products/',
        },
      }),
    })
    await managedServer.listen()
    const assetResponse = await fetch(
      `http://127.0.0.1:${managedServer.address().port}/products/${stableEntry}`
    )

    expect(assetResponse.status).toBe(200)
    expect(assetResponse.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8'
    )
    expect(assetResponse.headers.get('cache-control')).toBe(
      'public, max-age=3600'
    )
    expect((await assetResponse.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  it('excludes explicit hash-looking chunk filenames from revision metadata', async () => {
    productionOutDir = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-client-'))
    const explicitFileName = 'assets/manual-ABCDEF12.js'
    const publicId = 'virtual:explicit-hash-looking-chunk'
    const resolvedId = `\0${publicId}`
    await build({
      root: fixtureRoot,
      configFile: join(fixtureRoot, 'vite.config.ts'),
      base: '/products/',
      plugins: [
        {
          name: 'test-explicit-hash-looking-chunk',
          buildStart() {
            this.emitFile({
              type: 'chunk',
              id: publicId,
              fileName: explicitFileName,
            })
          },
          resolveId(id) {
            if (id === publicId) return resolvedId
          },
          load(id) {
            if (id === resolvedId) return 'export const manual = true'
          },
        },
      ],
      build: { outDir: productionOutDir, emptyOutDir: true },
    })

    const emittedSource = await readFile(
      join(productionOutDir, explicitFileName)
    )
    expect(emittedSource.byteLength).toBeGreaterThan(0)
    // The literal filename intentionally resembles Vite's normal
    // `assets/[name]-[hash].js` output despite bypassing that pattern.
    expect(explicitFileName).toMatch(/^assets\/[A-Za-z0-9_-]+-[A-Z0-9]{8}\.js$/)

    const manifest = JSON.parse(
      await readFile(join(productionOutDir, '.vite/manifest.json'), 'utf8')
    ) as Record<string, { file?: string }>
    expect(
      Object.values(manifest).some(({ file }) => file === explicitFileName)
    ).toBe(true)
    const cacheMetadata = parseSsrProductionAssetMetadata(
      await readFile(
        join(productionOutDir, SSR_PRODUCTION_ASSET_METADATA_PATH),
        'utf8'
      )
    )
    expect(cacheMetadata.has(explicitFileName)).toBe(false)

    const Root = defineComponent({
      setup: () => () => h('main', 'explicit-output-consumer'),
    })
    managedServer = await createSsrManagedServer({
      production: true,
      root: fixtureRoot,
      loadRuntime: async () => ({
        default: {
          ...defineSsrConfig({
            server: { port: 0, clientOutDir: productionOutDir },
            resolveSiteUrl: () => 'https://example.com',
            application: { root: Root },
            template: './index.html',
            domain: { production: 'localhost', customDomains: true },
          } as any),
          __vueSsrLiteViteBase: '/products/',
        },
      }),
    })
    await managedServer.listen()
    const response = await fetch(
      `http://127.0.0.1:${managedServer.address().port}/products/${explicitFileName}`
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=3600'
    )
    expect(Buffer.from(await response.arrayBuffer())).toEqual(emittedSource)
  })

  it('preserves a Vite CDN base for rendered lazy route assets', async () => {
    productionOutDir = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-client-'))
    const base = 'https://cdn.example.com/products/'
    await build({
      root: fixtureRoot,
      configFile: join(fixtureRoot, 'vite.config.ts'),
      base,
      build: { outDir: productionOutDir, emptyOutDir: true },
    })
    const ssrManifest = JSON.parse(
      await readFile(join(productionOutDir, '.vite/ssr-manifest.json'), 'utf8')
    ) as Record<string, string[]>
    const lazyAssets = Object.entries(ssrManifest).find(([id]) =>
      id.endsWith('src/LazyPage.vue')
    )?.[1] ?? []
    const lazyCss = lazyAssets.find((asset) => asset.endsWith('.css'))
    const lazyJs = lazyAssets.find((asset) => asset.endsWith('.js'))
    expect(lazyCss).toMatch(/^https:\/\/cdn\.example\.com\/products\//)
    expect(lazyJs).toMatch(/^https:\/\/cdn\.example\.com\/products\//)

    devServer = await createServer({
      root: fixtureRoot,
      configFile: join(fixtureRoot, 'vite.config.ts'),
      server: {
        middlewareMode: true,
        hmr: { server: createHttpServer() },
      },
      appType: 'custom',
    })
    const applicationModule = await importSsrViteModule(devServer, '/src/main.ts')
    managedServer = await createSsrManagedServer({
      production: true,
      root: fixtureRoot,
      loadRuntime: async () => ({
        default: {
          ...defineSsrConfig({
            server: { port: 0, clientOutDir: productionOutDir },
            resolveSiteUrl: () => 'https://example.com',
            application: applicationModule.default,
            template: './index.html',
            domain: { production: 'localhost', customDomains: true },
          } as any),
          __vueSsrLiteViteBase: base,
        },
      }),
    })
    await managedServer.listen()
    const html = await fetch(
      `http://127.0.0.1:${managedServer.address().port}/lazy`,
      { headers: { accept: 'text/html', host: 'localhost' } }
    ).then((response) => response.text())
    expect(html).toContain(`rel="stylesheet" href="${lazyCss}"`)
    expect(html).toContain(`rel="modulepreload" href="${lazyJs}"`)
  })

  it('rejects relative Vite bases for production SSR after a real build', async () => {
    productionOutDir = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-client-'))
    await build({
      root: fixtureRoot,
      configFile: join(fixtureRoot, 'vite.config.ts'),
      base: './',
      build: { outDir: productionOutDir, emptyOutDir: true },
    })
    const Root = defineComponent({ setup: () => () => h('main', 'relative') })
    await expect(
      createSsrManagedServer({
        production: true,
        root: fixtureRoot,
        loadRuntime: async () => ({
          default: {
            ...defineSsrConfig({
              server: { port: 0, clientOutDir: productionOutDir },
              resolveSiteUrl: () => 'https://example.com',
              application: { root: Root },
              template: './index.html',
              domain: { production: 'localhost', customDomains: true },
            } as any),
            __vueSsrLiteViteBase: './',
          },
        }),
      })
    ).rejects.toThrow('does not support Vite relative base')
  })
})

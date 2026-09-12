import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import vue from '@vitejs/plugin-vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  SSR_RUNTIME_VIRTUAL_ID,
} from '../SsrConfigCompileRuntime'
import { vueSsrLite } from '../vite/SsrVitePlugin'
import { importSsrViteModule } from '../vite/SsrViteModuleRuntime'
import { defineServer } from '../SsrConfigRuntime'
import { withSsrShells } from '../SsrTestFixtures'
import { createSsrProductionViteBuildOptions } from '../cli/SsrCliBuildOptions'
import type { SsrApplicationRenderer } from '../SsrRenderRuntime'
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

const importEphemeralDevelopmentRuntime = async (server: ViteDevServer) => {
  const runtime = await importSsrViteModule<{
    default: () => Promise<Record<string, any>>
  }>(server, SSR_RUNTIME_VIRTUAL_ID)
  const loadedConfig = await runtime.default()
  return {
    ...runtime,
    default: {
      ...loadedConfig,
      server: {
        ...loadedConfig.server,
        port: 0,
      },
    },
  }
}

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
  vi.unstubAllEnvs()
})

describe('zero-config clean consumer fixture', () => {
  it('discovers standard Vue files without server.ts', async () => {
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
    expect(normalized.applications.app.shell).toMatchObject({
      main: './src/main.ts',
      root: './src/App.vue',
    })
  })

  it('generates the default SSR browser and server entries', async () => {
    const config = await loadSsrConfigFile(fixtureRoot)
    const entries = extractSsrViteEntries(config, { root: fixtureRoot })
    expect(entries.applications).toEqual([
      expect.objectContaining({
        id: 'app',
        kind: 'ssr',
        main: './src/main.ts',
        root: './src/App.vue',
        template: './index.html',
        mountSelector: '#app',
      }),
    ])
    const client = generateSsrClientModule(fixtureRoot, entries.applications[0])
    expect(client).toContain('hydrateSsrApplication')
    expect(client).toContain('/src/main.ts')
    expect(client).toContain('link[data-vue-ssr-lite-style]')
    expect(client).toContain('await Promise.all(__vueSsrLiteRenderedStyles.map')
    const hydrateAt = client.indexOf('await hydrateSsrApplication')
    expect(hydrateAt).toBeGreaterThan(-1)
    expect(client.indexOf('data-vue-ssr-lite-style')).toBeLessThan(hydrateAt)
    expect(client.indexOf('__vueSsrLiteRenderedStyles')).toBeLessThan(hydrateAt)
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

  it.each(['/', '/app/', '/products/'])(
    'serves development resources before runtime reload with base %s', async (base) => {
      devServer = await createServer({
        root: fixtureRoot,
        configFile: join(fixtureRoot, 'vite.config.ts'),
        base,
        server: { middlewareMode: true, hmr: { server: createHttpServer() } },
        appType: 'custom',
      })
      let runtimeLoads = 0
      managedServer = await createSsrManagedServer({
        production: false,
        root: fixtureRoot,
        vite: devServer,
        loadRuntime: () => {
          runtimeLoads += 1
          return importEphemeralDevelopmentRuntime(devServer!)
        },
      })
      await managedServer.listen()
      const origin = `http://127.0.0.1:${managedServer.address().port}`
      const initialLoads = runtimeLoads
      for (const path of [
        '@vite/client', '@vue-ssr-lite/client/app',
        'src/main.ts', 'src/App.vue', 'src/style.css',
      ]) {
        const response = await fetch(`${origin}${base}${path}`)
        expect(response.status).toBe(200)
        await response.text()
        expect(runtimeLoads).toBe(initialLoads)
      }
      const page = await fetch(`${origin}/lazy`, { headers: { accept: 'text/html' } })
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('lazy-consumer')
      expect(runtimeLoads).toBeGreaterThan(initialLoads)
    }
  )

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

    managedServer = await createSsrManagedServer({
      production: false,
      root: fixtureRoot,
      vite: devServer,
      loadRuntime: () => importEphemeralDevelopmentRuntime(devServer!),
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
    managedServer = await createSsrManagedServer({
      production: false,
      root: fixtureRoot,
      vite: devServer,
      loadRuntime: () => importEphemeralDevelopmentRuntime(devServer!),
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
        'export const defineServer = (config) => config\nexport const defineApplication = (definition) => definition\n'
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
      loadRuntime: () => importEphemeralDevelopmentRuntime(devServer!),
    })
    await managedServer.listen()
    // The cache was cold when Vite was created. Managed startup now prepares
    // the guaranteed shell automatically, before the first HTTP navigation.
    expect(hasGeneratedClientEntry()).toBe(true)
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
      expect(html, path).not.toContain('Something went wrong')
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
      expect.stringMatching(/node_modules\/vue-ssr-lite\/client\.mjs(?:\?|$)/)
    )

    const subsequent = await fetch(`${origin}/`, {
      headers: { accept: 'text/html' },
    })
    const subsequentHtml = await subsequent.text()
    expect(subsequent.status).toBe(200)
    expect(subsequentHtml).toContain('class="home-page"')
    expect(subsequentHtml).not.toContain('Something went wrong')
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
    managedServer = await createSsrManagedServer({
      production: false,
      root: fixtureRoot,
      vite: devServer,
      loadRuntime: () => importEphemeralDevelopmentRuntime(devServer!),
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

  it('serves real client + SSR builds with tree-shaken SFC facades and lazy route assets', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('PUBLIC_URL', '')
    vi.stubEnv('HOST', '')
    vi.stubEnv('PORT', '')
    // Match the CLI's canonical root, including macOS /var -> /private/var.
    // Otherwise Vite resolves index.html outside the symlink-spelled root.
    coldConsumerRoot = await realpath(
      await mkdtemp(join(tmpdir(), 'vue-ssr-lite-production-consumer-'))
    )
    await cp(fixtureRoot, coldConsumerRoot, { recursive: true })
    const modules = join(coldConsumerRoot, 'node_modules')
    await mkdir(modules, { recursive: true })
    await symlink(packageRoot, join(modules, 'vue-ssr-lite'))
    await symlink(join(packageRoot, 'node_modules/vue'), join(modules, 'vue'))
    await symlink(join(packageRoot, 'node_modules/vue-router'), join(modules, 'vue-router'))
    await writeFile(join(coldConsumerRoot, 'package.json'), '{"type":"module"}')
    await writeFile(join(coldConsumerRoot, 'server.ts'),
      "import { defineServer } from 'vue-ssr-lite'\nexport default defineServer({ render: 'ssr' })\n")
    // A styleless TS setup SFC reproduces Vite's removed facade: SSR registers
    // src/App.vue, while the client retains only its ?vue&type=script module.
    await writeFile(join(coldConsumerRoot, 'src/App.vue'), `<script setup lang="ts">
import { RouterView } from 'vue-router'
</script>
<template><main class="clean-app"><RouterView /></main></template>`)
    await writeFile(join(coldConsumerRoot, 'src/ScriptLazy.vue'), `<script setup lang="ts">
import './script-lazy.css'
const title = 'script-only-lazy'
</script>
<template><article>{{ title }}</article></template>`)
    await writeFile(join(coldConsumerRoot, 'src/script-lazy.css'), 'article { outline: 1px solid purple; }')
    const mainPath = join(coldConsumerRoot, 'src/main.ts')
    await writeFile(mainPath, (await readFile(mainPath, 'utf8'))
      .replace('../../../src/index', 'vue-ssr-lite')
      .replace('const routes = [', "const routes = [\n  { path: '/script-lazy', component: () => import('./ScriptLazy.vue') },"))
    const fixtureBuildConfig = () => ({
      configFile: false as const,
      plugins: [vueSsrLite(), vue()],
      logLevel: 'silent' as const,
    })
    // The CLI's two production builds, including the real virtual SSR entry.
    // No development module runner or hand-written manifest participates.
    await build({ root: coldConsumerRoot, ...fixtureBuildConfig() })
    await build({ ...createSsrProductionViteBuildOptions(coldConsumerRoot), ...fixtureBuildConfig() })
    const clientRoot = join(coldConsumerRoot, 'dist/client')
    const manifest = JSON.parse(await readFile(join(clientRoot, '.vite/ssr-manifest.json'), 'utf8')) as Record<string, string[]>
    expect(manifest['src/App.vue']).toBeUndefined()
    expect(manifest['src/App.vue?vue&type=script&setup=true&lang.ts']).toBeDefined()
    const scriptAssets = manifest['src/ScriptLazy.vue?vue&type=script&setup=true&lang.ts']!
    expect(scriptAssets.some((asset) => asset.endsWith('.css'))).toBe(true)
    expect(scriptAssets.some((asset) => asset.endsWith('.js'))).toBe(true)
    const lazyAssets = manifest['src/LazyPage.vue']!
    const cardAssets = manifest['src/AsyncCard.vue']!
    expect(lazyAssets.some((asset) => asset.endsWith('.css'))).toBe(true)
    expect(cardAssets.some((asset) => asset.endsWith('.css'))).toBe(true)
    const entry = pathToFileURL(join(coldConsumerRoot, 'dist/server/SsrRuntime.js')).href
    const runtime = await import(entry) as { default: () => Promise<Record<string, any>> }
    const config = await runtime.default()
    expect(config.__vueSsrLiteModuleRoot).toBe(coldConsumerRoot.replaceAll('\\', '/'))
    const renderedModules = new Map<string, readonly string[]>()
    const render: SsrApplicationRenderer = config.__vueSsrLiteRenderApplication
    const errors = vi.fn()
    const productionOptions = {
      production: true, root: coldConsumerRoot,
      loadRuntime: async () => ({ ...config,
        // Ephemeral port and observation only; origin and SSR options remain
        // exactly those of the unchanged defineServer({ render: 'ssr' }).
        server: { ...config.server, host: '127.0.0.1', port: 0, logger: { error: errors } },
        __vueSsrLiteRenderApplication: (async (application, request, options) => {
          const result = await render(application, request, options)
          renderedModules.set(new URL(request.url).pathname, [...result.renderedModules])
          return result
        }) satisfies SsrApplicationRenderer,
      }),
    }
    managedServer = await createSsrManagedServer(productionOptions)
    await managedServer.listen()
    const origin = `http://127.0.0.1:${managedServer.address().port}`
    for (const [path, text] of [['/', 'clean-consumer'], ['/lazy', 'lazy-consumer'], ['/script-lazy', 'script-only-lazy']] as const) {
      const response = await fetch(`${origin}${path}`, { headers: { accept: 'text/html' } })
      const html = await response.text()
      expect(response.status, html).toBe(200)
      expect(html).toContain(text)
      expect(html).not.toContain('Something went wrong')
      expect(renderedModules.get(path)).toContain('src/App.vue')
      if (path === '/') {
        expect(renderedModules.get(path)).toContain('src/HomePage.vue')
        for (const file of [...lazyAssets, ...scriptAssets].filter((asset) => asset.endsWith('.css'))) expect(html).not.toContain(file)
      } else {
        const expected = path === '/lazy' ? [...lazyAssets, ...cardAssets] : scriptAssets
        expect(renderedModules.get(path)).toContain(path === '/lazy' ? 'src/LazyPage.vue' : 'src/ScriptLazy.vue')
        for (const file of expected.filter((asset) => /\.(?:css|js)$/.test(asset))) {
          expect(html).toContain(`href="${file}"`)
          const asset = await fetch(`${origin}${file}`)
          expect(asset.status).toBe(200)
          expect(await asset.text()).not.toBe('')
        }
      }
    }
    expect(errors).not.toHaveBeenCalled()

    // Missing authoritative entries remain fatal after successful startup.
    // Exercise the actual post-render boundary, not a simulated thrown error.
    await managedServer.close()
    for (const key of Object.keys(manifest)) {
      if (key === 'src/App.vue' || key.startsWith('src/App.vue?')) delete manifest[key]
    }
    await writeFile(join(clientRoot, '.vite/ssr-manifest.json'), JSON.stringify(manifest))
    managedServer = await createSsrManagedServer(productionOptions)
    await managedServer.listen()
    const failed = await fetch(`http://127.0.0.1:${managedServer.address().port}/`, { headers: { accept: 'text/html' } })
    expect(failed.status).toBe(500)
    const failedHtml = await failed.text()
    expect(failedHtml).toContain('500 · Internal Server Error')
    expect(failedHtml).toContain('Something went wrong')
    expect(failedHtml).toContain('The request could not be completed.')
    expect(failedHtml).not.toMatch(/src\/App|manifest|module-not-in-manifest|SsrProductionArtifactError/)
    expect(errors).toHaveBeenCalledWith('ssr.request.failed', expect.objectContaining({
      artifact: 'rendered-assets', reason: 'module-not-in-manifest',
      code: 'rendered-assets.module-not-in-manifest',
    }))
    expect(JSON.stringify(errors.mock.calls)).not.toContain(coldConsumerRoot)
  }, 120_000)

  it('bundles the generated browser entry as the production HTML entry', async () => {
    productionOutDir = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-client-'))
    await build({
      root: fixtureRoot,
      configFile: join(fixtureRoot, 'vite.config.ts'),
      base: '/products/',
      build: {
        outDir: productionOutDir,
        emptyOutDir: true,
        assetsInlineLimit: 0,
      },
    })

    const builtHtml = await readFile(join(productionOutDir, 'index.html'), 'utf8')
    const manifest = JSON.parse(
      await readFile(join(productionOutDir, '.vite/manifest.json'), 'utf8')
    ) as Record<string, {
      file?: string
      isEntry?: boolean
      css?: string[]
      assets?: string[]
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
    const importedAsset = Object.values(manifest)
      .flatMap((entry) => entry.assets ?? [])
      .find((asset) => asset.endsWith('.svg'))
    expect(importedAsset).toBeTruthy()

    const Root = defineComponent({
      setup: () => () => h('main', 'production-clean-consumer'),
    })
    managedServer = await createSsrManagedServer({
      production: true,
      root: fixtureRoot,
      loadRuntime: async () => ({
        default: withSsrShells(
          {
            ...defineServer({
              server: {
                port: 0,
                clientOutDir: productionOutDir,
              },
              resolveSiteUrl: () => 'https://example.com',
              template: './index.html',
              domain: {
                production: 'localhost',
                customDomains: true,
              },
            }),
            __vueSsrLiteViteBase: '/products/',
          },
          { app: { root: Root } }
        ),
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
    // The build plugin records Vite-owned extracted stylesheet outputs in its
    // immutable metadata; the server still verifies manifest ownership.
    expect(stylesheetResponse.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable'
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

    const importedAssetResponse = await fetch(
      `http://127.0.0.1:${managedServer.address().port}/products/${importedAsset}`
    )
    expect(importedAssetResponse.status).toBe(200)
    expect(importedAssetResponse.headers.get('content-type')).toBe(
      'image/svg+xml; charset=utf-8'
    )
    expect(importedAssetResponse.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable'
    )
    expect((await importedAssetResponse.arrayBuffer()).byteLength).toBeGreaterThan(0)

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
    managedServer = await createSsrManagedServer({
      production: true,
      root: fixtureRoot,
      loadRuntime: async () => {
        const runtime = await importSsrViteModule<{
          default: () => Promise<Record<string, any>>
        }>(devServer!, SSR_RUNTIME_VIRTUAL_ID)
        const loadedConfig = await runtime.default()
        return {
          default: {
            ...loadedConfig,
            server: {
              ...loadedConfig.server,
              port: 0,
              clientOutDir: productionOutDir,
            },
            resolveSiteUrl: () => 'https://example.com',
            __vueSsrLiteViteBase: '/products/',
          },
        }
      },
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
  }, 30_000)

  it('keeps manifest-owned stable Vite output names conservatively cached', async () => {
    productionOutDir = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-client-'))
    await build({
      root: fixtureRoot,
      configFile: join(fixtureRoot, 'vite.config.ts'),
      base: '/products/',
      build: {
        outDir: productionOutDir,
        emptyOutDir: true,
        assetsInlineLimit: 0,
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
    ) as Record<string, {
      file?: string
      isEntry?: boolean
      css?: string[]
      assets?: string[]
    }>
    const stableEntry = Object.values(manifest).find(
      (entry) => entry.isEntry && entry.file?.endsWith('.js')
    )?.file
    expect(stableEntry).toBeTruthy()
    expect(stableEntry).not.toMatch(/-[A-Za-z0-9_-]{6,}\.js$/)
    const stableCss = Object.values(manifest)
      .flatMap((entry) => entry.css ?? [])
      .find((asset) => asset.endsWith('.css'))
    const stableImportedAsset = Object.values(manifest)
      .flatMap((entry) => entry.assets ?? [])
      .find((asset) => asset.endsWith('.svg'))
    expect(stableCss).toBeTruthy()
    expect(stableImportedAsset).toBeTruthy()

    const cacheMetadata = parseSsrProductionAssetMetadata(
      await readFile(
        join(productionOutDir, SSR_PRODUCTION_ASSET_METADATA_PATH),
        'utf8'
      )
    )
    expect(cacheMetadata.has(stableEntry!)).toBe(false)
    expect(cacheMetadata.has(stableCss!)).toBe(false)
    expect(cacheMetadata.has(stableImportedAsset!)).toBe(false)

    const Root = defineComponent({
      setup: () => () => h('main', 'stable-output-consumer'),
    })
    managedServer = await createSsrManagedServer({
      production: true,
      root: fixtureRoot,
      loadRuntime: async () => ({
        default: withSsrShells(
          {
            ...defineServer({
              server: { port: 0, clientOutDir: productionOutDir },
              resolveSiteUrl: () => 'https://example.com',
              template: './index.html',
              domain: { production: 'localhost', customDomains: true },
            }),
            __vueSsrLiteViteBase: '/products/',
          },
          { app: { root: Root } }
        ),
      }),
    })
    await managedServer.listen()
    const entryResponse = await fetch(
      `http://127.0.0.1:${managedServer.address().port}/products/${stableEntry}`
    )

    expect(entryResponse.status).toBe(200)
    expect(entryResponse.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8'
    )
    expect(entryResponse.headers.get('cache-control')).toBe(
      'public, max-age=3600'
    )
    expect((await entryResponse.arrayBuffer()).byteLength).toBeGreaterThan(0)

    const cssResponse = await fetch(
      `http://127.0.0.1:${managedServer.address().port}/products/${stableCss}`
    )
    expect(cssResponse.status).toBe(200)
    expect(cssResponse.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(cssResponse.headers.get('cache-control')).toBe('public, max-age=3600')
    expect((await cssResponse.arrayBuffer()).byteLength).toBeGreaterThan(0)

    const importedAssetResponse = await fetch(
      `http://127.0.0.1:${managedServer.address().port}/products/${stableImportedAsset}`
    )
    expect(importedAssetResponse.status).toBe(200)
    expect(importedAssetResponse.headers.get('content-type')).toBe(
      'image/svg+xml; charset=utf-8'
    )
    expect(importedAssetResponse.headers.get('cache-control')).toBe(
      'public, max-age=3600'
    )
    expect((await importedAssetResponse.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  it('excludes explicitly named manifest assets from revision metadata', async () => {
    productionOutDir = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-client-'))
    const explicitAssets = [
      {
        fileName: 'assets/manual-stable.css',
        name: 'manual-stable.css',
        originalFileName: 'src/manual-stable.css',
        source: 'body { color: red }',
      },
      {
        fileName: 'assets/manual-ABCDEF12.svg',
        name: 'manual.svg',
        originalFileName: 'src/manual.svg',
        source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
      },
    ] as const
    let explicitReferences: string[] = []
    await build({
      root: fixtureRoot,
      configFile: join(fixtureRoot, 'vite.config.ts'),
      base: '/products/',
      plugins: [
        {
          name: 'test-explicit-output-assets',
          enforce: 'pre',
          buildStart() {
            explicitReferences = explicitAssets.map((asset) =>
              this.emitFile({ type: 'asset', ...asset })
            )
          },
          transform(code, id) {
            if (!id.endsWith('/src/main.ts')) return
            return `${code}\nglobalThis.__explicitAssetUrls = [${explicitReferences
              .map((reference) => `import.meta.ROLLUP_FILE_URL_${reference}`)
              .join(', ')}]`
          },
          generateBundle(_options, bundle) {
            const entry = Object.values(bundle).find(
              (output) => output.type === 'chunk' && output.isEntry
            )
            const metadata = (
              entry as typeof entry & {
                viteMetadata?: { importedAssets: Set<string> }
              }
            )?.viteMetadata
            if (!metadata) this.error('Missing Vite entry asset metadata.')
            for (const { fileName } of explicitAssets) {
              metadata.importedAssets.add(fileName)
            }
          },
        },
      ],
      build: { outDir: productionOutDir, emptyOutDir: true },
    })

    const manifest = JSON.parse(
      await readFile(join(productionOutDir, '.vite/manifest.json'), 'utf8')
    ) as Record<string, { assets?: string[] }>
    const manifestAssets = new Set(
      Object.values(manifest).flatMap((entry) => entry.assets ?? [])
    )
    const cacheMetadata = parseSsrProductionAssetMetadata(
      await readFile(
        join(productionOutDir, SSR_PRODUCTION_ASSET_METADATA_PATH),
        'utf8'
      )
    )
    for (const { fileName } of explicitAssets) {
      expect(manifestAssets.has(fileName)).toBe(true)
      expect(cacheMetadata.has(fileName)).toBe(false)
      expect((await readFile(join(productionOutDir, fileName))).byteLength).toBeGreaterThan(0)
    }

    const Root = defineComponent({
      setup: () => () => h('main', 'explicit-asset-output-consumer'),
    })
    managedServer = await createSsrManagedServer({
      production: true,
      root: fixtureRoot,
      loadRuntime: async () => ({
        default: withSsrShells(
          {
            ...defineServer({
              server: { port: 0, clientOutDir: productionOutDir },
              resolveSiteUrl: () => 'https://example.com',
              template: './index.html',
              domain: {
                production: 'localhost',
                customDomains: true,
              },
            }),
            __vueSsrLiteViteBase: '/products/',
          },
          { app: { root: Root } }
        ),
      }),
    })
    await managedServer.listen()
    for (const { fileName } of explicitAssets) {
      const response = await fetch(
        `http://127.0.0.1:${managedServer.address().port}/products/${fileName}`
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('public, max-age=3600')
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0)
    }
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
        default: withSsrShells(
          {
            ...defineServer({
              server: { port: 0, clientOutDir: productionOutDir },
              resolveSiteUrl: () => 'https://example.com',
              template: './index.html',
              domain: { production: 'localhost', customDomains: true },
            }),
            __vueSsrLiteViteBase: '/products/',
          },
          { app: { root: Root } }
        ),
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
    managedServer = await createSsrManagedServer({
      production: true,
      root: fixtureRoot,
      loadRuntime: async () => {
        const runtime = await importSsrViteModule<{
          default: () => Promise<Record<string, any>>
        }>(devServer!, SSR_RUNTIME_VIRTUAL_ID)
        const loadedConfig = await runtime.default()
        return {
          default: {
            ...loadedConfig,
            server: {
              ...loadedConfig.server,
              port: 0,
              clientOutDir: productionOutDir,
            },
            resolveSiteUrl: () => 'https://example.com',
            __vueSsrLiteViteBase: base,
          },
        }
      },
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
          default: withSsrShells(
            {
              ...defineServer({
                server: { port: 0, clientOutDir: productionOutDir },
                resolveSiteUrl: () => 'https://example.com',
                template: './index.html',
                domain: { production: 'localhost', customDomains: true },
              }),
              __vueSsrLiteViteBase: './',
            },
            { app: { root: Root } }
          ),
        }),
      })
    ).rejects.toThrow('does not support Vite relative base')
  })
})

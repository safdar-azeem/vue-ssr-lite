import { mkdir, mkdtemp, readFile, realpath, writeFile, rm } from 'node:fs/promises'
import { createServer as createHttpServer, request as requestHttp, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createSsrManagedServer, type SsrManagedServer } from '../server/SsrServerRuntime'
import { build, createServer, type ViteDevServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vueSsrLite } from './SsrVitePlugin'
import { closeViteDevServer, provisionHostVuePeers, withSsrShells } from '../SsrTestFixtures'
import { SSR_RENDERER_VIRTUAL_ID } from '../SsrConfigCompileRuntime'

let root = ''
let server: ViteDevServer | undefined
let hmrServer: Server | undefined
let managedServer: SsrManagedServer | undefined

afterEach(async () => {
  await managedServer?.close()
  managedServer = undefined
  await closeViteDevServer(server, hmrServer)
  server = undefined
  hmrServer = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

const writeMinimalConfig = async () => {
  root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-vite-'))
  await writeFile(
    join(root, 'server.ts'),
    `
export default {
  name: 'demo',
  applications: [
    {
      name: 'storefront',
      render: 'ssr',
      template: 'site.html',
      domain: {
        development: 'localhost',
        production: 'example.com',
        customDomains: true,
      },
      publicConfig: { api: { endpoint: 'http://localhost/graphql' } },
    },
  ],
}
`
  )
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/main.ts'), 'export default () => {}\n')
  await writeFile(join(root, 'src/App.vue'), '<template><div /></template>\n')
  await writeFile(join(root, 'site.html'), '<html><body><div id="app"></div></body></html>')
  await provisionHostVuePeers(root)
  return root
}

const runConfig = async (
  pluginRoot: string,
  command: 'serve' | 'build' = 'serve'
) => {
  const plugin = vueSsrLite({ root: pluginRoot })
  const configHook = plugin.config
  if (typeof configHook !== 'function') {
    throw new Error('vueSsrLite must expose a Vite config hook.')
  }
  return (await configHook.call(
    {} as never,
    { root: pluginRoot },
    {
      command,
      mode: 'test',
      isSsrBuild: command === 'build',
      isPreview: false,
    }
  )) as {
    server?: { allowedHosts?: string[] }
    resolve?: { dedupe?: string[] }
    optimizeDeps?: { include?: string[]; exclude?: string[] }
    ssr?: {
      external?: string[]
      noExternal?: Array<string | RegExp>
    }
    build?: {
      outDir?: string
      rollupOptions?: { input?: Record<string, string> }
    }
  }
}

describe('SSR Vite package identity', () => {
  it('adds named application hosts without turning catch-all routing into Vite access', async () => {
    await writeMinimalConfig()
    const config = await runConfig(root)
    expect(config.server?.allowedHosts).toContain('example.com')
    expect(config.server?.allowedHosts).toContain('.example.com')
    expect(config.server?.allowedHosts).not.toContain('*')
    expect((await runConfig(root, 'build')).server).toBeUndefined()
  })

  it.each(['/', '/products/'])(
    'preserves real Vite host security and hybrid application ownership with base %s', async (base) => {
      await writeMinimalConfig()
      const applications = [
        {
          name: 'portal', render: 'ssr' as const, template: 'site.html',
          domain: { development: 'portal.custom.test', mode: 'root' as const, customDomains: true },
        },
        {
          name: 'shop', render: 'ssr' as const, template: 'site.html',
          domain: { development: 'shop.example.test', mode: 'root-and-subdomains' as const },
        },
      ]
      await writeFile(join(root, 'server.ts'), `export default ${JSON.stringify({ applications })}`)
      hmrServer = createHttpServer()
      server = await createServer({
        root, base, configFile: false,
        resolve: { alias: { 'vue-ssr-lite/client': fileURLToPath(new URL('../client.ts', import.meta.url)) } },
        plugins: [vueSsrLite({ root }), vue()],
        server: {
          middlewareMode: true, hmr: { server: hmrServer },
          allowedHosts: ['explicit.example.test'],
        },
        appType: 'custom',
      })
      expect(server.config.server.allowedHosts).toContain('explicit.example.test')
      const classifyRedirect = vi.fn(() => '/home')
      const Shell = defineComponent({ render: () => h('main') })
      const loadRuntime = vi.fn(async () => ({
        default: withSsrShells({
          server: { port: 0 },
          applications: applications.map((application) => ({
            ...application,
            routes: [
              { path: '/', redirect: classifyRedirect },
              { path: '/home', component: Shell, meta: { render: 'spa' as const } },
            ],
          })),
        }, { portal: { root: Shell }, shop: { root: Shell } }),
      }))
      managedServer = await createSsrManagedServer({ production: false, root, vite: server, loadRuntime })
      await managedServer.listen()
      // Connect to loopback while sending the browser's actual custom Host.
      // Node HTTP avoids DNS setup and exercises Vite's real host middleware.
      const get = (host: string, path: string, accept = '*/*') =>
        new Promise<{ status: number; body: string }>((resolveResponse, reject) => {
          const request = requestHttp({
            hostname: '127.0.0.1', port: managedServer!.address().port, path,
            headers: { host, accept },
          }, (response) => {
            let body = ''
            response.setEncoding('utf8')
            response.on('data', (chunk) => { body += chunk })
            response.on('end', () => resolveResponse({ status: response.statusCode!, body }))
            response.on('error', reject)
          })
          request.on('error', reject)
          request.end()
        })
      for (const application of applications) {
        const host = application.domain.development
        const page = await get(host, '/', 'text/html')
        expect(page.status).toBe(200)
        expect(page.body).toContain(`"applicationId":"${application.name}"`)
        expect(classifyRedirect).toHaveBeenCalled()
        const classifications = classifyRedirect.mock.calls.length
        const loads = loadRuntime.mock.calls.length
        for (const path of ['@vite/client', `@vue-ssr-lite/client/${application.name}`, 'src/main.ts']) {
          const resource = await get(host, `${base}${path}`)
          expect(resource.status).toBe(200)
          expect(resource.body.length).toBeGreaterThan(0)
        }
        expect(classifyRedirect).toHaveBeenCalledTimes(classifications)
        expect(loadRuntime).toHaveBeenCalledTimes(loads)
      }
      const tenantPage = await get('tenant.shop.example.test', '/', 'text/html')
      expect(tenantPage.status).toBe(200)
      expect(tenantPage.body).toContain('"applicationId":"shop"')
      expect((await get('tenant.shop.example.test', `${base}@vite/client`)).status).toBe(200)
      const loads = loadRuntime.mock.calls.length
      for (const path of ['/', `${base}@vite/client`]) {
        const blocked = await get('untrusted.example.test', path, 'text/html')
        expect(blocked.status).toBe(403)
        expect(blocked.body).toContain('Blocked request')
      }
      expect(loadRuntime).toHaveBeenCalledTimes(loads)
      // Existing explicit Vite allowances still work.
      expect((await get('explicit.example.test', `${base}@vite/client`)).status).toBe(200)
    }
  )

  it('serves a rebuilt runtime at the same package version after a dev restart', async () => {
    await writeMinimalConfig()
    root = await realpath(root)
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'same-version-runtime-consumer',
      private: true,
      type: 'module',
    }))
    const packageRoot = join(root, 'node_modules/vue-ssr-lite')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: 'vue-ssr-lite',
      version: '1.0.0-local',
      type: 'module',
      exports: { '.': './index.js', './client': './client.js' },
    }))
    await writeFile(join(packageRoot, 'client.js'), 'export const client = true')
    await writeFile(join(root, 'src/probe.ts'),
      `import { revision } from 'vue-ssr-lite'; export { revision }`)

    const responses: Array<{ code: string; cacheControl: string | null }> = []
    for (const revision of ['before-rebuild', 'after-rebuild']) {
      await writeFile(join(packageRoot, 'index.js'),
        `export const revision = ${JSON.stringify(revision)}`)
      server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [vueSsrLite({ root }), vue()],
        server: { port: 0, host: '127.0.0.1', hmr: false },
      })
      await server.listen()
      const origin = server.resolvedUrls!.local[0]!
      const probe = await (await fetch(new URL('/src/probe.ts', origin))).text()
      const runtimeUrl = probe.match(/from ["']([^"']+)["']/)?.[1]
      expect(runtimeUrl).toBeDefined()
      const response = await fetch(new URL(runtimeUrl!, origin))
      expect(response.status, runtimeUrl).toBe(200)
      responses.push({
        code: await response.text(),
        cacheControl: response.headers.get('cache-control'),
      })
      await server.close()
      server = undefined
    }

    expect(responses[0]!.code).toContain('before-rebuild')
    expect(responses[1]!.code).toContain('after-rebuild')
    for (const response of responses) {
      // Old browser copies must be revalidated even when the package version,
      // lockfile, config, and dependency import URL have not changed.
      expect(response.cacheControl).toContain('no-cache')
      expect(response.cacheControl).not.toContain('immutable')
    }
  })

  it('resolves the runtime virtual id even when Vite path-resolves build.ssr', async () => {
    const pluginRoot = await writeMinimalConfig()
    const plugin = vueSsrLite({ root: pluginRoot })
    const configHook = plugin.config
    if (typeof configHook !== 'function') {
      throw new Error('vueSsrLite must expose a Vite config hook.')
    }
    await configHook.call(
      {} as never,
      { root: pluginRoot },
      {
        command: 'build',
        mode: 'test',
        isSsrBuild: true,
        isPreview: false,
      }
    )

    expect(plugin.resolveId?.call({} as never, 'virtual:vue-ssr-lite/runtime')).toBe(
      '\0virtual:vue-ssr-lite/runtime'
    )
    expect(
      plugin.resolveId?.call(
        {} as never,
        `${pluginRoot}/virtual:vue-ssr-lite/runtime`
      )
    ).toBe('\0virtual:vue-ssr-lite/runtime')
    await expect(
      plugin.resolveId?.call({} as never, SSR_RENDERER_VIRTUAL_ID)
    ).resolves.toMatch(/SsrRenderRuntime\.ts$/)
  })

  it('deduplicates Vue and transforms vue-ssr-lite in the host SSR graph', async () => {
    const pluginRoot = await writeMinimalConfig()
    const config = await runConfig(pluginRoot)

    expect(config.resolve?.dedupe).toContain('vue')
    expect(config.resolve?.dedupe).toContain('vue-router')
    expect(config.resolve?.dedupe).toContain('vue-ssr-lite')
    expect(config.resolve?.dedupe).not.toContain('@vue/server-renderer')
    expect(config.optimizeDeps?.include).toEqual(['vue', 'vue-router'])
    expect(config.optimizeDeps?.exclude).toContain('vue-ssr-lite')
    expect(config.ssr?.external ?? []).not.toContain('vue-ssr-lite')
    expect(config.ssr?.noExternal).toContain('vue-ssr-lite')
  })

  it('uses the same package identity contract in development and production', async () => {
    const pluginRoot = await writeMinimalConfig()
    const [development, production] = await Promise.all([
      runConfig(pluginRoot, 'serve'),
      runConfig(pluginRoot, 'build'),
    ])

    expect(development.ssr?.noExternal).toContain('vue-ssr-lite')
    expect(production.ssr?.noExternal).toContain('vue-ssr-lite')
  })

  it.each(['./', ''])('carries relative SPA base %j through a real generated SSR runtime', async (base) => {
    const pluginRoot = await writeMinimalConfig()
    await writeFile(
      join(pluginRoot, 'server.ts'),
      `
export default {
  server: { port: 0 },
  applications: [
    {
      name: 'admin',
      render: 'spa',
      template: 'site.html',
      host: 'admin.test',
    },
  ],
}
`
    )
    const outDir = join(pluginRoot, 'server-build')
    await build({
      root: pluginRoot,
      base,
      configFile: false,
      logLevel: 'silent',
      plugins: [vueSsrLite({ root: pluginRoot }), vue()],
      build: {
        ssr: true,
        outDir,
        emptyOutDir: true,
        rollupOptions: {
          input: 'virtual:vue-ssr-lite/runtime',
          output: { entryFileNames: 'runtime.mjs' },
        },
      },
    })
    const runtime = (await import(
      `${pathToFileURL(join(outDir, 'runtime.mjs')).href}?test=${Date.now()}`
    )) as { default: () => Promise<Record<string, unknown>> }
    const generated = await runtime.default()

    expect(generated.__vueSsrLiteViteBase).toBe(base)
    expect(
      (generated.applications as { name: string; render: string }[]).find(
        (application) => application.name === 'admin'
      )?.render
    ).toBe('spa')
  })

  it('stays API-client neutral: no Apollo or GraphQL packages by default', async () => {
    const pluginRoot = await writeMinimalConfig()
    const config = await runConfig(pluginRoot)

    expect(config.resolve?.dedupe).not.toContain('@apollo/client')
    expect(config.resolve?.dedupe).not.toContain('vue-apollo-client')
    expect(config.ssr?.external).toBeUndefined()
    expect(config.ssr?.noExternal).not.toContain('@apollo/client')
    expect(config.ssr?.noExternal).not.toContain('vue-apollo-client')
  })

  it('lets the consumer supply its own dedupe and SSR-inlined client packages', async () => {
    const pluginRoot = await writeMinimalConfig()
    const plugin = vueSsrLite({
      root: pluginRoot,
      dedupe: ['@apollo/client', 'graphql'],
      ssrNoExternal: ['vue-apollo-client', '@vue/apollo-composable', /^@wry\//],
    })
    const configHook = plugin.config
    if (typeof configHook !== 'function') {
      throw new Error('vueSsrLite must expose a Vite config hook.')
    }
    const config = (await configHook.call(
      {} as never,
      { root: pluginRoot },
      {
        command: 'serve',
        mode: 'test',
        isSsrBuild: false,
        isPreview: false,
      }
    )) as {
      resolve?: { dedupe?: string[] }
      ssr?: { noExternal?: Array<string | RegExp> }
    }

    expect(config.resolve?.dedupe).toContain('@apollo/client')
    expect(config.ssr?.noExternal).toContain('vue-apollo-client')
    expect(config.ssr?.noExternal).toContain('@vue/apollo-composable')
  })

  it('defaults client build.outDir to dist/client', async () => {
    const pluginRoot = await writeMinimalConfig()
    const config = await runConfig(pluginRoot, 'serve')
    expect(config.build?.outDir).toBe('dist/client')
  })

  it('respects an explicit consumer build.outDir', async () => {
    const pluginRoot = await writeMinimalConfig()
    const plugin = vueSsrLite({ root: pluginRoot })
    const configHook = plugin.config
    if (typeof configHook !== 'function') {
      throw new Error('vueSsrLite must expose a Vite config hook.')
    }
    const config = (await configHook.call(
      {} as never,
      { root: pluginRoot, build: { outDir: 'build/browser' } },
      {
        command: 'serve',
        mode: 'test',
        isSsrBuild: false,
        isPreview: false,
      }
    )) as { build?: { outDir?: string } }

    expect(config.build?.outDir).toBe('build/browser')
  })

  it('preserves module scripts that are not the configured application entry', async () => {
    const pluginRoot = await writeMinimalConfig()
    await writeFile(
      join(pluginRoot, 'site.html'),
      `<html><body>
        <div id="app"></div>
        <script type="module" src="/src/legacy-boot.ts"></script>
        <script src="/src/other.ts" type="module"></script>
      </body></html>`
    )
    const plugin = vueSsrLite({ root: pluginRoot })
    const configHook = plugin.config
    if (typeof configHook !== 'function') {
      throw new Error('vueSsrLite must expose a Vite config hook.')
    }
    await configHook.call(
      {} as never,
      { root: pluginRoot },
      {
        command: 'serve',
        mode: 'test',
        isSsrBuild: false,
        isPreview: false,
      }
    )
    expect(
      plugin.resolveId?.call(
        {} as never,
        '/@vue-ssr-lite/client/storefront'
      )
    ).toBe('\0virtual:vue-ssr-lite/client/storefront')
    const transform = plugin.transformIndexHtml
    if (!transform || typeof transform === 'function' || !transform.handler) {
      throw new Error('vueSsrLite must expose transformIndexHtml.')
    }
    const source = await readFile(join(pluginRoot, 'site.html'), 'utf8')
    const result = await transform.handler.call(
      {} as never,
      source,
      {
        path: '/site.html',
        filename: join(pluginRoot, 'site.html'),
      } as never
    )
    const htmlOut =
      typeof result === 'string'
        ? result
        : result && typeof result === 'object' && 'html' in result
          ? String(result.html)
          : ''
    expect(htmlOut).toContain('legacy-boot')
    expect(htmlOut).toContain('other.ts')
    const tags =
      result && typeof result === 'object' && 'tags' in result
        ? result.tags
        : []
    expect(JSON.stringify(tags)).toContain('/@vue-ssr-lite/client/storefront')
    expect(JSON.stringify(tags)).not.toContain('virtual:vue-ssr-lite/client/storefront')
    expect(JSON.stringify(tags)).not.toContain('children')
  })

  it('does not guess the first application when several share one HTML template', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-shared-html-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src/main.ts'), 'export default () => {}\n')
    await writeFile(join(root, 'src/App.vue'), '<template><div /></template>\n')
    await writeFile(
      join(root, 'index.html'),
      '<html><body><div id="app"></div></body></html>'
    )
    await writeFile(
      join(root, 'server.ts'),
      `
export default {
  applications: [
    {
      name: 'website',
      render: 'ssr',
      template: './index.html',
      domain: { development: 'website.localhost', production: 'website.test' },
    },
    {
      name: 'admin',
      render: 'spa',
      template: './index.html',
      domain: { development: 'admin.localhost', production: 'admin.test' },
    },
  ],
}
`
    )
    await provisionHostVuePeers(root)
    const plugin = vueSsrLite({ root })
    const configHook = plugin.config
    if (typeof configHook !== 'function') throw new Error('Missing config hook.')
    await configHook.call(
      {} as never,
      { root },
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
    const source = await readFile(join(root, 'index.html'), 'utf8')
    const shared = await transform.handler.call(
      {} as never,
      source,
      {
        path: '/',
        filename: join(root, 'index.html'),
      } as never
    )
    const sharedHtml =
      typeof shared === 'string' ? shared : String(shared?.html || source)
    const sharedTags = JSON.stringify(typeof shared === 'object' ? shared?.tags : [])
    expect(sharedHtml).not.toContain('/@vue-ssr-lite/client/')
    expect(sharedTags).not.toContain('/@vue-ssr-lite/client/')

    const admin = await transform.handler.call(
      {} as never,
      source,
      {
        path: '/@vue-ssr-lite/html/admin',
        filename: join(root, 'index.html'),
      } as never
    )
    const adminTags = JSON.stringify(typeof admin === 'object' ? admin?.tags : [])
    expect(adminTags).toContain('/@vue-ssr-lite/client/admin')
    expect(adminTags).not.toContain('/@vue-ssr-lite/client/website')
  })

  it('isolates eager styles by application and applies Vite base URLs', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'vue-ssr-lite-assets-')))
    await mkdir(join(root, 'src', 'website'), { recursive: true })
    await mkdir(join(root, 'src', 'admin'), { recursive: true })
    await mkdir(join(root, 'src', 'portal'), { recursive: true })
    await writeFile(
      join(root, 'client-runtime.ts'),
      'export const hydrateSsrApplication = () => {}; export const mountSpaApplication = () => {}'
    )
    await writeFile(
      join(root, 'server.ts'),
      `
export default {
  applications: [
    {
      name: 'website',
      render: 'ssr',
      template: './website.html',
      domain: { development: 'localhost', customDomains: true },
      app: { main: './src/website/main.ts', root: './src/website/App.vue' },
    },
    {
      name: 'admin',
      render: 'ssr',
      template: './admin.html',
      domain: { development: 'admin.localhost' },
      app: { main: './src/admin/main.ts', root: './src/admin/App.vue' },
    },
    {
      name: 'portal',
      render: 'spa',
      template: './portal.html',
      domain: { development: 'portal.localhost' },
      app: { main: './src/portal/main.ts', root: './src/portal/App.vue' },
    },
  ],
}
`
    )
    await writeFile(
      join(root, 'website.html'),
      '<html><head></head><body><div id="app"></div><script type="module" src="/src/website/main.ts"></script></body></html>'
    )
    await writeFile(
      join(root, 'admin.html'),
      '<html><head></head><body><div id="app"></div><script type="module" src="/src/admin/main.ts"></script></body></html>'
    )
    await writeFile(
      join(root, 'portal.html'),
      '<html><head></head><body><div id="app"></div><script type="module" src="/src/portal/main.ts"></script></body></html>'
    )
    await writeFile(
      join(root, 'src', 'website', 'main.ts'),
      `import './base.css'; import './bootstrap.ts'; import './router.ts'; export default () => {}`
    )
    await writeFile(
      join(root, 'src', 'website', 'bootstrap.ts'),
      `import './website.css'`
    )
    await writeFile(join(root, 'src', 'website', 'base.css'), 'html { color: blue }')
    await writeFile(
      join(root, 'src', 'website', 'website.css'),
      'body { background: white }'
    )
    await writeFile(
      join(root, 'src', 'website', 'router.ts'),
      `globalThis.__loadVueSsrLiteLazyPage = () => import('./LazyPage.ts')`
    )
    await writeFile(
      join(root, 'src', 'website', 'LazyPage.ts'),
      `import './lazy.css'; export default {}`
    )
    await writeFile(
      join(root, 'src', 'website', 'lazy.css'),
      'body { border: 10px solid red }'
    )
    await writeFile(
      join(root, 'src', 'admin', 'main.ts'),
      `import './admin.css'; export default () => {}`
    )
    await writeFile(join(root, 'src', 'admin', 'admin.css'), 'body { color: red }')
    await writeFile(join(root, 'src', 'admin', 'App.vue'), '<template><div /></template>')
    await writeFile(
      join(root, 'src', 'portal', 'main.ts'),
      `import './portal.css'; export default () => {}`
    )
    await writeFile(join(root, 'src', 'portal', 'portal.css'), 'body { color: green }')
    await writeFile(join(root, 'src', 'portal', 'App.vue'), '<template><div /></template>')
    await writeFile(join(root, 'src', 'website', 'App.vue'), '<template><div /></template>')
    await provisionHostVuePeers(root)

    hmrServer = createHttpServer()
    server = await createServer({
      root,
      base: '/dashboard/',
      configFile: false,
      resolve: {
        alias: {
          'vue-ssr-lite/client': join(root, 'client-runtime.ts'),
          '@site': join(root, 'src', 'website'),
        },
      },
      plugins: [vueSsrLite({ root }), vue()],
      server: {
        middlewareMode: true,
        hmr: { server: hmrServer },
      },
      appType: 'custom',
    })
    const websiteSource = await readFile(join(root, 'website.html'), 'utf8')
    const adminSource = await readFile(join(root, 'admin.html'), 'utf8')
    const portalSource = await readFile(join(root, 'portal.html'), 'utf8')
    const [websiteHtml, adminHtml, portalHtml] = await Promise.all([
      server.transformIndexHtml('/website.html', websiteSource, '/'),
      server.transformIndexHtml('/admin.html', adminSource, '/'),
      server.transformIndexHtml('/portal.html', portalSource, '/'),
    ])

    expect(websiteHtml).toMatch(
      /href="\/dashboard\/[^"']*src\/website\/base\.css"/
    )
    expect(websiteHtml).toMatch(
      /href="\/dashboard\/[^"']*src\/website\/website\.css"/
    )
    expect(websiteHtml.indexOf('src/website/base.css')).toBeLessThan(
      websiteHtml.indexOf('src/website/website.css')
    )
    expect(websiteHtml).not.toContain('/src/admin/admin.css')
    expect(websiteHtml).not.toContain('lazy.css')
    expect(adminHtml).toMatch(
      /href="\/dashboard\/[^"']*src\/admin\/admin\.css"/
    )
    expect(adminHtml).not.toContain('/src/website/website.css')
    expect(portalHtml).not.toContain('data-vue-ssr-lite-style')
    expect(portalHtml).toContain('/dashboard/@vue-ssr-lite/client/portal')
    expect((await server.transformRequest('/src/portal/main.ts'))?.code).toMatch(
      /\/dashboard\/[^"']*src\/portal\/portal\.css/
    )
    const lazyPageModule = await server.environments.client.moduleGraph.getModuleByUrl(
      '/src/website/LazyPage.ts'
    )
    expect(lazyPageModule).toBeDefined()
    expect(lazyPageModule?.transformResult).toBeNull()
    expect(
      await server.environments.client.moduleGraph.getModuleByUrl(
        '/src/website/lazy.css'
      )
    ).toBeUndefined()

    await server.close()
    server = undefined
    const outDir = join(root, 'dist-test')
    await build({
      root,
      base: '/dashboard/',
      configFile: false,
      logLevel: 'silent',
      resolve: {
        alias: {
          'vue-ssr-lite/client': join(root, 'client-runtime.ts'),
          '@site': join(root, 'src', 'website'),
        },
      },
      plugins: [vueSsrLite({ root }), vue()],
      build: { outDir, emptyOutDir: true },
    })
    const [builtWebsite, builtAdmin, builtPortal] = await Promise.all([
      readFile(join(outDir, 'website.html'), 'utf8'),
      readFile(join(outDir, 'admin.html'), 'utf8'),
      readFile(join(outDir, 'portal.html'), 'utf8'),
    ])
    expect(builtWebsite).toMatch(
      /href="\/dashboard\/assets\/website-[^"']+\.css"/
    )
    expect(builtWebsite).not.toMatch(/assets\/admin-[^"']+\.css/)
    const manifest = JSON.parse(
      await readFile(join(outDir, '.vite', 'manifest.json'), 'utf8')
    ) as Record<string, {
      file?: string
      css?: string[]
      isDynamicEntry?: boolean
    }>
    const immutable = JSON.parse(
      await readFile(join(outDir, '.vite', 'vue-ssr-lite-assets.json'), 'utf8')
    ) as { version: number; immutable: string[] }
    expect(immutable.version).toBe(1)
    const entryCss = Object.values(manifest)
      .flatMap((entry) => entry.css ?? [])
      .find((file) => file.includes('website-'))
    expect(entryCss).toBeDefined()
    expect(immutable.immutable).toContain(entryCss)
    const lazyEntry = Object.entries(manifest).find(([id]) =>
      id.endsWith('/src/website/LazyPage.ts') || id === 'src/website/LazyPage.ts'
    )?.[1]
    expect(lazyEntry?.isDynamicEntry).toBe(true)
    expect(lazyEntry?.css?.some((file) => file.endsWith('.css'))).toBe(true)
    for (const lazyCss of lazyEntry?.css ?? []) {
      expect(immutable.immutable).toContain(lazyCss)
    }
    for (const lazyCss of lazyEntry?.css ?? []) {
      expect(builtWebsite).not.toContain(lazyCss)
    }
    expect(builtAdmin).toMatch(
      /href="\/dashboard\/assets\/admin-[^"']+\.css"/
    )
    expect(builtAdmin).not.toMatch(/assets\/website-[^"']+\.css/)
    expect(builtPortal).toMatch(
      /href="\/dashboard\/assets\/portal-[^"']+\.css"/
    )
    expect(builtPortal).not.toContain('data-vue-ssr-lite-style')
  })

  it('deduplicates application CSS against consumer-owned stylesheet links', async () => {
    const pluginRoot = await writeMinimalConfig()
    await writeFile(
      join(pluginRoot, 'src/main.ts'),
      `import './style.css'; export default () => {}`
    )
    await writeFile(join(pluginRoot, 'src/style.css'), 'body { margin: 0 }')
    await writeFile(
      join(pluginRoot, 'client-runtime.ts'),
      'export const hydrateSsrApplication = () => {}; export const mountSpaApplication = () => {}'
    )
    const source = `<html><head>
      <link rel="stylesheet" href="/src/style.css">
      <link rel="stylesheet" href="https://fonts.example.com/font.css">
    </head><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>`
    await writeFile(join(pluginRoot, 'site.html'), source)
    hmrServer = createHttpServer()
    server = await createServer({
      root: pluginRoot,
      configFile: false,
      resolve: {
        alias: {
          'vue-ssr-lite/client': join(pluginRoot, 'client-runtime.ts'),
        },
      },
      plugins: [vueSsrLite({ root: pluginRoot }), vue()],
      server: {
        middlewareMode: true,
        hmr: { server: hmrServer },
      },
      appType: 'custom',
    })

    const html = await server.transformIndexHtml('/site.html', source, '/')
    expect(html.match(/href="\/src\/style\.css"/g)).toHaveLength(1)
    expect(html).toContain('https://fonts.example.com/font.css')
    expect(html).not.toContain(
      'href="/src/style.css" data-vue-ssr-lite-style="storefront"'
    )
  })
})

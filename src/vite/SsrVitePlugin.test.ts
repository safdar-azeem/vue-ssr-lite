import { mkdir, mkdtemp, readFile, realpath, writeFile, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { build, createServer, type ViteDevServer } from 'vite'
import { vueSsrLite } from './SsrVitePlugin'

let root = ''
let server: ViteDevServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

const writeMinimalConfig = async () => {
  root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-vite-'))
  await writeFile(
    join(root, 'ssr.config.mjs'),
    `
export default {
  name: 'demo',
  applications: {
    storefront: {
      render: 'ssr',
      application: {
        module: './src/SsrApplication.ts',
        exportName: 'websiteApplication',
      },
      template: 'site.html',
      domain: {
        development: 'localhost',
        production: 'example.com',
        customDomains: true,
      },
      publicConfig: { api: { endpoint: 'http://localhost/graphql' } },
    },
  },
}
`,
    'utf8'
  )
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(
    join(root, 'src/SsrApplication.ts'),
    `export default { root: {} }`,
    'utf8'
  )
  await writeFile(join(root, 'site.html'), '<html><body><div id="app"></div></body></html>')
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
    resolve?: { dedupe?: string[] }
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
  })

  it('deduplicates Vue and externalizes vue-ssr-lite by default', async () => {
    const pluginRoot = await writeMinimalConfig()
    const config = await runConfig(pluginRoot)

    expect(config.resolve?.dedupe).toContain('vue')
    expect(config.resolve?.dedupe).toContain('vue-router')
    expect(config.resolve?.dedupe).toContain('vue-ssr-lite')
    expect(config.resolve?.dedupe).not.toContain('@vue/server-renderer')
    expect(config.ssr?.external).toContain('vue-ssr-lite')
    expect(config.ssr?.noExternal).not.toContain('vue-ssr-lite')
  })

  it('uses the same package externalization contract in development and production', async () => {
    const pluginRoot = await writeMinimalConfig()
    const [development, production] = await Promise.all([
      runConfig(pluginRoot, 'serve'),
      runConfig(pluginRoot, 'build'),
    ])

    expect(development.ssr?.external).toContain('vue-ssr-lite')
    expect(production.ssr?.external).toContain('vue-ssr-lite')
  })

  it.each(['./', ''])('carries relative SPA base %j through a real generated SSR runtime', async (base) => {
    const pluginRoot = await writeMinimalConfig()
    await writeFile(
      join(pluginRoot, 'ssr.config.mjs'),
      `
export default {
  server: { port: 0 },
  applications: {
    admin: {
      render: 'spa',
      application: { module: './src/SsrApplication.ts' },
      template: 'site.html',
      host: 'admin.test',
      domain: { production: 'admin.test' },
    },
  },
}
`
    )
    const outDir = join(pluginRoot, 'server-build')
    await build({
      root: pluginRoot,
      base,
      configFile: false,
      logLevel: 'silent',
      plugins: [vueSsrLite({ root: pluginRoot })],
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
    expect((generated.applications as Record<string, { render: string }>).admin.render).toBe('spa')
  })

  it('stays API-client neutral: no Apollo or GraphQL packages by default', async () => {
    const pluginRoot = await writeMinimalConfig()
    const config = await runConfig(pluginRoot)

    expect(config.resolve?.dedupe).not.toContain('@apollo/client')
    expect(config.resolve?.dedupe).not.toContain('vue-apollo-client')
    expect(config.ssr?.external).not.toContain('@apollo/client')
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
      join(root, 'ssr.config.mjs'),
      `
export default {
  applications: {
    website: {
      render: 'ssr',
      app: '@site/main.ts',
      template: './website.html',
      domain: { development: 'localhost', customDomains: true },
    },
    admin: {
      render: 'ssr',
      app: './src/admin/main.ts',
      template: './admin.html',
      domain: { development: 'admin.localhost' },
    },
    portal: {
      render: 'spa',
      app: './src/portal/main.ts',
      template: './portal.html',
      domain: { development: 'portal.localhost' },
    },
  },
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
      `import './base.css'; import './bootstrap.ts'; import './router.ts'; export default { root: {} }`
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
      `import './admin.css'; export default { root: {} }`
    )
    await writeFile(join(root, 'src', 'admin', 'admin.css'), 'body { color: red }')
    await writeFile(
      join(root, 'src', 'portal', 'main.ts'),
      `import './portal.css'; export default { root: {} }`
    )
    await writeFile(join(root, 'src', 'portal', 'portal.css'), 'body { color: green }')

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
      plugins: [vueSsrLite({ root })],
      server: {
        middlewareMode: true,
        hmr: { server: createHttpServer() },
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
      plugins: [vueSsrLite({ root })],
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
    const lazyEntry = Object.entries(manifest).find(([id]) =>
      id.endsWith('/src/website/LazyPage.ts') || id === 'src/website/LazyPage.ts'
    )?.[1]
    expect(lazyEntry?.isDynamicEntry).toBe(true)
    expect(lazyEntry?.css?.some((file) => file.endsWith('.css'))).toBe(true)
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
      join(pluginRoot, 'src/SsrApplication.ts'),
      `import './style.css'; export default { root: {} }`
    )
    await writeFile(join(pluginRoot, 'src/style.css'), 'body { margin: 0 }')
    await writeFile(
      join(pluginRoot, 'client-runtime.ts'),
      'export const hydrateSsrApplication = () => {}'
    )
    const source = `<html><head>
      <link rel="stylesheet" href="/src/style.css">
      <link rel="stylesheet" href="https://fonts.example.com/font.css">
    </head><body><div id="app"></div><script type="module" src="/src/SsrApplication.ts"></script></body></html>`
    await writeFile(join(pluginRoot, 'site.html'), source)
    server = await createServer({
      root: pluginRoot,
      configFile: false,
      resolve: {
        alias: {
          'vue-ssr-lite/client': join(pluginRoot, 'client-runtime.ts'),
        },
      },
      plugins: [vueSsrLite({ root: pluginRoot })],
      server: {
        middlewareMode: true,
        hmr: { server: createHttpServer() },
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

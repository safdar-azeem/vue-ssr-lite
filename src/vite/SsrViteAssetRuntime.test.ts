import type { EnvironmentModuleNode, ViteDevServer } from 'vite'
import { describe, expect, it } from 'vitest'
import {
  createSsrStylesheetLinkTags,
  isViteStylesheetModule,
  normalizeViteAssetUrl,
  readEagerViteImports,
  resolveApplicationStyleDependencies,
} from './SsrViteAssetRuntime'

describe('SSR Vite application assets', () => {
  it('classifies Vite CSS languages and Vue style modules without query false positives', () => {
    for (const id of [
      '/src/app.css',
      '/src/theme.scss?used',
      '/src/theme.sass',
      '/src/theme.less',
      '/src/theme.styl',
      '/src/App.vue?vue&type=style&index=0&scoped=abc&lang.css',
    ]) {
      expect(isViteStylesheetModule(id), id).toBe(true)
    }
    for (const id of [
      '/src/app.css?inline',
      '/src/app.css?raw',
      '/src/app.css?url',
      '/src/app.ts?asset=.css',
      '/src/App.vue?vue&type=script&lang.css',
    ]) {
      expect(isViteStylesheetModule(id), id).toBe(false)
    }
  })

  it('normalizes Vite base and volatile module queries for identity', () => {
    expect(
      normalizeViteAssetUrl('/dashboard/src/app.css?v=one&t=2', {
        base: '/dashboard/',
      })
    ).toBe('/src/app.css')
    expect(
      normalizeViteAssetUrl('/src/App.vue?vue&type=style&lang.css&index=0')
    ).toBe('/src/App.vue?index=0&lang.css=&type=style&vue=')
    expect(normalizeViteAssetUrl('https://cdn.example.com/app.css')).toBeUndefined()
  })

  it('preserves consumer links and emits only missing marked resources', () => {
    const tags = createSsrStylesheetLinkTags(
      `<html><head>
        <link rel="stylesheet" href="/dashboard/src/app.css?v=old">
        <link rel="stylesheet" href="https://fonts.example.com/font.css">
        <script>const example = '<link rel="stylesheet" href="/src/theme.css">'</script>
      </head></html>`,
      [
        { applicationId: 'website', href: '/src/app.css' },
        { applicationId: 'website', href: '/src/theme.css' },
        { applicationId: 'website', href: '/src/theme.css?t=123' },
      ],
      { base: '/dashboard/', htmlPath: '/index.html' }
    )

    expect(tags).toEqual([
      {
        tag: 'link',
        attrs: {
          rel: 'stylesheet',
          href: '/src/theme.css',
          'data-vue-ssr-lite-style': 'website',
        },
        injectTo: 'head',
      },
    ])
  })

  it('uses transformed eager imports and excludes dynamic graph edges', async () => {
    const eager = {
      url: '/src/base.css',
    } as EnvironmentModuleNode
    const lazy = {
      url: '/src/LazyPage.ts',
    } as EnvironmentModuleNode
    const module = {
      url: '/src/main.ts',
      transformResult: {
        code: `import '/dashboard/src/base.css'; import('/dashboard/src/LazyPage.ts')`,
        map: null,
      },
      importedModules: new Set([eager, lazy]),
    } as EnvironmentModuleNode
    const server = {
      config: { base: '/dashboard/' },
    } as ViteDevServer

    await expect(readEagerViteImports(server, module)).resolves.toEqual([eager])
  })

  it('fails actionably when Vite eager dependency metadata is unavailable', async () => {
    const module = {
      url: '/src/main.ts',
      transformResult: null,
      importedModules: new Set(),
    } as unknown as EnvironmentModuleNode
    const server = {
      config: { base: '/' },
    } as ViteDevServer

    await expect(readEagerViteImports(server, module)).rejects.toThrow(
      'cannot inspect eager imports for untransformed Vite module /src/main.ts'
    )

    await expect(
      readEagerViteImports(server, {
        ...module,
        transformResult: {
          code: `import '/src/missing.css'`,
          map: null,
        },
      })
    ).rejects.toThrow(
      'could not map eager stylesheet imports from /src/main.ts'
    )
  })

  it('uses returned Vite transforms while optimized module graph state is transient', async () => {
    const stylesheet = {
      url: '/src/style.css',
      transformResult: null,
      importedModules: new Set(),
    } as unknown as EnvironmentModuleNode
    const optimizedRuntime = {
      url: '/node_modules/.vite/deps/vue-ssr-lite_client.js?v=cold',
      transformResult: null,
      importedModules: new Set([stylesheet]),
    } as unknown as EnvironmentModuleNode
    const entry = {
      url: '/@vue-ssr-lite/client/app',
      transformResult: null,
      importedModules: new Set([optimizedRuntime]),
    } as unknown as EnvironmentModuleNode
    const code = new Map([
      [entry.url, `import '${optimizedRuntime.url}'`],
      [optimizedRuntime.url, `import '${stylesheet.url}'`],
      [stylesheet.url, 'export {}'],
    ])
    const environment = {
      transformRequest: async (url: string) => {
        const transformed = code.get(url)
        return transformed == null ? null : { code: transformed, map: null }
      },
      waitForRequestsIdle: async () => {},
      moduleGraph: {
        getModuleByUrl: async (url: string) =>
          url === entry.url ? entry : undefined,
      },
    }
    const server = {
      config: { base: '/' },
      environments: { client: environment },
    } as unknown as ViteDevServer

    await expect(
      resolveApplicationStyleDependencies(server, 'app', entry.url)
    ).resolves.toEqual([{ applicationId: 'app', href: stylesheet.url }])
    expect(optimizedRuntime.transformResult).toBeNull()
  })
})

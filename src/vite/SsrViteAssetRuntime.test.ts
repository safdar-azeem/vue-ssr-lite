import type { EnvironmentModuleNode, ViteDevServer } from 'vite'
import { describe, expect, it } from 'vitest'
import {
  createSsrStylesheetLinkTags,
  isViteStylesheetModule,
  normalizeViteAssetUrl,
  readEagerViteImports,
  resolveApplicationStyleDependencies,
  resolveRenderedStyleDependencies,
  runWithSsrViteAssetResolutionContext,
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
        code: `const example = "import '/dashboard/src/LazyPage.ts'";
          export { default } from '/dashboard/src/base.css' with { type: 'css' };
          import('/dashboard/src/LazyPage.ts')`,
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
    let idleCalls = 0
    const environment = {
      transformRequest: async (url: string) => {
        const transformed = code.get(url)
        return transformed == null ? null : { code: transformed, map: null }
      },
      waitForRequestsIdle: async () => {
        idleCalls += 1
      },
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
    expect(idleCalls).toBe(0)
  })

  it('inspects each eager module once when rendered roots share dependency graphs', async () => {
    const reads = new Map<string, number>()
    const trackedModule = (
      url: string,
      code: string,
      dependencies: EnvironmentModuleNode[] = []
    ): EnvironmentModuleNode => {
      const module = {
        id: url,
        url,
        transformResult: { code, map: null },
      } as unknown as EnvironmentModuleNode
      Object.defineProperty(module, 'importedModules', {
        get: () => {
          reads.set(url, (reads.get(url) ?? 0) + 1)
          return new Set(dependencies)
        },
      })
      return module
    }
    const stylesheet = trackedModule('/src/shared.css', 'export {}')
    const first = trackedModule(
      '/src/First.vue',
      `import '${stylesheet.url}'`,
      [stylesheet]
    )
    const second = trackedModule(
      '/src/Second.vue',
      `import '${stylesheet.url}'`,
      [stylesheet]
    )
    const modules = new Map([
      [first.id!, first],
      [second.id!, second],
      [stylesheet.id!, stylesheet],
    ])
    let idleCalls = 0
    const environment = {
      transformRequest: async (url: string) => {
        throw new Error(`Unexpected transform for ${url}`)
      },
      waitForRequestsIdle: async () => {
        idleCalls += 1
      },
      moduleGraph: {
        getModuleById: (id: string) => modules.get(id),
        getModuleByUrl: async (url: string) => modules.get(url),
      },
    }
    const server = {
      config: { base: '/', root: '/project' },
      environments: { client: environment },
    } as unknown as ViteDevServer

    await expect(
      resolveRenderedStyleDependencies(server, 'app', [first.id!, second.id!])
    ).resolves.toEqual([
      {
        applicationId: 'app',
        href: '/src/shared.css',
        rel: 'stylesheet',
        temporary: true,
      },
    ])
    expect(Object.fromEntries(reads)).toEqual({
      '/src/First.vue': 1,
      '/src/shared.css': 1,
      '/src/Second.vue': 1,
    })
    expect(idleCalls).toBe(0)
  })

  it('shares graph inspection across application and rendered styles only within one request', async () => {
    const reads = new Map<string, number>()
    let currentStylesheet: EnvironmentModuleNode
    const trackedModule = (
      url: string,
      code: () => string,
      dependencies: () => EnvironmentModuleNode[]
    ): EnvironmentModuleNode => {
      const module = { id: url, url } as unknown as EnvironmentModuleNode
      Object.defineProperties(module, {
        transformResult: {
          get: () => ({ code: code(), map: null }),
        },
        importedModules: {
          get: () => {
            reads.set(url, (reads.get(url) ?? 0) + 1)
            return new Set(dependencies())
          },
        },
      })
      return module
    }
    const firstStylesheet = trackedModule(
      '/src/first.css',
      () => 'export {}',
      () => []
    )
    const nextStylesheet = trackedModule(
      '/src/next.css',
      () => 'export {}',
      () => []
    )
    currentStylesheet = firstStylesheet
    const rendered = trackedModule(
      '/src/Rendered.vue',
      () => `import '${currentStylesheet.url}'`,
      () => [currentStylesheet]
    )
    const entry = trackedModule(
      '/@vue-ssr-lite/client/app',
      () => `import '${rendered.url}'`,
      () => [rendered]
    )
    const modules = new Map([
      [entry.id!, entry],
      [rendered.id!, rendered],
      [firstStylesheet.id!, firstStylesheet],
      [nextStylesheet.id!, nextStylesheet],
    ])
    let idleCalls = 0
    const environment = {
      transformRequest: async (url: string) => modules.get(url)?.transformResult,
      waitForRequestsIdle: async () => {
        idleCalls += 1
      },
      moduleGraph: {
        getModuleById: (id: string) => modules.get(id),
        getModuleByUrl: async (url: string) => modules.get(url),
      },
    }
    const server = {
      config: { base: '/', root: '/project' },
      environments: { client: environment },
    } as unknown as ViteDevServer

    const firstRequest = await runWithSsrViteAssetResolutionContext(async () => ({
      application: await resolveApplicationStyleDependencies(
        server,
        'app',
        entry.url
      ),
      rendered: await resolveRenderedStyleDependencies(server, 'app', [
        rendered.id!,
      ]),
    }))

    expect(firstRequest.application).toEqual([
      { applicationId: 'app', href: firstStylesheet.url },
    ])
    expect(firstRequest.rendered).toEqual([
      {
        applicationId: 'app',
        href: firstStylesheet.url,
        rel: 'stylesheet',
        temporary: true,
      },
    ])
    expect(Object.fromEntries(reads)).toEqual({
      [entry.url]: 1,
      [rendered.url]: 1,
      [firstStylesheet.url]: 1,
    })

    currentStylesheet = nextStylesheet
    const nextRequest = await runWithSsrViteAssetResolutionContext(() =>
      resolveApplicationStyleDependencies(server, 'app', entry.url)
    )
    expect(nextRequest).toEqual([
      { applicationId: 'app', href: nextStylesheet.url },
    ])
    expect(reads.get(entry.url)).toBe(2)
    expect(reads.get(rendered.url)).toBe(2)
    expect(reads.get(nextStylesheet.url)).toBe(1)
    expect(idleCalls).toBe(0)
  })
})

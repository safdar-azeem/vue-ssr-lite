import type { EnvironmentModuleNode, ViteDevServer } from 'vite'
import { describe, expect, it } from 'vitest'
import {
  createSsrStylesheetLinkTags,
  isViteStylesheetModule,
  normalizeViteAssetUrl,
  prepareSsrViteComponentAssets,
  readEagerViteImports,
  resolveApplicationStyleDependencies,
  resolveRenderedStyleDependencies,
  runWithSsrViteAssetResolutionContext,
} from './SsrViteAssetRuntime'

const deferred = () => {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

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
      const transform = { map: null } as NonNullable<EnvironmentModuleNode['transformResult']>
      Object.defineProperty(transform, 'code', { get: () => {
        reads.set(url, (reads.get(url) ?? 0) + 1)
        return code
      } })
      const module = {
        id: url, url, transformResult: transform, importedModules: new Set(dependencies),
        lastHMRTimestamp: 0, lastInvalidationTimestamp: 0,
      } as EnvironmentModuleNode
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

  it('reuses eager code metadata across requests until Vite invalidates a dependency', async () => {
    const reads = new Map<string, number>()
    const transformed = (url: string, code: string) => {
      const result = { map: null } as NonNullable<EnvironmentModuleNode['transformResult']>
      Object.defineProperty(result, 'code', { get: () => {
        reads.set(url, (reads.get(url) ?? 0) + 1)
        return code
      } })
      return result
    }
    const node = (url: string, code: string, dependencies: EnvironmentModuleNode[] = []) => ({
      id: url, url, transformResult: transformed(url, code), importedModules: new Set(dependencies),
      lastHMRTimestamp: 0, lastInvalidationTimestamp: 0,
    }) as EnvironmentModuleNode
    const firstStylesheet = node('/src/first.css', 'export {}')
    const nextStylesheet = node('/src/next.css', 'export {}')
    const rendered = node('/src/Rendered.vue', `import '${firstStylesheet.url}'`, [firstStylesheet])
    const entry = node('/@vue-ssr-lite/client/app', `import '${rendered.url}'`, [rendered])
    const modules = new Map([entry, rendered, firstStylesheet, nextStylesheet].map((module) => [module.id!, module]))
    const environment = {
      transformRequest: async (url: string) => modules.get(url)?.transformResult ?? null,
      moduleGraph: {
        getModuleById: (id: string) => modules.get(id),
        getModuleByUrl: async (url: string) => modules.get(url),
      },
    }
    const server = { config: { base: '/', root: '/project' }, environments: { client: environment } } as unknown as ViteDevServer
    const request = () => runWithSsrViteAssetResolutionContext(async () => ({
      application: await resolveApplicationStyleDependencies(server, 'app', entry.url),
      rendered: await resolveRenderedStyleDependencies(server, 'app', [rendered.id!]),
    }))
    const first = await request()
    expect(first.application).toEqual([{ applicationId: 'app', href: firstStylesheet.url }])
    expect(first.rendered).toEqual([{ applicationId: 'app', href: firstStylesheet.url, rel: 'stylesheet', temporary: true }])
    expect(await request()).toEqual(first)
    expect(Object.fromEntries(reads)).toEqual({ [entry.url]: 1, [rendered.url]: 1, [firstStylesheet.url]: 1 })

    // The parent's transform remains unchanged, as at a Vue HMR acceptance boundary.
    rendered.lastHMRTimestamp += 1
    rendered.importedModules = new Set([nextStylesheet])
    rendered.transformResult = transformed(rendered.url, `import '${nextStylesheet.url}'`)
    const updated = await request()
    expect(updated.application).toEqual([{ applicationId: 'app', href: nextStylesheet.url }])
    expect(updated.rendered).toEqual([{ applicationId: 'app', href: nextStylesheet.url, rel: 'stylesheet', temporary: true }])
    expect(reads.get(entry.url)).toBe(1)
    expect(reads.get(rendered.url)).toBe(2)
    expect(reads.get(nextStylesheet.url)).toBe(1)
  })

  it('overlaps selected cold graphs, coalesces shared transforms, and retains rendered CSS order', async () => {
    const calls = new Map<string, number>()
    const modules = new Map<string, EnvironmentModuleNode>()
    const code = new Map<string, string>()
    const node = (name: string, dependencies: EnvironmentModuleNode[] = [], extra = '') => {
      const url = `/src/${name}`
      const module = {
        id: `/project${url}`, url, transformResult: null,
        importedModules: new Set(dependencies), lastInvalidationTimestamp: 0, lastHMRTimestamp: 0,
      } as EnvironmentModuleNode
      modules.set(module.id!, module)
      modules.set(url, module)
      code.set(url, dependencies.map((dependency) => `import '${dependency.url}'`).join('\n') + extra)
      return module
    }
    const shared = node('shared.css')
    const homeCss = node('home.css')
    const panelCss = node('panel.css')
    const otherCss = node('other.css')
    const unused = node('Unused.vue', [node('unused.css')])
    const panel = node('Panel.vue', [shared, panelCss])
    const home = node('Home.vue', [homeCss, panel], `\nexport const unused = () => import('${unused.url}')`)
    home.importedModules.add(unused)
    const other = node('Other.vue', [shared, otherCss])
    const sharedStarted = deferred()
    const releaseShared = deferred()
    const otherStarted = deferred()
    const server = {
      config: { root: '/project', base: '/products/' },
      environments: { client: {
        moduleGraph: {
          getModuleById: (id: string) => modules.get(id),
          getModuleByUrl: async (url: string) => modules.get(url),
        },
        transformRequest: async (url: string) => {
          calls.set(url, (calls.get(url) ?? 0) + 1)
          if (url === shared.url) { sharedStarted.resolve(); await releaseShared.promise }
          if (url === other.url) otherStarted.resolve()
          const module = modules.get(url)!
          return module.transformResult = { code: code.get(url)!, map: null }
        },
      } },
    } as unknown as ViteDevServer

    try {
      prepareSsrViteComponentAssets(server, home.id!)
      await sharedStarted.promise
      expect(calls.has(unused.url)).toBe(false)
      expect(calls.has(other.url)).toBe(false)
      const rendered = resolveRenderedStyleDependencies(server, 'alpha', [home.id!, other.id!, panel.id!, home.id!])
      // The first graph is still blocked, but a later independent root must
      // already be preparing. No elapsed-time threshold encodes this contract.
      await otherStarted.promise
      expect(calls.get(shared.url)).toBe(1)
      releaseShared.resolve()
      const assets = await rendered
      expect(assets.map(({ href }) => href)).toEqual([
        '/products/src/home.css', '/products/src/shared.css',
        '/products/src/panel.css', '/products/src/other.css',
      ])
      expect([...calls.values()].every((count) => count === 1)).toBe(true)
      expect(assets.every(({ applicationId }) => applicationId === 'alpha')).toBe(true)
      const before = [...calls]
      const second = await resolveRenderedStyleDependencies(server, 'beta', [other.id!])
      expect(second.map(({ href }) => href)).toEqual(['/products/src/shared.css', '/products/src/other.css'])
      expect(second.every(({ applicationId }) => applicationId === 'beta')).toBe(true)
      expect([...calls]).toEqual(before)

      const replacement = node('replacement.css')
      panel.lastInvalidationTimestamp += 1
      panel.transformResult = null
      panel.importedModules = new Set([replacement])
      code.set(panel.url, `import '${replacement.url}'`)
      prepareSsrViteComponentAssets(server, panel.id!)
      const updated = await resolveRenderedStyleDependencies(server, 'alpha', [home.id!])
      expect(updated.map(({ href }) => href)).toEqual(['/products/src/home.css', '/products/src/replacement.css'])
      expect(calls.get(home.url)).toBe(1)
      expect(calls.get(panel.url)).toBe(2)
      expect(calls.has(unused.url)).toBe(false)
    } finally {
      releaseShared.resolve()
    }
  })

  it('does not retain a failed preparation or hide the actual rendered asset error', async () => {
    const entered = deferred()
    const finish = deferred()
    let fail = true
    let calls = 0
    const module = {
      id: '/src/Home.vue', url: '/src/Home.vue', transformResult: null,
      importedModules: new Set(), lastInvalidationTimestamp: 0, lastHMRTimestamp: 0,
    } as unknown as EnvironmentModuleNode
    const server = { config: { root: '/project', base: '/' }, environments: { client: {
      moduleGraph: { getModuleById: () => module, getModuleByUrl: async () => module },
      transformRequest: async () => {
        calls += 1
        entered.resolve()
        await finish.promise
        if (fail) throw new Error('client plugin failed')
        return module.transformResult = { code: 'export {}', map: null }
      },
    } } } as unknown as ViteDevServer
    prepareSsrViteComponentAssets(server, module.id!)
    await entered.promise
    const rendered = resolveRenderedStyleDependencies(server, 'app', [module.id!])
    finish.resolve()
    await expect(rendered).rejects.toThrow('client plugin failed')
    expect(calls).toBe(1)
    fail = false
    await expect(resolveRenderedStyleDependencies(server, 'app', [module.id!])).resolves.toEqual([])
    expect(calls).toBe(2)
  })

  it('does not join or republish preparation invalidated while its transform is pending', async () => {
    const entered = deferred()
    const oldTransform = deferred()
    const module = {
      id: '/src/Home.vue', url: '/src/Home.vue', transformResult: null,
      importedModules: new Set(), lastInvalidationTimestamp: 0, lastHMRTimestamp: 0,
    } as unknown as EnvironmentModuleNode
    const stylesheet = {
      id: '/src/current.css', url: '/src/current.css',
      transformResult: { code: 'export {}', map: null }, importedModules: new Set(),
      lastInvalidationTimestamp: 0, lastHMRTimestamp: 0,
    } as unknown as EnvironmentModuleNode
    const modules = new Map([[module.id!, module], [stylesheet.id!, stylesheet]])
    let calls = 0
    const server = { config: { root: '/project', base: '/' }, environments: { client: {
      moduleGraph: { getModuleById: (id: string) => modules.get(id), getModuleByUrl: async (url: string) => modules.get(url) },
      transformRequest: async () => {
        calls += 1
        if (calls === 1) {
          entered.resolve()
          await oldTransform.promise
          // Like Vite, a superseded transform can return to its caller without
          // overwriting the newer transform stored on the public module node.
          return { code: 'export {}', map: null }
        }
        return module.transformResult = { code: `import '${stylesheet.url}'`, map: null }
      },
    } } } as unknown as ViteDevServer
    prepareSsrViteComponentAssets(server, module.id!)
    await entered.promise
    const oldRequest = resolveRenderedStyleDependencies(server, 'old', [module.id!])
    void oldRequest.catch(() => undefined)
    // Let the old request join the in-flight graph before invalidating it.
    await Promise.resolve()
    module.lastInvalidationTimestamp += 1
    module.importedModules = new Set([stylesheet])
    try {
      const current = await resolveRenderedStyleDependencies(server, 'current', [module.id!])
      expect(current.map(({ href }) => href)).toEqual(['/src/current.css'])
      expect(calls).toBe(2)
      oldTransform.resolve()
      await oldRequest
      expect(await resolveRenderedStyleDependencies(server, 'current', [module.id!])).toEqual(current)
      expect(calls).toBe(2)
    } finally {
      oldTransform.resolve()
    }
  })
})

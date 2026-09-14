import { describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig, Rollup } from 'vite'
import { SSR_BROWSER_BOOTSTRAP_SOURCES } from '../../../src/browser/SsrBrowserBootstrap'
import { createSsrBootstrapAssetManifest, resolveSsrBootstrapPreloadPolicy } from '../../../src/vite/SsrViteBootstrap'
import { extractSsrViteEntries } from '../../../src/config/compile/SsrConfigCompileRuntime'

const chunk = (fileName: string, ids: string[], imports: string[] = [], dynamicImports: string[] = []): Rollup.OutputChunk => ({
  type: 'chunk', fileName, exports: [], code: 'export const value = 1', imports, dynamicImports,
  facadeModuleId: ids[0], isEntry: ids[0]?.startsWith('entry:'),
  modules: Object.fromEntries(ids.map((id) => [id, { renderedLength: 1 }])),
} as unknown as Rollup.OutputChunk)
const sources = (id: string) => [id]
const boundary = SSR_BROWSER_BOOTSTRAP_SOURCES
const graph = (): Rollup.OutputBundle => Object.fromEntries([
  chunk('a.js', ['entry:a'], ['shared.js'], ['features.js', 'mw.js', 'nav.js']),
  chunk('b.js', ['entry:b'], ['shared.js'], ['nav.js']),
  chunk('shared.js', ['shared']),
  chunk('features.js', [boundary.seo, boundary.extensions], ['dep.js', 'shared.js'], ['future.js']),
  chunk('dep.js', ['dep'], ['leaf.js']), chunk('leaf.js', ['leaf'], ['dep.js']),
  chunk('mw.js', [boundary.middleware]), chunk('nav.js', [boundary.navigation], ['shared.js']),
  chunk('future.js', ['future']),
].map((output) => [output.fileName, output]))

describe('private browser bootstrap graph', () => {
  it('maps shared capabilities and recursive static dependencies without future or sibling assets', () => {
    const manifest = createSsrBootstrapAssetManifest(graph(), [
      { id: 'website', clientModuleId: 'entry:a', initial: ['seo', 'extensions', 'navigation'] },
      { id: 'admin', clientModuleId: 'entry:b', initial: ['navigation'] },
    ], sources)
    expect(manifest.applications.website!.capabilities.seo).toEqual(['dep.js', 'features.js', 'leaf.js'])
    expect(manifest.applications.website!.capabilities.extensions).toEqual(manifest.applications.website!.capabilities.seo)
    expect(manifest.applications.admin!.capabilities.seo).toEqual([])
    expect(manifest.applications.admin!.capabilities.navigation).toEqual(['nav.js'])
    expect(JSON.stringify(manifest)).not.toContain('entry:')
    expect(JSON.stringify(manifest)).not.toContain('future.js')
  })

  it('omits a capability already placed in the entry static closure by consumer chunking', () => {
    const bundle = graph()
    ;(bundle['a.js'] as Rollup.OutputChunk).imports.push('features.js')
    const manifest = createSsrBootstrapAssetManifest(bundle, [{ id: 'app', clientModuleId: 'entry:a', initial: ['seo'] }], sources)
    expect(manifest.applications.app!.capabilities.seo).toEqual([])
  })

  it.each(['disabled', 'resolve-dependencies', 'render-built-url'] as const)('persists only the disabled decision for %s', (policy) => {
    const manifest = createSsrBootstrapAssetManifest(graph(), [{ id: 'app', clientModuleId: 'entry:a', initial: ['seo'] }], sources, policy)
    expect(manifest.policy).toBe(policy)
    expect(manifest.applications.app!.capabilities).toEqual({})
  })

  it('does not invoke or mutate consumer dependency/path policies', () => {
    const resolveDependencies = vi.fn(() => ['different.js'])
    const config = { build: { modulePreload: { resolveDependencies } }, experimental: {} } as unknown as ResolvedConfig
    expect(resolveSsrBootstrapPreloadPolicy(config)).toBe('resolve-dependencies')
    expect(config.build.modulePreload).toEqual({ resolveDependencies })
    expect(resolveDependencies).not.toHaveBeenCalled()
    expect(resolveSsrBootstrapPreloadPolicy({ ...config, build: { ...config.build, modulePreload: false } })).toBe('disabled')
    expect(resolveSsrBootstrapPreloadPolicy({ ...config, build: { ...config.build, modulePreload: { polyfill: false } } })).toBe('enabled')
  })

  it('derives only proven normalized application capabilities, including custom routers', () => {
    const middleware = () => undefined
    const applications = [
      { name: 'minimal', host: 'minimal.test', seo: { enabled: false } },
      { name: 'router', host: 'router.test', routes: [], seo: { enabled: false } },
      { name: 'seo', host: 'seo.test', routes: [], seo: { enabled: true } },
      { name: 'extensions', host: 'extensions.test', seo: { enabled: false }, extensions: [{ name: 'custom' }] },
      { name: 'middleware', host: 'middleware.test', routes: [], middleware: [middleware], seo: { enabled: false } },
      { name: 'custom', host: 'custom.test', router: () => ({}), seo: { enabled: false } },
      { name: 'full', host: 'full.test', routes: [], middleware: [middleware], seo: { enabled: true } },
    ]
    const entries = extractSsrViteEntries({ applications } as never).applications
    expect(Object.fromEntries(entries.map((entry) => [entry.id, entry.initialBootstrap]))).toEqual({
      minimal: [], router: ['navigation'], seo: ['navigation', 'seo', 'extensions'],
      extensions: ['extensions'], middleware: ['navigation', 'middleware'],
      custom: ['navigation'], full: ['navigation', 'middleware', 'seo', 'extensions'],
    })
  })
})

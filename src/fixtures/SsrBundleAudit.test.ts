import { describe, expect, it } from 'vitest'
import type { OutputBundle, OutputChunk } from 'rollup'
import { bundleModuleOwner, inspectSsrBundle } from './SsrBundleAudit'
import { assertAttributedClientModules, assertBrowserActivationAccounting, assertCapabilityGraph, assertCapabilityPagePayload, assertCompleteCriticalPayload, assertInstalledCapabilityParity, assertReviewedClientModules, PERFORMANCE_BUDGETS } from './SsrPerformanceContracts'

const chunk = (fileName: string, imports: string[] = [], dynamicImports: string[] = []): OutputChunk => ({
  type: 'chunk', fileName, name: fileName, code: `console.log(${JSON.stringify(fileName)})`,
  isEntry: fileName === 'entry.js', isDynamicEntry: false, isImplicitEntry: false,
  facadeModuleId: null, exports: [], imports, dynamicImports, implicitlyLoadedBefore: [],
  importedBindings: {}, referencedFiles: [], moduleIds: [], modules: {}, map: null,
  sourcemapFileName: null, preliminaryFileName: fileName,
})

describe('bundle attribution', () => {
  it('walks static dependencies once, isolates lazy routes, and accepts rendered route seeds', () => {
    const bundle: OutputBundle = {
      'entry.js': chunk('entry.js', ['shared.js'], ['home.js', 'other.js']),
      'shared.js': chunk('shared.js', ['entry.js', 'external-dependency']),
      'home.js': chunk('home.js', ['shared.js']),
      'other.js': chunk('other.js', ['shared.js']),
    }
    const report = inspectSsrBundle(bundle, '/framework')
    expect(report.entries[0].files).toEqual(['entry.js', 'shared.js'])
    const home = report.critical(['entry.js', 'home.js'])
    expect(home.files).toEqual(['entry.js', 'shared.js', 'home.js'])
    expect(home.files).not.toContain('other.js')
    expect(home.external).toEqual(['external-dependency'])
    expect(home.js.bytes).toBe(report.chunks.filter((item) => item.file !== 'other.js')
      .reduce((sum, item) => sum + item.sizes.bytes, 0))
  })

  it.each([
    ['/framework/src/data/fetch/runtime/SsrFetchRuntime.ts', 'framework-fetch'],
    ['/framework/dist/chunks/SsrApplicationCore-example.mjs', 'framework-core'],
    ['/app/node_modules/vue-ssr-lite/dist/client.mjs', 'framework-core'],
    ['/app/node_modules/.pnpm/vue@3/node_modules/vue/dist/vue.js', 'vue'],
    ['/app/node_modules/@vue/runtime-core/index.js', 'vue'],
    ['/app/node_modules/vue-router/dist/router.js', 'vue-router'],
    ['/app/node_modules/@iconify/vue/dist/iconify.js', 'third-party'],
    ['/app/src/App.vue', 'application'],
    ['\0vite/preload-helper', 'bundler'],
  ])('attributes %s to %s', (id, owner) => {
    expect(bundleModuleOwner(id, '/framework')).toBe(owner)
  })

  it('counts critical JS and CSS once, includes explicit rendered CSS, and exposes incomplete accounting', () => {
    const entry = Object.assign(chunk('entry.js'), { viteMetadata: { importedCss: new Set(['shared.css']) } })
    const route = Object.assign(chunk('route.js', ['entry.js']), { viteMetadata: { importedCss: new Set(['shared.css', 'route.css']) } })
    const css = (fileName: string) => ({
      type: 'asset' as const, fileName, name: fileName, names: [fileName],
      originalFileName: null, originalFileNames: [], source: 'body{color:navy}', needsCodeReference: false,
    })
    const report = inspectSsrBundle({
      'entry.js': entry, 'route.js': route,
      'shared.css': css('shared.css'), 'route.css': css('route.css'), 'rendered.css': css('rendered.css'),
    }, '/framework')
    const page = report.critical(['entry.js', 'route.js'], ['rendered.css', 'shared.css'])
    expect(page.css).toEqual(['shared.css', 'route.css', 'rendered.css'])
    expect(page.resourceCount).toBe(5)
    expect(page.total.bytes).toBe(page.js.bytes + page.cssSizes.bytes)
    expect(page.total.gzip).toBe(page.js.gzip + page.cssSizes.gzip)
    expect(page.unresolvedCss).toEqual([])
    expect(report.critical(['missing.js'], ['missing.css'])).toMatchObject({
      external: ['missing.js'], unresolvedCss: ['missing.css'], resourceCount: 2,
    })
  })

  it('requires review for new client implementations even below every byte ceiling', () => {
    const entry = chunk('entry.js')
    const module = { renderedLength: 1, originalLength: 1, renderedExports: ['small'], removedExports: [], code: '1' }
    entry.modules = { '/framework/src/SsrRequestResolution.ts': module }
    expect(() => assertReviewedClientModules(inspectSsrBundle({ 'entry.js': entry }, '/framework'), '/framework')).not.toThrow()
    for (const implementation of ['SsrServerResolution.ts', 'SsrServerReactivity.ts', 'UnexpectedRuntime.ts']) {
      entry.modules = { [`/framework/src/${implementation}`]: module }
      expect(() => assertReviewedClientModules(inspectSsrBundle({ 'entry.js': entry }, '/framework'), '/framework'))
        .toThrow('Unreviewed browser implementation')
    }
  })

  it('rejects incomplete resources and separate CSS or combined payload regressions', () => {
    const audit = inspectSsrBundle({ 'entry.js': chunk('entry.js') }, '/framework')
    expect(() => assertCompleteCriticalPayload(audit.critical(['missing.js']))).toThrow('Incomplete critical payload')
    expect(() => assertCompleteCriticalPayload(audit.critical(['entry.js'], ['missing.css']))).toThrow('Incomplete critical payload')
    const cssOverflow = audit.critical(['entry.js'])
    cssOverflow.cssSizes.gzip = PERFORMANCE_BUDGETS.pageCssGzip + 1
    expect(() => assertCompleteCriticalPayload(cssOverflow)).toThrow('exceeds budget')
    const combinedOverflow = audit.critical(['entry.js'])
    combinedOverflow.total.gzip = PERFORMANCE_BUDGETS.pageGzip + 1
    expect(() => assertCompleteCriticalPayload(combinedOverflow)).toThrow('exceeds budget')
  })
})


describe('capability attribution contracts', () => {
  const module = { renderedLength: 1, originalLength: 1, renderedExports: ['run'], removedExports: [], code: '1' }

  it('does not charge mixed external-peer pages against the framework-only bootstrap ceiling', () => {
    const entry = chunk('entry.js', ['vue', 'vue-router'])
    const page = inspectSsrBundle({ 'entry.js': entry }, '/framework').critical(['entry.js'])
    // Fixture/application growth may exceed both bootstrap limits without
    // establishing a framework regression. Completeness still must be checked.
    page.js.bytes = PERFORMANCE_BUDGETS.frameworkBootstrapBytes + 1
    page.js.gzip = PERFORMANCE_BUDGETS.frameworkBootstrapGzip + 1
    expect(() => assertCapabilityPagePayload(page, true)).not.toThrow()
    expect(() => assertCapabilityPagePayload({ ...page, external: ['missing.js'] }, true)).toThrow('Incomplete')
    expect(() => assertCapabilityPagePayload({ ...page, unresolvedCss: ['missing.css'] }, true)).toThrow('Incomplete')
    expect(() => assertCapabilityPagePayload(page, false)).toThrow('Incomplete')
    expect(() => assertCapabilityPagePayload({ ...page, external: [], total: { ...page.total, gzip: PERFORMANCE_BUDGETS.pageGzip + 1 } }, false))
      .toThrow('exceeds budget')
  })

  it.each(['source', 'installed'] as const)('requires activation accounting for new %s framework dynamic imports', (mode) => {
    const entry = chunk('entry.js')
    const source = 'SsrBrowserRuntime.ts'
    const known = 'navigation/SsrNavigationRuntime.ts'
    const unexpected = 'SsrReactivityRuntime.ts'
    const id = (name: string) => mode === 'source' ? `/framework/src/${name}`
      : `/consumer/node_modules/vue-ssr-lite/dist/${name.replace(/\.ts$/, '.mjs')}`
    entry.modules = { [id(source)]: module }
    const inspect = (target: string) => inspectSsrBundle({ 'entry.js': entry }, '/framework', {
      moduleSources: Object.fromEntries([source, known, unexpected].map((name) => [name.replace(/\.ts$/, '.mjs'), [name]])),
      moduleInfo: () => ({ importedIds: [], dynamicallyImportedIds: [id(target)] }),
    })
    expect(() => assertBrowserActivationAccounting(inspect(known))).not.toThrow()
    // Even an already-reviewed client module needs an activation decision if
    // bootstrap starts acquiring it dynamically. No new byte limit is needed.
    expect(() => assertBrowserActivationAccounting(inspect(unexpected))).toThrow('Unaccounted browser capability import')
  })

  it('attributes installed code by emitted provenance and rejects opaque shared chunks', () => {
    const entry = chunk('entry.js')
    entry.modules = { '/consumer/node_modules/vue-ssr-lite/dist/data/fetch/runtime/SsrFetchRuntime.mjs': module }
    const report = inspectSsrBundle({ 'entry.js': entry }, '/framework', {
      moduleSources: { 'data/fetch/runtime/SsrFetchRuntime.mjs': ['data/fetch/runtime/SsrFetchRuntime.ts'] },
    })
    expect(report.chunks[0]!.modules[0]).toMatchObject({ owner: 'framework-fetch', sources: ['data/fetch/runtime/SsrFetchRuntime.ts'] })
    expect(() => assertAttributedClientModules(report)).not.toThrow()
    const opaque = inspectSsrBundle({ 'entry.js': entry }, '/framework')
    expect(() => assertAttributedClientModules(opaque)).toThrow('opaque installed browser implementation')
    const fused = inspectSsrBundle({ 'entry.js': entry }, '/framework', {
      moduleSources: { 'data/fetch/runtime/SsrFetchRuntime.mjs': ['data/fetch/runtime/SsrFetchRuntime.ts', 'extensions/seo/state.ts'] },
    })
    expect(() => assertAttributedClientModules(fused)).toThrow('opaque installed browser implementation')
  })

  it('counts activated dynamic modules in the critical closure without charging unneeded features', () => {
    const entry = chunk('entry.js', [], ['fetch.js'])
    entry.modules = { '/framework/src/SsrBrowserResolution.ts': module }
    const fetch = chunk('fetch.js')
    fetch.modules = { '/framework/src/data/fetch/runtime/SsrFetchRuntime.ts': module }
    const report = inspectSsrBundle({ 'entry.js': entry, 'fetch.js': fetch }, '/framework')
    expect(() => assertCapabilityGraph('minimal', report, report.critical(['entry.js']))).not.toThrow()
    const activated = report.critical(['entry.js', 'fetch.js'])
    expect(activated.js.gzip).toBe(report.chunks.reduce((total, chunk) => total + chunk.sizes.gzip, 0))
    expect(() => assertCapabilityGraph('minimal', report, activated)).toThrow('fetch implementation must be absent')
  })

  it('rejects package-only implementation retention independently of compressed byte counts', () => {
    expect(() => assertInstalledCapabilityParity(['client.ts'], ['client.ts', 'data/fetch/runtime/SsrFetchRuntime.ts'], 'minimal'))
      .toThrow('package-only framework retention')
  })
})

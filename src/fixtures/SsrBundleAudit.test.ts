import { describe, expect, it } from 'vitest'
import type { OutputBundle, OutputChunk } from 'rollup'
import { bundleModuleOwner, inspectSsrBundle } from './SsrBundleAudit'
import { assertCompleteCriticalPayload, assertReviewedClientModules, PERFORMANCE_BUDGETS } from './SsrPerformanceContracts'

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

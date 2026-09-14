import { describe, expect, it } from 'vitest'
import { requestBootstrapCapabilities } from '../../../../src/browser/SsrBrowserBootstrap'
import { parseSsrViteManifest } from '../../../../src/assets/SsrRenderedAssetRuntime'
import { classifyNuxtClientJs } from '../../../../tools/benchmarks/SsrProductionNuxtComparison'
import {
  compareLikeForLike,
  decideCompleteInitialClaim,
  detectDuplicatePackages,
  LANDING_SERVE_ONLY_CODEGEN_PLUGIN,
  omitLandingServeOnlyCodegen,
  routeAssetsFromRenderedModules,
  TASK_011_PRODUCTION_NETWORK_TRACE,
} from '../../../../tools/audits/SsrProductionRetentionAudit'

describe('Task 012 measurement helpers', () => {
  it('refuses to compare transferred network bytes to raw fixture bytes', () => {
    expect(compareLikeForLike(
      { metric: 'raw', bytes: 116_802 },
      { metric: 'transferred', bytes: TASK_011_PRODUCTION_NETWORK_TRACE.appJs.bytes },
    )).toEqual({
      comparable: false,
      left: 116_802,
      right: 118_771,
      deltaBytes: null,
    })
    expect(TASK_011_PRODUCTION_NETWORK_TRACE.appJs.metric).toBe('transferred')
    expect(TASK_011_PRODUCTION_NETWORK_TRACE.appJs.contentEncoding).toBe('br')
    expect(TASK_011_PRODUCTION_NETWORK_TRACE.source).toMatch(/nuxt-vue-ssr\/landing/)
    expect(TASK_011_PRODUCTION_NETWORK_TRACE.nuxtInitialJs.bytes).toBe(49_300)
    expect(TASK_011_PRODUCTION_NETWORK_TRACE.nuxtInitialJs.metric).toBe('transferred')
  })

  it('identifies the Nuxt client entry by #entry / __vite__mapDeps, not by file size', () => {
    expect(classifyNuxtClientJs('_nuxt/entry.js', 'const __vite__mapDeps=(i)=>i;const x={__name:"nuxt-root"}').role)
      .toBe('nuxt-client-entry')
    expect(classifyNuxtClientJs('_nuxt/home.js', 'import{a}from"#entry";const x={__name:"Home"}').role)
      .toBe('home-page')
    expect(classifyNuxtClientJs('_nuxt/chrome.js', 'import{a}from"#entry";IconifyId;const x={__name:"Header"}').role)
      .toBe('shared-app-chrome')
    expect(classifyNuxtClientJs('_nuxt/solutions.js', 'import{a}from"#entry";const x={__name:"Solutions"}').role)
      .toBe('deferred-page')
  })

  it('reports third-party duplicate roots, not only Vue', () => {
    const duplicates = detectDuplicatePackages([
      { id: '/app/node_modules/@apollo/client/index.js', renderedLength: 40, owner: 'third-party', sources: [], imports: [], dynamicImports: [], dynamicImportSources: [], originalLength: 40, renderedExports: [] },
      { id: '/app/node_modules/nested/node_modules/@apollo/client/core.js', renderedLength: 20, owner: 'third-party', sources: [], imports: [], dynamicImports: [], dynamicImportSources: [], originalLength: 20, renderedExports: [] },
      { id: '/app/node_modules/vlite3/index.js', renderedLength: 10, owner: 'third-party', sources: [], imports: [], dynamicImports: [], dynamicImportSources: [], originalLength: 10, renderedExports: [] },
      { id: '\0/app/node_modules/vlite3/extra.js', renderedLength: 4, owner: 'third-party', sources: [], imports: [], dynamicImports: [], dynamicImportSources: [], originalLength: 4, renderedExports: [] },
    ] as never)
    expect(duplicates.packages.map((item) => item.name)).toEqual(['@apollo/client'])
    expect(duplicates.inspectedPackages.find((item) => item.name === 'vlite3')?.roots).toEqual(['/app/node_modules/vlite3'])
    expect(duplicates.packages[0]!.roots).toHaveLength(2)
    expect(duplicates.inspectedPackages.map((item) => item.name).sort()).toEqual(['@apollo/client', 'vlite3'])
  })

  it('keeps Task 011 request bootstrap as navigation plus optional middleware', () => {
    expect(requestBootstrapCapabilities(true, false)).toEqual(['navigation'])
    expect(requestBootstrapCapabilities(true, true)).toEqual(['navigation', 'middleware'])
    expect(requestBootstrapCapabilities(false, true)).toEqual(['middleware'])
  })

  it('maps rendered modules through the production SSR manifest instead of filename regex', () => {
    const manifest = parseSsrViteManifest(JSON.stringify({
      'src/App.vue': [],
      'src/layouts/PublicLayout.vue': [],
      'src/modules/Public/pages/Home.vue': ['assets/home.js', 'assets/home.css'],
      'src/later.ts': ['assets/later.js'],
    }))
    expect(routeAssetsFromRenderedModules(
      ['/app/src/App.vue', '/app/src/layouts/PublicLayout.vue', '/app/src/modules/Public/pages/Home.vue'],
      manifest,
      { applicationId: 'app', base: '/', root: '/app' },
    )).toEqual({
      files: ['assets/home.js'],
      css: ['assets/home.css'],
      unmatched: [],
    })
  })

  it('omits only the landing serve-only GraphQL codegen plugin from the render loader', () => {
    expect(omitLandingServeOnlyCodegen([
      { name: 'vue-ssr-lite' },
      { name: LANDING_SERVE_ONLY_CODEGEN_PLUGIN },
      { name: 'vite:vue' },
    ]).map((plugin) => plugin.name)).toEqual(['vue-ssr-lite', 'vite:vue'])
  })
})

describe('decideCompleteInitialClaim', () => {
  const exactBase = {
    requestKind: 'authoritative-render' as const,
    manifest: { kind: 'resolved' as const, files: [] as const, css: [] as const, unmatched: [] as const },
    entryStaticModuleIds: ['/app/src/App.vue', '/app/src/layouts/PublicLayout.vue'],
    emittedFiles: ['assets/app.js', 'assets/SsrSeoLifecycle.js'],
    selectedCapabilityFiles: ['assets/SsrSeoLifecycle.js'],
    root: '/app',
  }

  it('sets exact after successful SSR-manifest mapping', () => {
    expect(decideCompleteInitialClaim(exactBase)).toMatchObject({
      claim: 'exact',
      reasons: [],
      unresolvedModules: [],
    })
  })

  it('does not claim when the SSR manifest is missing or invalid', () => {
    expect(decideCompleteInitialClaim({
      ...exactBase,
      manifest: { kind: 'unavailable', error: 'ssr-manifest.invalid-json', unmatched: ['src/App.vue'] },
    })).toMatchObject({
      claim: 'not-claimed',
    })
    expect(decideCompleteInitialClaim({
      ...exactBase,
      manifest: { kind: 'unavailable', error: 'ENOENT: no such file', unmatched: ['src/App.vue'] },
    }).reasons.join(' ')).toMatch(/SSR manifest was not successfully read and parsed/)
  })

  it('does not claim an unmatched rendered module unless it is proven entry-static', () => {
    expect(decideCompleteInitialClaim({
      ...exactBase,
      manifest: { kind: 'resolved', files: [], css: [], unmatched: ['/app/src/orphan.vue'] },
    })).toMatchObject({
      claim: 'not-claimed',
      unresolvedModules: ['/app/src/orphan.vue'],
    })
    expect(decideCompleteInitialClaim({
      ...exactBase,
      manifest: { kind: 'resolved', files: [], css: [], unmatched: ['/app/src/App.vue'] },
    })).toMatchObject({
      claim: 'exact',
      provenEntryStatic: ['/app/src/App.vue'],
      unresolvedModules: [],
    })
  })

  it('does not claim when a selected capability file is missing from the observed bundle', () => {
    expect(decideCompleteInitialClaim({
      ...exactBase,
      selectedCapabilityFiles: ['assets/missing-capability.js'],
    })).toMatchObject({
      claim: 'not-claimed',
    })
    expect(decideCompleteInitialClaim({
      ...exactBase,
      selectedCapabilityFiles: ['assets/missing-capability.js'],
    }).reasons.join(' ')).toMatch(/missing from the observed bundle/)
  })
})

import { normalizeFrameworkRoot, type inspectSsrBundle } from './SsrBundleAudit'
import { SSR_BROWSER_BOOTSTRAP_SOURCES } from '../../src/browser/SsrBrowserBootstrap'

// Reviewed browser implementations, not a count of whatever happens to build.
// A new runtime file requires an explicit boundary review before this list grows.
const CLIENT_MODULES = new Set([
  'index.ts', 'client.ts', 'config/SsrPublicConfigHelpers.ts', 'application/SsrApplicationCore.ts', 'browser/SsrBrowserRuntime.ts',
  'browser/SsrBrowserResolution.ts', 'browser/SsrBrowserTiming.ts', 'browser/SsrRouteRecovery.ts', 'request/SsrCanonicalOrigin.ts',
  'request/SsrDomainRuntime.ts', 'request/SsrHostnameRuntime.ts', 'head/SsrManagedHead.ts',
  'request/SsrRequestOrigin.ts', 'request/SsrRequestContext.ts', 'request/SsrRequestResolution.ts',
  'request/SsrResponseStatus.ts', 'rendering/SsrReactivityRuntime.ts', 'navigation/SsrRouteRenderRuntime.ts',
  'hydration/SsrHydrationRuntime.ts', 'hydration/SsrSerialization.ts', 'rendering/SsrEscape.ts', 'config/SsrPublicConfig.ts',
  'hydration/SsrVueHydrationAdapter.ts',
  'extensions/core/ExtensionRuntimeKey.ts',
  'extensions/core/ExtensionRuntime.ts', 'extensions/core/defineExtension.ts',
  'extensions/resolveBuiltInExtensions.ts', 'extensions/seo/index.ts',
  'extensions/seo/SsrSeoLifecycle.ts',
  'extensions/seo/types.ts', 'extensions/seo/state.ts', 'extensions/seo/normalize.ts',
  'extensions/seo/client.ts', 'extensions/seo/useSeo.ts', 'extensions/seo/robots.ts',
  // This module converts head contributions; its filename is historical.
  'extensions/seo/server.ts',
  'middleware/SsrBrowserMiddleware.ts', 'middleware/SsrMiddlewarePresence.ts',
  'middleware/defineMiddleware.ts',
  'middleware/SsrMiddlewareRuntime.ts', 'middleware/SsrMiddlewareExecution.ts',
  'middleware/SsrMiddlewareProps.ts', 'middleware/SsrMiddlewareCookies.ts',
  'middleware/SsrMiddlewareCollection.ts', 'middleware/SsrMiddlewareResult.ts',
  'navigation/index.ts', 'navigation/RouterView.ts', 'navigation/LoadingIndicator.ts',
  'navigation/SsrNavigationContext.ts', 'navigation/SsrNavigationRuntime.ts',
  'data/index.ts', 'data/fetch/index.ts', 'data/fetch/composables/useFetch.ts',
  'data/fetch/context/setContext.ts', 'data/fetch/runtime/SsrFetchRuntime.ts',
  'data/fetch/runtime/resolveSsrFetchRuntime.ts',
  'data/fetch/runtime/SsrFetchRuntimeScope.ts', 'data/fetch/runtime/SsrFetchContext.ts',
  'data/fetch/runtime/SsrFetchHydration.ts', 'data/fetch/runtime/SsrFetchCache.ts',
  'data/fetch/runtime/SsrFetchIdentity.ts', 'data/fetch/runtime/SsrFetchExecution.ts',
  'server/routes/defineServerRoutes.ts', 'server/routes/defineServerMiddleware.ts',
])

export const PERFORMANCE_BUDGETS = {
  // Same pinned Vue build on both sides: budget only the added watcher bridge.
  watcherAddedGzip: 2 * 1024,
  watcherAddedBytes: 8 * 1024,
  // Export-only bootstrap probe with Vue/Vue Router externalized. Never apply
  // these framework-only ceilings to a capability fixture's mixed page payload.
  frameworkBootstrapGzip: 24 * 1024,
  frameworkBootstrapBytes: 80 * 1024,
  pageGzip: 72 * 1024,
  pageCssGzip: 2 * 1024,
} as const

export const assertReviewedClientModules = (
  audit: ReturnType<typeof inspectSsrBundle>,
  frameworkRoot: string
): void => {
  const sourceRoot = `${normalizeFrameworkRoot(frameworkRoot)}/src/`
  const modules = audit.chunks.flatMap((chunk) => chunk.modules)
    .filter((module) => module.renderedLength > 0 && module.owner.startsWith('framework-'))
  if (!modules.length) throw new Error('The client audit must retain framework modules.')
  for (const module of modules) {
    const id = module.id.replaceAll('\\', '/').split('?', 1)[0]
    // Source-fixture audits must not silently substitute opaque distribution chunks.
    if (!id.startsWith(sourceRoot) || !CLIENT_MODULES.has(id.slice(sourceRoot.length))) {
      throw new Error(`Unreviewed browser implementation: ${module.id}`)
    }
  }
}

export const assertCompleteCriticalPayload = (
  page: ReturnType<ReturnType<typeof inspectSsrBundle>['critical']>
): void => {
  if (page.external.length || page.unresolvedCss.length) {
    throw new Error(`Incomplete critical payload: ${[...page.external, ...page.unresolvedCss].join(', ')}`)
  }
  if (page.total.gzip > PERFORMANCE_BUDGETS.pageGzip || page.cssSizes.gzip > PERFORMANCE_BUDGETS.pageCssGzip) {
    throw new Error(`Critical fixture payload exceeds budget: JS=${page.js.gzip}, CSS=${page.cssSizes.gzip}, total=${page.total.gzip} gzip bytes`)
  }
}

// Avoid process-global NODE_ENV mutation when a test is collecting a production
// client graph; concurrent server/development suites keep their environment.
export const productionClientDefines = {
  'process.env.NODE_ENV': JSON.stringify('production'),
  'import.meta.env.DEV': 'false',
  'import.meta.env.PROD': 'true',
  __VUE_OPTIONS_API__: 'true',
  __VUE_PROD_DEVTOOLS__: 'false',
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
}

export const sourceClientAliases = (root: string) => {
  const canonical = normalizeFrameworkRoot(root)
  return [
    { find: /^vue-ssr-lite\/client$/, replacement: `${canonical}/src/client.ts` },
    { find: /^vue-ssr-lite$/, replacement: `${canonical}/src/index.ts` },
  ]
}

export const CAPABILITY_PROFILES = {
  minimal: { baseline: 'minimal', router: false, fetch: false, middleware: false, seo: false, extensions: false, reactivity: false },
  router: { baseline: 'minimal', router: true, fetch: false, middleware: false, seo: false, extensions: false, reactivity: false },
  navigation: { baseline: 'router', router: true, fetch: false, middleware: false, seo: false, extensions: false, reactivity: false },
  fetch: { baseline: 'router', router: true, fetch: true, middleware: false, seo: false, extensions: false, reactivity: false },
  middleware: { baseline: 'router', router: true, fetch: false, middleware: true, seo: false, extensions: false, reactivity: false },
  seo: { baseline: 'router', router: true, fetch: false, middleware: false, seo: true, extensions: true, reactivity: false },
  extensions: { baseline: 'minimal', router: false, fetch: false, middleware: false, seo: false, extensions: true, reactivity: false },
  'reactivity-control': { baseline: 'minimal', router: false, fetch: false, middleware: false, seo: false, extensions: false, reactivity: false },
  reactivity: { baseline: 'reactivity-control', router: false, fetch: false, middleware: false, seo: false, extensions: false, reactivity: true },
  full: { baseline: 'router', router: true, fetch: true, middleware: true, seo: true, extensions: true, reactivity: true },
  'fetch-root': { baseline: 'fetch-root', router: false, fetch: true, middleware: false, seo: false, extensions: false, reactivity: false },
  'router-view-root': { baseline: 'router-view-root', router: false, fetch: false, middleware: false, seo: false, extensions: false, reactivity: false },
  'watcher-root': { baseline: 'watcher-root', router: false, fetch: false, middleware: false, seo: false, extensions: false, reactivity: true },
} as const
export type CapabilityProfile = keyof typeof CAPABILITY_PROFILES

type Audit = ReturnType<typeof inspectSsrBundle>
type CriticalPayload = ReturnType<Audit['critical']>

export const assertCapabilityPagePayload = (page: CriticalPayload, externalPeers: boolean): void => {
  if (!externalPeers) return assertCompleteCriticalPayload(page)
  if (page.external.some((id) => !['vue', 'vue-router'].includes(id)) || page.unresolvedCss.length) {
    throw new Error('Incomplete external-peer capability graph')
  }
  // External-peer pages still contain application/route glue. Their signed
  // baseline deltas are reported, without inventing numeric capability ceilings.
}

// Audit-only contract for the browser's four dynamic implementation boundaries.
// A new framework dynamic edge requires an explicit accounting decision here.
export const BROWSER_ACTIVATION_SOURCES = {
  router: SSR_BROWSER_BOOTSTRAP_SOURCES.navigation,
  middleware: SSR_BROWSER_BOOTSTRAP_SOURCES.middleware,
  seo: SSR_BROWSER_BOOTSTRAP_SOURCES.seo,
  extensions: SSR_BROWSER_BOOTSTRAP_SOURCES.extensions,
} as const

export const assertBrowserActivationAccounting = (audit: Audit): void => {
  const reviewed = new Set<string>(Object.values(BROWSER_ACTIVATION_SOURCES))
  for (const chunk of audit.chunks) for (const module of chunk.modules) {
    if (!module.renderedLength || !module.owner.startsWith('framework-')) continue
    for (const source of module.dynamicImportSources) {
      if (!reviewed.has(source)) throw new Error(`Unaccounted browser capability import: ${module.id} -> ${source}`)
    }
  }
}

export const retainedFrameworkSources = (audit: Audit, page?: CriticalPayload): string[] => {
  const selected = page ? new Set(page.files) : undefined
  return [...new Set(audit.chunks.filter((chunk) => !selected || selected.has(chunk.file))
    .flatMap((chunk) => chunk.modules)
    .filter((module) => module.renderedLength > 0 && module.owner.startsWith('framework-'))
    .flatMap((module) => module.sources))].sort()
}

/** Apply the same reviewed source allowlist to the installed artifact's provenance. */
export const assertAttributedClientModules = (audit: Audit): void => {
  if (!audit.chunks.some(chunk => chunk.modules.some(module => module.renderedLength > 0 && module.owner.startsWith('framework-')))) {
    throw new Error('The capability audit must retain framework implementations.')
  }
  for (const chunk of audit.chunks) {
    for (const module of chunk.modules) {
      if (!module.renderedLength || !module.owner.startsWith('framework-')) continue
      if (module.sources.length !== 1 || !CLIENT_MODULES.has(module.sources[0]!)) {
        throw new Error(`Unreviewed or opaque installed browser implementation: ${module.id}`)
      }
    }
  }
}

/** Capability execution can be emitted as a later chunk, but cannot be initial when absent. */
export const assertCapabilityGraph = (profile: CapabilityProfile, audit: Audit, page: CriticalPayload): void => {
  const capabilities = CAPABILITY_PROFILES[profile]
  const sources = retainedFrameworkSources(audit, page)
  const contracts = [
    ['fetch', 'data/fetch/runtime/SsrFetchRuntime.ts'],
    ['middleware', 'middleware/SsrMiddlewareExecution.ts'],
    ['seo', 'extensions/seo/state.ts'],
    ['extensions', 'extensions/core/ExtensionRuntime.ts'],
    ['reactivity', 'rendering/SsrReactivityRuntime.ts'],
    ['router', 'navigation/SsrNavigationRuntime.ts'],
  ] as const
  for (const [capability, implementation] of contracts) {
    if (sources.includes(implementation) !== capabilities[capability]) {
      throw new Error(`${profile}: ${capability} implementation must be ${capabilities[capability] ? 'present' : 'absent'}: ${implementation}`)
    }
  }
  // Reject whole unused families, not only one convenient sentinel file.
  for (const source of sources) {
    if (!capabilities.fetch && /^(?:data\/fetch\/)(?!runtime\/SsrFetchRuntimeScope\.ts)/.test(source) ||
        !capabilities.middleware && /^middleware\/(?!SsrBrowserMiddleware\.ts|SsrMiddlewarePresence\.ts)/.test(source) ||
        !capabilities.seo && /^extensions\/seo\/(?!types\.ts)/.test(source) ||
        !capabilities.extensions && /^extensions\/core\/(?!ExtensionRuntimeKey\.ts)/.test(source)) {
      throw new Error(`${profile}: unused capability retained ${source}`)
    }
  }
}

/** A distribution build cannot add a framework implementation to an equivalent source graph. */
export const assertInstalledCapabilityParity = (
  source: readonly string[], installed: readonly string[], label: string
): void => {
  const allowed = new Set(source)
  const extra = installed.filter((id) => !allowed.has(id))
  if (extra.length) throw new Error(`${label}: package-only framework retention: ${extra.join(', ')}`)
}

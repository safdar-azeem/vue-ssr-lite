import type { inspectSsrBundle } from './SsrBundleAudit'

// Reviewed browser implementations, not a count of whatever happens to build.
// A new runtime file requires an explicit boundary review before this list grows.
const CLIENT_MODULES = new Set([
  'index.ts', 'client.ts', 'SsrApplicationCore.ts', 'SsrBrowserRuntime.ts',
  'SsrBrowserResolution.ts', 'SsrBrowserTiming.ts', 'SsrCanonicalOrigin.ts',
  'SsrDomainRuntime.ts', 'SsrHostnameRuntime.ts', 'SsrManagedHead.ts',
  'SsrRequestOrigin.ts', 'SsrRequestContext.ts', 'SsrRequestResolution.ts',
  'SsrResponseStatus.ts', 'SsrReactivityRuntime.ts', 'SsrRouteRenderRuntime.ts',
  'SsrHydrationRuntime.ts', 'SsrSerialization.ts', 'SsrEscape.ts', 'SsrPublicConfig.ts',
  'hydration/SsrVueHydrationAdapter.ts',
  'core/extensions/ExtensionRuntime.ts', 'core/extensions/defineExtension.ts',
  'extensions/resolveBuiltInExtensions.ts', 'extensions/seo/index.ts',
  'extensions/seo/types.ts', 'extensions/seo/state.ts', 'extensions/seo/normalize.ts',
  'extensions/seo/client.ts', 'extensions/seo/useSeo.ts', 'extensions/seo/robots.ts',
  // This module converts head contributions; its filename is historical.
  'extensions/seo/server.ts',
  'middleware/index.ts', 'middleware/defineMiddleware.ts',
  'middleware/SsrMiddlewareRuntime.ts', 'middleware/SsrMiddlewareExecution.ts',
  'middleware/SsrMiddlewareProps.ts', 'middleware/SsrMiddlewareCookies.ts',
  'middleware/SsrMiddlewareCollection.ts', 'middleware/SsrMiddlewareResult.ts',
  'navigation/index.ts', 'navigation/RouterView.ts', 'navigation/LoadingIndicator.ts',
  'navigation/SsrNavigationRuntime.ts',
  'data/index.ts', 'data/fetch/index.ts', 'data/fetch/composables/useFetch.ts',
  'data/fetch/context/setContext.ts', 'data/fetch/runtime/SsrFetchRuntime.ts',
  'data/fetch/runtime/SsrFetchRuntimeScope.ts', 'data/fetch/runtime/SsrFetchContext.ts',
  'data/fetch/runtime/SsrFetchHydration.ts', 'data/fetch/runtime/SsrFetchCache.ts',
  'data/fetch/runtime/SsrFetchIdentity.ts', 'data/fetch/runtime/SsrFetchExecution.ts',
  'server-routes/defineServerRoutes.ts', 'server-routes/defineServerMiddleware.ts',
])

export const PERFORMANCE_BUDGETS = {
  // Same pinned Vue build on both sides: budget only the added watcher bridge.
  watcherAddedGzip: 2 * 1024,
  watcherAddedBytes: 8 * 1024,
  // This build externalizes Vue/Vue Router, so these are actual framework bytes.
  frameworkBootstrapGzip: 24 * 1024,
  frameworkBootstrapBytes: 80 * 1024,
  pageGzip: 72 * 1024,
  pageCssGzip: 2 * 1024,
} as const

export const assertReviewedClientModules = (
  audit: ReturnType<typeof inspectSsrBundle>,
  frameworkRoot: string
): void => {
  const sourceRoot = `${frameworkRoot.replaceAll('\\', '/').replace(/\/$/, '')}/src/`
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

export const sourceClientAliases = (root: string) => [
  { find: /^vue-ssr-lite\/client$/, replacement: `${root}/src/client.ts` },
  { find: /^vue-ssr-lite$/, replacement: `${root}/src/index.ts` },
]

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import * as clientApi from './client'
import * as publicApi from './index'
import * as serverApi from './server'
import * as viteApi from './vite'

const ROOT_RUNTIME_EXPORTS = [
  'LoadingIndicator',
  'RouteSuspense',
  'defineApplication',
  'defineExtension',
  'defineMiddleware',
  'defineServer',
  'redirectTo',
  'setHttpStatus',
  'usePublicConfig',
  'useSeo',
  'useOrigin',
  'useDomain',
]

const CLIENT_RUNTIME_EXPORTS = [
  'SSR_HYDRATION_CONTEXT',
  'SSR_REQUEST_RESOLUTION',
  'createDomainUrl',
  'hydrateSsrApplication',
  'mountSpaApplication',
  'ssrWatch',
  'ssrWatchEffect',
  'useDomain',
  'useSsrResolution',
]

const SERVER_RUNTIME_EXPORTS = [
  'createDomainUrl',
  'createSsrConsoleLogger',
  'createSsrManagedServer',
  'createSsrMemoryResponseCache',
  'createSsrSeoEndpoints',
  'defineServer',
  'defineSitemap',
  'requireSsrEnum',
  'requireSsrEnv',
  'requireSsrHostname',
  'ssrEnvBoolean',
  'ssrEnvList',
  'ssrEnvNumber',
  'useDomain',
  'useSsrRequestContext',
]

const VITE_RUNTIME_EXPORTS = ['vueSsrLite']

const OBSOLETE_RUNTIME_EXPORTS = [
  'useSsrDomain',
  'useSiteOrigin',
  'setResponseStatus',
  'setResponseRedirect',
]

/** PUBLIC CONSUMER CONTRACT: normal universal application types. */
const ROOT_TYPE_EXPORTS = [
  'AppContext',
  'AppInitializer',
  'ApplicationConfig',
  'ExtensionContext',
  'ExtensionDefinition',
  'ExtensionEnvironment',
  'JsonObject',
  'JsonPrimitive',
  'JsonValue',
  'Middleware',
  'MiddlewareContext',
  'MiddlewareCookieOptions',
  'MiddlewareCookies',
  'MiddlewarePropsResult',
  'MiddlewareRedirectOptions',
  'MiddlewareRedirectResult',
  'MiddlewareRedirectStatus',
  'MiddlewareResult',
  'RobotsConfig',
  'RobotsGroup',
  'SeoImageInput',
  'SeoImageValue',
  'SeoLinkEntry',
  'SeoMediaInput',
  'SeoMediaValue',
  'SeoMetaEntry',
  'SeoOpenGraphDefaults',
  'SeoOpenGraphInput',
  'SeoPageInput',
  'SeoResolvable',
  'SeoRobotsInput',
  'SeoRouteInput',
  'SeoSiteDefaults',
  'SeoTwitterInput',
  'ServerConfig',
  'SiteRobotsConfig',
  'SiteRobotsContext',
  'SiteRobotsResolution',
  'SiteRobotsResolver',
  'SiteSeoConfig',
  'SiteSeoContext',
  'SiteSeoResolution',
  'SiteSeoResolver',
  'SsrAppShellConfig',
  'SsrDomainApi',
  'SsrRenderMode',
  'SsrResponseRedirectOptions',
  'SsrSeoConfig',
  'SsrSiteSeoInput',
  'UseSeoInput',
  'UseSeoSource',
]

/** ADVANCED PUBLIC CONTRACT: browser bootstrap and hydration types. */
const CLIENT_TYPE_EXPORTS = [
  'SsrApplicationDefinition',
  'SsrClientApplicationDefinition',
  'SsrCreateDomainUrlOptions',
  'SsrDomainApi',
  'SsrDomainContext',
  'SsrHydrateOptions',
  'SsrHydrationContext',
  'SsrHydrationState',
  'SsrMountedApplication',
  'SsrRenderRequest',
  'SsrRequestResolution',
  'SsrSpaMountOptions',
  'SsrWatchOptions',
]

/** ADVANCED PUBLIC CONTRACT: server hosting, endpoint, cache, and SEO types. */
const SERVER_TYPE_EXPORTS = [
  'ApplicationConfig',
  'RobotsConfig',
  'RobotsGroup',
  'ServerConfig',
  'SeoSiteDefaults',
  'SitemapContext',
  'SitemapEntriesResult',
  'SitemapEntry',
  'SitemapImageEntry',
  'SitemapNewsEntry',
  'SitemapNotFoundResult',
  'SitemapProvider',
  'SitemapProviderResult',
  'SitemapShardCollection',
  'SitemapSource',
  'SitemapVideoEntry',
  'SiteRobotsConfig',
  'SiteRobotsContext',
  'SiteRobotsResolution',
  'SiteRobotsResolver',
  'SiteSeoConfig',
  'SiteSeoContext',
  'SiteSeoResolution',
  'SiteSeoResolver',
  'SsrApplicationCookiesConfig',
  'SsrApplicationDomainConfig',
  'SsrAppShellConfig',
  'SsrConfigServerOptions',
  'SsrCreateDomainUrlOptions',
  'SsrDomainApi',
  'SsrDomainContext',
  'SsrDomainMode',
  'SsrDomainParamDefinition',
  'SsrDomainParamSource',
  'SsrEndpointDefinition',
  'SsrEndpointTools',
  'SsrErrorRenderContext',
  'SsrHeaderValue',
  'SsrHeaders',
  'SsrHttpRequest',
  'SsrHttpResponse',
  'SsrLogger',
  'SsrManagedServer',
  'SsrManagedServerOptions',
  'SsrMemoryResponseCacheOptions',
  'SsrPublicConfigDomain',
  'SsrPublicConfigFactory',
  'SsrPublicConfigHeaderValue',
  'SsrPublicConfigHeaders',
  'SsrPublicConfigRequest',
  'SsrPublicConfigSource',
  'SsrReadinessProbe',
  'SsrRenderMetrics',
  'SsrRenderMode',
  'SsrResponseCache',
  'SsrResponseCacheInvalidation',
  'SsrResponseCacheReadOptions',
  'SsrResponseCacheStrategy',
  'SsrResponseCacheWriteOptions',
  'SsrSeoConfig',
  'SsrSeoEndpointMode',
  'SsrSeoEndpointOptions',
  'SsrSiteSeoInput',
]

/** ADVANCED PUBLIC CONTRACT: Vite integration options only. */
const VITE_TYPE_EXPORTS = ['SsrVitePluginOptions']

const HIDDEN_ROOT_RUNTIME_EXPORTS = [
  'createManagedHeadController',
  'createSsrApplication',
  'defineSitemap',
  'defineSsrConfig',
  'hydrateSsrApplication',
  'renderSsrApplication',
  'SSR_REQUEST_CONTEXT',
  'useSsrRequestContext',
]

interface EntrypointSourceSurface {
  runtime: string[]
  types: string[]
}

const sourceRoot = dirname(fileURLToPath(import.meta.url))

const collectEntrypointSourceSurface = async (
  filename: 'index.ts' | 'client.ts' | 'server.ts' | 'vite.ts'
): Promise<EntrypointSourceSurface> => {
  const source = await readFile(join(sourceRoot, filename), 'utf8')
  const parsed = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const runtime = new Set<string>()
  const types = new Set<string>()

  for (const statement of parsed.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        throw new Error(`${filename} must use explicit named exports.`)
      }
      for (const specifier of statement.exportClause.elements) {
        const target = statement.isTypeOnly || specifier.isTypeOnly ? types : runtime
        target.add(specifier.name.text)
      }
      continue
    }

    const exported = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement)?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
        )
      : false
    if (!exported) continue

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          throw new Error(`${filename} must use named exported declarations.`)
        }
        runtime.add(declaration.name.text)
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      runtime.add(statement.name.text)
    } else if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    ) {
      types.add(statement.name.text)
    }
  }

  return {
    runtime: [...runtime].sort(),
    types: [...types].sort(),
  }
}

describe('public package entrypoint contracts', () => {
  it.each([
    ['root', publicApi, ROOT_RUNTIME_EXPORTS],
    ['client', clientApi, CLIENT_RUNTIME_EXPORTS],
    ['server', serverApi, SERVER_RUNTIME_EXPORTS],
    ['vite', viteApi, VITE_RUNTIME_EXPORTS],
  ] as const)('locks the %s runtime surface', (_name, api, expected) => {
    expect(Object.keys(api).sort()).toEqual([...expected].sort())
  })

  it.each([
    ['index.ts', ROOT_RUNTIME_EXPORTS, ROOT_TYPE_EXPORTS],
    ['client.ts', CLIENT_RUNTIME_EXPORTS, CLIENT_TYPE_EXPORTS],
    ['server.ts', SERVER_RUNTIME_EXPORTS, SERVER_TYPE_EXPORTS],
    ['vite.ts', VITE_RUNTIME_EXPORTS, VITE_TYPE_EXPORTS],
  ] as const)(
    'locks explicit runtime and type exports in %s',
    async (filename, expectedRuntime, expectedTypes) => {
      const surface = await collectEntrypointSourceSurface(filename)
      expect(surface.runtime).toEqual([...expectedRuntime].sort())
      expect(surface.types).toEqual([...expectedTypes].sort())
    }
  )

  it('does not publish server or renderer internals from the package root', () => {
    for (const name of HIDDEN_ROOT_RUNTIME_EXPORTS) {
      expect(publicApi).not.toHaveProperty(name)
    }
  })

  it('does not publish obsolete runtime API names from affected entrypoints', () => {
    for (const api of [publicApi, clientApi, serverApi]) {
      for (const name of OBSOLETE_RUNTIME_EXPORTS) {
        expect(api).not.toHaveProperty(name)
      }
    }
  })

  it('keeps internal and superseded type names out of package entrypoints', async () => {
    const surfaces = await Promise.all(
      (['index.ts', 'client.ts', 'server.ts', 'vite.ts'] as const).map(
        collectEntrypointSourceSurface
      )
    )
    const exportedTypes = new Set(surfaces.flatMap((surface) => surface.types))
    // INTERNAL OR SUPERSEDED TYPES: package entrypoints must not export these.
    for (const name of [
      'RobotsLegacyConfig',
      'SeoInput',
      'SsrCompiledConfig',
      'SsrConfig',
      'SsrConfigExport',
      'SsrConfigShared',
      'SsrMultiApplicationConfig',
      'SsrNormalizedConfig',
      'SsrSingleApplicationConfig',
      'SsrViteApplicationEntry',
    ]) {
      expect(exportedTypes).not.toContain(name)
    }
  })
})

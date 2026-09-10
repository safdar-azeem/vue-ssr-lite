import { access } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import type { RouteRecordRaw } from 'vue-router'
import { compileServerRoutes, snapshotServerMiddleware } from './server-routes/SsrServerRouteRuntime'
import type { SsrCompiledServerRoutes } from './server-routes/SsrServerRouteInternalTypes'
import type { GlobalServerMiddleware } from './server-routes/SsrServerRouteTypes'
import type {
  ApplicationConfig,
  SsrAppShellConfig,
  SsrApplicationDomainConfig,
  SsrBoundAppShell,
  SsrConfig,
  SsrConfigExport,
  SsrDomainMode,
  SsrPublicConfigFactory,
  SsrRenderMode,
  SsrResolvedAppShell,
  SsrRobotsInput,
  SsrSeoConfig,
  SsrSingleApplicationConfig,
  SsrSiteSeoInput,
} from './SsrConfigTypes'
import { createSeoEndpoints } from './extensions/seo/SeoEndpoints'
import type { SitemapProvider } from './extensions/seo/sitemap'
import type {
  SeoApplicationConfig,
  SeoSiteDefaults,
  SiteRobotsConfig,
  SiteSeoConfig,
} from './extensions/seo/types'
import { validateSeoSiteDefaults } from './extensions/seo/normalize'
import {
  readPublicUrl,
  requiresProductionSeoOrigin,
  resolveServerSiteOrigin,
} from './server/SsrSiteOriginRuntime'
import { loadSitemapProvider } from './server/SsrSitemapConfig'
import { normalizeSsrHost, stripSsrHostPort } from './SsrHostnameRuntime'
import type {
  SsrEndpointDefinition,
  SsrEntryKind,
  SsrReadinessProbe,
  SsrResolvedApplicationDefinition,
  SsrResponseCacheStrategy,
  SsrServerOptions,
} from './SsrRuntimeTypes'
import { SsrHostConfigurationError, validateSsrHostEntries } from './server/SsrHostRuntime'
import {
  createRouteRenderMatcher,
  validateRouteRenderBoundaries,
  type SsrRouteRenderMatcher,
} from './SsrRouteRenderRuntime'
import type { SsrApplicationRenderer } from './SsrRenderRuntime'
import { prepareSsrCompiledMetadata } from './server/SsrCompiledMetadata'
import type { SsrUniversalRuntimeProjection } from './SsrUniversalProjection'

export const SSR_DEFAULT_MAIN = './src/main.ts'
export const SSR_DEFAULT_ROOT = './src/App.vue'
export const SSR_DEFAULT_APPLICATION_ENTRY = SSR_DEFAULT_MAIN
export const SSR_DEFAULT_TEMPLATE = './index.html'
export const SSR_DEFAULT_MOUNT = '#app'
export const SSR_DEFAULT_APPLICATION_ID = 'app'

export const DEFINE_SERVER_ROUTES_ERROR = [
  'defineServer({ routes }) is not supported for single applications.',
  '',
  'Export routes from src/main.ts instead:',
  '',
  'export { routes }',
  '',
  'Use defineApplication({ routes }) for explicit multi-application configuration.',
].join('\n')

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1'] as const
const LOOPBACK_HOST_SET = new Set<string>(LOOPBACK_HOSTS)
export const SSR_RUNTIME_VIRTUAL_ID = 'virtual:vue-ssr-lite/runtime'
export const SSR_RENDERER_VIRTUAL_ID =
  'virtual:vue-ssr-lite/internal/ssr-renderer'
export const SSR_CLIENT_VIRTUAL_PREFIX = 'virtual:vue-ssr-lite/client/'
export const SSR_HTML_VIRTUAL_PREFIX = 'virtual:vue-ssr-lite/html/'

export interface SsrCompiledApplication {
  id: string
  kind: SsrEntryKind
  template: string
  templateMissing: boolean
  hosts: string[]
  application?: SsrResolvedApplicationDefinition<any, any>
  mountSelector: string
  cacheControl?: string
  responseCache?: SsrResponseCacheStrategy<any>
  endpoints: SsrEndpointDefinition<any>[]
  serverRoutes?: SsrCompiledServerRoutes
  cookieAllowlist: string[]
  cookieDenylist: string[]
  publicConfig: Record<string, unknown>
  publicConfigFactory?: SsrPublicConfigFactory
  siteSeo?: SiteSeoConfig
  siteRobots?: SiteRobotsConfig
  sitemapProvider?: SitemapProvider
  shell: SsrResolvedAppShell
  hasRouteRenderOverrides: boolean
  resolveRouteRender?: SsrRouteRenderMatcher['resolve']
  domain: {
    development: string
    production: string
    mode: SsrDomainMode
    localAliases: boolean
    customDomains: boolean
    params: SsrApplicationDomainConfig['params']
  }
}

export interface SsrCompiledConfig {
  serverMiddleware?: readonly GlobalServerMiddleware[]
  name: string
  applications: SsrCompiledApplication[]
  server: SsrResolvedServerOptions
  readiness?: SsrReadinessProbe[]
  development: boolean
  /** Vite's resolved client `base`, carried by the generated SSR runtime. */
  viteBase?: string
  /** Original Vite root for module identities, independent of deployment root. */
  moduleRoot?: string
  /** Renderer evaluated beside the application in its Vite/server bundle. */
  renderApplication?: SsrApplicationRenderer
  resolveSiteUrl?: SsrConfig['resolveSiteUrl']
}

export type SsrResolvedServerOptions = Omit<
  SsrServerOptions<Record<string, unknown>>,
  | 'root'
  | 'host'
  | 'trustProxy'
  | 'clientOutDir'
  | 'requestTimeoutMs'
  | 'shutdownTimeoutMs'
  | 'maxConcurrentSsrRequests'
  | 'maxQueuedSsrRequests'
  | 'healthPath'
  | 'readinessPath'
  | 'maxResolutionPasses'
  | 'resolutionDeadlineMs'
  | 'diagnostics'
> & {
  root: string
  host: string
  trustProxy: boolean
  clientOutDir: string
  requestTimeoutMs: number
  shutdownTimeoutMs: number
  maxConcurrentSsrRequests: number
  maxQueuedSsrRequests: number
  healthPath: string
  readinessPath: string
  maxResolutionPasses: number
  resolutionDeadlineMs: number
  diagnostics: boolean
}

export interface SsrViteApplicationEntry {
  id: string
  kind: SsrRenderMode
  main: string
  root: string
  routesModule?: string
  /** Export used by `defineApplication({ routes })`: `default`, `routes`, or another name. */
  routesExport?: string
  /** When true, the client reads `routes` from `main.ts` (single-app convention). */
  routesFromMain?: boolean
  template: string
  mountSelector: string
  applicationFile?: string
  universalProjection?: SsrUniversalRuntimeProjection
}

export interface SsrViteEntries {
  applications: SsrViteApplicationEntry[]
}

export interface SsrNormalizedApplicationConfig {
  id: string
  render: SsrRenderMode
  template: string
  templateMissing: boolean
  mountSelector: string
  hosts: string[]
  domain: SsrApplicationDomainConfig
  cookies?: ApplicationConfig['cookies']
  endpoints?: ApplicationConfig['endpoints']
  serverRoutes?: ApplicationConfig['serverRoutes']
  cacheControl?: string
  responseCache?: ApplicationConfig['responseCache']
  publicConfig?: ApplicationConfig['publicConfig']
  seo?: SsrSeoConfig
  shell: SsrResolvedAppShell
  routes?: ApplicationConfig['routes']
  router?: ApplicationConfig['router']
  scrollBehavior?: ApplicationConfig['scrollBehavior']
  middleware?: ApplicationConfig['middleware']
  extensions?: ApplicationConfig['extensions']
  cleanup?: ApplicationConfig['cleanup']
  createInitialState?: ApplicationConfig['createInitialState']
}

export interface SsrNormalizedConfig {
  serverMiddleware?: SsrConfig['serverMiddleware']
  name: string
  applications: Record<string, SsrNormalizedApplicationConfig>
  server?: SsrConfig['server']
  readiness?: SsrConfig['readiness']
  resolveSiteUrl?: SsrConfig['resolveSiteUrl']
}

export interface NormalizeSsrConfigOptions {
  root?: string
  development?: boolean
  applicationFiles?: ReadonlyMap<string, string>
  routesModules?: ReadonlyMap<string, string>
  routesExports?: ReadonlyMap<string, string>
}

export interface CompileSsrConfigOptions extends NormalizeSsrConfigOptions {
  importModule?: (specifier: string) => Promise<Record<string, unknown>>
}

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export const resolveProjectPath = (
  root: string,
  fromDir: string,
  input: string,
  label: string
): string => {
  const absolute = resolve(fromDir, input)
  const relativeToRoot = relative(root, absolute)
  if (relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
    throw new Error(`${label} resolves outside the project root: ${input}`)
  }
  return absolute.replaceAll('\\', '/')
}

export const toProjectRelative = (root: string, absolute: string): string => {
  const relativePath = relative(root, absolute).replaceAll('\\', '/')
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`
}

const normalizeHostname = (value: string, label: string): string => {
  const normalized = stripSsrHostPort(normalizeSsrHost(value) || value)
  if (!normalized || normalized.includes('/') || normalized.includes('?')) {
    throw new SsrHostConfigurationError(
      `${label} must be a valid hostname without a protocol, path, or port.`
    )
  }
  return normalized.replace(/^\[|\]$/g, '')
}

const parseDomainValue = (
  value: string,
  label: string
): { wildcard: boolean; hostname: string } => {
  const trimmed = value.trim()
  if (trimmed.startsWith('*.')) {
    return { wildcard: true, hostname: normalizeHostname(trimmed.slice(2), label) }
  }
  return { wildcard: false, hostname: normalizeHostname(trimmed, label) }
}

const pushUnique = (target: string[], value: string) => {
  if (!target.includes(value)) target.push(value)
}

const expandApplicationHosts = (
  domain: SsrApplicationDomainConfig,
  development: boolean
): string[] => {
  const mode = domain.mode ?? 'root-and-subdomains'
  const developmentBase = String(domain.development || '').trim()
  const productionBase = String(domain.production || '').trim()
  const activeRaw = development ? developmentBase || productionBase : productionBase
  if (!activeRaw) return domain.customDomains ? ['*'] : []
  const active = parseDomainValue(
    activeRaw,
    development ? 'domain.development' : 'domain.production'
  )
  const hosts: string[] = []
  if (active.wildcard) {
    pushUnique(hosts, `*.${active.hostname}`)
  } else {
    if (mode === 'root' || mode === 'root-and-subdomains') pushUnique(hosts, active.hostname)
    if (mode === 'subdomains' || mode === 'root-and-subdomains') {
      pushUnique(hosts, `*.${active.hostname}`)
    }
  }
  if (development && productionBase) {
    const production = parseDomainValue(productionBase, 'domain.production')
    if (production.hostname !== active.hostname || production.wildcard !== active.wildcard) {
      if (production.wildcard) {
        pushUnique(hosts, `*.${production.hostname}`)
      } else {
        if (mode === 'root' || mode === 'root-and-subdomains') pushUnique(hosts, production.hostname)
        if (mode === 'subdomains' || mode === 'root-and-subdomains') {
          pushUnique(hosts, `*.${production.hostname}`)
        }
      }
    }
  }
  if (development && domain.localAliases && LOOPBACK_HOST_SET.has(active.hostname)) {
    for (const alias of LOOPBACK_HOSTS) pushUnique(hosts, alias)
  }
  for (const extra of domain.additionalHosts ?? []) {
    pushUnique(hosts, normalizeHostname(extra, 'domain.additionalHosts'))
  }
  if (domain.customDomains) pushUnique(hosts, '*')
  return hosts
}

const normalizeHostPatterns = (
  host: string | readonly string[] | undefined,
  applicationId: string
): string[] => {
  const values = host == null ? [] : Array.isArray(host) ? host : [host]
  return values.map((value) => {
    const trimmed = String(value).trim()
    if (trimmed === '*') return trimmed
    if (trimmed.startsWith('*.')) {
      return `*.${normalizeHostname(trimmed.slice(2), `${applicationId}.host`)}`
    }
    return normalizeHostname(trimmed, `${applicationId}.host`)
  })
}

const baseFromHosts = (hosts: readonly string[]): string => {
  const candidate = hosts.find((host) => host !== '*') || ''
  return candidate.replace(/^\*\./, '')
}

const resolveShellPath = (
  root: string,
  fromDir: string,
  input: string | undefined,
  fallback: string,
  label: string
): string => {
  const value = input?.trim() || fallback
  return toProjectRelative(root, resolveProjectPath(root, fromDir, value, label))
}

const resolveApplicationShell = (
  root: string,
  id: string,
  application: Pick<ApplicationConfig, 'app'>,
  globalApp: SsrAppShellConfig | undefined,
  applicationFile?: string
): SsrResolvedAppShell => {
  const applicationDir = applicationFile ? dirname(applicationFile) : root
  const fromApp = application.app
  const mainFrom = fromApp?.main ? applicationDir : root
  const rootFrom = fromApp?.root ? applicationDir : root
  return {
    main: resolveShellPath(
      root,
      mainFrom,
      fromApp?.main ?? globalApp?.main,
      SSR_DEFAULT_MAIN,
      `Application "${id}" app.main`
    ),
    root: resolveShellPath(
      root,
      rootFrom,
      fromApp?.root ?? globalApp?.root,
      SSR_DEFAULT_ROOT,
      `Application "${id}" app.root`
    ),
    applicationDir: applicationFile ? applicationDir : undefined,
    applicationFile,
  }
}

export const isStaticSiteSeo = (value: SsrSiteSeoInput | undefined): value is SeoSiteDefaults =>
  Boolean(value && typeof value === 'object' && typeof (value as SiteSeoConfig).resolve !== 'function')

export const normalizeSiteSeoConfig = (site?: SsrSiteSeoInput): SiteSeoConfig | undefined => {
  if (!site) return undefined
  if (!isStaticSiteSeo(site)) return site
  validateSeoSiteDefaults(site)
  const defaults = site
  return {
    resolve: async () => ({ status: 'resolved', defaults }),
  }
}

export const siteSeoToApplicationConfig = (
  site?: SsrSiteSeoInput
): SeoApplicationConfig | undefined => (isStaticSiteSeo(site) ? { ...site } : undefined)

/** Application SEO flags (`mode`, `enabled`, …) live on `app.seo`, not `app.seo.site`. */
export const resolveApplicationSeoConfig = (
  seo?: SsrSeoConfig
): SeoApplicationConfig => ({
  ...siteSeoToApplicationConfig(seo?.site),
  mode: seo?.mode,
  enabled: seo?.enabled,
  siteUrl: seo?.siteUrl,
  allowHttpOrigin: seo?.allowHttpOrigin,
  trailingSlash: seo?.trailingSlash,
})

const isSiteRobotsConfig = (value: SsrRobotsInput): value is SiteRobotsConfig =>
  'resolve' in value && typeof value.resolve === 'function'

export const normalizeRobotsConfig = (robots?: SsrRobotsInput): SiteRobotsConfig | undefined => {
  if (!robots) return undefined
  if (isSiteRobotsConfig(robots)) return robots
  return {
    resolve: async () => ({ status: 'resolved' as const, config: robots }),
  }
}

const normalizeApplication = (
  input: ApplicationConfig,
  options: {
    development: boolean
    single: boolean
    applicationCount: number
    root: string
    globalApp?: SsrAppShellConfig
    applicationFile?: string
    templateMissing: boolean
  }
): SsrNormalizedApplicationConfig => {
  if (!input || typeof input !== 'object') {
    throw new Error('Application must be an object returned by defineApplication().')
  }
  if ('serverMiddleware' in input && input.serverMiddleware !== undefined) {
    throw new Error('serverMiddleware belongs on defineServer(), not defineApplication().')
  }
  const id = input.name
  if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)) {
    throw new Error(
      'defineApplication() name must be a stable identifier matching /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.'
    )
  }
  const render = input.render ?? 'ssr'
  if (render !== 'ssr' && render !== 'spa') {
    throw new Error(`Application "${id}" render must be "ssr" or "spa".`)
  }
  if (input.routes && input.router) {
    throw new Error(`Application "${id}" cannot declare both routes and router.`)
  }
  if (input.host != null && input.domain != null) {
    throw new Error(
      `Application "${id}" cannot declare both "host" and "domain". Use "host" for simple static host matching or "domain" for environment-aware domain routing.`
    )
  }
  const explicitHosts = normalizeHostPatterns(input.host, id)
  const domain = { ...(input.domain || {}) }
  let hosts = explicitHosts.length ? explicitHosts : expandApplicationHosts(domain, options.development)
  if (!hosts.length && (options.single || options.applicationCount === 1)) {
    hosts = ['*']
  }
  if (!hosts.length) {
    throw new Error(
      `Application "${id}" needs host routing because multiple applications are configured. Add domain or host: "example.com" (wildcards are supported).`
    )
  }
  const derivedBase = baseFromHosts(hosts)
  const shell = resolveApplicationShell(
    options.root,
    id,
    input,
    options.globalApp,
    options.applicationFile
  )
  return {
    id,
    render,
    template: input.template ?? SSR_DEFAULT_TEMPLATE,
    templateMissing: options.templateMissing && !input.template,
    mountSelector: input.mount ?? SSR_DEFAULT_MOUNT,
    hosts,
    domain: {
      ...domain,
      development: domain.development ?? derivedBase,
      production: domain.production ?? derivedBase,
      customDomains: domain.customDomains ?? false,
    },
    cookies: input.cookies,
    endpoints: input.endpoints,
    serverRoutes: input.serverRoutes,
    cacheControl: input.cacheControl,
    responseCache: input.responseCache,
    publicConfig: input.publicConfig,
    seo: input.seo,
    shell,
    routes: input.routes,
    router: input.router,
    scrollBehavior: input.scrollBehavior,
    middleware: input.middleware,
    extensions: input.extensions,
    cleanup: input.cleanup,
    createInitialState: input.createInitialState,
  }
}

const asApplicationList = (
  config: SsrConfig,
  root: string
): { applications: ApplicationConfig[]; single: boolean } => {
  const configRecord = config as unknown as Record<string, unknown>
  if (configRecord.routes !== undefined) {
    throw new Error(DEFINE_SERVER_ROUTES_ERROR)
  }
  if (config.applications != null) {
    if (!Array.isArray(config.applications)) {
      throw new Error(
        'defineServer({ applications }) must be an array of defineApplication() results. Object-map application config is not supported.'
      )
    }
    if (!config.applications.length) {
      throw new Error('defineServer({ applications }) cannot be empty.')
    }
    const singleApplicationKeys = [
      'render',
      'template',
      'host',
      'domain',
      'cookies',
      'endpoints',
      'serverRoutes',
      'mount',
      'cacheControl',
      'responseCache',
      'publicConfig',
      'seo',
      'router',
      'scrollBehavior',
      'middleware',
      'extensions',
    ] as const
    const mixedKey = singleApplicationKeys.find((key) => configRecord[key] !== undefined)
    if (mixedKey) {
      throw new Error(
        `Server config cannot use single-application field \`${mixedKey}\` with applications. Move it into the relevant defineApplication() result.`
      )
    }
    return { applications: [...config.applications], single: false }
  }
  const single = config as SsrSingleApplicationConfig
  const applicationBase = {
    name: SSR_DEFAULT_APPLICATION_ID,
    render: single.render,
    template: single.template,
    cookies: single.cookies,
    endpoints: single.endpoints,
    serverRoutes: single.serverRoutes,
    mount: single.mount,
    cacheControl: single.cacheControl,
    responseCache: single.responseCache,
    publicConfig: single.publicConfig,
    seo: single.seo,
    app: undefined,
    router: single.router,
    scrollBehavior: single.scrollBehavior,
    middleware: single.middleware,
    extensions: single.extensions,
    cleanup: single.cleanup,
    createInitialState: single.createInitialState,
  }
  const application: ApplicationConfig = single.host != null
    ? { ...applicationBase, host: single.host }
    : single.domain != null
      ? { ...applicationBase, domain: single.domain }
      : applicationBase
  return {
    applications: [application],
    single: true,
  }
}

/** Resolve conventions and optional overrides into one deterministic shape. */
export const normalizeSsrConfig = (
  input: SsrConfig | null | undefined,
  options: NormalizeSsrConfigOptions = {}
): SsrNormalizedConfig => {
  const config = (input ?? {}) as SsrConfig
  if (!config || typeof config !== 'object') {
    throw new Error('server.ts must export an object or a function returning one.')
  }
  const development =
    options.development ?? (typeof process === 'undefined' || process.env.NODE_ENV !== 'production')
  const root = resolve(options.root || process.cwd())
  const { applications: sourceApplications, single } = asApplicationList(config, root)
  const names = new Set<string>()
  const applications: Record<string, SsrNormalizedApplicationConfig> = {}
  for (const application of sourceApplications) {
    const id = application.name
    if (names.has(id)) {
      throw new Error(`Duplicate application name "${id}". Application identity must be unique.`)
    }
    names.add(id)
    const normalizedApp = normalizeApplication(application, {
      development,
      single,
      applicationCount: sourceApplications.length,
      root,
      globalApp: config.app,
      applicationFile: options.applicationFiles?.get(id),
      templateMissing: false,
    })
    const routesModule = options.routesModules?.get(id)
    if (routesModule) normalizedApp.shell.routesModule = routesModule
    const routesExport = options.routesExports?.get(id)
    if (routesExport) normalizedApp.shell.routesExport = routesExport
    applications[id] = normalizedApp
  }
  return {
    name: String(config.name || basename(root) || 'app'),
    applications,
    server: config.server,
    serverMiddleware: config.serverMiddleware,
    readiness: config.readiness,
    resolveSiteUrl: config.resolveSiteUrl,
  }
}

export const attachClientGraph = (
  applications: Record<string, SsrNormalizedApplicationConfig>,
  routesModules?: ReadonlyMap<string, string>,
  routesExports?: ReadonlyMap<string, string>
) => {
  if (!routesModules && !routesExports) return
  for (const application of Object.values(applications)) {
    const routesModule = routesModules?.get(application.id)
    if (routesModule) application.shell.routesModule = routesModule
    const routesExport = routesExports?.get(application.id)
    if (routesExport) application.shell.routesExport = routesExport
  }
}

const parseCookieList = (value: string | readonly string[] | undefined): string[] => {
  if (value == null) return []
  const values = Array.isArray(value) ? value : String(value).split(',')
  return values.map((item) => String(item).trim()).filter(Boolean)
}

const readRoutes = (
  routes: ApplicationConfig['routes'] | undefined
): RouteRecordRaw[] | undefined => {
  if (!routes) return undefined
  return typeof routes === 'function' ? routes() : routes
}

const bindInternalApplication = (
  app: SsrNormalizedApplicationConfig,
  shell: SsrBoundAppShell | undefined
): SsrResolvedApplicationDefinition<any, any> | undefined => {
  if (!shell?.root) return undefined
  const initializer = shell.main?.default
  if (typeof initializer !== 'function') {
    throw new Error(
      `Application "${app.id}" main module must default-export an initializer function (${app.shell.main}).`
    )
  }
  const declaredRoutes = readRoutes(app.routes)
  const mainRoutes = readRoutes(shell.main.routes)
  const routes =
    declaredRoutes ?? (app.shell.applicationDir ? undefined : mainRoutes)
  if (routes && app.router) {
    throw new Error(`Application "${app.id}" cannot declare both routes and router.`)
  }
  return {
    id: app.id,
    root: shell.root,
    routes,
    router: app.router,
    scrollBehavior: app.scrollBehavior,
    middleware: app.middleware,
    extensions: app.extensions,
    seo: resolveApplicationSeoConfig(app.seo),
    defaultRender: app.render,
    cleanup: app.cleanup,
    createInitialState: app.createInitialState,
    install: (setup) =>
      initializer({
        app: setup.app,
        router: setup.router,
        server: setup.server,
        hydration: setup.hydration,
      }),
  }
}

const normalizeNonNegativeDuration = (
  value: number | undefined,
  fallback: number,
  label: string
): number => {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error(`${label} must be a finite non-negative number.`)
  }
  return resolved
}

const normalizeIntegerCapacity = (
  value: number | undefined,
  fallback: number,
  label: string,
  minimum: number
): number => {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || !Number.isInteger(resolved) || resolved < minimum) {
    const range = minimum === 0 ? 'non-negative' : 'positive'
    throw new Error(`${label} must be a finite ${range} integer.`)
  }
  return resolved
}

const normalizeCompiledServerOptions = (
  config: SsrNormalizedConfig,
  options: CompileSsrConfigOptions,
  development: boolean
): SsrResolvedServerOptions => {
  const requestTimeoutMs = normalizeNonNegativeDuration(
    config.server?.requestTimeoutMs,
    15_000,
    'server.requestTimeoutMs'
  )
  const configuredPasses = config.server?.maxResolutionPasses ?? 4
  if (!Number.isFinite(configuredPasses)) {
    throw new Error('server.maxResolutionPasses must be a finite number.')
  }
  return {
    root: config.server?.root || options.root || process.cwd(),
    host: config.server?.host || '0.0.0.0',
    port: config.server?.port,
    trustProxy: config.server?.trustProxy ?? false,
    clientOutDir: config.server?.clientOutDir || 'dist/client',
    requestTimeoutMs,
    shutdownTimeoutMs: normalizeNonNegativeDuration(
      config.server?.shutdownTimeoutMs,
      10_000,
      'server.shutdownTimeoutMs'
    ),
    maxConcurrentSsrRequests: normalizeIntegerCapacity(
      config.server?.maxConcurrentSsrRequests,
      8,
      'server.maxConcurrentSsrRequests',
      1
    ),
    maxQueuedSsrRequests: normalizeIntegerCapacity(
      config.server?.maxQueuedSsrRequests,
      32,
      'server.maxQueuedSsrRequests',
      0
    ),
    healthPath: config.server?.healthPath || '/healthz',
    readinessPath: config.server?.readinessPath || '/readyz',
    maxResolutionPasses: Math.max(1, Math.floor(configuredPasses)),
    resolutionDeadlineMs: normalizeNonNegativeDuration(
      config.server?.resolutionDeadlineMs,
      requestTimeoutMs,
      'server.resolutionDeadlineMs'
    ),
    diagnostics: config.server?.diagnostics ?? development,
    logger: config.server?.logger,
    onMetrics: config.server?.onMetrics,
    renderError: config.server?.renderError,
    publicConfig: {},
  }
}

const readBoundShells = (
  loaded: unknown
): Record<string, SsrBoundAppShell> | undefined => {
  const record = loaded as { __vueSsrLiteShells?: Record<string, SsrBoundAppShell> }
  if (record.__vueSsrLiteShells) return record.__vueSsrLiteShells
  const exported = (loaded as { default?: { __vueSsrLiteShells?: Record<string, SsrBoundAppShell> } })
    .default
  return exported?.__vueSsrLiteShells
}

export const compileSsrConfig = async (
  loaded: unknown,
  options: CompileSsrConfigOptions = {}
): Promise<SsrCompiledConfig> => {
  const moduleValue = loaded as {
    default?: SsrConfigExport
    __vueSsrLiteShells?: Record<string, SsrBoundAppShell>
  }
  const exported = moduleValue?.default ?? (loaded as SsrConfigExport)
  const raw = typeof exported === 'function' ? await exported() : exported
  const development =
    options.development ?? (typeof process === 'undefined' || process.env.NODE_ENV !== 'production')
  const loadedRecord = (raw || {}) as SsrConfig & {
    __vueSsrLiteViteBase?: unknown
    __vueSsrLiteModuleRoot?: unknown
    __vueSsrLiteRenderApplication?: SsrApplicationRenderer
    __vueSsrLiteShells?: Record<string, SsrBoundAppShell>
    __vueSsrLiteApplicationFiles?: Map<string, string>
    __vueSsrLiteRoutesModules?: Map<string, string>
    __vueSsrLiteRoutesExports?: Map<string, string>
  }
  const applicationFiles =
    options.applicationFiles ??
    loadedRecord.__vueSsrLiteApplicationFiles ??
    (moduleValue as { __vueSsrLiteApplicationFiles?: Map<string, string> })
      .__vueSsrLiteApplicationFiles
  const routesModules =
    options.routesModules ??
    loadedRecord.__vueSsrLiteRoutesModules ??
    (moduleValue as { __vueSsrLiteRoutesModules?: Map<string, string> })
      .__vueSsrLiteRoutesModules
  const routesExports =
    options.routesExports ??
    loadedRecord.__vueSsrLiteRoutesExports ??
    (moduleValue as { __vueSsrLiteRoutesExports?: Map<string, string> })
      .__vueSsrLiteRoutesExports
  const config = normalizeSsrConfig(loadedRecord, {
    root: options.root,
    development,
    applicationFiles: applicationFiles && new Map([...applicationFiles].map(([id, path]) =>
      [id, resolve(options.root || process.cwd(), path)] as const
    )),
    routesModules,
    routesExports,
  })
  attachClientGraph(config.applications, routesModules, routesExports)
  const viteBase =
    typeof loadedRecord.__vueSsrLiteViteBase === 'string'
      ? loadedRecord.__vueSsrLiteViteBase
      : undefined
  const renderApplication = loadedRecord.__vueSsrLiteRenderApplication
  const shells = loadedRecord.__vueSsrLiteShells ?? readBoundShells(loaded) ?? {}
  const resolveSiteUrl = config.resolveSiteUrl ?? loadedRecord.resolveSiteUrl
  const server = normalizeCompiledServerOptions(config, options, development)
  const applications: SsrCompiledApplication[] = []
  for (const app of Object.values(config.applications)) {
    const templatePath = resolve(options.root || process.cwd(), app.template)
    const templateMissing = app.templateMissing || !(await exists(templatePath))
    const shell = shells[app.id]
    const application = bindInternalApplication(app, shell)
    const routes = readRoutes(application?.routes ?? app.routes)
    const hasRouteRenderOverrides = validateRouteRenderBoundaries(
      routes,
      app.render,
      app.id
    )
    const developmentDomain = String(app.domain.development || '')
    const productionDomain = String(app.domain.production || '')
    const publicConfigFactory =
      typeof app.publicConfig === 'function' ? app.publicConfig : undefined
    const siteSeo = normalizeSiteSeoConfig(app.seo?.site)
    const siteRobots = normalizeRobotsConfig(app.seo?.robots)
    const sitemapProvider = await loadSitemapProvider(app.seo?.sitemap)
    const compiled: SsrCompiledApplication = {
      id: app.id,
      kind: app.render,
      template: app.template,
      templateMissing: templateMissing && app.template === SSR_DEFAULT_TEMPLATE,
      hosts: [...app.hosts],
      application,
      mountSelector: app.mountSelector,
      cacheControl: app.cacheControl,
      responseCache: app.responseCache,
      endpoints: app.endpoints ? [...app.endpoints] : [],
      serverRoutes: compileServerRoutes(app.serverRoutes, {
        healthPath: server.healthPath,
        readinessPath: server.readinessPath,
        endpoints: app.endpoints,
      }),
      cookieAllowlist: parseCookieList(app.cookies?.allow),
      cookieDenylist: parseCookieList(app.cookies?.deny),
      publicConfig: publicConfigFactory
        ? {}
        : { ...((app.publicConfig as Record<string, unknown>) || {}) },
      publicConfigFactory,
      siteSeo,
      siteRobots,
      sitemapProvider,
      shell: app.shell,
      hasRouteRenderOverrides,
      resolveRouteRender:
        hasRouteRenderOverrides && routes
          ? createRouteRenderMatcher(routes, app.render).resolve
          : undefined,
      domain: {
        development: developmentDomain
          ? parseDomainValue(developmentDomain, `${app.id}.domain.development`).hostname
          : '',
        production: productionDomain
          ? parseDomainValue(productionDomain, `${app.id}.domain.production`).hostname
          : '',
        mode: app.domain.mode ?? 'root-and-subdomains',
        localAliases: Boolean(app.domain.localAliases),
        customDomains: Boolean(app.domain.customDomains),
        params: app.domain.params,
      },
    }
    const seoRoutes = routes
    const applicationSeo = application?.seo ?? resolveApplicationSeoConfig(app.seo)
    if (app.seo || application) {
      compiled.endpoints.push(
        ...(await createSeoEndpoints({
          applicationId: app.id,
          routes: seoRoutes,
          seo: applicationSeo,
          root: options.root || process.cwd(),
          publicDirectory: development ? undefined : resolve(server.root, server.clientOutDir),
          sitemapProvider,
          existingEndpoints: compiled.endpoints,
          serverRouteOwnedPaths: compiled.serverRoutes!.ownedPaths,
          siteSeo,
          siteRobots,
          defaultRender: app.render,
          resolveSiteUrl: (request) =>
            resolveServerSiteOrigin({
              siteUrl: applicationSeo.siteUrl,
              publicUrl: readPublicUrl(),
              resolveSiteUrl,
              request,
              production: !development,
              requireProductionOrigin: requiresProductionSeoOrigin(
                app.render === 'spa' && !hasRouteRenderOverrides ? 'spa' : 'ssr',
                applicationSeo
              ),
              allowHttpOrigin: applicationSeo.allowHttpOrigin,
            }),
        }))
      )
    }
    applications.push(compiled)
  }
  validateSsrHostEntries(applications)
  const compiled: SsrCompiledConfig = {
    name: config.name,
    applications,
    development,
    viteBase,
    moduleRoot: typeof loadedRecord.__vueSsrLiteModuleRoot === 'string'
      ? loadedRecord.__vueSsrLiteModuleRoot : server.root,
    renderApplication,
    readiness: config.readiness,
    resolveSiteUrl,
    server,
    serverMiddleware: snapshotServerMiddleware(config.serverMiddleware, 'serverMiddleware') as readonly GlobalServerMiddleware[],
  }
  prepareSsrCompiledMetadata(compiled)
  return compiled
}

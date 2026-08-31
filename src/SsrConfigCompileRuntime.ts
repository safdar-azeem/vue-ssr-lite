import { randomBytes } from 'node:crypto'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { RouteRecordRaw } from 'vue-router'
import {
  bundleSsrConfigModule,
  collectApplicationDeclarationFiles,
  collectSkippedApplicationRoutesFiles,
  isEvaluatedApplicationConfig,
  resolveSsrConfigGraphModule,
  resolveApplicationRoutesModule,
  type SsrConfigModuleGraph,
} from './SsrConfigCompileBoundary'
import {
  assertNoImportedUniversalConfigMutation,
  isDefineApplicationModuleSource,
  projectUniversalRuntimeSource,
  resolveApplicationRoutesImportBindings,
  sourceDeclaresServerConfigRoutes,
  assertUniversalProjectionCoverage,
  type SsrUniversalRuntimeProjection,
} from './SsrUniversalProjection'
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
import { defineServer } from './SsrConfigRuntime'
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
  prepareSsrHtmlTemplate,
  SSR_HTML_TEMPLATE,
} from './server/SsrHtmlRuntime'
import {
  generateSsrDevelopmentRenderedStylesheetHandoff,
  generateSsrDevelopmentStylesheetHandoff,
} from './SsrApplicationAssetRuntime'
import { getSsrStateElementId } from './SsrSerialization'
import {
  createRouteRenderMatcher,
  validateRouteRenderBoundaries,
  type SsrRouteRenderMatcher,
} from './SsrRouteRenderRuntime'

export { defineServer }
export { bundleSsrConfigModule } from './SsrConfigCompileBoundary'

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
const CONFIG_CANDIDATES = ['server.ts'] as const

export const SSR_RUNTIME_VIRTUAL_ID = 'virtual:vue-ssr-lite/runtime'
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
  name: string
  applications: SsrCompiledApplication[]
  server: SsrResolvedServerOptions
  readiness?: SsrReadinessProbe[]
  development: boolean
  /** Vite's resolved client `base`, carried by the generated SSR runtime. */
  viteBase?: string
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

const toProjectRelative = (root: string, absolute: string): string => {
  const relativePath = relative(root, absolute).replaceAll('\\', '/')
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`
}

export interface SsrDiscoveredApplicationSources {
  files: Map<string, string>
  routesModules: Map<string, string>
  routesExports: Map<string, string>
  projections: Map<string, SsrUniversalRuntimeProjection>
  truncated: boolean
}

const evaluateBundledConfigModule = async (
  root: string,
  code: string
): Promise<Record<string, unknown>> => {
  const cacheDirectory = resolve(root, 'node_modules', '.cache', 'vue-ssr-lite')
  await mkdir(cacheDirectory, { recursive: true })
  const outfile = resolve(cacheDirectory, `server.${randomBytes(6).toString('hex')}.mjs`)
  try {
    await writeFile(outfile, code, 'utf8')
    return (await import(pathToFileURL(outfile).href)) as Record<string, unknown>
  } finally {
    await rm(outfile, { force: true })
  }
}

export const discoverApplicationSourceFiles = async (
  root: string,
  configPath: string,
  authoritativeGraph?: SsrConfigModuleGraph
): Promise<SsrDiscoveredApplicationSources> => {
  const walked = await collectApplicationDeclarationFiles(configPath, 0, new Set(), root)
  const moduleResolver = authoritativeGraph
    ? (importer: string, specifier: string) =>
        resolveSsrConfigGraphModule(authoritativeGraph, importer, specifier)
    : undefined
  const isProjectFile = (file: string) => {
    const relativePath = relative(root, file)
    return !relativePath.startsWith('..') && !isAbsolute(relativePath)
  }
  const authoritativeFiles = authoritativeGraph
    ? [
        ...authoritativeGraph.imports.keys(),
        ...[...authoritativeGraph.imports.values()].flat(),
      ].filter((file) => file !== configPath && isProjectFile(file))
    : []
  const authoritativeApplicationFiles: string[] = []
  for (const file of [...new Set(authoritativeFiles)]) {
    try {
      if (
        await isDefineApplicationModuleSource(
          await readFile(file, 'utf8'),
          file,
          moduleResolver
        )
      ) {
        authoritativeApplicationFiles.push(file)
      }
    } catch {
      // Non-script and unavailable graph nodes cannot be declaration modules.
    }
  }
  const candidateFiles = [
    ...new Set([...walked.files, ...authoritativeApplicationFiles]),
  ]
  const skippedRoutesFiles = new Set([
    ...(await collectSkippedApplicationRoutesFiles(candidateFiles)),
    ...[...(authoritativeGraph?.applicationRoutesModules ?? [])].map((file) =>
      file.replaceAll('\\', '/')
    ),
  ])
  const files = new Map<string, string>()
  const routesModules = new Map<string, string>()
  const routesExports = new Map<string, string>()
  const projections = new Map<string, SsrUniversalRuntimeProjection>()
  for (const file of candidateFiles) {
    if (
      skippedRoutesFiles.has(
        file.replaceAll('\\', '/').replace(/^\/private(?=\/(?:var|tmp)\/)/, '')
      )
    ) {
      continue
    }
    const { code, graph } = await bundleSsrConfigModule(root, file)
    const namespace = await evaluateBundledConfigModule(root, code)
    if (!isEvaluatedApplicationConfig(namespace.default)) continue
    const application = namespace.default
    const existing = files.get(application.name)
    if (existing && existing !== file) {
      throw new Error(
        `Application "${application.name}" is default-exported from both ${existing} and ${file}. Import each defineApplication() module once.`
      )
    }
    files.set(application.name, file)
    const source = await readFile(file, 'utf8')
    const routesAbsolute = resolveApplicationRoutesModule(file, graph, application.name)
    if (routesAbsolute) {
      routesModules.set(application.name, toProjectRelative(root, routesAbsolute))
      const [routesBinding] = await resolveApplicationRoutesImportBindings(source, file)
      if (routesBinding) routesExports.set(application.name, routesBinding.imported)
    } else if (application.routes) {
      throw new Error(
        `Application "${application.name}" must import a dedicated routes module so the client graph does not import ${file}.`
      )
    }
    const projection = await projectUniversalRuntimeSource(source, file, moduleResolver)
    assertUniversalProjectionCoverage(application, projection, file)
    if (projection) projections.set(application.name, projection)
  }
  return { files, routesModules, routesExports, projections, truncated: walked.truncated }
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
    readiness: config.readiness,
    resolveSiteUrl: config.resolveSiteUrl,
  }
}

export const resolveSsrConfigPath = async (
  root: string,
  explicit?: string
): Promise<string | undefined> => {
  if (explicit) {
    const fullPath = resolve(root, explicit)
    try {
      await access(fullPath)
      return fullPath
    } catch {
      throw new Error(`vue-ssr-lite could not find the configured server file: ${fullPath}`)
    }
  }
  for (const candidate of CONFIG_CANDIDATES) {
    const fullPath = resolve(root, candidate)
    try {
      await access(fullPath)
      return fullPath
    } catch {
      // Configuration is optional; convention files still apply.
    }
  }
  return undefined
}

const assertConventionFiles = async (
  root: string,
  config: SsrConfig,
  applicationFiles?: ReadonlyMap<string, string>
) => {
  const normalized = normalizeSsrConfig(config, { root, applicationFiles })
  for (const application of Object.values(normalized.applications)) {
    const mainPath = resolve(root, application.shell.main)
    const rootPath = resolve(root, application.shell.root)
    if (!(await exists(mainPath))) {
      throw new Error(
        `Application "${application.id}" main was not found at ${mainPath}. Create ${SSR_DEFAULT_MAIN}, or set app.main.`
      )
    }
    if (!(await exists(rootPath))) {
      throw new Error(
        `Application "${application.id}" root component was not found at ${rootPath}. Create ${SSR_DEFAULT_ROOT}, or set app.root.`
      )
    }
    const templatePath = resolve(root, application.template)
    if (await exists(templatePath)) {
      const source = await readFile(templatePath, 'utf8')
      try {
        prepareSsrHtmlTemplate(source, application.mountSelector)
      } catch (error) {
        throw new Error(
          `Application "${application.id}" template ${templatePath} is invalid: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    } else if (application.template !== SSR_DEFAULT_TEMPLATE) {
      throw new Error(
        `Application "${application.id}" HTML template was not found at ${templatePath}.`
      )
    } else {
      try {
        prepareSsrHtmlTemplate(SSR_HTML_TEMPLATE, application.mountSelector)
      } catch (error) {
        throw new Error(
          `Application "${application.id}" default HTML template is invalid: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }
}

const attachClientGraph = (
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

/** Load optional overrides; absence means the standard Vue conventions. */
export const loadSsrConfigFile = async (root: string, configPath?: string): Promise<SsrConfig> => {
  const absoluteConfig = await resolveSsrConfigPath(root, configPath)
  if (!absoluteConfig) {
    const config: SsrConfig = {}
    await assertConventionFiles(root, config)
    return config
  }
  const configSource = await readFile(absoluteConfig, 'utf8')
  if (await sourceDeclaresServerConfigRoutes(configSource, absoluteConfig)) {
    throw new Error(DEFINE_SERVER_ROUTES_ERROR)
  }
  const { code, graph } = await bundleSsrConfigModule(root, absoluteConfig)
  const moduleResolver = (importer: string, specifier: string) =>
    resolveSsrConfigGraphModule(graph, importer, specifier)
  const isProjectFile = (file: string) => {
    const relativePath = relative(root, file)
    return !relativePath.startsWith('..') && !isAbsolute(relativePath)
  }
  const reachableConfigModules = [
    ...new Set([
      ...graph.imports.keys(),
      ...[...graph.imports.values()].flat(),
    ]),
  ].filter(isProjectFile)
  const preEvaluationProjections = new Map<string, SsrUniversalRuntimeProjection>()
  const preEvaluationApplicationFiles = new Set<string>()
  for (const file of [absoluteConfig, ...reachableConfigModules]) {
    const source = file === absoluteConfig ? configSource : await readFile(file, 'utf8')
    if (
      file !== absoluteConfig &&
      (await isDefineApplicationModuleSource(source, file, moduleResolver))
    ) {
      preEvaluationApplicationFiles.add(file)
    }
    const projection = await projectUniversalRuntimeSource(source, file, moduleResolver)
    if (projection) {
      preEvaluationProjections.set(file, projection)
    }
  }
  const protectedUniversalDependencies = [
    ...new Set(
      [...preEvaluationProjections.values()]
        .flatMap((projection) => projection.dependencyFiles ?? [])
    ),
  ]
  const protectedUniversalIdentities = [
    ...new Set(
      [...preEvaluationProjections.values()].flatMap(
        (projection) => projection.dependencyIdentities ?? []
      )
    ),
  ]
  await assertNoImportedUniversalConfigMutation(
    configSource,
    absoluteConfig,
    preEvaluationApplicationFiles,
    protectedUniversalDependencies,
    reachableConfigModules,
    moduleResolver,
    protectedUniversalIdentities
  )
  const discovered = await discoverApplicationSourceFiles(root, absoluteConfig, graph)
  const singleApplicationProjection = discovered.files.size
    ? undefined
    : preEvaluationProjections.get(absoluteConfig)
  const loaded = (await evaluateBundledConfigModule(root, code)) as {
    default?: SsrConfigExport
  }
  const exported = loaded.default ?? (loaded as unknown as SsrConfigExport)
  const config = typeof exported === 'function' ? await exported() : exported
  if (!config || typeof config !== 'object') {
    throw new Error('The server.ts module must export an object.')
  }
  if (Array.isArray(config.applications)) {
    for (const application of config.applications) {
      if (!isEvaluatedApplicationConfig(application)) {
        throw new Error(
          'defineServer({ applications }) must contain defineApplication() results.'
        )
      }
        if (application.routes && !discovered.routesModules.has(application.name)) {
          throw new Error(
            `Application "${application.name}" must import a dedicated routes module from its own defineApplication() file` +
              (discovered.truncated
                ? ' (application discovery stopped at import depth 4)'
                : '') +
              '. Inline defineApplication({ routes }) and deep barrels are not supported.'
          )
        }
        const applicationFile = discovered.files.get(application.name) ?? absoluteConfig
        assertUniversalProjectionCoverage(
          application,
          discovered.projections.get(application.name),
          applicationFile
        )
    }
  } else {
    const projection = singleApplicationProjection
    assertUniversalProjectionCoverage(config, projection, absoluteConfig)
    if (projection) discovered.projections.set(SSR_DEFAULT_APPLICATION_ID, projection)
  }
  await assertConventionFiles(root, config, discovered.files)
  const normalized = normalizeSsrConfig(config, {
    root,
    applicationFiles: discovered.files,
    routesModules: discovered.routesModules,
    routesExports: discovered.routesExports,
  })
  attachClientGraph(
    normalized.applications,
    discovered.routesModules,
    discovered.routesExports
  )
  Object.defineProperty(config, '__vueSsrLiteApplicationFiles', {
    value: discovered.files,
    enumerable: false,
  })
  Object.defineProperty(config, '__vueSsrLiteRoutesModules', {
    value: discovered.routesModules,
    enumerable: false,
  })
  Object.defineProperty(config, '__vueSsrLiteRoutesExports', {
    value: discovered.routesExports,
    enumerable: false,
  })
  Object.defineProperty(config, '__vueSsrLiteUniversalProjections', {
    value: discovered.projections,
    enumerable: false,
  })
  Object.defineProperty(config, '__vueSsrLiteNormalized', {
    value: normalized,
    enumerable: false,
  })
  return config
}

export const extractSsrViteEntries = (
  config: SsrConfig,
  options: NormalizeSsrConfigOptions = {}
): SsrViteEntries => {
  const attached = (config as { __vueSsrLiteNormalized?: SsrNormalizedConfig }).__vueSsrLiteNormalized
  const projections = (
    config as { __vueSsrLiteUniversalProjections?: Map<string, SsrUniversalRuntimeProjection> }
  ).__vueSsrLiteUniversalProjections
  const normalized = attached ?? normalizeSsrConfig(config, options)
  if (!attached) {
    attachClientGraph(normalized.applications, options.routesModules, options.routesExports)
  }
  return {
    applications: Object.values(normalized.applications).map((app) => ({
      id: app.id,
      kind: app.render,
      main: app.shell.main,
      root: app.shell.root,
      routesModule: app.shell.routesModule,
      routesExport: app.shell.routesExport,
      routesFromMain: !app.shell.applicationDir,
      template: app.template,
      mountSelector: app.mountSelector,
      applicationFile: app.shell.applicationFile,
      universalProjection: projections?.get(app.id),
    })),
  }
}

export const resolveSsrViteEntries = async (
  root: string,
  configPath?: string
): Promise<SsrViteEntries> =>
  extractSsrViteEntries(await loadSsrConfigFile(root, configPath), { root })

const absoluteImportPath = (root: string, filePath: string): string => {
  if (/^[@~#]/.test(filePath)) return filePath.replaceAll('\\', '/')
  return resolve(root, filePath).replaceAll('\\', '/')
}

const shellAlias = (kind: 'root' | 'main', id: string, index: number): string =>
  `__ssr${kind === 'root' ? 'Root' : 'Main'}${index}_${id.replace(/[^A-Za-z0-9_]/g, '_')}`

export const generateSsrRuntimeModule = (
  root: string,
  configPath: string | undefined,
  entries: SsrViteApplicationEntry[],
  viteBase = '/'
): string => {
  const importLines: string[] = configPath
    ? [`import __ssrUserConfig from ${JSON.stringify(absoluteImportPath(root, configPath))}`]
    : []
  const shellBindings: string[] = ['  const __vueSsrLiteShells = {']
  const imported = new Map<string, string>()
  entries
    .filter((entry) => entry.kind === 'ssr')
    .forEach((entry, index) => {
      const rootPath = absoluteImportPath(root, entry.root)
      const mainPath = absoluteImportPath(root, entry.main)
      const rootAlias =
        imported.get(`root:${rootPath}`) ?? shellAlias('root', entry.id, index)
      const mainAlias =
        imported.get(`main:${mainPath}`) ?? shellAlias('main', entry.id, index)
      if (!imported.has(`root:${rootPath}`)) {
        importLines.push(`import ${rootAlias} from ${JSON.stringify(rootPath)}`)
        imported.set(`root:${rootPath}`, rootAlias)
      }
      if (!imported.has(`main:${mainPath}`)) {
        importLines.push(`import * as ${mainAlias} from ${JSON.stringify(mainPath)}`)
        imported.set(`main:${mainPath}`, mainAlias)
      }
      shellBindings.push(
        `    ${JSON.stringify(entry.id)}: { root: ${imported.get(`root:${rootPath}`)}, main: ${imported.get(`main:${mainPath}`)} },`
      )
    })
  shellBindings.push('  }')
  const applicationFiles = entries
    .filter((entry) => entry.applicationFile)
    .map(
      (entry) =>
        `    [${JSON.stringify(entry.id)}, ${JSON.stringify(absoluteImportPath(root, entry.applicationFile!))}],`
    )
  return [
    ...importLines,
    '',
    'const resolveConfig = async () => {',
    configPath
      ? '  const exported = __ssrUserConfig?.default ?? __ssrUserConfig\n  const config = typeof exported === "function" ? await exported() : exported'
      : '  const config = {}',
    `  const viteBase = ${JSON.stringify(viteBase)}`,
    ...shellBindings,
    '  const __vueSsrLiteApplicationFiles = new Map([',
    ...applicationFiles,
    '  ])',
    '  return { ...config, __vueSsrLiteViteBase: viteBase, __vueSsrLiteShells, __vueSsrLiteApplicationFiles }',
    '}',
    '',
    'export default resolveConfig',
    '',
  ].join('\n')
}

const isIdentifierName = (value: string): boolean => /^[A-Za-z_$][\w$]*$/.test(value)

const applicationRoutesImportLine = (routesPath: string, exported?: string): string => {
  if (exported === 'default') {
    return `import applicationRoutes from ${JSON.stringify(routesPath)}`
  }
  if (exported && exported !== '*' && isIdentifierName(exported)) {
    return `import { ${exported} as applicationRoutes } from ${JSON.stringify(routesPath)}`
  }
  return `import * as applicationRoutes from ${JSON.stringify(routesPath)}`
}

const applicationRoutesBindingLine = (exported?: string): string => {
  if (exported === 'default' || (exported && exported !== '*' && isIdentifierName(exported))) {
    return 'const routes = applicationRoutes'
  }
  if (exported && exported !== '*') {
    return `const routes = applicationRoutes[${JSON.stringify(exported)}]`
  }
  return 'const routes = applicationRoutes.default ?? applicationRoutes.routes'
}

export const generateSsrClientModule = (root: string, entry: SsrViteApplicationEntry): string => {
  const rootPath = absoluteImportPath(root, entry.root)
  const mainPath = absoluteImportPath(root, entry.main)
  const routesPath = entry.routesModule
    ? absoluteImportPath(root, entry.routesModule)
    : undefined
  const hydrate = entry.kind !== 'spa'
  const mountSelector = JSON.stringify(entry.mountSelector)
  const projection = entry.universalProjection
  const lines = [
    `import App from ${JSON.stringify(rootPath)}`,
    `import * as __ssrMain from ${JSON.stringify(mainPath)}`,
  ]
  if (routesPath) {
    lines.push(applicationRoutesImportLine(routesPath, entry.routesExport))
  }
  if (projection?.imports.length) {
    lines.push(...projection.imports)
  }
  if (projection?.statements?.length) {
    lines.push(...projection.statements)
  }
  lines.push(
    `import { ${hydrate ? 'hydrateSsrApplication, mountSpaApplication' : 'mountSpaApplication'} } from 'vue-ssr-lite/client'`
  )
  const projectedFields = projection
    ? Object.entries(projection.fields).map(([key, value]) => `  ${key}: ${value},`)
    : []
  lines.push(
    'const initialize = __ssrMain.default',
    routesPath
      ? applicationRoutesBindingLine(entry.routesExport)
      : entry.routesFromMain === false
        ? 'const routes = undefined'
        : 'const routes = __ssrMain.routes',
    'if (typeof initialize !== "function") {',
    `  throw new Error(${JSON.stringify(`Application "${entry.id}" main module must default-export an initializer function.`)})`,
    '}',
    'if (!App) {',
    `  throw new Error(${JSON.stringify(`Application "${entry.id}" root component is missing.`)})`,
    '}',
    'export const definition = {',
    `  id: ${JSON.stringify(entry.id)},`,
    '  root: App,',
    '  routes,',
    `  defaultRender: ${JSON.stringify(entry.kind)},`,
    '  install: initialize,',
    ...projectedFields,
    '}',
  )
  if (hydrate) {
    lines.push(
      `const __ssrStateId = ${JSON.stringify(getSsrStateElementId(entry.id))}`,
      'export const ready = (async () => {',
      '  const __ssrStateElement = document.getElementById(__ssrStateId)',
      '  if (__ssrStateElement?.textContent) {',
      ...generateSsrDevelopmentStylesheetHandoff(entry.id).map((line) => `    ${line}`),
      ...generateSsrDevelopmentRenderedStylesheetHandoff(entry.id).map((line) => `    ${line}`),
      `    await hydrateSsrApplication(definition, { mountSelector: ${mountSelector} })`,
      '    return',
      '  }',
      `  return mountSpaApplication(definition, { mountSelector: ${mountSelector} })`,
      '})()',
      'void ready.catch((error) => {',
      "  console.error('[vue-ssr-lite] hydration failed', error)",
      '  throw error',
      '})',
      '',
    )
  } else {
    lines.push(
      `export const ready = mountSpaApplication(definition, { mountSelector: ${mountSelector} })`,
      'void ready.catch((error) => {',
      "  console.error('[vue-ssr-lite] SPA mount failed', error)",
      '  throw error',
      '})',
      '',
    )
  }
  return lines.join('\n')
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
    applicationFiles,
    routesModules,
    routesExports,
  })
  attachClientGraph(config.applications, routesModules, routesExports)
  const viteBase =
    typeof loadedRecord.__vueSsrLiteViteBase === 'string'
      ? loadedRecord.__vueSsrLiteViteBase
      : undefined
  const shells = loadedRecord.__vueSsrLiteShells ?? readBoundShells(loaded) ?? {}
  const resolveSiteUrl = config.resolveSiteUrl ?? loadedRecord.resolveSiteUrl
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
          sitemapProvider,
          existingEndpoints: compiled.endpoints,
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
  return {
    name: config.name,
    applications,
    development,
    viteBase,
    readiness: config.readiness,
    resolveSiteUrl,
    server: normalizeCompiledServerOptions(config, options, development),
  }
}

import { randomBytes } from 'node:crypto'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  SsrApplicationConfig,
  SsrApplicationDomainConfig,
  SsrApplicationLoader,
  SsrApplicationModuleRef,
  SsrApplicationSource,
  SsrConfig,
  SsrConfigExport,
  SsrDomainMode,
  SsrRenderMode,
} from './SsrConfigTypes'
import { defineSsrConfig } from './SsrConfigRuntime'
import { normalizeSsrHost, stripSsrHostPort } from './SsrHostnameRuntime'
import type {
  SsrEndpointDefinition,
  SsrEntryKind,
  SsrReadinessProbe,
  SsrResolvedApplicationDefinition,
  SsrResponseCacheStrategy,
  SsrServerOptions,
} from './SsrRuntimeTypes'
import {
  SsrHostConfigurationError,
  validateSsrHostEntries,
} from './server/SsrHostRuntime'
import { prepareSsrHtmlTemplate } from './server/SsrHtmlRuntime'

export { defineSsrConfig }

export const SSR_DEFAULT_APPLICATION_ENTRY = './src/main.ts'
export const SSR_DEFAULT_TEMPLATE = './index.html'
export const SSR_DEFAULT_MOUNT = '#app'
export const SSR_DEFAULT_APPLICATION_ID = 'app'

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1'] as const
const LOOPBACK_HOST_SET = new Set<string>(LOOPBACK_HOSTS)
const CONFIG_CANDIDATES = [
  'ssr.config.ts',
  'ssr.config.mts',
  'ssr.config.js',
  'ssr.config.mjs',
] as const

export const SSR_RUNTIME_VIRTUAL_ID = 'virtual:vue-ssr-lite/runtime'
export const SSR_CLIENT_VIRTUAL_PREFIX = 'virtual:vue-ssr-lite/client/'

export interface SsrCompiledApplication {
  id: string
  kind: SsrEntryKind
  template: string
  hosts: string[]
  roles?: string[]
  application?: SsrResolvedApplicationDefinition<any, any, any>
  mountSelector: string
  cacheControl?: string
  responseCache?: SsrResponseCacheStrategy<any>
  endpoints: SsrEndpointDefinition<any>[]
  cookieAllowlist: string[]
  cookieDenylist: string[]
  publicConfig: Record<string, unknown>
  applicationModule?: SsrApplicationModuleRef
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
  defaultApplicationId?: string
  server: SsrServerOptions<Record<string, unknown>>
  readiness?: SsrReadinessProbe[]
  development: boolean
}

export interface SsrViteApplicationEntry {
  id: string
  kind: SsrRenderMode
  definition: string
  exportName?: string
  template: string
  mountSelector: string
}

export interface SsrViteEntries {
  applications: SsrViteApplicationEntry[]
}

export interface SsrNormalizedApplicationConfig {
  id: string
  render: SsrRenderMode
  application: SsrApplicationSource
  template: string
  mountSelector: string
  hosts: string[]
  roles?: readonly string[]
  domain: SsrApplicationDomainConfig
  cookies?: SsrApplicationConfig['cookies']
  endpoints?: SsrApplicationConfig['endpoints']
  cacheControl?: string
  responseCache?: SsrApplicationConfig['responseCache']
  publicConfig?: Record<string, unknown>
}

/** Runtime-only shape for already-loaded legacy/programmatic modules. */
type SsrLoadedApplicationConfig = SsrApplicationConfig & {
  app?: SsrApplicationSource | string
  application?: SsrApplicationSource
  mountSelector?: string
}

type SsrLoadedConfig = SsrConfig & {
  applications?: Record<string, SsrLoadedApplicationConfig>
  app?: SsrApplicationSource | string
  application?: SsrApplicationSource
}

export interface SsrNormalizedConfig {
  name: string
  runtime?: string
  applications: Record<string, SsrNormalizedApplicationConfig>
  defaultApplicationId?: string
  server?: SsrConfig['server']
  readiness?: SsrConfig['readiness']
}

export interface NormalizeSsrConfigOptions {
  root?: string
  development?: boolean
}

export interface CompileSsrConfigOptions extends NormalizeSsrConfigOptions {
  importModule?: (specifier: string) => Promise<Record<string, unknown>>
}

export const isSsrApplicationModuleRef = (
  value: unknown
): value is SsrApplicationModuleRef =>
  Boolean(
    value &&
      typeof value === 'object' &&
      'module' in value &&
      typeof (value as SsrApplicationModuleRef).module === 'string'
  )

const asApplicationSource = (
  value: SsrApplicationSource | string | undefined
): SsrApplicationSource =>
  typeof value === 'string' ? { module: value } : value!

const normalizeHostname = (value: string, label: string): string => {
  const normalized = stripSsrHostPort(normalizeSsrHost(value) || value)
  if (!normalized || normalized.includes('/') || normalized.includes('?')) {
    throw new SsrHostConfigurationError(
      `${label} must be a valid hostname without a protocol, path, or port.`
    )
  }
  return normalized.replace(/^\[|\]$/g, '')
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
  const activeBase = normalizeHostname(
    activeRaw,
    development ? 'domain.development' : 'domain.production'
  )
  const hosts: string[] = []
  if (mode === 'root' || mode === 'root-and-subdomains') pushUnique(hosts, activeBase)
  if (mode === 'subdomains' || mode === 'root-and-subdomains') {
    pushUnique(hosts, `*.${activeBase}`)
  }
  if (development && productionBase) {
    const production = normalizeHostname(productionBase, 'domain.production')
    if (production !== activeBase) {
      if (mode === 'root' || mode === 'root-and-subdomains') pushUnique(hosts, production)
      if (mode === 'subdomains' || mode === 'root-and-subdomains') {
        pushUnique(hosts, `*.${production}`)
      }
    }
  }
  if (development && domain.localAliases && LOOPBACK_HOST_SET.has(activeBase)) {
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

const normalizeApplication = (
  id: string,
  input: SsrLoadedApplicationConfig,
  options: { development: boolean; single: boolean; applicationCount: number }
): SsrNormalizedApplicationConfig => {
  if (!input || typeof input !== 'object') {
    throw new Error(`Application "${id}" must be an object.`)
  }
  if (input.app && input.application) {
    throw new Error(
      `Application "${id}" cannot declare both app and application. Use app.`
    )
  }
  const render = input.render ?? 'ssr'
  if (render !== 'ssr' && render !== 'spa') {
    throw new Error(`Application "${id}" render must be "ssr" or "spa".`)
  }
  const application = asApplicationSource(
    input.app ?? input.application ?? SSR_DEFAULT_APPLICATION_ENTRY
  )
  const explicitHosts = normalizeHostPatterns(input.host, id)
  const domain = { ...(input.domain || {}) }
  let hosts = explicitHosts.length
    ? explicitHosts
    : expandApplicationHosts(domain, options.development)
  if (!hosts.length && (options.single || options.applicationCount === 1)) {
    hosts = ['*']
  }
  if (!hosts.length) {
    throw new Error(
      `Application "${id}" needs host routing because multiple applications are configured. Add host: "example.com" (wildcards are supported).`
    )
  }
  const derivedBase = baseFromHosts(hosts)
  return {
    id,
    render,
    application,
    template: input.template ?? SSR_DEFAULT_TEMPLATE,
    mountSelector: input.mount ?? input.mountSelector ?? SSR_DEFAULT_MOUNT,
    hosts,
    roles: input.roles,
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
  }
}

/** Resolve conventions and optional overrides into one deterministic shape. */
export const normalizeSsrConfig = (
  input: SsrConfig | null | undefined,
  options: NormalizeSsrConfigOptions = {}
): SsrNormalizedConfig => {
  const config = (input ?? {}) as SsrLoadedConfig
  if (!config || typeof config !== 'object') {
    throw new Error('ssr.config must export an object or a function returning one.')
  }
  const development =
    options.development ??
    (typeof process === 'undefined' || process.env.NODE_ENV !== 'production')
  const hasApplications = config.applications != null
  if (hasApplications) {
    const singleApplicationKeys = [
      'app',
      'application',
      'render',
      'template',
      'host',
      'domain',
      'cookies',
      'endpoints',
      'mount',
      'mountSelector',
      'cacheControl',
      'responseCache',
      'publicConfig',
    ] as const
    const configRecord = config as Record<string, unknown>
    const mixedKey = singleApplicationKeys.find(
      (key) => configRecord[key] !== undefined
    )
    if (mixedKey) {
      throw new Error(
        `SSR config cannot use single-application field \`${mixedKey}\` with applications. Move it into the relevant applications entry.`
      )
    }
  }
  const sourceApplications: Record<string, SsrLoadedApplicationConfig> = hasApplications
    ? config.applications!
    : { [SSR_DEFAULT_APPLICATION_ID]: config }
  const ids = Object.keys(sourceApplications)
  if (!ids.length) throw new Error('SSR config applications cannot be empty.')
  const applications = Object.fromEntries(
    ids.map((id) => [
      id,
      normalizeApplication(id, sourceApplications[id], {
        development,
        single: !hasApplications,
        applicationCount: ids.length,
      }),
    ])
  )
  const root = resolve(options.root || process.cwd())
  return {
    name: String(config.name || basename(root) || 'app'),
    runtime: config.runtime,
    applications,
    defaultApplicationId: config.defaultApplicationId,
    server: config.server,
    readiness: config.readiness,
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
      throw new Error(`vue-ssr-lite could not find the configured SSR config: ${fullPath}`)
    }
  }
  for (const candidate of CONFIG_CANDIDATES) {
    const fullPath = resolve(root, candidate)
    try {
      await access(fullPath)
      return fullPath
    } catch {
      // Configuration is optional; keep looking for another supported extension.
    }
  }
  return undefined
}

const assertConventionFiles = async (root: string, config: SsrConfig) => {
  const normalized = normalizeSsrConfig(config, { root })
  for (const application of Object.values(normalized.applications)) {
    if (isSsrApplicationModuleRef(application.application)) {
      const modulePath = application.application.module
      if (modulePath.startsWith('.') || modulePath.startsWith('/')) {
        const absolute = resolve(root, modulePath)
        try {
          await access(absolute)
        } catch {
          throw new Error(
            `Application "${application.id}" entry was not found at ${absolute}. Create ${SSR_DEFAULT_APPLICATION_ENTRY}, or set app in ssr.config to the correct entry.`
          )
        }
      }
    }
    const templatePath = resolve(root, application.template)
    let source: string
    try {
      source = await readFile(templatePath, 'utf8')
    } catch {
      throw new Error(
        `Application "${application.id}" HTML template was not found at ${templatePath}. Create ${SSR_DEFAULT_TEMPLATE}, or set template in ssr.config.`
      )
    }
    try {
      prepareSsrHtmlTemplate(source, application.mountSelector)
    } catch (error) {
      throw new Error(
        `Application "${application.id}" template ${templatePath} is invalid: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}

/** Load optional overrides; absence means the standard Vue conventions. */
export const loadSsrConfigFile = async (
  root: string,
  configPath?: string
): Promise<SsrConfig> => {
  const absoluteConfig = await resolveSsrConfigPath(root, configPath)
  if (!absoluteConfig) {
    const config: SsrConfig = {}
    await assertConventionFiles(root, config)
    return config
  }
  const esbuild = await import('esbuild')
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [absoluteConfig],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    logLevel: 'silent',
  })
  const code = result.outputFiles?.[0]?.text
  if (!code) throw new Error(`Failed to bundle SSR config: ${absoluteConfig}`)
  const directory = join(root, 'node_modules', '.cache', 'vue-ssr-lite')
  await mkdir(directory, { recursive: true })
  const outfile = join(directory, `ssr.config.${randomBytes(6).toString('hex')}.mjs`)
  try {
    await writeFile(outfile, code, 'utf8')
    const loaded = (await import(pathToFileURL(outfile).href)) as {
      default?: SsrConfigExport
    }
    const exported = loaded.default ?? (loaded as unknown as SsrConfigExport)
    const config = typeof exported === 'function' ? await exported() : exported
    if (!config || typeof config !== 'object') {
      throw new Error('The SSR config module must export an object.')
    }
    await assertConventionFiles(root, config)
    return config
  } finally {
    await rm(outfile, { force: true })
  }
}

export const extractSsrViteEntries = (
  config: SsrConfig,
  options: NormalizeSsrConfigOptions = {}
): SsrViteEntries => {
  const normalized = normalizeSsrConfig(config, options)
  const applications = Object.values(normalized.applications).map((app) => {
    if (!isSsrApplicationModuleRef(app.application)) {
      throw new Error(
        `Application "${app.id}" must use an app module path so Vite can generate its browser entry.`
      )
    }
    return {
      id: app.id,
      kind: app.render,
      definition: app.application.module,
      exportName: app.application.exportName,
      template: app.template,
      mountSelector: app.mountSelector,
    }
  })
  return { applications }
}

export const resolveSsrViteEntries = async (
  root: string,
  configPath?: string
): Promise<SsrViteEntries> =>
  extractSsrViteEntries(await loadSsrConfigFile(root, configPath), { root })

const absoluteImportPath = (root: string, filePath: string): string =>
  resolve(root, filePath).replaceAll('\\', '/')

export const generateSsrRuntimeModule = (
  root: string,
  configPath: string | undefined,
  entries: SsrViteApplicationEntry[]
): string => {
  const importLines: string[] = configPath
    ? [`import __ssrUserConfig from ${JSON.stringify(absoluteImportPath(root, configPath))}`]
    : []
  const bindLines: string[] = []
  let firstSsrAlias: string | undefined
  entries
    .filter((entry) => entry.kind === 'ssr')
    .forEach((entry, index) => {
      const alias = `__ssrApp${index}`
      firstSsrAlias ??= alias
      const definitionPath = absoluteImportPath(root, entry.definition)
      importLines.push(
        entry.exportName
          ? `import { ${entry.exportName} as ${alias} } from ${JSON.stringify(definitionPath)}`
          : `import ${alias} from ${JSON.stringify(definitionPath)}`
      )
      bindLines.push(
        `  applications[${JSON.stringify(entry.id)}] = { ...applications[${JSON.stringify(entry.id)}], app: ${alias} }`
      )
    })
  return [
    ...importLines,
    '',
    'const resolveConfig = async () => {',
    configPath
      ? '  const exported = __ssrUserConfig?.default ?? __ssrUserConfig\n  const config = typeof exported === "function" ? await exported() : exported'
      : '  const config = {}',
    '  if (config?.applications) {',
    '    const applications = { ...config.applications }',
    ...bindLines,
    '    return { ...config, applications }',
    '  }',
    firstSsrAlias
      ? `  return { ...config, app: ${firstSsrAlias} }`
      : '  return config',
    '}',
    '',
    'export default resolveConfig',
    '',
  ].join('\n')
}

export const generateSsrClientModule = (
  root: string,
  entry: SsrViteApplicationEntry
): string => {
  const definitionPath = absoluteImportPath(root, entry.definition)
  const importStatement = entry.exportName
    ? `import { ${entry.exportName} as loadApplication } from ${JSON.stringify(definitionPath)}`
    : `import loadApplication from ${JSON.stringify(definitionPath)}`
  const mountFunction = entry.kind === 'spa' ? 'mountSpaApplication' : 'hydrateSsrApplication'
  const label = entry.kind === 'spa' ? 'SPA mount' : 'hydration'
  return [
    importStatement,
    `import { ${mountFunction} } from 'vue-ssr-lite/client'`,
    'const definition = typeof loadApplication === "function"',
    '  ? await loadApplication()',
    '  : loadApplication',
    'if (!definition?.root) {',
    `  throw new Error(${JSON.stringify(`Application "${entry.id}" must default-export defineApplication({ root, ... }).`)})`,
    '}',
    `void ${mountFunction}(`,
    `  { ...definition, id: ${JSON.stringify(entry.id)} },`,
    `  { mountSelector: ${JSON.stringify(entry.mountSelector)} },`,
    ').catch((error) => {',
    `  console.error('[vue-ssr-lite] ${label} failed', error)`,
    '  throw error',
    '})',
    '',
  ].join('\n')
}

const parseCookieList = (value: string | readonly string[] | undefined): string[] => {
  if (value == null) return []
  const values = Array.isArray(value) ? value : String(value).split(',')
  return values.map((item) => String(item).trim()).filter(Boolean)
}

const isApplicationDefinition = (
  value: unknown
): value is SsrResolvedApplicationDefinition<any, any, any> =>
  Boolean(value && typeof value === 'object' && (value as any).root)

const pickModuleExport = (
  mod: Record<string, unknown>,
  exportName: string | undefined,
  applicationId: string
): SsrApplicationLoader => {
  const resolved = exportName ? mod[exportName] : mod.default
  if (resolved == null) {
    throw new Error(
      `Application "${applicationId}" module must export${exportName ? ` "${exportName}"` : ' a default defineApplication(...) value'}.`
    )
  }
  return resolved as SsrApplicationLoader
}

const resolveApplicationSource = async (
  source: SsrApplicationSource,
  applicationId: string,
  options: CompileSsrConfigOptions
): Promise<SsrResolvedApplicationDefinition<any, any, any>> => {
  let loader: SsrApplicationLoader = source as SsrApplicationLoader
  if (isSsrApplicationModuleRef(source)) {
    const root = options.root || process.cwd()
    const specifier = source.module.startsWith('.')
      ? resolve(root, source.module)
      : source.module
    const mod = options.importModule
      ? await options.importModule(source.module)
      : ((await import(pathToFileURL(specifier).href)) as Record<string, unknown>)
    loader = pickModuleExport(mod, source.exportName, applicationId)
  }
  const resolved = typeof loader === 'function' ? await loader() : loader
  if (!isApplicationDefinition(resolved)) {
    throw new Error(
      `Application "${applicationId}" must export defineApplication({ root, ... }). A browser createApp(...).mount(...) entry cannot run universally.`
    )
  }
  return { ...resolved, id: applicationId }
}

export const compileSsrConfig = async (
  loaded: unknown,
  options: CompileSsrConfigOptions = {}
): Promise<SsrCompiledConfig> => {
  const moduleValue = loaded as { default?: SsrConfigExport }
  const exported = moduleValue?.default ?? (loaded as SsrConfigExport)
  const raw = typeof exported === 'function' ? await exported() : exported
  const development =
    options.development ??
    (typeof process === 'undefined' || process.env.NODE_ENV !== 'production')
  const config = normalizeSsrConfig((raw || {}) as SsrConfig, {
    root: options.root,
    development,
  })
  const applications: SsrCompiledApplication[] = []
  for (const app of Object.values(config.applications)) {
    const applicationModule = isSsrApplicationModuleRef(app.application)
      ? app.application
      : undefined
    const application =
      app.render === 'ssr'
        ? await resolveApplicationSource(app.application, app.id, options)
        : undefined
    const developmentDomain = String(app.domain.development || '')
    const productionDomain = String(app.domain.production || '')
    applications.push({
      id: app.id,
      kind: app.render,
      template: app.template,
      hosts: [...app.hosts],
      roles: app.roles ? [...app.roles] : undefined,
      application,
      mountSelector: app.mountSelector,
      cacheControl: app.cacheControl,
      responseCache: app.responseCache,
      endpoints: app.endpoints ? [...app.endpoints] : [],
      cookieAllowlist: parseCookieList(app.cookies?.allow),
      cookieDenylist: parseCookieList(app.cookies?.deny),
      publicConfig: { ...(app.publicConfig || {}) },
      applicationModule,
      domain: {
        development: developmentDomain
          ? normalizeHostname(developmentDomain, `${app.id}.domain.development`)
          : '',
        production: productionDomain
          ? normalizeHostname(productionDomain, `${app.id}.domain.production`)
          : '',
        mode: app.domain.mode ?? 'root-and-subdomains',
        localAliases: Boolean(app.domain.localAliases),
        customDomains: Boolean(app.domain.customDomains),
        params: app.domain.params,
      },
    })
  }
  validateSsrHostEntries(applications)
  if (
    config.defaultApplicationId &&
    !applications.some((app) => app.id === config.defaultApplicationId)
  ) {
    throw new Error(
      `defaultApplicationId "${config.defaultApplicationId}" does not match an application.`
    )
  }
  return {
    name: config.name,
    applications,
    defaultApplicationId: config.defaultApplicationId,
    development,
    readiness: config.readiness,
    server: {
      root: config.server?.root ?? options.root,
      host: config.server?.host,
      port: config.server?.port,
      role: config.runtime ?? 'unified',
      trustProxy: config.server?.trustProxy,
      clientOutDir: config.server?.clientOutDir,
      requestTimeoutMs: config.server?.requestTimeoutMs,
      shutdownTimeoutMs: config.server?.shutdownTimeoutMs,
      healthPath: config.server?.healthPath,
      readinessPath: config.server?.readinessPath,
      maxResolutionPasses: config.server?.maxResolutionPasses,
      resolutionDeadlineMs: config.server?.resolutionDeadlineMs,
      diagnostics: config.server?.diagnostics,
      logger: config.server?.logger,
      onMetrics: config.server?.onMetrics,
      renderError: config.server?.renderError,
      publicConfig: {},
    },
  }
}

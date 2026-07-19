import { access, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import type {
  SsrApplicationConfig,
  SsrApplicationDomainConfig,
  SsrApplicationLoader,
  SsrApplicationModuleRef,
  SsrApplicationSource,
  SsrConfig,
  SsrConfigExport,
  SsrDomainMode,
} from './SsrConfigTypes'
import { defineSsrConfig } from './SsrConfigRuntime'
import type {
  SsrApplicationDefinition,
  SsrEndpointDefinition,
  SsrEntryKind,
  SsrReadinessProbe,
  SsrResponseCacheStrategy,
  SsrServerOptions,
} from './SsrRuntimeTypes'
import {
  normalizeSsrHost,
  SsrHostConfigurationError,
  stripSsrHostPort,
  validateSsrHostEntries,
} from './server/SsrHostRuntime'

export { defineSsrConfig }

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1'] as const
const CONFIG_CANDIDATES = [
  'ssr.config.ts',
  'ssr.config.mts',
  'ssr.config.js',
  'ssr.config.mjs',
] as const

export interface SsrCompiledApplication {
  id: string
  kind: SsrEntryKind
  template: string
  hosts: string[]
  roles?: string[]
  application?: SsrApplicationDefinition<any, any, any>
  mountSelector?: string
  cacheControl?: string
  responseCache?: SsrResponseCacheStrategy<any>
  endpoints: SsrEndpointDefinition<any>[]
  cookieAllowlist: string[]
  cookieDenylist: string[]
  publicConfig: Record<string, unknown>
  /** Present when `ssr` was declared as a module reference. */
  ssrModule?: SsrApplicationModuleRef
  domain: {
    development: string
    production: string
    mode: SsrDomainMode
    localAliases: boolean
    customDomains: boolean
    expose: SsrApplicationDomainConfig['expose']
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
  definition: string
  exportName?: string
  template: string
  mountSelector?: string
}

export interface SsrViteEntries {
  applications: SsrViteApplicationEntry[]
  spaEntries: Record<string, string>
}

export const isSsrApplicationModuleRef = (
  value: unknown
): value is SsrApplicationModuleRef =>
  Boolean(
    value &&
      typeof value === 'object' &&
      'module' in value &&
      typeof (value as SsrApplicationModuleRef).module === 'string' &&
      !('id' in value && 'rootComponent' in value)
  )

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
  const activeBase = normalizeHostname(
    development ? domain.development : domain.production,
    development ? 'domain.development' : 'domain.production'
  )
  const hosts: string[] = []
  if (mode === 'root' || mode === 'root-and-subdomains') {
    pushUnique(hosts, activeBase)
  }
  if (mode === 'subdomains' || mode === 'root-and-subdomains') {
    pushUnique(hosts, `*.${activeBase}`)
  }

  // In development, also own the production apex family when it differs so a
  // single process can serve both local and production-shaped hosts.
  if (development) {
    const productionBase = normalizeHostname(
      domain.production,
      'domain.production'
    )
    if (productionBase !== activeBase) {
      if (mode === 'root' || mode === 'root-and-subdomains') {
        pushUnique(hosts, productionBase)
      }
      if (mode === 'subdomains' || mode === 'root-and-subdomains') {
        pushUnique(hosts, `*.${productionBase}`)
      }
    }
    if (domain.localAliases) {
      for (const alias of LOOPBACK_HOSTS) pushUnique(hosts, alias)
    }
  }

  for (const extra of domain.additionalHosts ?? []) {
    pushUnique(hosts, normalizeHostname(extra, 'domain.additionalHosts'))
  }

  if (domain.customDomains) pushUnique(hosts, '*')
  if (!hosts.length) {
    throw new SsrHostConfigurationError(
      'Application domain configuration produced an empty host list.'
    )
  }
  return hosts
}

const parseCookieList = (
  value: string | readonly string[] | undefined
): string[] => {
  if (value == null) return []
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean)
  }
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

const pickModuleExport = (
  mod: Record<string, unknown>,
  exportName: string | undefined,
  applicationId: string,
  kind: SsrEntryKind
): SsrApplicationDefinition<any, any, any> => {
  const resolved = (
    exportName ? mod[exportName] : mod.default
  ) as SsrApplicationDefinition<any, any, any> | undefined
  if (!resolved?.id || !resolved.rootComponent) {
    throw new SsrHostConfigurationError(
      `Application "${applicationId}" ${kind} module must export a valid SsrApplicationDefinition${
        exportName ? ` as "${exportName}"` : ' (default)'
      }.`
    )
  }
  return resolved
}

const resolveApplicationLoader = async (
  loader: SsrApplicationLoader | undefined,
  applicationId: string,
  kind: SsrEntryKind
): Promise<SsrApplicationDefinition<any, any, any> | undefined> => {
  if (!loader) return undefined
  const resolved = typeof loader === 'function' ? await loader() : loader
  if (!resolved?.id || !resolved.rootComponent) {
    throw new SsrHostConfigurationError(
      `Application "${applicationId}" ${kind} loader must return a valid SsrApplicationDefinition.`
    )
  }
  return resolved
}

export interface CompileSsrConfigOptions {
  development?: boolean
  /** Project root used to resolve `{ module }` paths. */
  root?: string
  /**
   * Custom importer for module references (Vite `ssrLoadModule` in development).
   * Falls back to a Node ESM import of the resolved file URL.
   */
  importModule?: (specifier: string) => Promise<Record<string, unknown>>
}

const resolveApplicationSource = async (
  source: SsrApplicationSource | undefined,
  applicationId: string,
  kind: SsrEntryKind,
  options: CompileSsrConfigOptions
): Promise<SsrApplicationDefinition<any, any, any> | undefined> => {
  if (!source) return undefined
  if (isSsrApplicationModuleRef(source)) {
    const root = options.root || process.cwd()
    const specifier = source.module.startsWith('.')
      ? resolve(root, source.module)
      : source.module
    const mod = options.importModule
      ? await options.importModule(source.module)
      : ((await import(pathToFileURL(specifier).href)) as Record<string, unknown>)
    return pickModuleExport(mod, source.exportName, applicationId, kind)
  }
  return resolveApplicationLoader(source, applicationId, kind)
}

export const resolveSsrConfigPath = async (
  root: string,
  explicit?: string
): Promise<string> => {
  if (explicit) return resolve(root, explicit)
  for (const candidate of CONFIG_CANDIDATES) {
    const fullPath = resolve(root, candidate)
    try {
      await access(fullPath)
      return fullPath
    } catch {
      // try next
    }
  }
  throw new Error(
    `vue-ssr-lite could not find an SSR config in ${root}. Expected one of: ${CONFIG_CANDIDATES.join(', ')}`
  )
}

/** Derive Vite HTML / hydration entries from a loaded `SsrConfig`. */
export const extractSsrViteEntries = (config: SsrConfig): SsrViteEntries => {
  const applications: SsrViteApplicationEntry[] = []
  const spaEntries: Record<string, string> = {}
  for (const [id, app] of Object.entries(config.applications || {})) {
    if (app.ssr !== undefined) {
      if (!isSsrApplicationModuleRef(app.ssr)) {
        throw new Error(
          `Application "${id}" must declare ssr: { module, exportName } so vueSsrLite() can derive the client entry from ssr.config.`
        )
      }
      applications.push({
        id,
        definition: app.ssr.module,
        exportName: app.ssr.exportName,
        template: app.template,
        mountSelector: app.mountSelector,
      })
      continue
    }
    if (app.spa !== undefined) {
      spaEntries[id] = app.template
    }
  }
  if (!applications.length && !Object.keys(spaEntries).length) {
    throw new Error(
      'ssr.config must declare at least one spa or ssr application for Vite.'
    )
  }
  return { applications, spaEntries }
}

/**
 * Load `ssr.config` for Vite entry discovery without going through the
 * consumer's Vite plugin graph. Relative local imports are bundled; packages
 * stay external.
 *
 * The bundled file is written under the project `node_modules` tree so Node can
 * resolve bare imports like `vue-ssr-lite` from the consumer's dependencies.
 * Writing under the OS temp directory breaks package resolution.
 */
export const loadSsrConfigFile = async (
  root: string,
  configPath?: string
): Promise<SsrConfig> => {
  const absoluteConfig = await resolveSsrConfigPath(root, configPath)
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
  if (!code) {
    throw new Error(`Failed to bundle SSR config: ${absoluteConfig}`)
  }
  const directory = join(root, 'node_modules', '.cache', 'vue-ssr-lite')
  await mkdir(directory, { recursive: true })
  const outfile = join(
    directory,
    `ssr.config.${randomBytes(6).toString('hex')}.mjs`
  )
  try {
    await writeFile(outfile, code, 'utf8')
    const loaded = (await import(pathToFileURL(outfile).href)) as {
      default?: SsrConfigExport
    }
    const exported = loaded.default ?? (loaded as unknown as SsrConfigExport)
    const config = typeof exported === 'function' ? await exported() : exported
    if (!config?.name || !config.applications) {
      throw new Error(
        'The SSR config module must export defineSsrConfig({ name, applications }).'
      )
    }
    return config
  } finally {
    await rm(outfile, { force: true })
  }
}

export const resolveSsrViteEntries = async (
  root: string,
  configPath?: string
): Promise<SsrViteEntries> => {
  const config = await loadSsrConfigFile(root, configPath)
  return extractSsrViteEntries(config)
}

/**
 * Rewrite `ssr: { module, exportName }` object literals into Vite-analyzable
 * dynamic import loaders so production SSR bundles include the application.
 */
export const transformSsrModuleRefs = (code: string, filename: string): string | null => {
  if (!/ssr\.config\.(m?ts|m?js)$/.test(filename.replaceAll('\\', '/'))) {
    return null
  }
  if (!/\bssr\s*:\s*\{/.test(code) || !/\bmodule\s*:/.test(code)) {
    return null
  }

  const rewritten = code.replace(
    /ssr\s*:\s*\{\s*module\s*:\s*(['"])(.+?)\1\s*(?:,\s*exportName\s*:\s*(['"])(.+?)\3\s*)?,?\s*\}/g,
    (_match, _q1, modulePath, _q2, exportName) => {
      const exportExpr = exportName
        ? `m[${JSON.stringify(exportName)}]`
        : 'm.default'
      return `ssr: () => import(${JSON.stringify(modulePath)}).then((m) => ${exportExpr})`
    }
  )
  return rewritten === code ? null : rewritten
}

export const compileSsrConfig = async (
  loaded: unknown,
  options: CompileSsrConfigOptions = {}
): Promise<SsrCompiledConfig> => {
  const moduleValue = loaded as { default?: SsrConfigExport }
  const exported = moduleValue?.default ?? (loaded as SsrConfigExport)
  const config = typeof exported === 'function' ? await exported() : exported
  if (!config?.name || !config.applications || typeof config.applications !== 'object') {
    throw new Error(
      'The SSR config module must export defineSsrConfig({ name, applications }).'
    )
  }

  const development =
    options.development ??
    (typeof process !== 'undefined'
      ? process.env.NODE_ENV !== 'production'
      : true)
  const applicationIds = Object.keys(config.applications)
  if (!applicationIds.length) {
    throw new Error('SSR config requires at least one application.')
  }

  const applications: SsrCompiledApplication[] = []
  for (const id of applicationIds) {
    const appConfig: SsrApplicationConfig = config.applications[id]
    if (!appConfig?.template || !appConfig.domain) {
      throw new SsrHostConfigurationError(
        `Application "${id}" requires template and domain configuration.`
      )
    }
    const hasSpa = appConfig.spa !== undefined
    const hasSsr = appConfig.ssr !== undefined
    // `spa: true` means "serve the SPA template shell" without a managed
    // application definition (consumer mounts via its own client entry).
    if (!hasSpa && !hasSsr) {
      throw new SsrHostConfigurationError(
        `Application "${id}" requires spa or ssr.`
      )
    }
    if (hasSpa && hasSsr) {
      throw new SsrHostConfigurationError(
        `Application "${id}" cannot declare both spa and ssr.`
      )
    }

    const kind: SsrEntryKind = hasSsr ? 'ssr' : 'spa'
    const ssrModule = isSsrApplicationModuleRef(appConfig.ssr)
      ? appConfig.ssr
      : undefined
    // SPA shells are mounted in the browser (`mountSpaApplication` / client
    // entry). Never resolve SPA loaders on the Node server — they commonly pull
    // browser-only packages (charts, maps, etc.) that crash without `window`.
    const application = hasSsr
      ? await resolveApplicationSource(appConfig.ssr, id, kind, options)
      : undefined
    const publicConfig: Record<string, unknown> = {
      ...(appConfig.publicConfig || {}),
    }
    if (appConfig.graphql) {
      publicConfig.graphql = {
        endpoint: appConfig.graphql.endpoint,
        timeout: appConfig.graphql.timeout ?? 8_000,
      }
    }

    applications.push({
      id,
      kind,
      template: appConfig.template,
      hosts: expandApplicationHosts(appConfig.domain, development),
      roles: appConfig.roles ? [...appConfig.roles] : undefined,
      application,
      mountSelector: appConfig.mountSelector,
      cacheControl: appConfig.cacheControl,
      responseCache: appConfig.responseCache,
      endpoints: appConfig.endpoints ? [...appConfig.endpoints] : [],
      cookieAllowlist: parseCookieList(appConfig.cookies?.allow),
      cookieDenylist: parseCookieList(appConfig.cookies?.deny),
      publicConfig,
      ssrModule,
      domain: {
        development: normalizeHostname(
          appConfig.domain.development,
          `${id}.domain.development`
        ),
        production: normalizeHostname(
          appConfig.domain.production,
          `${id}.domain.production`
        ),
        mode: appConfig.domain.mode ?? 'root-and-subdomains',
        localAliases: Boolean(appConfig.domain.localAliases),
        customDomains: Boolean(appConfig.domain.customDomains),
        expose: appConfig.domain.expose,
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
      role: config.runtime,
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
      publicConfig: {},
    },
  }
}

import { access, mkdir, writeFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
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
  SsrApplicationDefinition,
  SsrEndpointDefinition,
  SsrEntryKind,
  SsrReadinessProbe,
  SsrResponseCacheStrategy,
  SsrServerOptions,
} from './SsrRuntimeTypes'
import {
  SsrHostConfigurationError,
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

export const SSR_RUNTIME_VIRTUAL_ID = 'virtual:vue-ssr-lite/runtime'
export const SSR_CLIENT_VIRTUAL_PREFIX = 'virtual:vue-ssr-lite/client/'

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
  mountSelector?: string
}

export interface SsrViteEntries {
  applications: SsrViteApplicationEntry[]
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

const isApplicationDefinition = (
  value: unknown
): value is SsrApplicationDefinition<any, any, any> =>
  Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as SsrApplicationDefinition).id === 'string' &&
      (value as SsrApplicationDefinition).rootComponent
  )

const canonicalizeApplicationId = (
  definition: SsrApplicationDefinition<any, any, any>,
  applicationId: string
): SsrApplicationDefinition<any, any, any> =>
  definition.id === applicationId
    ? definition
    : { ...definition, id: applicationId }

const pickModuleExport = (
  mod: Record<string, unknown>,
  exportName: string | undefined,
  applicationId: string,
  kind: SsrEntryKind
): SsrApplicationLoader => {
  const resolved = exportName ? mod[exportName] : mod.default
  if (resolved == null) {
    throw new SsrHostConfigurationError(
      `Application "${applicationId}" ${kind} module must export${
        exportName ? ` "${exportName}"` : ' a default value'
      }.`
    )
  }
  return resolved as SsrApplicationLoader
}

const resolveApplicationLoader = async (
  loader: SsrApplicationLoader,
  applicationId: string,
  kind: SsrEntryKind
): Promise<SsrApplicationDefinition<any, any, any>> => {
  const resolved = typeof loader === 'function' ? await loader() : loader
  if (!isApplicationDefinition(resolved)) {
    throw new SsrHostConfigurationError(
      `Application "${applicationId}" ${kind} loader must return a valid SsrApplicationDefinition.`
    )
  }
  return canonicalizeApplicationId(resolved, applicationId)
}

export interface CompileSsrConfigOptions {
  development?: boolean
  root?: string
  importModule?: (specifier: string) => Promise<Record<string, unknown>>
}

const resolveApplicationSource = async (
  source: SsrApplicationSource,
  applicationId: string,
  kind: SsrEntryKind,
  options: CompileSsrConfigOptions
): Promise<SsrApplicationDefinition<any, any, any>> => {
  if (isSsrApplicationModuleRef(source)) {
    const root = options.root || process.cwd()
    const specifier = source.module.startsWith('.')
      ? resolve(root, source.module)
      : source.module
    const mod = options.importModule
      ? await options.importModule(source.module)
      : ((await import(pathToFileURL(specifier).href)) as Record<string, unknown>)
    const loader = pickModuleExport(mod, source.exportName, applicationId, kind)
    return resolveApplicationLoader(loader, applicationId, kind)
  }
  return resolveApplicationLoader(source, applicationId, kind)
}

const validateProductionConfig = (config: SsrConfig) => {
  if (!String(config.runtime || '').trim()) {
    throw new Error(
      'Production SSR config requires `runtime` (e.g. APP_RUNTIME). Refusing to default to "unified".'
    )
  }
  for (const [id, app] of Object.entries(config.applications)) {
    if (!String(app.domain?.production || '').trim()) {
      throw new Error(
        `Application "${id}" requires domain.production in production.`
      )
    }
    const api = (app.publicConfig as { api?: { endpoint?: string } } | undefined)
      ?.api
    if (!String(api?.endpoint || '').trim()) {
      throw new Error(
        `Application "${id}" requires publicConfig.api.endpoint in production.`
      )
    }
  }
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

/** Derive Vite HTML / client entries from a loaded `SsrConfig`. */
export const extractSsrViteEntries = (config: SsrConfig): SsrViteEntries => {
  const applications: SsrViteApplicationEntry[] = []
  for (const [id, app] of Object.entries(config.applications || {})) {
    if (!app.render || !app.template) {
      throw new Error(
        `Application "${id}" requires render and template in ssr.config.`
      )
    }
    if (!isSsrApplicationModuleRef(app.application)) {
      throw new Error(
        `Application "${id}" must declare application: { module, exportName } so vueSsrLite() can generate the client entry.`
      )
    }
    applications.push({
      id,
      kind: app.render,
      definition: app.application.module,
      exportName: app.application.exportName,
      template: app.template,
      mountSelector: app.mountSelector,
    })
  }
  if (!applications.length) {
    throw new Error('ssr.config must declare at least one application for Vite.')
  }
  return { applications }
}

/**
 * Load `ssr.config` for Vite entry discovery / runtime module generation.
 * Written under the project `node_modules` tree so bare imports resolve.
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
 * Absolute POSIX paths for imports emitted into virtual modules. Relative
 * `./src/...` paths resolve against the virtual id (not the project root) and
 * fail import-analysis.
 */
const absoluteImportPath = (root: string, filePath: string): string =>
  resolve(root, filePath).replaceAll('\\', '/')

/**
 * Generate a Vite-analyzable runtime module that imports each SSR application
 * module statically and merges it into the user `ssr.config` export.
 *
 * SPA modules are intentionally omitted: the Node server only needs host /
 * template metadata for them. Eagerly importing SPA apps would execute their
 * client-side module side effects (shared registries, etc.) in the SSR process.
 */
export const generateSsrRuntimeModule = (
  root: string,
  configPath: string,
  entries: SsrViteApplicationEntry[]
): string => {
  const configImportPath = absoluteImportPath(root, configPath)
  const importLines: string[] = [
    `import __ssrUserConfig from ${JSON.stringify(configImportPath)}`,
  ]
  const bindLines: string[] = []
  entries
    .filter((entry) => entry.kind === 'ssr')
    .forEach((entry, index) => {
      const alias = `__ssrApp${index}`
      const definitionPath = absoluteImportPath(root, entry.definition)
      if (entry.exportName) {
        importLines.push(
          `import { ${entry.exportName} as ${alias} } from ${JSON.stringify(definitionPath)}`
        )
      } else {
        importLines.push(
          `import ${alias} from ${JSON.stringify(definitionPath)}`
        )
      }
      bindLines.push(
        `  applications[${JSON.stringify(entry.id)}] = { ...applications[${JSON.stringify(entry.id)}], application: ${alias} }`
      )
    })

  return [
    ...importLines,
    '',
    'const resolveConfig = async () => {',
    '  const exported = __ssrUserConfig?.default ?? __ssrUserConfig',
    '  const config = typeof exported === "function" ? await exported() : exported',
    '  if (!config?.applications) {',
    '    throw new Error("ssr.config must export defineSsrConfig({ name, applications }).")',
    '  }',
    '  const applications = { ...config.applications }',
    ...bindLines,
    '  return { ...config, applications }',
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
  const mountSelector = entry.mountSelector || '#app'
  if (entry.kind === 'spa') {
    return [
      importStatement,
      `import { mountSpaApplication } from 'vue-ssr-lite/client'`,
      `const definition = typeof loadApplication === 'function'`,
      `  ? await loadApplication()`,
      `  : loadApplication`,
      `void mountSpaApplication(`,
      `  { ...definition, id: ${JSON.stringify(entry.id)} },`,
      `  { mountSelector: ${JSON.stringify(mountSelector)} }`,
      `).catch((error) => {`,
      `  console.error('[vue-ssr-lite] SPA mount failed', error)`,
      `  throw error`,
      `})`,
      '',
    ].join('\n')
  }
  return [
    importStatement,
    `import { hydrateSsrApplication } from 'vue-ssr-lite/client'`,
    `const definition = typeof loadApplication === 'function'`,
    `  ? await loadApplication()`,
    `  : loadApplication`,
    `hydrateSsrApplication(`,
    `  { ...definition, id: ${JSON.stringify(entry.id)} },`,
    `  { mountSelector: ${JSON.stringify(mountSelector)} }`,
    `).catch((error) => {`,
    `  console.error('[vue-ssr-lite] hydration failed', error)`,
    `  throw error`,
    `})`,
    '',
  ].join('\n')
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

  if (!development) {
    validateProductionConfig(config)
  }

  const applicationIds = Object.keys(config.applications)
  if (!applicationIds.length) {
    throw new Error('SSR config requires at least one application.')
  }

  const applications: SsrCompiledApplication[] = []
  for (const id of applicationIds) {
    const appConfig: SsrApplicationConfig = config.applications[id]
    if (!appConfig?.template || !appConfig.domain || !appConfig.render) {
      throw new SsrHostConfigurationError(
        `Application "${id}" requires render, template, and domain configuration.`
      )
    }
    if (!appConfig.application) {
      throw new SsrHostConfigurationError(
        `Application "${id}" requires an application module.`
      )
    }
    if (appConfig.render !== 'spa' && appConfig.render !== 'ssr') {
      throw new SsrHostConfigurationError(
        `Application "${id}" render must be "spa" or "ssr".`
      )
    }

    const kind: SsrEntryKind = appConfig.render
    const applicationModule = isSsrApplicationModuleRef(appConfig.application)
      ? appConfig.application
      : undefined

    // SPA application modules often pull browser-only packages. Resolve only
    // SSR definitions on the Node server; SPA mounts via the generated client.
    const application =
      kind === 'ssr'
        ? await resolveApplicationSource(
            appConfig.application,
            id,
            kind,
            options
          )
        : undefined

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
      publicConfig: { ...(appConfig.publicConfig || {}) },
      applicationModule,
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
        params: appConfig.domain.params,
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
      role: config.runtime ?? (development ? 'unified' : undefined),
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

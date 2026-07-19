import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  SsrApplicationConfig,
  SsrApplicationDomainConfig,
  SsrApplicationLoader,
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

export const compileSsrConfig = async (
  loaded: unknown,
  options: { development?: boolean } = {}
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
    const loader =
      appConfig.ssr ||
      (appConfig.spa && appConfig.spa !== true ? appConfig.spa : undefined)
    const application = await resolveApplicationLoader(loader, id, kind)
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
      root: config.server?.root,
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

import type { SsrApplicationDefinition } from './SsrRuntimeTypes'
import type {
  SsrEndpointDefinition,
  SsrLogger,
  SsrReadinessProbe,
  SsrResponseCacheStrategy,
} from './SsrRuntimeTypes'

/** How an application owns its apex hostname and subdomains. */
export type SsrDomainMode = 'root' | 'subdomains' | 'root-and-subdomains'

export interface SsrApplicationDomainExpose {
  /** Expose the last subdomain label under the app base (e.g. workspace). */
  subdomainAs?: string
  /**
   * Expose the remaining labels under the app base, or the full hostname for
   * custom domains (e.g. storeDomain).
   */
  subdomainOrHostnameAs?: string
}

export interface SsrApplicationDomainConfig {
  /** Apex used while `NODE_ENV !== 'production'`. */
  development: string
  /** Apex used in production. */
  production: string
  /** Defaults to `root-and-subdomains`. */
  mode?: SsrDomainMode
  /** Register loopback aliases in development. Defaults to false. */
  localAliases?: boolean
  /** Own unmatched hosts via catch-all `*`. Defaults to false. */
  customDomains?: boolean
  /** Extra exact hostnames owned by this application. */
  additionalHosts?: readonly string[]
  /** Map resolved subdomain/hostname values onto `useSsrDomain().params`. */
  expose?: SsrApplicationDomainExpose
}

export interface SsrApplicationGraphqlConfig {
  endpoint: string
  timeout?: number
}

export interface SsrApplicationCookiesConfig {
  allow?: string | readonly string[]
  deny?: readonly string[]
}

export type SsrApplicationLoader =
  | SsrApplicationDefinition<any, any, any>
  | (() =>
      | SsrApplicationDefinition<any, any, any>
      | Promise<SsrApplicationDefinition<any, any, any>>)

/**
 * One self-contained SPA or SSR application: runtime, domain, security,
 * endpoints, and public configuration live together.
 */
export interface SsrApplicationConfig {
  /**
   * SPA application. Use `true` to serve only the HTML shell (consumer mounts
   * via its own client entry). Pass a definition/loader for managed SPA mount.
   */
  spa?: true | SsrApplicationLoader
  /** Server-rendered Vue application. */
  ssr?: SsrApplicationLoader
  template: string
  roles?: readonly string[]
  domain: SsrApplicationDomainConfig
  graphql?: SsrApplicationGraphqlConfig
  cookies?: SsrApplicationCookiesConfig
  endpoints?: SsrEndpointDefinition<any>[]
  mountSelector?: string
  cacheControl?: string
  responseCache?: SsrResponseCacheStrategy<any>
  /** Merged into the request `publicConfig` for this application. */
  publicConfig?: Record<string, unknown>
}

export interface SsrConfigServerOptions {
  root?: string
  host?: string
  port?: number
  trustProxy?: boolean
  clientOutDir?: string
  requestTimeoutMs?: number
  shutdownTimeoutMs?: number
  healthPath?: string
  readinessPath?: string
  maxResolutionPasses?: number
  resolutionDeadlineMs?: number
  diagnostics?: boolean
  logger?: SsrLogger
}

/**
 * Flat Vite/Nuxt-style SSR configuration.
 * Everything about an application lives under `applications.<id>`.
 */
export interface SsrConfig {
  name: string
  server?: SsrConfigServerOptions
  /** Active process role (`unified`, `erp`, `storefront`, …). */
  runtime?: string
  applications: Record<string, SsrApplicationConfig>
  /** Used only when no application host pattern matches. */
  defaultApplicationId?: string
  readiness?: SsrReadinessProbe[]
}

export type SsrConfigExport =
  | SsrConfig
  | (() => SsrConfig | Promise<SsrConfig>)

/** Serializable domain snapshot attached to every request and hydration state. */
export interface SsrDomainContext {
  /** Selected application id. */
  entry: string
  hostname: string
  /** Active environment apex for the selected application. */
  baseDomain: string
  /** Remaining labels under `baseDomain`, or null on the apex / custom host. */
  subdomain: string | null
  isCustomDomain: boolean
  development: boolean
  /** Values declared via `domain.expose`. */
  params: Record<string, string>
}

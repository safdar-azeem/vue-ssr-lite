import type { SsrApplicationDefinition } from './SsrRuntimeTypes'
import type {
  SsrEndpointDefinition,
  SsrErrorRenderContext,
  SsrHttpResponse,
  SsrLogger,
  SsrReadinessProbe,
  SsrRenderMetrics,
  SsrResponseCacheStrategy,
} from './SsrRuntimeTypes'

/** How an application owns its apex hostname and subdomains. */
export type SsrDomainMode = 'root' | 'subdomains' | 'root-and-subdomains'

export type SsrRenderMode = 'spa' | 'ssr'

/** How a declared domain param is derived from the request host. */
export type SsrDomainParamSource =
  | 'last-subdomain-label'
  | 'subdomain-or-hostname'

export interface SsrDomainParamDefinition {
  source: SsrDomainParamSource
}

export interface SsrApplicationDomainConfig {
  /** Apex used while `NODE_ENV !== 'production'`. */
  development: string
  /** Apex used in production. Required in production (no silent fallback). */
  production: string
  /** Defaults to `root-and-subdomains`. */
  mode?: SsrDomainMode
  /** Register loopback aliases in development. Defaults to false. */
  localAliases?: boolean
  /** Own unmatched hosts via catch-all `*`. Defaults to false. */
  customDomains?: boolean
  /** Extra exact hostnames owned by this application. */
  additionalHosts?: readonly string[]
  /**
   * Named values exposed on `useSsrDomain().params`.
   * Example: `{ workspace: { source: 'last-subdomain-label' } }`.
   */
  params?: Record<string, SsrDomainParamDefinition>
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
 * Path-based application reference. Prefer this in `ssr.config` so Vite can
 * generate client entries without importing browser-only modules into Node.
 */
export interface SsrApplicationModuleRef {
  /** Project-root-relative module path (e.g. `./src/runtime/ErpBootstrap.ts`). */
  module: string
  /** Named export. Defaults to the module's `default` export. */
  exportName?: string
}

export type SsrApplicationSource = SsrApplicationLoader | SsrApplicationModuleRef

/**
 * One self-contained SPA or SSR application. The object key under
 * `applications` is the canonical application ID everywhere.
 */
export interface SsrApplicationConfig {
  /** Browser SPA shell or server-rendered application. */
  render: SsrRenderMode
  /**
   * Application module. Required for both SPA and SSR so the library can
   * generate client entries from `ssr.config` alone.
   */
  application: SsrApplicationSource
  template: string
  roles?: readonly string[]
  domain: SsrApplicationDomainConfig
  cookies?: SsrApplicationCookiesConfig
  endpoints?: SsrEndpointDefinition<any>[]
  mountSelector?: string
  cacheControl?: string
  responseCache?: SsrResponseCacheStrategy<any>
  /**
   * Opaque public configuration delivered to the selected application.
   * Transport-only — the library does not interpret GraphQL, REST, etc.
   */
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
  onMetrics?: (metrics: SsrRenderMetrics) => void
  renderError?: (
    context: SsrErrorRenderContext
  ) => SsrHttpResponse | null | Promise<SsrHttpResponse | null>
}

/**
 * Flat Vite/Nuxt-style SSR configuration.
 * Everything about an application lives under `applications.<id>`.
 */
export interface SsrConfig {
  name: string
  server?: SsrConfigServerOptions
  /** Active process role (`unified`, `erp`, `storefront`, …). Required in production. */
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
  /** Selected application id (the `applications` object key). */
  entry: string
  hostname: string
  /** Active environment apex for the selected application. */
  baseDomain: string
  /** Remaining labels under `baseDomain`, or null on the apex / custom host. */
  subdomain: string | null
  isCustomDomain: boolean
  development: boolean
  /** Values declared via `domain.params`. */
  params: Record<string, string>
}

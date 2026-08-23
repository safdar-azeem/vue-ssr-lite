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
  development?: string
  /** Apex used in production. Optional when host routing is not required. */
  production?: string
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

/**
 * Low-level programmatic source accepted by server compilation APIs. The
 * consumer-facing `SsrApplicationConfig.app` intentionally accepts only a
 * statically analyzable module path/ref so Vite can generate browser entries.
 */
export type SsrApplicationSource = SsrApplicationLoader | SsrApplicationModuleRef

/**
 * One self-contained SPA or SSR application. The object key under
 * `applications` is the canonical application ID everywhere.
 */
export interface SsrApplicationConfig {
  /** Statically analyzable application module. Defaults to `./src/main.ts`. */
  app?: SsrApplicationModuleRef | string
  /** Browser SPA shell or server-rendered application. Defaults to SSR. */
  render?: SsrRenderMode
  /** Existing Vite HTML entry. Defaults to `./index.html`. */
  template?: string
  roles?: readonly string[]
  /** Simple host pattern(s), primarily for multi-application routing. */
  host?: string | readonly string[]
  domain?: SsrApplicationDomainConfig
  cookies?: SsrApplicationCookiesConfig
  endpoints?: SsrEndpointDefinition<any>[]
  mount?: string
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
 * Optional convention overrides. Single-application options stay flat;
 * `applications.<id>` is introduced only for multi-application projects.
 */
export interface SsrConfigShared {
  name?: string
  server?: SsrConfigServerOptions
  /** Advanced process role (`unified`, `erp`, `storefront`, …). */
  runtime?: string
  /** Used only when no application host pattern matches. */
  defaultApplicationId?: string
  readiness?: SsrReadinessProbe[]
}

/** Flat convention overrides for one application. */
export type SsrSingleApplicationConfig = SsrConfigShared &
  SsrApplicationConfig & {
    applications?: never
  }

/** Multi-application configuration. Single-app fields are intentionally forbidden. */
export type SsrMultiApplicationConfig = SsrConfigShared & {
  applications: Record<string, SsrApplicationConfig>
  app?: never
  application?: never
  render?: never
  template?: never
  host?: never
  domain?: never
  cookies?: never
  endpoints?: never
  mount?: never
  mountSelector?: never
  cacheControl?: never
  responseCache?: never
  publicConfig?: never
}

export type SsrConfig = SsrSingleApplicationConfig | SsrMultiApplicationConfig

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

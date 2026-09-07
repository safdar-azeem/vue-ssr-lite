import type { GlobalServerMiddleware, ServerRoutesDefinition } from './server-routes/SsrServerRouteTypes'
import type { Component } from 'vue'
import type { Router, RouterHistory, RouterScrollBehavior, RouteRecordRaw } from 'vue-router'
import type { ExtensionDefinition } from './core/extensions/ExtensionDefinition'
import type { SitemapProvider } from './extensions/seo/sitemap'
import type {
  SeoSiteDefaults,
  SiteRobotsConfig,
  SiteSeoConfig,
  RobotsConfig,
} from './extensions/seo/types'
import type { AppContext } from './SsrAppContext'
import type { Middleware } from './middleware/SsrMiddlewareTypes'
import type {
  SsrEndpointDefinition,
  SsrErrorRenderContext,
  SsrHttpRequest,
  SsrHttpResponse,
  SsrLogger,
  SsrPublicConfigRequest,
  SsrReadinessProbe,
  SsrRenderMetrics,
  SsrResponseCacheStrategy,
} from './SsrRuntimeTypes'

export type SsrPublicConfigFactory = (
  request: SsrPublicConfigRequest
) => Record<string, unknown> | Promise<Record<string, unknown>>

export type SsrPublicConfigSource = Record<string, unknown> | SsrPublicConfigFactory

/** How an application owns its apex hostname and subdomains. */
export type SsrDomainMode = 'root' | 'subdomains' | 'root-and-subdomains'

export type SsrRenderMode = 'spa' | 'ssr'

/** How a declared domain param is derived from the request host. */
export type SsrDomainParamSource = 'last-subdomain-label' | 'subdomain-or-hostname'

export interface SsrDomainParamDefinition {
  source: SsrDomainParamSource
}

export interface SsrApplicationDomainConfig {
  /** Apex or `*.apex` used while `NODE_ENV !== 'production'`. */
  development?: string
  /** Apex or `*.apex` used in production. Optional when host routing is not required. */
  production?: string
  /** Defaults to `root-and-subdomains`. Ignored when the active domain value is already `*.host`. */
  mode?: SsrDomainMode
  /** Register loopback aliases in development. Defaults to false. */
  localAliases?: boolean
  /** Own unmatched hosts via catch-all `*`. Defaults to false. */
  customDomains?: boolean
  /** Extra exact hostnames owned by this application. */
  additionalHosts?: readonly string[]
  /**
   * Named values exposed on `useDomain().params`.
   * Example: `{ workspace: { source: 'last-subdomain-label' } }`.
   */
  params?: Record<string, SsrDomainParamDefinition>
}

export interface SsrApplicationCookiesConfig {
  allow?: string | readonly string[]
  deny?: readonly string[]
}

/** Optional shell overrides. Paths in `defineApplication()` are relative to that module. */
export interface SsrAppShellConfig {
  /** Initializer module. Defaults to `/src/main.ts`. */
  main?: string
  /** Root Vue component. Defaults to `/src/App.vue`. */
  root?: string
}

export type SsrSiteSeoInput = SeoSiteDefaults | SiteSeoConfig
export type SsrRobotsInput = SiteRobotsConfig | RobotsConfig

/**
 * Explicit SEO configuration for a server or application.
 * There is no automatic `sitemap.config.ts` lookup.
 */
export interface SsrSeoConfig {
  site?: SsrSiteSeoInput
  sitemap?: SitemapProvider
  robots?: SsrRobotsInput
  /** Private applications emit conservative robots and skip public sitemaps. */
  mode?: 'public' | 'private'
  enabled?: boolean
  siteUrl?: string
  allowHttpOrigin?: boolean
  trailingSlash?: boolean
}

/** Awaited before Core installs Vue Router and starts browser navigation. */
export type SsrAppInitializer = (context: AppContext) => void | Promise<void>

export interface SsrMainModule {
  default: SsrAppInitializer
  /** Single-application route graph. Export from `src/main.ts`. */
  routes?: RouteRecordRaw[] | (() => RouteRecordRaw[])
}

/** Advanced request-safe router factory. Core supplies memory or web history. */
export type SsrRouterFactory = (options: {
  history: RouterHistory
  server: boolean
}) => Router

/**
 * Multi-application registration. Identity is `name`, never array index.
 * Applications are always registered explicitly on `defineServer()`.
 */
interface ApplicationConfigBase {
  /** HTTP middleware is global and belongs on defineServer(). */
  serverMiddleware?: never
  name: string
  render?: SsrRenderMode
  /** Existing Vite HTML entry. Defaults to `./index.html` when present. */
  template?: string
  cookies?: SsrApplicationCookiesConfig
  endpoints?: SsrEndpointDefinition<any>[]
  /** Server-only native HTTP routes owned by this application. */
  serverRoutes?: readonly ServerRoutesDefinition[]
  mount?: string
  cacheControl?: string
  responseCache?: SsrResponseCacheStrategy<any>
  publicConfig?: SsrPublicConfigSource
  seo?: SsrSeoConfig
  /** Application-specific shell. Paths resolve relative to the `app.ts` module. */
  app?: SsrAppShellConfig
  /** Explicit application route graph. Single-app routes are exported from `src/main.ts`. */
  routes?: RouteRecordRaw[] | (() => RouteRecordRaw[])
  router?: SsrRouterFactory
  scrollBehavior?: RouterScrollBehavior
  /**
   * Application middleware, executed before entered route middleware.
   * Universal when the application may render on the server; browser-only for
   * an application statically declared with `render: 'spa'`.
   */
  middleware?: readonly Middleware<any>[]
  /** Universal-safe custom runtime extensions. Built-in SEO is auto-attached. */
  extensions?: readonly ExtensionDefinition[]
  cleanup?: import('./SsrRuntimeTypes').SsrApplicationDefinition['cleanup']
  createInitialState?: import('./SsrRuntimeTypes').SsrApplicationDefinition['createInitialState']
}

type SsrApplicationRoutingConfig =
  | {
      /** Simple static host pattern(s). Use `domain` instead for environment-aware routing. */
      host?: string | readonly string[]
      domain?: never
    }
  | {
      host?: never
      /** Environment-aware domain, subdomain, custom-domain, and domain-param routing. */
      domain?: SsrApplicationDomainConfig
    }

/**
 * Public application registration. `host` and `domain` are alternative routing
 * models and cannot be declared together.
 */
export type ApplicationConfig = ApplicationConfigBase & SsrApplicationRoutingConfig

export interface SsrConfigServerOptions {
  root?: string
  host?: string
  port?: number
  trustProxy?: boolean
  clientOutDir?: string
  /** One deadline for the complete application request. Defaults to 15 seconds. */
  requestTimeoutMs?: number
  shutdownTimeoutMs?: number
  /** Maximum actively executing Vue SSR requests per managed server. Defaults to 8. */
  maxConcurrentSsrRequests?: number
  /** Maximum Vue SSR requests waiting for capacity per managed server. Defaults to 32. */
  maxQueuedSsrRequests?: number
  healthPath?: string
  readinessPath?: string
  maxResolutionPasses?: number
  resolutionDeadlineMs?: number
  diagnostics?: boolean
  logger?: SsrLogger
  onMetrics?: (metrics: SsrRenderMetrics) => void | Promise<void>
  renderError?: (
    context: SsrErrorRenderContext
  ) => SsrHttpResponse | null | Promise<SsrHttpResponse | null>
}

export interface SsrConfigShared {
  /** Cross-cutting HTTP middleware wrapping every application-owned response. */
  serverMiddleware?: readonly GlobalServerMiddleware[]
  name?: string
  server?: SsrConfigServerOptions
  readiness?: SsrReadinessProbe[]
  /**
   * Server-only advanced origin override after Core host/domain resolution.
   * Returned values still pass Core's origin and production HTTPS validation.
   */
  resolveSiteUrl?: (
    request: SsrHttpRequest<any>
  ) => string | undefined | Promise<string | undefined>
  /** Global shell override. Paths resolve relative to the project root. */
  app?: SsrAppShellConfig
}

/**
 * Flat convention overrides for one application.
 * Routes belong on `src/main.ts` (`export { routes }`), not `defineServer()`.
 */
type SsrSingleApplicationFields = {
  applications?: never
  render?: SsrRenderMode
  template?: string
  cookies?: SsrApplicationCookiesConfig
  endpoints?: SsrEndpointDefinition<any>[]
  /** Server-only native HTTP routes owned by this application. */
  serverRoutes?: readonly ServerRoutesDefinition[]
  mount?: string
  cacheControl?: string
  responseCache?: SsrResponseCacheStrategy<any>
  publicConfig?: SsrPublicConfigSource
  seo?: SsrSeoConfig
  router?: SsrRouterFactory
  scrollBehavior?: RouterScrollBehavior
  middleware?: readonly Middleware<any>[]
  extensions?: readonly ExtensionDefinition[]
  cleanup?: import('./SsrRuntimeTypes').SsrApplicationDefinition['cleanup']
  createInitialState?: import('./SsrRuntimeTypes').SsrApplicationDefinition['createInitialState']
}

export type SsrSingleApplicationConfig = SsrConfigShared &
  SsrSingleApplicationFields &
  SsrApplicationRoutingConfig

/** Multi-application configuration. Per-app fields belong on `defineApplication()`. */
export type SsrMultiApplicationConfig = SsrConfigShared & {
  applications: readonly ApplicationConfig[]
  render?: never
  template?: never
  host?: never
  domain?: never
  cookies?: never
  endpoints?: never
  serverRoutes?: never
  mount?: never
  cacheControl?: never
  responseCache?: never
  publicConfig?: never
  seo?: never
  router?: never
  scrollBehavior?: never
  middleware?: never
  extensions?: never
}

export type ServerConfig = SsrSingleApplicationConfig | SsrMultiApplicationConfig
/** @internal Normalized alias used by the compile/runtime pipeline. */
export type SsrConfig = ServerConfig

/** @internal Configuration-module export shape used only by the compiler. */
export type SsrConfigExport = SsrConfig | (() => SsrConfig | Promise<SsrConfig>)

/** Serializable domain snapshot attached to every request and hydration state. */
export interface SsrDomainContext {
  /** Selected application id (`defineApplication({ name })` or the single-app default). */
  entry: string
  /** Normalized request authority, including the active port when present. */
  authority: string
  /** Protocol resolved by the managed server (including trusted proxy policy). */
  protocol: 'http' | 'https'
  /** Active request port, or an empty string for the protocol default. */
  port: string
  /** Hostname-only value used for domain and host matching. */
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

/** Internal compile-time shell graph for one application. */
export interface SsrResolvedAppShell {
  main: string
  root: string
  /** Set when routes are owned by `defineApplication()`, not `main.ts`. */
  routesModule?: string
  /** Export used by `defineApplication({ routes })`: `default`, `routes`, or another name. */
  routesExport?: string
  /** Directory of the application module, when registered from a file. */
  applicationDir?: string
  /** Absolute path of the `defineApplication()` module, when registered from a file. */
  applicationFile?: string
}

/** Runtime Vue shell bound by the generated server module. */
export interface SsrBoundAppShell {
  root: Component
  main: SsrMainModule
}

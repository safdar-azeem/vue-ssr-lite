import type { ExtensionDefinition } from './core/extensions/ExtensionDefinition'
import type { SeoApplicationConfig } from './extensions/seo/types'
import type { SeoProviderMeta, SeoSiteDefaults } from './extensions/seo/types'
import type { App, Component, Plugin } from 'vue'
import type { Router, RouterHistory, RouteRecordRaw, RouterScrollBehavior } from 'vue-router'
import type { SsrHydrationContext, SsrHydrationController } from './SsrHydrationRuntime'
import type { SsrRequestResolution, SsrResolutionController } from './SsrRequestResolution'

export type SsrHeaderValue = string | readonly string[] | undefined
/** Immutable transport facts captured at the request boundary. */
export type SsrHeaders = Readonly<Record<string, SsrHeaderValue>>

export type SsrPublicConfigHeaderValue =
  | string
  | readonly string[]
  | undefined
export type SsrPublicConfigHeaders = Readonly<
  Record<string, SsrPublicConfigHeaderValue>
>
export type SsrPublicConfigDomain = Readonly<
  Omit<import('./SsrConfigTypes').SsrDomainContext, 'params'> & {
    params: Readonly<Record<string, string>>
  }
>

/**
 * Server-only request facts available while resolving browser-visible public
 * configuration. Routing, proxy trust, application selection, and domain
 * resolution have already completed. `publicConfig` is intentionally absent.
 */
export interface SsrPublicConfigRequest {
  readonly requestId: string
  readonly url: string
  readonly host: string
  readonly protocol: 'http' | 'https'
  readonly method: string
  readonly headers: SsrPublicConfigHeaders
  /** Cookie header after the selected application's allow/deny filtering. */
  readonly cookie?: string
  readonly signal: AbortSignal
  readonly domain: SsrPublicConfigDomain
  readonly pathname: string
  readonly search: string
  readonly entryId: string
}

export interface SsrResponseState {
  statusCode: number
  headers: Record<string, string>
  redirect?: {
    location: string
    statusCode?: 301 | 302 | 303 | 307 | 308
    allowExternal?: boolean
  } | null
}

export interface SsrRenderMetrics {
  requestId: string
  applicationId: string
  contextDurationMs: number
  routeDurationMs: number
  renderDurationMs: number
  totalDurationMs: number
  htmlBytes: number
  stateBytes: number
  /** Number of render passes the resolution contract required. Usually 1. */
  renderPasses: number
}

export interface SsrRenderRequest<TPublicConfig = unknown> {
  requestId: string
  url: string
  host: string
  protocol: 'http' | 'https'
  method: string
  headers: SsrHeaders
  cookie?: string
  publicConfig: TPublicConfig
  signal: AbortSignal
  /** Library-resolved domain context for the selected application. */
  domain: import('./SsrConfigTypes').SsrDomainContext
  /** Authoritative public origin for this request, when already resolved. */
  siteOrigin?: string
  /** Internal/public hydration-safe request-resolved site SEO snapshot. */
  siteSeo?: SeoSiteDefaults
  /** Server-only provider hints; never serialized into hydration state. */
  siteSeoMeta?: SeoProviderMeta
}

export interface SsrHydrationState<TApplicationState = unknown, TPublicConfig = unknown> {
  version: 1
  applicationId: string
  publicConfig: TPublicConfig
  domain: import('./SsrConfigTypes').SsrDomainContext
  application: TApplicationState
  /** Authoritative public origin resolved during SSR. */
  siteOrigin?: string
  /** Validated public site defaults resolved on the server. */
  siteSeo?: SeoSiteDefaults
  /**
   * Serializable state contributed by installed application plugins, keyed by
   * an opaque plugin identifier. `vue-ssr-lite` never inspects the values.
   */
  plugins?: Record<string, unknown>
}

export interface SsrRequestContext<
  TApplicationState = Record<string, unknown>,
  TPublicConfig = unknown,
> {
  /** Stable identity of the application selected for this request. */
  applicationId: string
  request: SsrRenderRequest<TPublicConfig>
  url: URL
  host: string
  /** Library-resolved domain context (also available via `useSsrDomain()`). */
  domain: import('./SsrConfigTypes').SsrDomainContext
  publicConfig: TPublicConfig
  /** Authoritative public origin for canonical URLs and structured data. */
  siteOrigin: string
  state: TApplicationState
  response: SsrResponseState
  /** Generic hydration state contract for installed application plugins. */
  hydration: SsrHydrationContext
  /**
   * Generic server-render resolution contract. Installed plugins register
   * in-flight work so the renderer can await it, and explicitly request a new
   * pass when resolution changes the tree. Present in every mode; a no-op
   * outside the server render.
   */
  resolution: SsrRequestResolution
}

export interface SsrApplicationSetup<TApplicationState, TPublicConfig> {
  app: App
  router: Router | null
  context: SsrRequestContext<TApplicationState, TPublicConfig>
  /** Generic hydration state contract for installed application plugins. */
  hydration: SsrHydrationContext
  /** Generic server-render resolution contract for installed plugins. */
  resolution: SsrRequestResolution
  server: boolean
}

export interface SsrApplicationDefinition<
  TApplicationState = Record<string, unknown>,
  TPublicConfig = unknown,
> {
  /** Optional identity used by tests and compile-time resolution. */
  id?: string
  /** The universal root component used for both SSR and browser execution. */
  root: Component
  routes?: RouteRecordRaw[] | (() => RouteRecordRaw[])
  /**
   * Advanced request-safe router factory. vue-ssr-lite supplies memory history
   * on the server and web history in the browser.
   */
  router?: (options: { history: RouterHistory; server: boolean }) => Router
  /**
   * Optional router scroll behaviour. When omitted, a sensible default is used
   * (restore saved position, scroll to hash, otherwise top). Provide one to keep
   * an application's existing behaviour exactly when adopting the definition.
   */
  scrollBehavior?: RouterScrollBehavior
  /** Application default render mode. Route `meta.render` may override it. */
  defaultRender?: import('./SsrConfigTypes').SsrRenderMode
  /**
   * Vue plugins installed for every isolated server/browser app. Prefer a
   * factory for stateful plugins so concurrent SSR requests never share state.
   * A static list is suitable only for stateless/global-safe plugins.
   */
  plugins?: readonly Plugin[] | (() => readonly Plugin[])
  /** Declarative built-in SEO configuration. Omitted means SEO is enabled. */
  seo?: SeoApplicationConfig
  /**
   * Universal-safe custom runtime extensions. Built-in SEO is auto-attached
   * and must not be registered here.
   */
  extensions?: readonly ExtensionDefinition[]
  createInitialState?: () => TApplicationState
  install?: (setup: SsrApplicationSetup<TApplicationState, TPublicConfig>) => void | Promise<void>
  cleanup?: (context: SsrRequestContext<TApplicationState, TPublicConfig>) => void | Promise<void>
}

/** Internal application definition after configuration assigns its identity. */
export type SsrResolvedApplicationDefinition<
  TApplicationState = Record<string, unknown>,
  TPublicConfig = unknown,
> = SsrApplicationDefinition<TApplicationState, TPublicConfig> & { id: string }

export interface SsrCreatedApplication<
  TApplicationState = Record<string, unknown>,
  TPublicConfig = unknown,
> {
  app: App
  router: Router | null
  context: SsrRequestContext<TApplicationState, TPublicConfig>
  /** Per-request hydration controller owning plugin state and disposal. */
  hydration: SsrHydrationController
  /** Per-request resolution controller, shared across render passes. */
  resolution: SsrResolutionController
  /** Core managed-head collector for this application instance. */
  managedHead: import('./SsrManagedHead').ManagedHeadController
}

export interface SsrRenderResult<TApplicationState = unknown, TPublicConfig = unknown> {
  html: string
  /** Vue-native target-to-markup Teleport result. */
  teleports: Record<string, string>
  /** Module ids reported by Vue for the final accepted SSR render pass. */
  renderedModules: readonly string[]
  head: import('./SsrManagedHead').ManagedHeadSnapshot
  response: SsrResponseState
  hydrationState: SsrHydrationState<TApplicationState, TPublicConfig>
  metrics: SsrRenderMetrics
}

export type SsrEntryKind = 'ssr' | 'spa'

export interface SsrHttpRequest<TPublicConfig = unknown> extends SsrRenderRequest<TPublicConfig> {
  pathname: string
  search: string
  entryId: string
}

export interface SsrHttpResponse {
  statusCode: number
  body?: string | Uint8Array
  /** Header values retain multiplicity for fields such as Set-Cookie. */
  headers?: Record<string, string | string[]>
}

export interface SsrResponseCacheWriteOptions {
  ttlMs: number
  tags?: readonly string[]
  /** Aborts when the request producing this write is no longer active. */
  signal?: AbortSignal
}

export interface SsrResponseCacheReadOptions {
  /** Aborts when the request performing this read is no longer active. */
  signal?: AbortSignal
}

export interface SsrResponseCacheInvalidation {
  keys?: readonly string[]
  tags?: readonly string[]
}

export interface SsrResponseCache {
  get: (
    key: string,
    options?: SsrResponseCacheReadOptions
  ) => SsrHttpResponse | null | Promise<SsrHttpResponse | null>
  set: (
    key: string,
    response: SsrHttpResponse,
    options: SsrResponseCacheWriteOptions
  ) => void | Promise<void>
  invalidate: (selector?: SsrResponseCacheInvalidation) => number | Promise<number>
}

export interface SsrResponseCacheStrategy<TPublicConfig = unknown> {
  store: SsrResponseCache
  ttlMs: number
  /**
   * Adds publication/data version, locale, or another public discriminator to
   * the package-owned application + host + route key. Returning null bypasses
   * the cache. Requests with non-empty Cookie, Authorization, or
   * Proxy-Authorization headers are always bypassed.
   */
  vary?: (request: SsrHttpRequest<TPublicConfig>) => string | null | Promise<string | null>
  tags?: (request: SsrHttpRequest<TPublicConfig>) => readonly string[] | Promise<readonly string[]>
  shouldCache?: (response: SsrHttpResponse, request: SsrHttpRequest<TPublicConfig>) => boolean
}

export interface SsrEndpointDefinition<TPublicConfig = unknown> {
  id: string
  /**
   * Exact request paths owned by this endpoint. Core uses this declaration for
   * deterministic compile-time collision avoidance and never executes `match`
   * outside the request lifecycle.
   */
  ownedPaths?: readonly string[]
  match: (request: SsrHttpRequest<TPublicConfig>) => boolean
  handle: (
    request: SsrHttpRequest<TPublicConfig>,
    tools: SsrEndpointTools
  ) => SsrHttpResponse | null | Promise<SsrHttpResponse | null>
}

export interface SsrEndpointTools {
  /** Aborts when the owning request is cancelled. */
  readonly signal: AbortSignal
  /** Structured runtime logger, when the server was configured with one. */
  readonly logger?: SsrLogger
}

export interface SsrReadinessProbe {
  id: string
  run: () => void | Promise<void>
}

export interface SsrLogger {
  debug?: (event: string, details?: Record<string, unknown>) => void | Promise<void>
  info?: (event: string, details?: Record<string, unknown>) => void | Promise<void>
  warn?: (event: string, details?: Record<string, unknown>) => void | Promise<void>
  error?: (event: string, details?: Record<string, unknown>) => void | Promise<void>
}

export interface SsrErrorRenderContext<TPublicConfig = unknown> {
  error: unknown
  kind: 'timeout' | 'internal'
  production: boolean
  request?: SsrHttpRequest<TPublicConfig>
  entryId?: string
}

export interface SsrServerOptions<TPublicConfig = unknown> {
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
  cookieAllowlist?: string[]
  cookieDenylist?: string[]
  publicConfig?: TPublicConfig
  healthPath?: string
  readinessPath?: string
  /**
   * Maximum server render passes per request. The first pass always runs; extra
   * passes only occur when an installed plugin explicitly asks for another pass
   * through the resolution contract. Tracked work is awaited but does not by
   * itself invalidate rendered HTML. A fully resolvable page completes in one
   * pass. Defaults to 4. Clamped to at least 1.
   */
  maxResolutionPasses?: number
  /**
   * Upper bound, in milliseconds, for awaiting registered resolution work after
   * a render pass. Independent of — and additionally capped by — the overall
   * `requestTimeoutMs` and the request abort signal. Defaults to
   * `requestTimeoutMs` when unset.
   */
  resolutionDeadlineMs?: number
  /**
   * Enables development-only render diagnostics (loading-placeholder detection,
   * empty-route detection, discarded-watcher hints). Defaults to
   * `NODE_ENV !== 'production'` when unset. Always inert in production.
   */
  diagnostics?: boolean
  logger?: SsrLogger
  onMetrics?: (metrics: SsrRenderMetrics) => void | Promise<void>
  renderError?: (
    context: SsrErrorRenderContext<TPublicConfig>
  ) => SsrHttpResponse | null | Promise<SsrHttpResponse | null>
}

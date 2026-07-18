import type { App, Component, Plugin } from 'vue'
import type { Router, RouteRecordRaw } from 'vue-router'
import type {
  SsrHydrationContext,
  SsrHydrationController,
} from './SsrHydrationRuntime'

export type SsrHeaderValue = string | string[] | undefined
export type SsrHeaders = Record<string, SsrHeaderValue>

export interface SsrHeadPayload {
  title?: string | null
  description?: string | null
  keywords?: string | readonly string[] | null
  robots?: string | null
  canonicalUrl?: string | null
  favicon?: string | null
  ogTitle?: string | null
  ogDescription?: string | null
  ogImage?: string | null
  ogImageAlt?: string | null
  ogUrl?: string | null
  ogType?: string | null
  ogSiteName?: string | null
  ogLocale?: string | null
  twitterCard?: string | null
  twitterTitle?: string | null
  twitterDescription?: string | null
  twitterImage?: string | null
  twitterImageAlt?: string | null
  twitterSite?: string | null
  twitterCreator?: string | null
  jsonLd?: readonly unknown[] | null
  htmlAttributes?: Record<string, string | null | undefined>
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
}

export interface SsrHydrationState<TApplicationState = unknown, TPublicConfig = unknown> {
  version: 1
  applicationId: string
  publicConfig: TPublicConfig
  application: TApplicationState
  /**
   * Serializable state contributed by installed application plugins, keyed by
   * an opaque plugin identifier. `vue-ssr-lite` never inspects the values.
   */
  plugins?: Record<string, unknown>
}

export interface SsrRequestContext<
  TApplicationState = Record<string, unknown>,
  TPublicConfig = unknown,
  TExtension = unknown,
> {
  /** Stable identity of the application selected for this request. */
  applicationId: string
  request: SsrRenderRequest<TPublicConfig>
  url: URL
  host: string
  publicConfig: TPublicConfig
  state: TApplicationState
  head: { value: SsrHeadPayload | null }
  response: SsrResponseState
  /** Generic hydration state contract for installed application plugins. */
  hydration: SsrHydrationContext
  extension: TExtension
}

export interface SsrApplicationSetup<
  TApplicationState,
  TPublicConfig,
  TExtension,
> {
  app: App
  router: Router | null
  context: SsrRequestContext<TApplicationState, TPublicConfig, TExtension>
  /** Generic hydration state contract for installed application plugins. */
  hydration: SsrHydrationContext
  server: boolean
}

export interface SsrApplicationDefinition<
  TApplicationState = Record<string, unknown>,
  TPublicConfig = unknown,
  TExtension = unknown,
> {
  id: string
  rootComponent: Component
  mountSelector?: string
  routes?: RouteRecordRaw[] | (() => RouteRecordRaw[])
  /** Generic Vue plugins installed for every isolated server/browser app. */
  plugins?: readonly Plugin[]
  createInitialState?: () => TApplicationState
  createExtension?: (
    context: Omit<
      SsrRequestContext<TApplicationState, TPublicConfig, TExtension>,
      'extension'
    >
  ) => TExtension | Promise<TExtension>
  install?: (
    setup: SsrApplicationSetup<TApplicationState, TPublicConfig, TExtension>
  ) => void | Promise<void>
  resolveHead?: (
    context: SsrRequestContext<TApplicationState, TPublicConfig, TExtension>
  ) => SsrHeadPayload | null | Promise<SsrHeadPayload | null>
  cleanup?: (
    context: SsrRequestContext<TApplicationState, TPublicConfig, TExtension>
  ) => void | Promise<void>
}

export interface SsrCreatedApplication<
  TApplicationState = Record<string, unknown>,
  TPublicConfig = unknown,
  TExtension = unknown,
> {
  app: App
  router: Router | null
  context: SsrRequestContext<TApplicationState, TPublicConfig, TExtension>
  /** Per-request hydration controller owning plugin state and disposal. */
  hydration: SsrHydrationController
}

export interface SsrRenderResult<
  TApplicationState = unknown,
  TPublicConfig = unknown,
> {
  html: string
  teleports: string
  head: SsrHeadPayload | null
  response: SsrResponseState
  hydrationState: SsrHydrationState<TApplicationState, TPublicConfig>
  metrics: SsrRenderMetrics
}

export type SsrEntryKind = 'ssr' | 'spa'

export interface SsrRuntimeEntry {
  id: string
  kind: SsrEntryKind
  template: string
  hosts: string[]
  roles?: string[]
  application?: SsrApplicationDefinition<any, any, any>
  mountSelector?: string
  cacheControl?: string
  responseCache?: SsrResponseCacheStrategy<any>
}

export interface SsrHttpRequest<TPublicConfig = unknown>
  extends SsrRenderRequest<TPublicConfig> {
  pathname: string
  search: string
  entryId: string
}

export interface SsrHttpResponse {
  statusCode: number
  body?: string | Uint8Array
  headers?: Record<string, string>
}

export interface SsrResponseCacheWriteOptions {
  ttlMs: number
  tags?: readonly string[]
}

export interface SsrResponseCacheInvalidation {
  keys?: readonly string[]
  tags?: readonly string[]
}

export interface SsrResponseCache {
  get: (
    key: string
  ) => SsrHttpResponse | null | Promise<SsrHttpResponse | null>
  set: (
    key: string,
    response: SsrHttpResponse,
    options: SsrResponseCacheWriteOptions
  ) => void | Promise<void>
  invalidate: (
    selector?: SsrResponseCacheInvalidation
  ) => number | Promise<number>
}

export interface SsrResponseCacheStrategy<TPublicConfig = unknown> {
  store: SsrResponseCache
  ttlMs: number
  /**
   * Adds publication/data version, locale, or another public discriminator to
   * the package-owned application + host + route key. Returning null bypasses
   * the cache. Requests with forwarded cookies are always bypassed.
   */
  vary?: (
    request: SsrHttpRequest<TPublicConfig>
  ) => string | null | Promise<string | null>
  tags?: (
    request: SsrHttpRequest<TPublicConfig>
  ) => readonly string[] | Promise<readonly string[]>
  shouldCache?: (
    response: SsrHttpResponse,
    request: SsrHttpRequest<TPublicConfig>
  ) => boolean
}

export interface SsrEndpointDefinition<TPublicConfig = unknown> {
  id: string
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
  debug?: (event: string, details?: Record<string, unknown>) => void
  info?: (event: string, details?: Record<string, unknown>) => void
  warn?: (event: string, details?: Record<string, unknown>) => void
  error?: (event: string, details?: Record<string, unknown>) => void
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
  role?: string
  trustProxy?: boolean
  clientOutDir?: string
  requestTimeoutMs?: number
  shutdownTimeoutMs?: number
  cookieAllowlist?: string[]
  cookieDenylist?: string[]
  publicConfig: TPublicConfig
  healthPath?: string
  readinessPath?: string
  logger?: SsrLogger
  onMetrics?: (metrics: SsrRenderMetrics) => void
  renderError?: (
    context: SsrErrorRenderContext<TPublicConfig>
  ) => SsrHttpResponse | null | Promise<SsrHttpResponse | null>
}

export interface SsrRuntimeDefinition<TPublicConfig = unknown> {
  name: string
  entries: SsrRuntimeEntry[]
  defaultEntryId?: string
  server: SsrServerOptions<TPublicConfig>
  endpoints?: SsrEndpointDefinition<TPublicConfig>[]
  readiness?: SsrReadinessProbe[]
}

export type SsrRuntimeDefinitionExport<TPublicConfig = unknown> =
  | SsrRuntimeDefinition<TPublicConfig>
  | (() => SsrRuntimeDefinition<TPublicConfig> | Promise<SsrRuntimeDefinition<TPublicConfig>>)

import type {
  SsrLogger,
  SsrRenderMetrics,
} from '../../diagnostics/SsrDiagnosticsTypes'
import type { SsrRenderRequest } from '../../request/SsrRequestTypes'

export type SsrEntryKind = 'ssr' | 'spa'

export interface SsrHttpRequest<TPublicConfig = unknown> extends SsrRenderRequest<TPublicConfig> {
  pathname: string
  search: string
  entryId: string
}

export interface SsrHttpResponse {
  /** Legacy Node transport accepts 100–599; informational responses have no native Web equivalent. */
  statusCode: number
  body?: string | Uint8Array
  /** Header values retain multiplicity for fields such as Set-Cookie. */
  headers?: Record<string, string | string[]>
}

/** Context supplied to the server-owned `renderError` response hook. */
export interface SsrErrorRenderContext<TPublicConfig = unknown> {
  error: unknown
  /** Framework-generated correlation id for this handled failure. */
  errorId?: string
  kind: 'timeout' | 'internal'
  production: boolean
  request?: SsrHttpRequest<TPublicConfig>
  entryId?: string
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

/** Legacy/SEO compatibility. New application HTTP APIs use defineServerRoutes(). */
export interface SsrEndpointDefinition<TPublicConfig = unknown> {
  id: string
  /**
   * Exact request paths owned by this endpoint. Core uses this declaration for
   * deterministic compile-time collision avoidance and never executes `match`
   * outside the request lifecycle.
   */
  ownedPaths?: readonly string[]
  match: (request: SsrHttpRequest<TPublicConfig>) => boolean
  /** Returning null continues through later endpoints, assets and Vue rendering. */
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
  /** Maximum server render passes per request. Defaults to 4. Clamped to at least 1. */
  maxResolutionPasses?: number
  /** Upper bound for registered resolution work after a render pass. */
  resolutionDeadlineMs?: number
  /** Enables development-only render diagnostics. */
  diagnostics?: boolean
  /**
   * Opt-in per-request phase timings, in any mode. Off by default. When true and
   * `logger.debug` exists, each application request emits one bounded
   * `ssr.diagnostic.timing` event with fixed phase names and durations only: no
   * URL, header, cookie, body or tenant data. Unlike `diagnostics`, it does not
   * run the render diagnostics that scan the HTML.
   */
  phaseTimings?: boolean
  logger?: SsrLogger
  onMetrics?: (metrics: SsrRenderMetrics) => void | Promise<void>
  renderError?: (
    context: SsrErrorRenderContext<TPublicConfig>
  ) => SsrHttpResponse | null | Promise<SsrHttpResponse | null>
}

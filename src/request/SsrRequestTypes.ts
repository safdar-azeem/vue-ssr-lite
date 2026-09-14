import type { SeoProviderMeta, SeoSiteDefaults } from '../extensions/seo/types'
import type { SsrHydrationContext } from '../hydration/SsrHydrationRuntime'
import type { SsrRequestResolution } from './SsrRequestResolution'

export type SsrHeaderValue = string | readonly string[] | undefined
/** Immutable transport facts captured at the request boundary. */
export type SsrHeaders = Readonly<Record<string, SsrHeaderValue>>

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

export type SsrPublicConfigHeaderValue = string | readonly string[] | undefined
export type SsrPublicConfigHeaders = Readonly<Record<string, SsrPublicConfigHeaderValue>>
export type SsrPublicConfigDomain = Readonly<
  Omit<SsrDomainContext, 'params'> & { params: Readonly<Record<string, string>> }
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
  /** Header values retain multiplicity for fields such as Set-Cookie. */
  headers: Record<string, string | string[]>
  redirect?: {
    location: string
    statusCode?: 301 | 302 | 303 | 307 | 308
    allowExternal?: boolean
  } | null
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
  domain: SsrDomainContext
  /** Authoritative public origin for this request, when already resolved. */
  siteOrigin?: string
  /** Internal/public hydration-safe request-resolved site SEO snapshot. */
  siteSeo?: SeoSiteDefaults
  /** Server-only provider hints; never serialized into hydration state. */
  siteSeoMeta?: SeoProviderMeta
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
  /** Library-resolved domain context (also available via `useDomain()`). */
  domain: SsrDomainContext
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

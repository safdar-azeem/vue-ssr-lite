import type { ComputedRef, Ref } from 'vue'
import type { SsrDomainContext } from '../../SsrConfigTypes'
import type { ManagedHeadLinkEntry, ManagedHeadMetaEntry } from '../../SsrManagedHead'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }
export type SeoResolvable<T> = T | Ref<T> | ComputedRef<T> | (() => T)
export type SeoMetaEntry = ManagedHeadMetaEntry
export type SeoLinkEntry = ManagedHeadLinkEntry

export interface SeoImageInput {
  key?: string
  url: string
  secureUrl?: string
  type?: string
  width?: number
  height?: number
  alt?: string
}

export interface SeoMediaInput {
  key?: string
  url: string
  secureUrl?: string
  type?: string
  width?: number
  height?: number
}

export type SeoImageValue = string | SeoImageInput | readonly (string | SeoImageInput)[]
export type SeoMediaValue = string | SeoMediaInput | readonly (string | SeoMediaInput)[]

export interface SeoOpenGraphInput {
  type?: string
  title?: string
  description?: string
  url?: string
  siteName?: string
  locale?: string
  localeAlternate?: readonly string[]
  determiner?: 'a' | 'an' | 'the' | '' | 'auto'
  image?: SeoImageValue
  audio?: SeoMediaValue
  video?: SeoMediaValue
}

export type SeoOpenGraphDefaults = Omit<SeoOpenGraphInput, 'url'>

export interface SeoTwitterInput {
  card?: 'summary' | 'summary_large_image' | 'app' | 'player'
  site?: string
  creator?: string
  title?: string
  description?: string
  image?: string | SeoImageInput
}

export interface SeoRobotsInput {
  nosnippet?: boolean
  noimageindex?: boolean
  maxSnippet?: number
  maxImagePreview?: 'none' | 'standard' | 'large'
  maxVideoPreview?: number
  notranslate?: boolean
  indexifembedded?: boolean
  unavailableAfter?: string | Date
  noarchive?: boolean
  additional?: Record<string, string | number | boolean>
}

export interface SeoPageInput {
  title?: string | null
  description?: string | null
  image?: string | null
  canonical?: string | false | null
  index?: boolean
  follow?: boolean
  status?: number
  openGraph?: SeoOpenGraphInput | null
  twitter?: SeoTwitterInput | null
  robots?: SeoRobotsInput | null
  alternates?: { languages?: Record<string, string | null> } | null
  structuredData?: JsonObject | readonly JsonObject[] | null
  structuredDataMode?: 'merge' | 'replace'
  meta?: readonly SeoMetaEntry[] | null
  links?: readonly SeoLinkEntry[] | null
  htmlAttributes?: { lang?: string | null; dir?: 'ltr' | 'rtl' | 'auto' | null }
}

export interface SeoApplicationConfig {
  enabled?: boolean
  title?: string | null
  siteName?: string | null
  titleTemplate?: string | null
  description?: string | null
  image?: string | null
  index?: boolean
  follow?: boolean
  openGraph?: SeoOpenGraphDefaults | null
  twitter?: SeoTwitterInput | null
  robots?: SeoRobotsInput | null
  structuredData?: JsonObject | readonly JsonObject[] | null
  structuredDataMode?: 'merge' | 'replace'
  meta?: readonly SeoMetaEntry[] | null
  links?: readonly SeoLinkEntry[] | null
  htmlAttributes?: SeoPageInput['htmlAttributes']
  siteUrl?: string
  trailingSlash?: boolean
  mode?: 'public' | 'private'
  allowHttpOrigin?: boolean
  robotsTxt?: RobotsConfig
  canonical?: never
  status?: never
  sitemap?: never
  alternates?: never
}

export interface SeoSiteDefaults {
  title?: string | null
  siteName?: string | null
  titleTemplate?: string | null
  description?: string | null
  image?: string | null
  index?: boolean
  follow?: boolean
  openGraph?: SeoOpenGraphDefaults | null
  twitter?: SeoTwitterInput | null
  robots?: SeoRobotsInput | null
  structuredData?: JsonObject | readonly JsonObject[] | null
  structuredDataMode?: 'merge' | 'replace'
  meta?: readonly SeoMetaEntry[] | null
  links?: readonly SeoLinkEntry[] | null
  htmlAttributes?: SeoPageInput['htmlAttributes']
  alternates?: never
}

export interface SeoRouteInput extends SeoPageInput {
  sitemap?: boolean
}

export interface SeoServerContext {
  applicationId: string
  siteOrigin: string
  domain: Readonly<SsrDomainContext>
  signal: AbortSignal
}
export type SiteSeoContext = SeoServerContext

export interface SeoEndpointContext extends SeoServerContext {
  pathname: string
  search: string
}
export type SiteRobotsContext = SeoEndpointContext

export interface SeoProviderMeta {
  revision?: string | number
  cacheTags?: readonly string[]
}
export interface SeoEndpointResultMeta extends SeoProviderMeta {
  lastModified?: string | Date
  cacheControl?: string
}

export type SiteSeoResolution =
  | ({ status: 'resolved'; defaults: SeoSiteDefaults } & SeoProviderMeta)
  | { status: 'not-found'; responseStatus?: 404 | 421 }
export type SiteSeoResolver = (
  context: SiteSeoContext
) => SiteSeoResolution | Promise<SiteSeoResolution>
export interface SiteSeoConfig { resolve: SiteSeoResolver }

export interface RobotsGroup {
  userAgents: string | readonly string[]
  allow?: readonly string[]
  disallow?: readonly string[]
  directives?: Record<string, string | number | boolean>
}
interface RobotsSimpleConfig {
  groups?: never
  allow?: string | readonly string[]
  disallow?: string | readonly string[]
  sitemaps?: readonly string[]
}
interface RobotsGroupedConfig {
  groups: readonly RobotsGroup[]
  sitemaps?: readonly string[]
  allow?: never
  disallow?: never
}
export type RobotsConfig = RobotsSimpleConfig | RobotsGroupedConfig

export type SiteRobotsResolution =
  | ({ status: 'resolved'; config: RobotsConfig } & SeoEndpointResultMeta)
  | { status: 'not-found'; responseStatus?: 404 | 421 }
export type SiteRobotsResolver = (
  context: SiteRobotsContext
) => SiteRobotsResolution | Promise<SiteRobotsResolution>
export interface SiteRobotsConfig { resolve: SiteRobotsResolver }

export type UseSeoInput = {
  [K in keyof SeoPageInput]?: SeoResolvable<SeoPageInput[K]>
}
export type UseSeoSource =
  | UseSeoInput
  | SeoResolvable<SeoPageInput | null | undefined>

declare module 'vue-router' {
  interface RouteMeta {
    seo?: SeoRouteInput
    /** Route-level render mode. Children inherit unless they override. */
    render?: 'ssr' | 'spa'
  }
}

export const isSeoEnabled = (config: SeoApplicationConfig | undefined): boolean =>
  config?.enabled !== false
export const isPrivateSeoMode = (config: SeoApplicationConfig | undefined): boolean =>
  config?.mode === 'private'

import type { ComputedRef, Ref } from 'vue'
import type {
  ManagedHeadLinkEntry,
  ManagedHeadMetaEntry,
} from '../../SsrManagedHead'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type SeoResolvable<T> = T | Ref<T> | ComputedRef<T> | (() => T)

export type SeoMetaEntry = ManagedHeadMetaEntry
export type SeoLinkEntry = ManagedHeadLinkEntry

/** Core plain serializable SEO data contract. */
export interface SeoInput {
  title?: string
  description?: string
  image?: string
  canonical?: string | false
  index?: boolean
  follow?: boolean
  openGraph?: {
    type?: string
    title?: string
    description?: string
    image?: string
    url?: string
  }
  twitter?: {
    card?: string
    title?: string
    description?: string
    image?: string
  }
  robots?: {
    maxSnippet?: number
    maxImagePreview?: 'none' | 'standard' | 'large'
    noarchive?: boolean
    nosnippet?: boolean
  }
  structuredData?: JsonObject | JsonObject[]
  meta?: SeoMetaEntry[]
  links?: SeoLinkEntry[]
}

/** Composable input schema supporting Vue reactivity. */
export interface UseSeoInput {
  title?: SeoResolvable<string | undefined>
  description?: SeoResolvable<string | undefined>
  image?: SeoResolvable<string | undefined>
  canonical?: SeoResolvable<string | false | undefined>
  index?: SeoResolvable<boolean | undefined>
  follow?: SeoResolvable<boolean | undefined>
  openGraph?: SeoResolvable<SeoInput['openGraph']>
  twitter?: SeoResolvable<SeoInput['twitter']>
  robots?: SeoResolvable<SeoInput['robots']>
  structuredData?: SeoResolvable<JsonObject | JsonObject[] | undefined>
  meta?: SeoResolvable<SeoMetaEntry[] | undefined>
  links?: SeoResolvable<SeoLinkEntry[] | undefined>
}

/** Route-level metadata schema. */
export interface SeoRouteInput extends SeoInput {
  sitemap?: boolean
  status?: number
}

/** Global application configuration schema. */
export interface SeoApplicationConfig extends SeoInput {
  enabled?: boolean
  siteName?: string
  titleTemplate?: string
  siteUrl?: string
  trailingSlash?: boolean
  mode?: 'public' | 'private'
  /**
   * Allow `http://` public production origins. Default is https-only.
   * Use only for intentional local or unusual production environments.
   */
  allowHttpOrigin?: boolean
  robotsTxt?: {
    disallow?: string[]
    allow?: string[]
  }
}

declare module 'vue-router' {
  interface RouteMeta {
    seo?: SeoRouteInput
  }
}

export const isSeoEnabled = (
  config: SeoApplicationConfig | undefined
): boolean => config?.enabled !== false

export const isPrivateSeoMode = (
  config: SeoApplicationConfig | undefined
): boolean => config?.mode === 'private'

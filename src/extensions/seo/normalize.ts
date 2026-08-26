import { composeCanonicalUrl, normalizeCanonicalPath, normalizeSiteOrigin } from '../../SsrCanonicalOrigin'
import { isErrorResponseStatus, validateResponseStatus } from '../../SsrResponseStatus'
import type {
  JsonObject,
  SeoApplicationConfig,
  SeoImageInput,
  SeoLinkEntry,
  SeoMediaInput,
  SeoMetaEntry,
  SeoOpenGraphInput,
  SeoPageInput,
  SeoRobotsInput,
  SeoSiteDefaults,
} from './types'
import type { SeoResolvedInput } from './state'
import { isPrivateSeoMode } from './types'
import { normalizeRobotsConfig } from './robots'

const CONTROL = /[\u0000-\u001f\u007f]/
const MAX_TEXT = 32_768
const ROBOTS_NAME = /^[A-Za-z][A-Za-z0-9-]*$/
const RESERVED_ROBOTS = new Set([
  'index', 'noindex', 'follow', 'nofollow', 'nosnippet', 'noimageindex',
  'maxsnippet', 'maximagepreview', 'maxvideopreview', 'notranslate',
  'indexifembedded', 'unavailableafter', 'noarchive',
])

const fail = (message: string): never => {
  throw new Error(`[vue-ssr-lite] ${message}`)
}

const assertSafeText = (value: unknown, label: string, max = MAX_TEXT): string => {
  if (typeof value !== 'string') fail(`${label} must be a string.`)
  const text = value as string
  if (CONTROL.test(text)) fail(`${label} contains a control character.`)
  if (text.length > max) fail(`${label} exceeds ${max} characters.`)
  return text
}

const directiveIdentity = (value: string): string =>
  value.replace(/([a-z])([A-Z])/g, '$1$2').replace(/[-_]/g, '').toLowerCase()

export const validateRobotsInput = (
  input: SeoRobotsInput | null | undefined,
  label = 'seo.robots'
): void => {
  if (!input) return
  for (const key of [
    'nosnippet', 'noimageindex', 'notranslate', 'indexifembedded', 'noarchive',
  ] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') {
      fail(`${label}.${key} must be boolean.`)
    }
  }
  if (input.maxSnippet !== undefined && !Number.isInteger(input.maxSnippet)) {
    fail(`${label}.maxSnippet must be an integer.`)
  }
  if (input.maxVideoPreview !== undefined && !Number.isInteger(input.maxVideoPreview)) {
    fail(`${label}.maxVideoPreview must be an integer.`)
  }
  if (input.maxImagePreview !== undefined &&
    !['none', 'standard', 'large'].includes(input.maxImagePreview)) {
    fail(`${label}.maxImagePreview is invalid.`)
  }
  if (input.unavailableAfter instanceof Date) {
    if (Number.isNaN(input.unavailableAfter.getTime())) fail(`${label}.unavailableAfter is invalid.`)
  } else if (input.unavailableAfter !== undefined) {
    assertSafeText(input.unavailableAfter, `${label}.unavailableAfter`, 256)
    if (Number.isNaN(new Date(input.unavailableAfter).getTime())) {
      fail(`${label}.unavailableAfter is invalid.`)
    }
  }
  for (const [key, value] of Object.entries(input.additional ?? {})) {
    if (RESERVED_ROBOTS.has(directiveIdentity(key))) {
      fail(`${label}.additional cannot own reserved directive "${key}".`)
    }
    if (!ROBOTS_NAME.test(key)) fail(`${label}.additional directive "${key}" is invalid.`)
    if (typeof value === 'string') assertSafeText(value, `${label}.additional.${key}`, 2048)
    if (typeof value === 'number' && !Number.isFinite(value)) {
      fail(`${label}.additional.${key} must be finite.`)
    }
  }
}

const assertGenericOwnership = (
  meta: readonly SeoMetaEntry[] | null | undefined,
  links: readonly SeoLinkEntry[] | null | undefined,
  label: string
): void => {
  for (const entry of meta ?? []) {
    if (entry.property?.toLowerCase() === 'og:url') {
      fail(`${label}.meta cannot emit page-owned property "og:url".`)
    }
  }
  for (const entry of links ?? []) {
    const rel = entry.rel.toLowerCase()
    if (rel === 'canonical') fail(`${label}.links cannot emit page-owned rel="canonical".`)
    if (rel === 'alternate' && entry.hreflang) {
      fail(`${label}.links cannot emit page-owned hreflang alternates.`)
    }
  }
}

const validateHeadEntries = (
  meta: readonly SeoMetaEntry[] | null | undefined,
  links: readonly SeoLinkEntry[] | null | undefined,
  label: string
): void => {
  for (const [index, entry] of (meta ?? []).entries()) {
    assertSafeText(entry.content, `${label}.meta[${index}].content`)
    if (entry.key) assertSafeText(entry.key, `${label}.meta[${index}].key`, 512)
    if (entry.name) assertSafeText(entry.name, `${label}.meta[${index}].name`, 512)
    if (entry.property) assertSafeText(entry.property, `${label}.meta[${index}].property`, 512)
    if (entry.httpEquiv) assertSafeText(entry.httpEquiv, `${label}.meta[${index}].httpEquiv`, 512)
  }
  for (const [index, entry] of (links ?? []).entries()) {
    assertSafeText(entry.rel, `${label}.links[${index}].rel`, 512)
    assertSafeText(entry.href, `${label}.links[${index}].href`, 8192)
    if (entry.hreflang) assertSafeText(entry.hreflang, `${label}.links[${index}].hreflang`, 128)
  }
}

const assertJsonValue = (value: unknown, label: string, seen = new Set<object>()): void => {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number.`)
    return
  }
  if (typeof value !== 'object') fail(`${label} must be JSON serializable.`)
  if (seen.has(value as object)) fail(`${label} must not contain cycles.`)
  seen.add(value as object)
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, label, seen)
  } else {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertSafeText(key, `${label} key`, 512)
      assertJsonValue(item, label, seen)
    }
  }
  seen.delete(value as object)
}

const assertJsonSize = (value: unknown, label: string, maxBytes = 1024 * 1024): void => {
  let serialized: string
  try { serialized = JSON.stringify(value) }
  catch { return fail(`${label} must be JSON serializable.`) }
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
    fail(`${label} exceeds ${maxBytes} serialized bytes.`)
  }
}

const validateCommonDefaults = (
  value: SeoApplicationConfig | SeoSiteDefaults,
  label: string
): void => {
  for (const key of ['title', 'siteName', 'titleTemplate', 'description', 'image'] as const) {
    const item = value[key]
    if (item !== undefined && item !== null) assertSafeText(item, `${label}.${key}`)
  }
  validateRobotsInput(value.robots, `${label}.robots`)
  for (const key of ['index', 'follow'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') fail(`${label}.${key} must be boolean.`)
  }
  if (value.structuredDataMode !== undefined &&
    value.structuredDataMode !== 'merge' && value.structuredDataMode !== 'replace') {
    fail(`${label}.structuredDataMode is invalid.`)
  }
  if (value.twitter?.card !== undefined &&
    !['summary', 'summary_large_image', 'app', 'player'].includes(value.twitter.card)) {
    fail(`${label}.twitter.card is invalid.`)
  }
  if (value.openGraph?.determiner !== undefined &&
    !['a', 'an', 'the', '', 'auto'].includes(value.openGraph.determiner)) {
    fail(`${label}.openGraph.determiner is invalid.`)
  }
  if (value.htmlAttributes?.dir !== undefined && value.htmlAttributes.dir !== null &&
    !['ltr', 'rtl', 'auto'].includes(value.htmlAttributes.dir)) {
    fail(`${label}.htmlAttributes.dir is invalid.`)
  }
  validateHeadEntries(value.meta, value.links, label)
  assertGenericOwnership(value.meta, value.links, label)
  if (value.openGraph && Object.prototype.hasOwnProperty.call(value.openGraph, 'url')) {
    fail(`${label}.openGraph cannot own page-owned url.`)
  }
  if (value.structuredData !== undefined && value.structuredData !== null) {
    assertJsonValue(value.structuredData, `${label}.structuredData`)
    assertJsonSize(value.structuredData, `${label}.structuredData`)
  }
}

export const validateSeoApplicationConfig = (config: SeoApplicationConfig): SeoApplicationConfig => {
  for (const key of ['canonical', 'status', 'sitemap', 'alternates'] as const) {
    if (Object.prototype.hasOwnProperty.call(config, key)) fail(`seo.${key} is page/route-owned.`)
  }
  validateCommonDefaults(config, 'seo')
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') fail('seo.enabled must be boolean.')
  if (config.mode !== undefined && config.mode !== 'public' && config.mode !== 'private') {
    fail('seo.mode must be public or private.')
  }
  for (const key of ['index', 'follow', 'trailingSlash', 'allowHttpOrigin'] as const) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') fail(`seo.${key} must be boolean.`)
  }
  if (config.robotsTxt) normalizeRobotsConfig(config.robotsTxt, config.siteUrl)
  return config
}

export const validateSeoSiteDefaults = (defaults: SeoSiteDefaults): SeoSiteDefaults => {
  const forbidden = [
    'siteUrl', 'canonical', 'status', 'sitemap', 'alternates', 'allowHttpOrigin',
    'enabled', 'trailingSlash', 'mode', 'robotsTxt',
  ]
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(defaults, key)) fail(`siteSeo.defaults.${key} is forbidden.`)
  }
  validateCommonDefaults(defaults, 'siteSeo.defaults')
  assertJsonValue(defaults, 'siteSeo.defaults')
  assertJsonSize(defaults, 'siteSeo.defaults')
  return defaults
}

export const validateSeoPageInput = (input: SeoPageInput, label = 'SEO input'): SeoPageInput => {
  if (input.status !== undefined) {
    const status = validateResponseStatus(input.status)
    if (status >= 300 && status < 400) fail(`${label}.status cannot be 3xx without a redirect.`)
  }
  validateRobotsInput(input.robots, `${label}.robots`)
  for (const key of ['index', 'follow'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') fail(`${label}.${key} must be boolean.`)
  }
  if (input.structuredDataMode !== undefined &&
    input.structuredDataMode !== 'merge' && input.structuredDataMode !== 'replace') {
    fail(`${label}.structuredDataMode is invalid.`)
  }
  if (input.htmlAttributes?.dir !== undefined && input.htmlAttributes.dir !== null &&
    !['ltr', 'rtl', 'auto'].includes(input.htmlAttributes.dir)) {
    fail(`${label}.htmlAttributes.dir is invalid.`)
  }
  if (input.twitter?.card !== undefined &&
    !['summary', 'summary_large_image', 'app', 'player'].includes(input.twitter.card)) {
    fail(`${label}.twitter.card is invalid.`)
  }
  if (input.openGraph?.determiner !== undefined &&
    !['a', 'an', 'the', '', 'auto'].includes(input.openGraph.determiner)) {
    fail(`${label}.openGraph.determiner is invalid.`)
  }
  validateHeadEntries(input.meta, input.links, label)
  for (const key of ['title', 'description', 'image', 'canonical'] as const) {
    const value = input[key]
    if (typeof value === 'string') assertSafeText(value, `${label}.${key}`)
  }
  for (const [key, value] of Object.entries(input.openGraph ?? {})) {
    if (typeof value === 'string') assertSafeText(value, `${label}.openGraph.${key}`)
  }
  for (const [key, value] of Object.entries(input.twitter ?? {})) {
    if (typeof value === 'string') assertSafeText(value, `${label}.twitter.${key}`)
  }
  for (const [language, href] of Object.entries(input.alternates?.languages ?? {})) {
    assertSafeText(language, `${label}.alternates language`, 128)
    if (href !== null) assertSafeText(href, `${label}.alternates.${language}`, 8192)
  }
  if (input.htmlAttributes?.lang != null) {
    assertSafeText(input.htmlAttributes.lang, `${label}.htmlAttributes.lang`, 128)
  }
  if (input.structuredData !== undefined && input.structuredData !== null) {
    assertJsonValue(input.structuredData, `${label}.structuredData`)
    assertJsonSize(input.structuredData, `${label}.structuredData`)
  }
  return input
}

const resolveHttpUrl = (
  origin: string,
  value: string,
  label: string,
  sameOrigin: boolean
): string => {
  assertSafeText(value, label, 8192)
  const parsed = (() => {
    try { return new URL(value, `${normalizeSiteOrigin(origin)}/`) }
    catch { return fail(`${label} must be a valid URL.`) }
  })()
  if (!['http:', 'https:'].includes(parsed.protocol)) fail(`${label} must use http or https.`)
  if (parsed.username || parsed.password) fail(`${label} must not contain credentials.`)
  if (sameOrigin && parsed.origin !== normalizeSiteOrigin(origin)) {
    fail(`${label} must be same-origin with the resolved site origin.`)
  }
  return parsed.href
}

const resolvePageUrl = (origin: string, value: string, label: string): string =>
  resolveHttpUrl(origin, value, label, true)
const resolveMediaUrl = (origin: string, value: string, label: string): string =>
  resolveHttpUrl(origin, value, label, false)

const imageArray = (
  value: SeoOpenGraphInput['image'],
  origin: string
): SeoImageInput[] => {
  if (value === undefined) return []
  const values = Array.isArray(value) ? value : [value]
  return values.map((entry) => {
    const item = typeof entry === 'string' ? { url: entry } : entry
    if (item.alt !== undefined) assertSafeText(item.alt, 'openGraph.image.alt')
    for (const dimension of ['width', 'height'] as const) {
      const value = item[dimension]
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        fail(`openGraph.image.${dimension} must be a positive integer.`)
      }
    }
    return {
      ...item,
      url: resolveMediaUrl(origin, item.url, 'openGraph.image.url'),
      secureUrl: item.secureUrl
        ? resolveMediaUrl(origin, item.secureUrl, 'openGraph.image.secureUrl')
        : undefined,
    }
  })
}

const mediaArray = (
  value: SeoOpenGraphInput['audio'] | SeoOpenGraphInput['video'],
  origin: string,
  label: string
): SeoMediaInput[] => {
  if (value === undefined) return []
  const values = Array.isArray(value) ? value : [value]
  return values.map((entry) => {
    const item = typeof entry === 'string' ? { url: entry } : entry
    for (const dimension of ['width', 'height'] as const) {
      const value = item[dimension]
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        fail(`${label}.${dimension} must be a positive integer.`)
      }
    }
    return {
      ...item,
      url: resolveMediaUrl(origin, item.url, `${label}.url`),
      secureUrl: item.secureUrl ? resolveMediaUrl(origin, item.secureUrl, `${label}.secureUrl`) : undefined,
    }
  })
}

const robotsContent = (
  input: SeoResolvedInput,
  config: SeoApplicationConfig,
  status: number
): string => {
  const robots = input.robots ?? undefined
  const index = isErrorResponseStatus(status)
    ? false
    : input.index ?? (isPrivateSeoMode(config) ? false : true)
  const follow = input.follow ?? (isPrivateSeoMode(config) ? false : true)
  const tokens = [index ? 'index' : 'noindex', follow ? 'follow' : 'nofollow']
  if (robots?.nosnippet) tokens.push('nosnippet')
  if (robots?.noimageindex) tokens.push('noimageindex')
  if (robots?.maxSnippet != null) tokens.push(`max-snippet:${robots.maxSnippet}`)
  if (robots?.maxImagePreview) tokens.push(`max-image-preview:${robots.maxImagePreview}`)
  if (robots?.maxVideoPreview != null) tokens.push(`max-video-preview:${robots.maxVideoPreview}`)
  if (robots?.notranslate) tokens.push('notranslate')
  if (robots?.indexifembedded) tokens.push('indexifembedded')
  if (robots?.unavailableAfter) {
    const value = robots.unavailableAfter instanceof Date
      ? robots.unavailableAfter.toUTCString()
      : robots.unavailableAfter
    tokens.push(`unavailable_after:${value}`)
  }
  if (robots?.noarchive) tokens.push('noarchive')
  for (const [key, value] of Object.entries(robots?.additional ?? {})) {
    if (value === false) continue
    if (value === true) tokens.push(key)
    else tokens.push(`${key}:${value}`)
  }
  return tokens.join(', ')
}

export interface NormalizedSeo {
  title: string | undefined
  description: string | undefined
  canonical: string | null
  canonicalDirective: string | false | null | undefined
  robots: string
  image: string | undefined
  openGraph: {
    type: string
    title?: string
    description?: string
    url?: string
    siteName?: string
    locale?: string
    localeAlternate: readonly string[]
    determiner?: string
    images: readonly SeoImageInput[]
    audio: readonly SeoMediaInput[]
    video: readonly SeoMediaInput[]
  }
  twitter: {
    card: string
    site?: string
    creator?: string
    title?: string
    description?: string
    image?: string
  }
  alternates: Record<string, string>
  structuredData: readonly JsonObject[]
  meta: readonly SeoMetaEntry[]
  links: readonly SeoLinkEntry[]
  htmlAttributes?: SeoPageInput['htmlAttributes']
}

export interface NormalizeSeoOptions {
  config: SeoApplicationConfig
  input: SeoResolvedInput
  origin: string
  path: string
  status: number
  redirect?: boolean
}

export const normalizeSeo = (options: NormalizeSeoOptions): NormalizedSeo => {
  const { config, input, origin, path, status } = options
  validateSeoPageInput(input)
  const error = isErrorResponseStatus(status)
  const suppress = error || options.redirect || isPrivateSeoMode(config)
  const rawTitle = input.title === null ? undefined : input.title
  const template = input.titleTemplate === null ? undefined : input.titleTemplate
  const title = rawTitle && template ? template.replaceAll('%s', rawTitle) : rawTitle
  const description = input.description === null ? undefined : input.description
  const image = input.image
    ? resolveMediaUrl(origin, input.image, 'seo.image')
    : undefined
  let canonical: string | null = null
  if (!suppress && input.canonical !== false && input.canonical !== null) {
    canonical = input.canonical
      ? resolvePageUrl(origin, input.canonical, 'seo.canonical')
      : composeCanonicalUrl(origin, path, config.trailingSlash)
  }
  const og = input.openGraph ?? {}
  const explicitOgUrl = og.url
    ? resolvePageUrl(origin, og.url, 'openGraph.url')
    : undefined
  const automaticOgUrl = suppress
    ? undefined
    : canonical ?? (
      input.canonical === false || input.canonical === null
        ? undefined
        : composeCanonicalUrl(origin, normalizeCanonicalPath(path, config.trailingSlash), config.trailingSlash)
    )
  const ogImages = imageArray(og.image, origin)
  if (!ogImages.length && image) ogImages.push({ url: image })
  const twitterImage = input.twitter?.image
  const resolvedTwitterImage = typeof twitterImage === 'string'
    ? resolveMediaUrl(origin, twitterImage, 'twitter.image')
    : twitterImage?.url
      ? resolveMediaUrl(origin, twitterImage.url, 'twitter.image.url')
      : image
  const alternates: Record<string, string> = {}
  for (const [language, href] of Object.entries(input.alternates?.languages ?? {})) {
    if (href != null) alternates[language] = resolvePageUrl(origin, href, `alternates.languages.${language}`)
  }
  const blocks = suppress || input.structuredData == null
    ? []
    : Array.isArray(input.structuredData)
      ? [...input.structuredData]
      : [input.structuredData as JsonObject]
  const meta = (input.meta ?? []).filter((entry) => {
    if (!suppress) return true
    if (entry.property?.toLowerCase() === 'og:url') return false
    if ((error || isPrivateSeoMode(config)) && entry.name?.toLowerCase() === 'robots') return false
    return true
  }).map((entry) => {
    if (entry.property?.toLowerCase() === 'og:url') {
      return { ...entry, content: resolvePageUrl(origin, entry.content, 'meta property og:url') }
    }
    return entry
  })
  const links = (input.links ?? []).filter((entry) => {
    if (!suppress) return true
    const rel = entry.rel.toLowerCase()
    return rel !== 'canonical' && !(rel === 'alternate' && Boolean(entry.hreflang))
  }).map((entry) => {
    const pageOwned = entry.rel.toLowerCase() === 'canonical' ||
      (entry.rel.toLowerCase() === 'alternate' && Boolean(entry.hreflang))
    return {
      ...entry,
      href: pageOwned
        ? resolvePageUrl(origin, entry.href, `link rel=${entry.rel}`)
        : resolveMediaUrl(origin, entry.href, `link rel=${entry.rel}`),
    }
  })
  return {
    title,
    description,
    canonical,
    canonicalDirective: input.canonical,
    robots: robotsContent(input, config, status),
    image,
    openGraph: {
      type: og.type ?? 'website',
      title: og.title ?? title,
      description: og.description ?? description,
      url: options.redirect ? undefined : explicitOgUrl ?? automaticOgUrl,
      siteName: og.siteName ?? (input.siteName === null ? undefined : input.siteName),
      locale: og.locale,
      localeAlternate: og.localeAlternate ?? [],
      determiner: og.determiner,
      images: ogImages,
      audio: mediaArray(og.audio, origin, 'openGraph.audio'),
      video: mediaArray(og.video, origin, 'openGraph.video'),
    },
    twitter: {
      card: input.twitter?.card ?? (resolvedTwitterImage ? 'summary_large_image' : 'summary'),
      site: input.twitter?.site,
      creator: input.twitter?.creator,
      title: input.twitter?.title ?? title,
      description: input.twitter?.description ?? description,
      image: resolvedTwitterImage,
    },
    alternates,
    structuredData: blocks,
    meta,
    links,
    htmlAttributes: input.htmlAttributes,
  }
}

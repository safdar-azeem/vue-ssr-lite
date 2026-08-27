import type { RouteRecordRaw } from 'vue-router'
import { composeCanonicalUrl, normalizeSiteOrigin } from '../../SsrCanonicalOrigin'
import type { SsrRenderMode } from '../../SsrConfigTypes'
import { validateResponseStatus } from '../../SsrResponseStatus'
import type { SeoEndpointContext, SeoEndpointResultMeta, SeoRouteInput } from './types'

export interface SitemapImageEntry { loc: string }
export interface SitemapVideoEntry {
  thumbnailLoc: string
  title: string
  description: string
  contentLoc?: string
  playerLoc?: string
  duration?: number
  publicationDate?: string | Date
  familyFriendly?: boolean
  live?: boolean
  tags?: readonly string[]
}
export interface SitemapNewsEntry {
  publication: { name: string; language: string }
  publicationDate: string | Date
  title: string
}
export interface SitemapEntry {
  loc: string
  lastmod?: string | Date
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never'
  priority?: number
  alternates?: Record<string, string>
  images?: readonly SitemapImageEntry[]
  videos?: readonly SitemapVideoEntry[]
  news?: SitemapNewsEntry
}
export interface SitemapContext extends SeoEndpointContext {
  hostname: string
  subdomain: string | null
  isCustomDomain: boolean
  params: Readonly<Record<string, string>>
}
export type SitemapSource = Iterable<SitemapEntry> | AsyncIterable<SitemapEntry>
export interface SitemapEntriesResult extends SeoEndpointResultMeta {
  kind?: 'entries'
  entries: SitemapSource
}
export interface SitemapShardCollection extends SeoEndpointResultMeta {
  kind: 'sharded'
  revision: string | number
  shardCount: number
  getShard: (
    context: SitemapContext,
    shardNumber: number
  ) => SitemapSource | Promise<SitemapSource>
}
export type SitemapNotFoundResult = { status: 'not-found'; responseStatus?: 404 | 421 }
export type SitemapProviderResult =
  | SitemapSource
  | SitemapShardCollection
  | SitemapEntriesResult
  | SitemapNotFoundResult
export type SitemapProvider = (
  context: SitemapContext
) => SitemapProviderResult | Promise<SitemapProviderResult>

const CONTROL = /[\u0000-\u001f\u007f]/
export const SITEMAP_MAX_URLS = 50_000
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024

const joinRoutePaths = (parent: string, child: string): string => {
  if (!child) return parent || '/'
  if (child.startsWith('/')) return child
  if (!parent || parent === '/') return `/${child}`
  return `${parent.replace(/\/+$/, '')}/${child}`
}
const isDynamicPath = (path: string): boolean => path.includes(':') || path.includes('*')
const readRouteSeo = (record: RouteRecordRaw): SeoRouteInput =>
  (record.meta?.seo ?? {}) as SeoRouteInput
const isNavigableRecord = (record: RouteRecordRaw): boolean => Boolean(record.component || record.components)
const declaredErrorStatus = (seo: SeoRouteInput): boolean =>
  seo.status !== undefined && validateResponseStatus(seo.status) >= 400

const collectStaticPaths = (
  records: readonly RouteRecordRaw[] | undefined,
  parentPath: string,
  parentSeo: SeoRouteInput,
  parentRender: SsrRenderMode | undefined,
  defaultRender: SsrRenderMode,
  output: Set<string>
): void => {
  for (const record of records ?? []) {
    const path = joinRoutePaths(parentPath, String(record.path ?? ''))
    const seo = { ...parentSeo, ...readRouteSeo(record) }
    const declared = record.meta?.render
    const render =
      declared === 'ssr' || declared === 'spa' ? declared : parentRender
    const effective = render ?? defaultRender
    if (record.children?.length) {
      collectStaticPaths(record.children, path, seo, effective, defaultRender, output)
    }
    if (record.redirect || !isNavigableRecord(record) || isDynamicPath(path)) continue
    if (effective === 'spa') continue
    if (seo.index === false || seo.sitemap === false || declaredErrorStatus(seo)) continue
    output.add(path === '' ? '/' : path)
  }
}

export const discoverStaticSitemapPaths = (
  routes: readonly RouteRecordRaw[] | undefined,
  defaultRender: SsrRenderMode = 'ssr'
): string[] => {
  const paths = new Set<string>()
  collectStaticPaths(routes, '', {}, undefined, defaultRender, paths)
  return [...paths].sort((left, right) => left === '/' ? -1 : right === '/' ? 1 : left.localeCompare(right))
}

export const escapeXml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;')

const safeText = (value: unknown, label: string, max = 32_768): string => {
  if (typeof value !== 'string' || CONTROL.test(value) || value.length > max) {
    throw new Error(`[vue-ssr-lite] ${label} is invalid.`)
  }
  return value
}

const httpUrl = (value: string, label: string): URL => {
  safeText(value, label, 8192)
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`[vue-ssr-lite] ${label} must be an absolute URL.`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`[vue-ssr-lite] ${label} must be a credential-free HTTP(S) URL.`)
  }
  return url
}

const isoDate = (value: string | Date | undefined, label: string): string | undefined => {
  if (value === undefined) return undefined
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`[vue-ssr-lite] ${label} is not a valid date.`)
  return date.toISOString()
}

const resolveLoc = (origin: string, loc: string, label: string, sameOrigin: boolean): string => {
  const originValue = normalizeSiteOrigin(origin)
  const value = /^https?:\/\//i.test(loc) ? loc : composeCanonicalUrl(originValue, loc)
  const parsed = httpUrl(value, label)
  if (sameOrigin && parsed.origin !== originValue) {
    throw new Error(`[vue-ssr-lite] ${label} must be same-origin with siteOrigin.`)
  }
  return parsed.href
}

export const normalizeSitemapEntry = (origin: string, entry: SitemapEntry): SitemapEntry => {
  const loc = resolveLoc(origin, entry.loc, 'sitemap loc', true)
  const changefreqValues = new Set(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'])
  if (entry.changefreq !== undefined && !changefreqValues.has(entry.changefreq)) {
    throw new Error('[vue-ssr-lite] sitemap changefreq is invalid.')
  }
  if (entry.priority !== undefined && (!Number.isFinite(entry.priority) || entry.priority < 0 || entry.priority > 1)) {
    throw new Error('[vue-ssr-lite] sitemap priority must be between 0 and 1.')
  }
  if ((entry.images?.length ?? 0) > 1000) {
    throw new Error('[vue-ssr-lite] sitemap entries may contain at most 1,000 images.')
  }
  const images = entry.images?.map((image) => ({
    loc: resolveLoc(origin, image.loc, 'sitemap image loc', false),
  }))
  const videos = entry.videos?.map((video) => {
    safeText(video.title, 'sitemap video title')
    safeText(video.description, 'sitemap video description', 2048)
    if (!video.contentLoc && !video.playerLoc) {
      throw new Error('[vue-ssr-lite] sitemap video requires contentLoc or playerLoc.')
    }
    if (video.duration !== undefined && (!Number.isInteger(video.duration) || video.duration < 1 || video.duration > 28_800)) {
      throw new Error('[vue-ssr-lite] sitemap video duration must be an integer from 1 through 28800.')
    }
    if ((video.tags?.length ?? 0) > 32) throw new Error('[vue-ssr-lite] sitemap video supports at most 32 tags.')
    if (video.familyFriendly !== undefined && typeof video.familyFriendly !== 'boolean') {
      throw new Error('[vue-ssr-lite] sitemap video familyFriendly must be boolean.')
    }
    if (video.live !== undefined && typeof video.live !== 'boolean') {
      throw new Error('[vue-ssr-lite] sitemap video live must be boolean.')
    }
    return {
      ...video,
      thumbnailLoc: resolveLoc(origin, video.thumbnailLoc, 'sitemap video thumbnailLoc', false),
      contentLoc: video.contentLoc ? resolveLoc(origin, video.contentLoc, 'sitemap video contentLoc', false) : undefined,
      playerLoc: video.playerLoc ? resolveLoc(origin, video.playerLoc, 'sitemap video playerLoc', false) : undefined,
      publicationDate: isoDate(video.publicationDate, 'sitemap video publicationDate'),
      tags: video.tags?.map((tag) => safeText(tag, 'sitemap video tag', 256)),
    }
  })
  const news = entry.news ? {
    publication: {
      name: safeText(entry.news.publication.name, 'sitemap news publication name'),
      language: safeText(entry.news.publication.language, 'sitemap news publication language', 64),
    },
    publicationDate: isoDate(entry.news.publicationDate, 'sitemap news publicationDate')!,
    title: safeText(entry.news.title, 'sitemap news title'),
  } : undefined
  const alternates = entry.alternates
    ? Object.fromEntries(Object.entries(entry.alternates).map(([language, href]) => [
        safeText(language, 'sitemap alternate language', 64),
        resolveLoc(origin, href, `sitemap alternate ${language}`, true),
      ]))
    : undefined
  return {
    ...entry,
    loc,
    lastmod: isoDate(entry.lastmod, 'sitemap lastmod'),
    alternates,
    images,
    videos,
    news,
  }
}

export const mergeSitemapEntries = (
  origin: string,
  staticPaths: readonly string[],
  dynamicEntries: readonly SitemapEntry[] = []
): SitemapEntry[] => {
  const merged = new Map<string, SitemapEntry>()
  for (const path of staticPaths) {
    const entry = normalizeSitemapEntry(origin, { loc: path })
    merged.set(entry.loc, entry)
  }
  for (const raw of dynamicEntries) {
    const entry = normalizeSitemapEntry(origin, raw)
    merged.set(entry.loc, entry)
  }
  return [...merged.values()]
}

const serializeVideo = (video: SitemapVideoEntry): string[] => [
  '    <video:video>',
  `      <video:thumbnail_loc>${escapeXml(video.thumbnailLoc)}</video:thumbnail_loc>`,
  `      <video:title>${escapeXml(video.title)}</video:title>`,
  `      <video:description>${escapeXml(video.description)}</video:description>`,
  video.contentLoc ? `      <video:content_loc>${escapeXml(video.contentLoc)}</video:content_loc>` : '',
  video.playerLoc ? `      <video:player_loc>${escapeXml(video.playerLoc)}</video:player_loc>` : '',
  video.duration ? `      <video:duration>${video.duration}</video:duration>` : '',
  video.publicationDate ? `      <video:publication_date>${escapeXml(String(video.publicationDate))}</video:publication_date>` : '',
  video.familyFriendly !== undefined ? `      <video:family_friendly>${video.familyFriendly ? 'yes' : 'no'}</video:family_friendly>` : '',
  video.live !== undefined ? `      <video:live>${video.live ? 'yes' : 'no'}</video:live>` : '',
  ...(video.tags ?? []).map((tag) => `      <video:tag>${escapeXml(tag)}</video:tag>`),
  '    </video:video>',
].filter(Boolean)

export const serializeSitemapXml = (entries: readonly SitemapEntry[]): string => {
  if (entries.length > SITEMAP_MAX_URLS) throw new Error('[vue-ssr-lite] sitemap exceeds 50,000 URLs.')
  let newsCount = 0
  const urls = entries.map((entry) => {
    if (entry.news && ++newsCount > 1000) throw new Error('[vue-ssr-lite] sitemap exceeds 1,000 news entries.')
    return [
      '  <url>',
      `    <loc>${escapeXml(entry.loc)}</loc>`,
      entry.lastmod ? `    <lastmod>${escapeXml(String(entry.lastmod))}</lastmod>` : '',
      entry.changefreq ? `    <changefreq>${entry.changefreq}</changefreq>` : '',
      entry.priority !== undefined ? `    <priority>${entry.priority}</priority>` : '',
      ...Object.entries(entry.alternates ?? {}).map(([language, href]) =>
        `    <xhtml:link rel="alternate" hreflang="${escapeXml(language)}" href="${escapeXml(href)}" />`
      ),
      ...(entry.images ?? []).flatMap((image) => [
        '    <image:image>',
        `      <image:loc>${escapeXml(image.loc)}</image:loc>`,
        '    </image:image>',
      ]),
      ...(entry.videos ?? []).flatMap(serializeVideo),
      ...(entry.news ? [
        '    <news:news>',
        '      <news:publication>',
        `        <news:name>${escapeXml(entry.news.publication.name)}</news:name>`,
        `        <news:language>${escapeXml(entry.news.publication.language)}</news:language>`,
        '      </news:publication>',
        `      <news:publication_date>${escapeXml(String(entry.news.publicationDate))}</news:publication_date>`,
        `      <news:title>${escapeXml(entry.news.title)}</news:title>`,
        '    </news:news>',
      ] : []),
      '  </url>',
    ].filter(Boolean).join('\n')
  }).join('\n')
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">',
    urls,
    '</urlset>',
    '',
  ].join('\n')
  if (new TextEncoder().encode(xml).byteLength > SITEMAP_MAX_BYTES) {
    throw new Error('[vue-ssr-lite] sitemap exceeds 50 MB uncompressed.')
  }
  return xml
}

export const serializeSitemapIndexXml = (
  origin: string,
  shardCount: number,
  lastModified?: string | Date
): string => {
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > SITEMAP_MAX_URLS) {
    throw new Error('[vue-ssr-lite] sharded sitemap shardCount must be an integer from 1 through 50,000.')
  }
  const lastmod = isoDate(lastModified, 'sitemap index lastModified')
  const rows = Array.from({ length: shardCount }, (_, index) => [
    '  <sitemap>',
    `    <loc>${escapeXml(composeCanonicalUrl(origin, `/sitemap-${index + 1}.xml`))}</loc>`,
    lastmod ? `    <lastmod>${escapeXml(lastmod)}</lastmod>` : '',
    '  </sitemap>',
  ].filter(Boolean).join('\n')).join('\n')
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    rows,
    '</sitemapindex>',
    '',
  ].join('\n')
  if (new TextEncoder().encode(xml).byteLength > SITEMAP_MAX_BYTES) {
    throw new Error('[vue-ssr-lite] sitemap index exceeds 50 MB uncompressed.')
  }
  return xml
}

export const collectSitemapSource = async (
  source: SitemapSource,
  origin: string,
  signal?: AbortSignal
): Promise<SitemapEntry[]> => {
  const entries: SitemapEntry[] = []
  const seen = new Set<string>()
  const append = (raw: SitemapEntry) => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    if (entries.length >= SITEMAP_MAX_URLS) throw new Error('[vue-ssr-lite] sitemap exceeds 50,000 URLs.')
    const entry = normalizeSitemapEntry(origin, raw)
    if (seen.has(entry.loc)) return
    seen.add(entry.loc)
    entries.push(entry)
  }
  if (Symbol.asyncIterator in Object(source)) {
    for await (const raw of source as AsyncIterable<SitemapEntry>) append(raw)
  } else if (Symbol.iterator in Object(source)) {
    for (const raw of source as Iterable<SitemapEntry>) append(raw)
  } else {
    throw new Error('[vue-ssr-lite] sitemap provider must return an iterable or async iterable source.')
  }
  return entries
}

export const isSitemapNotFound = (value: unknown): value is SitemapNotFoundResult =>
  Boolean(value && typeof value === 'object' && (value as any).status === 'not-found')
export const isSitemapSharded = (value: unknown): value is SitemapShardCollection =>
  Boolean(value && typeof value === 'object' && (value as any).kind === 'sharded')
export const isSitemapEntriesResult = (value: unknown): value is SitemapEntriesResult =>
  Boolean(
    value &&
    typeof value === 'object' &&
    Object.prototype.hasOwnProperty.call(value, 'entries') &&
    typeof (value as any).entries !== 'function'
  )

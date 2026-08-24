import type { RouteRecordRaw } from 'vue-router'
import { composeCanonicalUrl } from '../../SsrCanonicalOrigin'
import { validateResponseStatus } from '../../SsrResponseStatus'
import type { SeoRouteInput } from './types'

export interface SitemapEntry {
  loc: string
  lastmod?: string | Date
}

export interface SitemapContext {
  applicationId: string
  siteUrl: string
}

export type SitemapProvider = (
  context: SitemapContext
) => SitemapEntry[] | Promise<SitemapEntry[]>

const joinRoutePaths = (parent: string, child: string): string => {
  if (!child) return parent || '/'
  if (child.startsWith('/')) return child
  if (!parent || parent === '/') return `/${child}`
  return `${parent.replace(/\/+$/, '')}/${child}`
}

const isDynamicPath = (path: string): boolean =>
  path.includes(':') || path.includes('*')

const readRouteSeo = (record: RouteRecordRaw): SeoRouteInput =>
  (record.meta?.seo ?? {}) as SeoRouteInput

const isNavigableRecord = (record: RouteRecordRaw): boolean =>
  Boolean(record.component || record.components)

const declaredErrorStatus = (seo: SeoRouteInput): boolean => {
  if (seo.status === undefined) return false
  return validateResponseStatus(seo.status) >= 400
}

const collectStaticPaths = (
  records: readonly RouteRecordRaw[] | undefined,
  parentPath: string,
  parentSeo: SeoRouteInput,
  output: Set<string>
): void => {
  for (const record of records ?? []) {
    const path = joinRoutePaths(parentPath, String(record.path ?? ''))
    const seo = { ...parentSeo, ...readRouteSeo(record) }
    if (record.children?.length) {
      collectStaticPaths(record.children, path, seo, output)
    }
    if (record.redirect) continue
    if (!isNavigableRecord(record)) continue
    if (isDynamicPath(path)) continue
    if (seo.index === false) continue
    if (seo.sitemap === false) continue
    if (declaredErrorStatus(seo)) continue
    output.add(path === '' ? '/' : path)
  }
}

export const discoverStaticSitemapPaths = (
  routes: readonly RouteRecordRaw[] | undefined
): string[] => {
  const paths = new Set<string>()
  collectStaticPaths(routes, '', {}, paths)
  return [...paths].sort((left, right) => {
    if (left === '/') return -1
    if (right === '/') return 1
    return left.localeCompare(right)
  })
}

const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')

const formatLastmod = (value: string | Date | undefined): string | undefined => {
  if (!value) return undefined
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString()
}

const resolveEntryLoc = (origin: string, loc: string): string => {
  if (/^https?:\/\//i.test(loc)) return loc
  return composeCanonicalUrl(origin, loc)
}

export const mergeSitemapEntries = (
  origin: string,
  staticPaths: readonly string[],
  dynamicEntries: readonly SitemapEntry[] = []
): SitemapEntry[] => {
  const merged = new Map<string, SitemapEntry>()
  for (const path of staticPaths) {
    const loc = resolveEntryLoc(origin, path)
    merged.set(loc, { loc })
  }
  for (const entry of dynamicEntries) {
    const loc = resolveEntryLoc(origin, entry.loc)
    merged.set(loc, { loc, lastmod: entry.lastmod })
  }
  return [...merged.values()]
}

export const serializeSitemapXml = (entries: readonly SitemapEntry[]): string => {
  const urls = entries
    .map((entry) => {
      const lastmod = formatLastmod(entry.lastmod)
      return [
        '  <url>',
        `    <loc>${escapeXml(entry.loc)}</loc>`,
        lastmod ? `    <lastmod>${escapeXml(lastmod)}</lastmod>` : '',
        '  </url>',
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    '</urlset>',
    '',
  ].join('\n')
}

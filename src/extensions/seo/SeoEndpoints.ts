import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { RouteRecordRaw } from 'vue-router'
import { composeCanonicalUrl } from '../../SsrCanonicalOrigin'
import type { SsrRenderMode } from '../../SsrConfigTypes'
import type { SsrEndpointDefinition, SsrHttpRequest, SsrHttpResponse } from '../../SsrRuntimeTypes'
import { validateSeoApplicationConfig, validateSeoSiteDefaults } from './normalize'
import {
  collectSitemapSource,
  discoverStaticSitemapPaths,
  isSitemapEntriesResult,
  isSitemapNotFound,
  isSitemapSharded,
  mergeSitemapEntries,
  serializeSitemapIndexXml,
  serializeSitemapXml,
  type SitemapContext,
  type SitemapProvider,
  type SitemapSource,
} from './sitemap'
import { privateRobotsConfig, serializeRobotsConfig, serializeRobotsTxt } from './robots'
import {
  isPrivateSeoMode,
  isSeoEnabled,
  type SeoApplicationConfig,
  type SeoEndpointResultMeta,
  type SiteRobotsConfig,
  type SiteSeoConfig,
  type SiteSeoResolution,
} from './types'

export interface SeoEndpointOptions {
  applicationId: string
  routes?: RouteRecordRaw[] | (() => RouteRecordRaw[])
  seo?: SeoApplicationConfig
  siteSeo?: SiteSeoConfig
  siteRobots?: SiteRobotsConfig
  root: string
  sitemapProvider?: SitemapProvider
  defaultRender?: SsrRenderMode
  resolveSiteUrl: (request: SsrHttpRequest<any>) => string | Promise<string>
  serverRouteOwnedPaths?: readonly string[]
  existingEndpoints: readonly SsrEndpointDefinition<any>[]
}

const CONTROL = /[\u0000-\u001f\u007f]/

export class SeoProviderFailure extends Error {
  override name = 'SeoProviderFailure'
  constructor(message: string, cause?: unknown) {
    super(message)
    this.cause = cause
  }
}

const physicalFileExists = async (root: string, fileName: string): Promise<boolean> => {
  try { await access(resolve(root, 'public', fileName)); return true } catch { return false }
}

const ownedEndpoint = (
  existing: readonly SsrEndpointDefinition<any>[],
  pathname: string
) => existing.find((endpoint) => endpoint.ownedPaths?.includes(pathname))

const endpointHeaders = (contentType: string) => ({
  'content-type': contentType,
  'cache-control': 'public, max-age=3600',
})

const notFound = (status: 404 | 421 = 404): SsrHttpResponse => ({
  statusCode: status,
  headers: { 'cache-control': 'private, no-store' },
})

const validateNotFoundStatus = (status: unknown): 404 | 421 => {
  if (status === undefined) return 404
  if (status !== 404 && status !== 421) {
    throw new Error('[vue-ssr-lite] SEO provider not-found responseStatus must be 404 or 421.')
  }
  return status
}

const validateProviderMeta = (meta: {
  revision?: string | number
  cacheTags?: readonly string[]
}): void => {
  if (meta.revision !== undefined) {
    const value = String(meta.revision)
    if (!value || CONTROL.test(value) ||
      (typeof meta.revision === 'number' && !Number.isFinite(meta.revision))) {
      throw new Error('[vue-ssr-lite] SEO provider revision is invalid.')
    }
  }
  if ((meta.cacheTags?.length ?? 0) > 256) {
    throw new Error('[vue-ssr-lite] SEO provider cacheTags exceeds 256 entries.')
  }
  for (const tag of meta.cacheTags ?? []) {
    if (typeof tag !== 'string' || !tag || tag.length > 512 || CONTROL.test(tag)) {
      throw new Error('[vue-ssr-lite] SEO provider cache tag is invalid.')
    }
  }
}

export const resolveSiteSeoForRequest = async (
  request: SsrHttpRequest<any>,
  applicationId: string,
  siteOrigin: string,
  config?: SiteSeoConfig
): Promise<SiteSeoResolution | undefined> => {
  if (!config) return undefined
  if (request.siteSeo !== undefined) {
    return { status: 'resolved', defaults: request.siteSeo, ...(request.siteSeoMeta ?? {}) }
  }
  let result: SiteSeoResolution
  try {
    result = await config.resolve({
      applicationId,
      siteOrigin,
      domain: request.domain,
      signal: request.signal,
    })
  } catch (error) {
    if (request.signal.aborted) throw error
    throw new SeoProviderFailure('[vue-ssr-lite] siteSeo.resolve() failed.', error)
  }
  if (!result || (result.status !== 'resolved' && result.status !== 'not-found')) {
    throw new Error('[vue-ssr-lite] siteSeo.resolve() returned an invalid result.')
  }
  if (result.status === 'not-found') {
    validateNotFoundStatus(result.responseStatus)
    return result
  }
  validateProviderMeta(result)
  validateSeoSiteDefaults(result.defaults)
  request.siteSeo = JSON.parse(JSON.stringify(result.defaults))
  request.siteSeoMeta = {
    revision: result.revision,
    cacheTags: result.cacheTags ? [...result.cacheTags] : undefined,
  }
  return { ...result, defaults: request.siteSeo! }
}

const endpointContext = (
  request: SsrHttpRequest<any>,
  applicationId: string,
  siteOrigin: string
): SitemapContext => ({
  applicationId,
  siteOrigin,
  domain: request.domain,
  signal: request.signal,
  pathname: request.pathname,
  search: request.search,
  hostname: request.domain.hostname,
  subdomain: request.domain.subdomain,
  isCustomDomain: request.domain.isCustomDomain,
  params: request.domain.params,
})

const headerValue = (request: SsrHttpRequest<any>, name: string): string => {
  const entry = Object.entries(request.headers).find(([key]) => key.toLowerCase() === name)
  const value = entry?.[1]
  return Array.isArray(value) ? value.join(', ') : String(value ?? '')
}

const endpointMetaHeaders = (
  meta: SeoEndpointResultMeta | undefined,
  contentType: string,
  discriminator = ''
): Record<string, string> => {
  const headers: Record<string, string> = endpointHeaders(contentType)
  if (!meta) return headers
  validateProviderMeta(meta)
  if (meta.cacheControl !== undefined) {
    if (CONTROL.test(meta.cacheControl)) throw new Error('[vue-ssr-lite] SEO endpoint cacheControl contains control characters.')
    headers['cache-control'] = meta.cacheControl
  }
  if (meta.revision !== undefined) {
    const revision = String(meta.revision)
    if (!revision || CONTROL.test(revision)) throw new Error('[vue-ssr-lite] SEO endpoint revision is invalid.')
    headers.etag = `"${Buffer.from(`${revision}:${discriminator}`).toString('base64url')}"`
  }
  if (meta.lastModified !== undefined) {
    const date = meta.lastModified instanceof Date ? meta.lastModified : new Date(meta.lastModified)
    if (Number.isNaN(date.getTime())) throw new Error('[vue-ssr-lite] SEO endpoint lastModified is invalid.')
    headers['last-modified'] = date.toUTCString()
  }
  return headers
}

const conditionalResponse = (
  request: SsrHttpRequest<any>,
  headers: Record<string, string>
): SsrHttpResponse | undefined => {
  const noneMatch = headerValue(request, 'if-none-match')
  if (headers.etag && noneMatch) {
    if (noneMatch === '*' || noneMatch.split(',').map((v) => v.trim()).includes(headers.etag)) {
      return { statusCode: 304, headers }
    }
    return undefined
  }
  const modifiedSince = headerValue(request, 'if-modified-since')
  if (headers['last-modified'] && modifiedSince) {
    const since = new Date(modifiedSince).getTime()
    const modified = new Date(headers['last-modified']).getTime()
    if (Number.isFinite(since) && since >= modified) return { statusCode: 304, headers }
  }
  return undefined
}

const toSource = (result: unknown): SitemapSource =>
  isSitemapEntriesResult(result) ? result.entries : result as SitemapSource

export const createSeoEndpoints = async (
  options: SeoEndpointOptions
): Promise<SsrEndpointDefinition<any>[]> => {
  if (!isSeoEnabled(options.seo)) return []
  validateSeoApplicationConfig(options.seo ?? {})
  const privateMode = isPrivateSeoMode(options.seo)
  const routes = typeof options.routes === 'function' ? options.routes() : options.routes
  const endpoints: SsrEndpointDefinition<any>[] = []
  const sitemapId = `${options.applicationId}-sitemap`
  const robotsId = `${options.applicationId}-robots`
  const hasPhysicalSitemap = await physicalFileExists(options.root, 'sitemap.xml')

  if (
    !privateMode &&
    !hasPhysicalSitemap &&
    !(options.serverRouteOwnedPaths?.includes('/sitemap.xml') || ownedEndpoint(options.existingEndpoints, '/sitemap.xml'))
  ) {
    endpoints.push({
      id: sitemapId,
      ownedPaths: ['/sitemap.xml'],
      match: (request) => request.pathname === '/sitemap.xml' || /^\/sitemap-[1-9]\d*\.xml$/.test(request.pathname),
      async handle(request) {
        const siteOrigin = request.siteOrigin ?? await options.resolveSiteUrl(request)
        const site = await resolveSiteSeoForRequest(request, options.applicationId, siteOrigin, options.siteSeo)
        if (site?.status === 'not-found') return notFound(validateNotFoundStatus(site.responseStatus))
        const context = endpointContext(request, options.applicationId, siteOrigin)
        const result = options.sitemapProvider ? await options.sitemapProvider(context) : []
        if (isSitemapNotFound(result)) return notFound(validateNotFoundStatus(result.responseStatus))
        const shardMatch = /^\/sitemap-([1-9]\d*)\.xml$/.exec(request.pathname)
        if (isSitemapSharded(result)) {
          if (!Number.isInteger(result.shardCount) || result.shardCount < 1 || result.shardCount > 50_000) {
            throw new Error('[vue-ssr-lite] sharded sitemap shardCount must be an integer from 1 through 50,000.')
          }
          const headers = endpointMetaHeaders(result, 'application/xml; charset=utf-8', request.pathname)
          const conditional = conditionalResponse(request, headers)
          if (conditional) return conditional
          if (!shardMatch) {
            return { statusCode: 200, body: serializeSitemapIndexXml(siteOrigin, result.shardCount, result.lastModified), headers }
          }
          const shardNumber = Number(shardMatch[1])
          if (shardNumber > result.shardCount) return notFound()
          const source = await result.getShard(context, shardNumber)
          const entries = await collectSitemapSource(source, siteOrigin, request.signal)
          return { statusCode: 200, body: serializeSitemapXml(entries), headers }
        }
        if (shardMatch) return notFound()
        const meta = isSitemapEntriesResult(result) ? result : undefined
        const headers = endpointMetaHeaders(meta, 'application/xml; charset=utf-8', request.pathname)
        const conditional = conditionalResponse(request, headers)
        if (conditional) return conditional
        const dynamic = await collectSitemapSource(toSource(result), siteOrigin, request.signal)
        const entries = mergeSitemapEntries(
          siteOrigin,
          discoverStaticSitemapPaths(routes, options.defaultRender ?? 'ssr'),
          dynamic
        )
        return { statusCode: 200, body: serializeSitemapXml(entries), headers }
      },
    })
  }

  if (
    (privateMode || !(await physicalFileExists(options.root, 'robots.txt'))) &&
    !options.serverRouteOwnedPaths?.includes('/robots.txt') &&
    !ownedEndpoint(
      [...options.existingEndpoints, ...endpoints],
      '/robots.txt'
    )
  ) {
    endpoints.push({
      id: robotsId,
      ownedPaths: ['/robots.txt'],
      match: (request) => request.pathname === '/robots.txt',
      async handle(request) {
        const siteOrigin = request.siteOrigin ?? await options.resolveSiteUrl(request)
        const site = await resolveSiteSeoForRequest(request, options.applicationId, siteOrigin, options.siteSeo)
        if (site?.status === 'not-found') return notFound(validateNotFoundStatus(site.responseStatus))
        if (privateMode) {
          return {
            statusCode: 200,
            body: serializeRobotsConfig(privateRobotsConfig()),
            headers: endpointHeaders('text/plain; charset=utf-8'),
          }
        }
        if (options.siteRobots) {
          const context = endpointContext(request, options.applicationId, siteOrigin)
          const resolved = await options.siteRobots.resolve(context)
          if (!resolved || (resolved.status !== 'resolved' && resolved.status !== 'not-found')) {
            throw new Error('[vue-ssr-lite] siteRobots.resolve() returned an invalid result.')
          }
          if (resolved.status === 'not-found') return notFound(validateNotFoundStatus(resolved.responseStatus))
          const headers = endpointMetaHeaders(resolved, 'text/plain; charset=utf-8', request.pathname)
          const conditional = conditionalResponse(request, headers)
          if (conditional) return conditional
          const sitemapUrl = endpoints.some((endpoint) => endpoint.id === sitemapId) || hasPhysicalSitemap
            ? composeCanonicalUrl(siteOrigin, '/sitemap.xml')
            : null
          return { statusCode: 200, body: serializeRobotsTxt(sitemapUrl, resolved.config, siteOrigin), headers }
        }
        const sitemapUrl = endpoints.some((endpoint) => endpoint.id === sitemapId) || hasPhysicalSitemap
          ? composeCanonicalUrl(siteOrigin, '/sitemap.xml')
          : null
        return {
          statusCode: 200,
          body: serializeRobotsTxt(sitemapUrl, options.seo?.robotsTxt, siteOrigin),
          headers: endpointHeaders('text/plain; charset=utf-8'),
        }
      },
    })
  }
  return endpoints
}

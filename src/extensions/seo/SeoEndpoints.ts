import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { RouteRecordRaw } from 'vue-router'
import { composeCanonicalUrl } from '../../SsrCanonicalOrigin'
import type {
  SsrEndpointDefinition,
  SsrHttpRequest,
} from '../../SsrRuntimeTypes'
import {
  discoverStaticSitemapPaths,
  mergeSitemapEntries,
  serializeSitemapXml,
  type SitemapProvider,
} from './sitemap'
import { serializeRobotsTxt } from './robots'
import { isPrivateSeoMode, isSeoEnabled, type SeoApplicationConfig } from './types'

export interface SeoEndpointOptions {
  applicationId: string
  routes?: RouteRecordRaw[] | (() => RouteRecordRaw[])
  seo?: SeoApplicationConfig
  root: string
  sitemapProvider?: SitemapProvider
  resolveSiteUrl: (request: SsrHttpRequest<any>) => string | Promise<string>
  existingEndpoints: readonly SsrEndpointDefinition<any>[]
}

const physicalFileExists = async (
  root: string,
  fileName: string
): Promise<boolean> => {
  try {
    await access(resolve(root, 'public', fileName))
    return true
  } catch {
    return false
  }
}

const dummyRequest = (
  pathname: string,
  applicationId: string
): SsrHttpRequest<any> => ({
  requestId: 'seo-endpoint-collision',
  url: `https://vue-ssr-lite.test${pathname}`,
  host: 'vue-ssr-lite.test',
  protocol: 'https',
  method: 'GET',
  headers: {},
  publicConfig: {},
  signal: new AbortController().signal,
  domain: {
    entry: applicationId,
    authority: 'vue-ssr-lite.test',
    protocol: 'https',
    port: '',
    hostname: 'vue-ssr-lite.test',
    baseDomain: 'vue-ssr-lite.test',
    subdomain: null,
    isCustomDomain: false,
    development: true,
    params: {},
  },
  pathname,
  search: '',
  entryId: applicationId,
})

const assertUniqueEndpoint = (
  existing: readonly SsrEndpointDefinition<any>[],
  pathname: string,
  applicationId: string,
  source: string
) => {
  const request = dummyRequest(pathname, applicationId)
  const conflict = existing.find((endpoint) => endpoint.match(request))
  if (!conflict) return
  throw new Error(
    `[vue-ssr-lite] Duplicate endpoint GET ${pathname}. "${conflict.id}" conflicts with "${source}".`
  )
}

const endpointHeaders = (contentType: string) => ({
  'content-type': contentType,
  'cache-control': 'public, max-age=3600',
})

export const createSeoEndpoints = async (
  options: SeoEndpointOptions
): Promise<SsrEndpointDefinition<any>[]> => {
  if (!isSeoEnabled(options.seo) || isPrivateSeoMode(options.seo)) return []

  const routes =
    typeof options.routes === 'function' ? options.routes() : options.routes
  const endpoints: SsrEndpointDefinition<any>[] = []
  const sitemapId = `${options.applicationId}-sitemap`
  const robotsId = `${options.applicationId}-robots`

  if (!(await physicalFileExists(options.root, 'sitemap.xml'))) {
    assertUniqueEndpoint(
      options.existingEndpoints,
      '/sitemap.xml',
      options.applicationId,
      sitemapId
    )
    endpoints.push({
      id: sitemapId,
      match: (request) => request.pathname === '/sitemap.xml',
      async handle(request) {
        const siteUrl = await options.resolveSiteUrl(request)
        const dynamic = options.sitemapProvider
          ? await options.sitemapProvider({
              applicationId: options.applicationId,
              siteUrl,
            })
          : []
        const body = serializeSitemapXml(
          mergeSitemapEntries(
            siteUrl,
            discoverStaticSitemapPaths(routes),
            dynamic
          )
        )
        return {
          statusCode: 200,
          body,
          headers: endpointHeaders('application/xml; charset=utf-8'),
        }
      },
    })
  }

  if (!(await physicalFileExists(options.root, 'robots.txt'))) {
    assertUniqueEndpoint(
      [...options.existingEndpoints, ...endpoints],
      '/robots.txt',
      options.applicationId,
      robotsId
    )
    endpoints.push({
      id: robotsId,
      match: (request) => request.pathname === '/robots.txt',
      async handle(request) {
        const siteUrl = await options.resolveSiteUrl(request)
        const hasSitemap =
          endpoints.some((endpoint) => endpoint.id === sitemapId) ||
          (await physicalFileExists(options.root, 'sitemap.xml'))
        return {
          statusCode: 200,
          body: serializeRobotsTxt(
            hasSitemap ? composeCanonicalUrl(siteUrl, '/sitemap.xml') : null,
            options.seo?.robotsTxt
          ),
          headers: endpointHeaders('text/plain; charset=utf-8'),
        }
      },
    })
  }

  return endpoints
}

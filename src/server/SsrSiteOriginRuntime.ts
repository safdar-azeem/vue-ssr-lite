import {
  PRODUCTION_ORIGIN_ERROR,
  assertPublicProductionOrigin,
  normalizeSiteOrigin,
  resolveCanonicalOrigin,
} from '../SsrCanonicalOrigin'
import type { SsrEntryKind, SsrHttpRequest } from '../SsrRuntimeTypes'
import {
  isPrivateSeoMode,
  isSeoEnabled,
  type SeoApplicationConfig,
} from '../extensions/seo/types'

/** Shared startup/request rule for authoritative public SEO origins. */
export const requiresProductionSeoOrigin = (
  kind: SsrEntryKind,
  seo: SeoApplicationConfig | undefined
): boolean =>
  kind === 'ssr' && isSeoEnabled(seo) && !isPrivateSeoMode(seo)

export interface ResolveServerSiteOriginOptions {
  siteUrl?: string
  publicUrl?: string
  resolveSiteUrl?: (
    request: SsrHttpRequest<any>
  ) => string | undefined | Promise<string | undefined>
  request: SsrHttpRequest<any>
  production: boolean
  requireProductionOrigin: boolean
  allowHttpOrigin?: boolean
}

export const resolveServerSiteOrigin = async (
  options: ResolveServerSiteOriginOptions
): Promise<string> => {
  const resolved = options.resolveSiteUrl
    ? await options.resolveSiteUrl(options.request)
    : undefined
  const fallbackOrigin = `${options.request.protocol}://${options.request.host}`
  return resolveCanonicalOrigin({
    siteUrl: options.siteUrl,
    requestOrigin: options.publicUrl || resolved,
    fallbackOrigin,
    production: options.production,
    requireProductionOrigin: options.requireProductionOrigin,
    allowHttpOrigin: options.allowHttpOrigin,
  })
}

export const readPublicUrl = (): string | undefined => {
  const value = String(process.env.PUBLIC_URL ?? '').trim()
  return value || undefined
}

export const assertProductionSeoOriginConfigured = (options: {
  siteUrl?: string
  resolveSiteUrl?: unknown
  allowHttpOrigin?: boolean
}): void => {
  const originOptions = { allowHttpOrigin: options.allowHttpOrigin }
  if (options.siteUrl) {
    assertPublicProductionOrigin(options.siteUrl, 'seo.siteUrl', originOptions)
    return
  }
  if (options.resolveSiteUrl) return
  const publicUrl = readPublicUrl()
  if (publicUrl) {
    assertPublicProductionOrigin(publicUrl, 'PUBLIC_URL', originOptions)
    return
  }
  throw new Error(PRODUCTION_ORIGIN_ERROR)
}

export const normalizeConfiguredOrigin = normalizeSiteOrigin

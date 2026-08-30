import {
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

/** Whether the request origin must satisfy public production SEO rules. */
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
  const fallbackOrigin = `${options.request.domain.protocol}://${options.request.domain.authority}`
  if (options.resolveSiteUrl) {
    const resolverOrigin = (await options.resolveSiteUrl(options.request))?.trim()
    const resolved =
      resolverOrigin ||
      options.siteUrl ||
      options.publicUrl
    return resolveCanonicalOrigin({
      requestOrigin: resolved,
      fallbackOrigin,
      production: options.production,
      requireProductionOrigin: options.requireProductionOrigin,
      allowHttpOrigin: options.allowHttpOrigin,
    })
  }
  return resolveCanonicalOrigin({
    siteUrl: options.siteUrl,
    requestOrigin: options.publicUrl,
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

/** Validate an explicit production override when one is configured. */
export const assertConfiguredProductionSeoOrigin = (options: {
  siteUrl?: string
  resolveSiteUrl?: unknown
  allowHttpOrigin?: boolean
}): void => {
  if (options.resolveSiteUrl) return
  const configured = options.siteUrl || readPublicUrl()
  if (!configured) return
  assertPublicProductionOrigin(
    configured,
    options.siteUrl ? 'seo.siteUrl' : 'PUBLIC_URL',
    { allowHttpOrigin: options.allowHttpOrigin },
  )
}

export const normalizeConfiguredOrigin = normalizeSiteOrigin

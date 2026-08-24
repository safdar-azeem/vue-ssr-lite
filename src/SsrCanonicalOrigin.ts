export const PRODUCTION_ORIGIN_ERROR = `[vue-ssr-lite] Missing PUBLIC_URL for production deployment.

Add:
PUBLIC_URL=https://example.com`

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1'])

export const isSsrProduction = (): boolean =>
  typeof process !== 'undefined' && process.env.NODE_ENV === 'production'

export const normalizeSiteOrigin = (
  value: string,
  label = 'site origin'
): string => {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`[vue-ssr-lite] ${label} must be a valid absolute URL.`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`[vue-ssr-lite] ${label} must use http or https.`)
  }
  if (!parsed.hostname) {
    throw new Error(`[vue-ssr-lite] ${label} must include a hostname.`)
  }
  return parsed.origin
}

export const PRODUCTION_HTTP_ORIGIN_ERROR = `[vue-ssr-lite] Public production origins must use https://.

Use PUBLIC_URL=https://example.com
Or set seo.allowHttpOrigin = true for an intentional local/unusual exception.`

export const assertPublicProductionOrigin = (
  origin: string,
  label = 'site origin',
  options: { allowHttpOrigin?: boolean } = {}
): string => {
  const normalized = normalizeSiteOrigin(origin, label)
  const parsed = new URL(normalized)
  if (LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `[vue-ssr-lite] ${label} cannot be a localhost origin in production.`
    )
  }
  if (parsed.protocol !== 'https:' && !options.allowHttpOrigin) {
    throw new Error(PRODUCTION_HTTP_ORIGIN_ERROR)
  }
  return normalized
}

export interface ResolveCanonicalOriginOptions {
  siteUrl?: string
  requestOrigin?: string
  fallbackOrigin?: string
  production: boolean
  requireProductionOrigin: boolean
  allowHttpOrigin?: boolean
}

export const resolveCanonicalOrigin = (
  options: ResolveCanonicalOriginOptions
): string => {
  const candidates = [
    options.siteUrl,
    options.requestOrigin,
    options.production ? undefined : options.fallbackOrigin,
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    const origin = options.production
      ? assertPublicProductionOrigin(candidate, 'site origin', {
          allowHttpOrigin: options.allowHttpOrigin,
        })
      : normalizeSiteOrigin(candidate)
    return origin
  }
  if (options.requireProductionOrigin && options.production) {
    throw new Error(PRODUCTION_ORIGIN_ERROR)
  }
  if (options.fallbackOrigin) {
    return normalizeSiteOrigin(options.fallbackOrigin)
  }
  throw new Error(PRODUCTION_ORIGIN_ERROR)
}

export const normalizeCanonicalPath = (
  path: string,
  trailingSlash = false
): string => {
  const raw = path.split(/[?#]/, 1)[0] || '/'
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`
  if (withLeading === '/') return '/'
  const stripped = withLeading.replace(/\/+$/, '')
  return trailingSlash ? `${stripped}/` : stripped
}

export const composeCanonicalUrl = (
  origin: string,
  path: string,
  trailingSlash = false
): string => {
  const normalizedOrigin = normalizeSiteOrigin(origin)
  const normalizedPath = normalizeCanonicalPath(path, trailingSlash)
  return `${normalizedOrigin}${normalizedPath}`
}

export const resolveCanonicalHref = (
  origin: string,
  activePath: string,
  canonical: string | false | undefined,
  trailingSlash = false
): string | null => {
  if (canonical === false) return null
  if (canonical == null || canonical === '') {
    return composeCanonicalUrl(origin, activePath, trailingSlash)
  }
  if (/^https?:\/\//i.test(canonical)) {
    const parsed = new URL(canonical)
    return `${parsed.origin}${normalizeCanonicalPath(parsed.pathname, trailingSlash)}`
  }
  return composeCanonicalUrl(origin, canonical, trailingSlash)
}

export const resolveAbsoluteAssetUrl = (
  origin: string,
  value: string | undefined
): string | undefined => {
  if (!value) return undefined
  if (/^https?:\/\//i.test(value) || value.startsWith('data:')) return value
  const path = value.startsWith('/') ? value : `/${value}`
  return `${normalizeSiteOrigin(origin)}${path}`
}

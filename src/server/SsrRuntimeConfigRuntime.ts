import type {
  SsrEndpointDefinition,
  SsrHttpRequest,
  SsrHttpResponse,
  SsrLogger,
} from '../SsrRuntimeTypes'
import { normalizeSsrHost } from './SsrHostRuntime'

/**
 * Declarative runtime-configuration helpers.
 *
 * Every SSR runtime definition re-implements the same env parsing, production
 * guards, host normalization, logger wiring, and robots/sitemap endpoints.
 * These helpers absorb that boilerplate so a runtime file shrinks to
 * declarative configuration. They contain zero application-specific logic.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])

/** Parse an env flag. Accepts 1/true/yes/on (case-insensitive). */
export const ssrEnvBoolean = (value: string | undefined): boolean =>
  TRUTHY.has(String(value ?? '').trim().toLowerCase())

/** Parse a positive number, falling back when absent or non-positive. */
export const ssrEnvNumber = (
  value: string | undefined,
  fallback: number
): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Parse a comma-separated list into trimmed, non-empty entries. */
export const ssrEnvList = (value: string | undefined): string[] =>
  String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

/**
 * Return a required env value or throw with an actionable message when
 * `production` is true. In development it returns the (possibly empty) value so
 * sane defaults can apply upstream.
 */
export const requireSsrEnv = (
  name: string,
  value: string | undefined,
  options: { production: boolean; message?: string } = { production: true }
): string => {
  const trimmed = String(value ?? '').trim()
  if (!trimmed && options.production) {
    throw new Error(options.message ?? `${name} is required in production.`)
  }
  return trimmed
}

/**
 * Normalize a required hostname env, throwing when invalid or (in production)
 * absent. Rejects a value carrying a port, which is a common misconfiguration.
 */
export const requireSsrHostname = (
  name: string,
  value: string | undefined,
  options: { production: boolean; fallback?: string }
): string => {
  const raw = requireSsrEnv(name, value, { production: options.production }) ||
    options.fallback ||
    ''
  const normalized = normalizeSsrHost(raw)
  if (!normalized || normalized.includes(':')) {
    throw new Error(`${name} must be a valid hostname without a port.`)
  }
  return normalized
}

/** Restrict a value to one of `allowed`, throwing otherwise. */
export const requireSsrEnum = <T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
  fallback: T
): T => {
  const candidate = (String(value ?? '').trim() || fallback) as T
  if (!allowed.includes(candidate)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}.`)
  }
  return candidate
}

/** A console-backed structured logger prefixed with the runtime name. */
export const createSsrConsoleLogger = (name: string): SsrLogger => ({
  info: (event, details) => console.info(`[${name}] ${event}`, details ?? ''),
  warn: (event, details) => console.warn(`[${name}] ${event}`, details ?? ''),
  error: (event, details) => console.error(`[${name}] ${event}`, details ?? ''),
})

const disallowRobots = 'User-agent: *\nDisallow: /\n'
const emptySitemap =
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n'

const contentTypeFor = (resource: 'robots.txt' | 'sitemap.xml') =>
  resource === 'robots.txt'
    ? 'text/plain; charset=utf-8'
    : 'application/xml; charset=utf-8'

export type SsrSeoEndpointMode = 'disallow' | 'inline' | 'proxy'

export interface SsrSeoEndpointOptions<TPublicConfig = unknown> {
  /**
   * - `disallow`: serve a blanket `Disallow: /` robots and an empty sitemap.
   * - `inline`: serve strings from `robots` / `sitemap` builders.
   * - `proxy`: fetch from the URL returned by `upstream`.
   */
  mode: SsrSeoEndpointMode
  /** Restrict to a single entry id. Applies to all entries when omitted. */
  entryId?: string
  /** Endpoint id. Defaults to `${entryId ?? 'ssr'}-seo-resources`. */
  id?: string
  cacheControl?: string
  /** `inline` mode: robots.txt body builder. */
  robots?: (
    request: SsrHttpRequest<TPublicConfig>
  ) => string | Promise<string>
  /** `inline` mode: sitemap.xml body builder. */
  sitemap?: (
    request: SsrHttpRequest<TPublicConfig>
  ) => string | Promise<string>
  /** `proxy` mode: resolves the upstream URL for a resource. */
  upstream?: (
    request: SsrHttpRequest<TPublicConfig>,
    resource: 'robots.txt' | 'sitemap.xml'
  ) => string
}

/**
 * Standard `robots.txt` / `sitemap.xml` endpoints. One helper, three modes,
 * so a runtime declares SEO resource behaviour instead of re-implementing it.
 */
export const createSsrSeoEndpoints = <TPublicConfig = unknown>(
  options: SsrSeoEndpointOptions<TPublicConfig>
): SsrEndpointDefinition<TPublicConfig>[] => {
  const cacheControl = options.cacheControl ?? 'no-store'
  const id = options.id ?? `${options.entryId ?? 'ssr'}-seo-resources`

  const inline = (
    resource: 'robots.txt' | 'sitemap.xml',
    body: string
  ): SsrHttpResponse => ({
    statusCode: 200,
    body,
    headers: {
      'content-type': contentTypeFor(resource),
      'cache-control': cacheControl,
      vary: 'Host, X-Forwarded-Host, X-Forwarded-Proto',
    },
  })

  return [
    {
      id,
      match: (request) =>
        (!options.entryId || request.entryId === options.entryId) &&
        (request.pathname === '/robots.txt' ||
          request.pathname === '/sitemap.xml'),
      async handle(request, tools) {
        const resource =
          request.pathname === '/robots.txt' ? 'robots.txt' : 'sitemap.xml'

        if (options.mode === 'disallow') {
          return inline(
            resource,
            resource === 'robots.txt' ? disallowRobots : emptySitemap
          )
        }

        if (options.mode === 'inline') {
          const body =
            resource === 'robots.txt'
              ? await options.robots?.(request)
              : await options.sitemap?.(request)
          return inline(
            resource,
            body ?? (resource === 'robots.txt' ? disallowRobots : emptySitemap)
          )
        }

        // proxy
        const target = options.upstream?.(request, resource)
        if (!target) return inline(resource, resource === 'robots.txt' ? disallowRobots : emptySitemap)
        try {
          const response = await fetch(target, {
            headers: {
              host: request.host,
              'x-forwarded-host': request.host,
              'x-forwarded-proto': request.protocol,
            },
            signal: tools.signal,
          })
          return {
            statusCode: response.status,
            body: new Uint8Array(await response.arrayBuffer()),
            headers: {
              'content-type':
                response.headers.get('content-type') || contentTypeFor(resource),
              'cache-control':
                response.headers.get('cache-control') || cacheControl,
              vary: 'Host, X-Forwarded-Host, X-Forwarded-Proto',
            },
          }
        } catch (error) {
          tools.logger?.warn?.('ssr.seo_proxy_failed', {
            resource,
            message: error instanceof Error ? error.message : String(error),
          })
          return {
            statusCode: 502,
            body: resource === 'robots.txt' ? disallowRobots : emptySitemap,
            headers: {
              'content-type': contentTypeFor(resource),
              'cache-control': 'no-store',
            },
          }
        }
      },
    },
  ]
}

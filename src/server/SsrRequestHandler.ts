import type { SsrCompiledConfig } from '../SsrConfigCompileRuntime'
import { resolveSsrDomainContext } from '../SsrDomainRuntime'
import { createSafeSsrLogger, safeSsrLog, safeSsrMetrics } from '../SsrObservability'
import { resolvePublicConfigValue } from '../SsrPublicConfig'
import { renderSsrApplication } from '../SsrRenderRuntime'
import type {
  SsrHeaders,
  SsrEndpointTools,
  SsrHttpRequest,
  SsrHttpResponse,
  SsrPublicConfigRequest,
} from '../SsrRuntimeTypes'
import { serializeSsrState } from '../SsrSerialization'
import type { SsrRenderedApplicationAsset } from '../SsrApplicationAssetRuntime'
import type { SsrViteManifest } from '../SsrRenderedAssetRuntime'
import { resolveRenderedApplicationAssets } from '../SsrRenderedAssetRuntime'
import {
  filterSsrCookieHeader,
  resolveSsrForwardedHost,
  resolveSsrForwardedProtocol,
  resolveSsrHostEntry,
} from './SsrHostRuntime'
import { injectSsrHtml, renderSsrErrorDocument } from './SsrHtmlRuntime'
import { isSsrResponseCacheable, resolveSsrResponseCacheKey } from './SsrResponseCacheRuntime'
import {
  readPublicUrl,
  requiresProductionSeoOrigin,
  resolveServerSiteOrigin,
} from './SsrSiteOriginRuntime'
import { resolveSiteSeoForRequest, SeoProviderFailure } from '../extensions/seo/SeoEndpoints'
import { isPrivateSeoMode } from '../extensions/seo/types'

export class SsrRequestTimeoutError extends Error {
  constructor() {
    super('SSR request timed out.')
    this.name = 'SsrRequestTimeoutError'
  }
}

export class SsrRequestCancelledError extends Error {
  constructor() {
    super('SSR request was cancelled.')
    this.name = 'SsrRequestCancelledError'
  }
}

class SsrErrorRendererTimeoutError extends Error {
  constructor() {
    super('SSR error renderer timed out.')
    this.name = 'SsrErrorRendererTimeoutError'
  }
}

const SSR_ERROR_RENDER_TIMEOUT_MS = 250

const runBoundedErrorRenderer = async <T>(
  work: () => T | Promise<T>,
  signal: AbortSignal
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new SsrErrorRendererTimeoutError()),
      SSR_ERROR_RENDER_TIMEOUT_MS
    )
  })
  const aborted = signal.aborted
    ? undefined
    : new Promise<never>((_resolve, reject) => {
        onAbort = () =>
          reject(signal.reason instanceof Error ? signal.reason : new SsrRequestCancelledError())
        signal.addEventListener('abort', onAbort, { once: true })
      })
  try {
    const workResult = Promise.resolve().then(work)
    return await Promise.race(aborted ? [workResult, timeout, aborted] : [workResult, timeout])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

export interface SsrRequestScope {
  /** The sole cancellation signal for this request and all downstream work. */
  readonly signal: AbortSignal
  readonly remainingMs: () => number
  cancel(reason?: Error): void
  run<T>(work: () => T | Promise<T>): Promise<T>
  throwIfAborted(): void
  dispose(): void
}

export const createSsrRequestScope = (timeoutMs: number): SsrRequestScope => {
  const controller = new AbortController()
  const finiteTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
  const deadline = finiteTimeout ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | undefined
  if (finiteTimeout) {
    timer = setTimeout(() => controller.abort(new SsrRequestTimeoutError()), timeoutMs)
  }
  const abortReason = (): Error =>
    controller.signal.reason instanceof Error
      ? controller.signal.reason
      : new SsrRequestCancelledError()
  return {
    signal: controller.signal,
    remainingMs: () => (Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : 0),
    cancel: (reason = new SsrRequestCancelledError()) => {
      if (!controller.signal.aborted) controller.abort(reason)
    },
    throwIfAborted: () => {
      if (controller.signal.aborted) throw abortReason()
    },
    run: async <T>(work: () => T | Promise<T>): Promise<T> => {
      if (controller.signal.aborted) throw abortReason()
      let onAbort: (() => void) | undefined
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortReason())
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        return await Promise.race([Promise.resolve().then(work), aborted])
      } finally {
        if (onAbort) controller.signal.removeEventListener('abort', onAbort)
      }
    },
    dispose: () => {
      if (timer) clearTimeout(timer)
      if (!controller.signal.aborted) controller.abort(new SsrRequestCancelledError())
    },
  }
}

/** Node-free facts captured by the transport before entering SSR Core. */
export interface SsrNormalizedRequest {
  readonly requestId: string
  readonly startedAt: number
  readonly method: string
  readonly url: string
  readonly headers: SsrHeaders
  readonly protocol: 'http' | 'https'
}

export interface SsrRequestHandlerRuntime {
  readonly production: boolean
  /** Owns the request deadline and transport-triggered cancellation. */
  readonly scope: SsrRequestScope
  readonly loadDefinition: () => Promise<SsrCompiledConfig>
  readonly fallbackDefinition: () => SsrCompiledConfig
  readonly shuttingDown: () => boolean
  readonly assertReady: (definition: SsrCompiledConfig) => Promise<void>
  readonly viteBase: string
  readonly ssrManifest?: SsrViteManifest
  readonly loadTemplate: (
    definition: SsrCompiledConfig,
    entry: SsrCompiledConfig['applications'][number],
    requestUrl: string,
    signal?: AbortSignal
  ) => Promise<string>
  readonly loadPreparedSsrTemplate: (
    definition: SsrCompiledConfig,
    entry: SsrCompiledConfig['applications'][number],
    requestUrl: string,
    signal?: AbortSignal
  ) => Promise<string>
  readonly resolveDevelopmentAssets: (
    applicationId: string,
    modules: readonly string[]
  ) => Promise<readonly SsrRenderedApplicationAsset[]>
  /** Static streaming remains an outer-transport operation. */
  readonly isPrivateProductionAssetPath: (pathname: string) => boolean
  readonly serveProductionAsset: (
    pathname: string,
    protectedTemplates: readonly string[],
    signal: AbortSignal
  ) => Promise<boolean>
  /** Vite owns its Node middleware response in development. */
  readonly serveViteRequest?: () => Promise<boolean>
}

export type SsrRequestHandlerResult = SsrHttpResponse | undefined

const htmlSecurityHeaders = {
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
}

const headerValue = (
  headers: SsrHeaders,
  name: string
): string | readonly string[] | undefined => {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name)
  return found?.[1]
}

const hasPathExtension = (pathname: string): boolean => {
  const segment = pathname.slice(pathname.lastIndexOf('/') + 1)
  return segment !== '.' && segment !== '..' && segment.lastIndexOf('.') > 0
}

const isHtmlNavigation = (request: SsrNormalizedRequest, pathname: string): boolean => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  if (headerValue(request.headers, 'sec-fetch-mode') === 'navigate') return true
  const accept = String(headerValue(request.headers, 'accept') || '')
  if (accept.includes('text/html')) return true
  return (!accept || accept === '*/*') && !hasPathExtension(pathname)
}

const jsonResponse = (statusCode: number, payload: Record<string, unknown>): SsrHttpResponse => ({
  statusCode,
  body: JSON.stringify(payload),
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  },
})

const validateSsrHttpResponse = (response: SsrHttpResponse): SsrHttpResponse => {
  if (
    !Number.isInteger(response.statusCode) ||
    response.statusCode < 100 ||
    response.statusCode > 599
  ) {
    throw new Error(`[vue-ssr-lite] Invalid endpoint response status ${String(response.statusCode)}.`)
  }
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error(`[vue-ssr-lite] Invalid response header name "${name}".`)
    }
    const values = Array.isArray(value) ? value : [value]
    if (values.some((item) => /[\u0000-\u001f\u007f]/.test(item))) {
      throw new Error(`[vue-ssr-lite] Response header "${name}" contains control characters.`)
    }
  }
  return response
}

const snapshotRequestDomain = (
  domain: ReturnType<typeof resolveSsrDomainContext>
): ReturnType<typeof resolveSsrDomainContext> =>
  Object.freeze({ ...domain, params: Object.freeze({ ...domain.params }) })

const injectSpaDomainState = (
  template: string,
  applicationId: string,
  domain: ReturnType<typeof resolveSsrDomainContext>,
  publicConfig: unknown
): string => {
  const payload = serializeSsrState({ version: 1, applicationId, domain, publicConfig })
  const tag = `<script type="application/json" id="vue-ssr-lite-domain">${payload}</script>`
  return template.includes('</body>')
    ? template.replace(/<\/body>/i, `\t${tag}\n</body>`)
    : `${template}\n${tag}`
}

/**
 * Process one normalized request without access to Node request/response
 * objects. The two optional transport callbacks are deliberately limited to
 * byte streaming and Vite middleware, whose lifecycle remains Node-owned.
 */
export const handleSsrRequest = async (
  request: SsrNormalizedRequest,
  runtime: SsrRequestHandlerRuntime
): Promise<SsrRequestHandlerResult> => {
  const { scope } = runtime
  const signal = scope.signal
  let pathname = '/'
  let rawAssetPathname = '/'
  let selectedEntryId = 'unknown'
  let activeRenderRequest: SsrHttpRequest<any> | undefined
  let activeDefinition = runtime.fallbackDefinition()

  try {
    const definition = await scope.run(runtime.loadDefinition)
    activeDefinition = definition
    const serverOptions = definition.server
    const requestUrl = new URL(request.url || '/', 'http://internal')
    pathname = requestUrl.pathname
    rawAssetPathname = (request.url || '/').split('?', 1)[0]

    if (pathname === serverOptions.healthPath) {
      return jsonResponse(200, {
        status: 'ok',
        service: definition.name,
        role: serverOptions.role || 'default',
        timestamp: new Date(request.startedAt).toISOString(),
      })
    }
    if (pathname === serverOptions.readinessPath) {
      if (runtime.shuttingDown()) {
        return jsonResponse(503, {
          status: 'error',
          service: definition.name,
          message: 'Server is shutting down.',
        })
      }
      try {
        await scope.run(() => runtime.assertReady(definition))
        return jsonResponse(200, {
          status: 'ok',
          service: definition.name,
          role: serverOptions.role || 'default',
        })
      } catch {
        return jsonResponse(503, {
          status: 'error',
          service: definition.name,
          message: 'A required dependency is unavailable.',
        })
      }
    }

    if (
      runtime.production &&
      (runtime.isPrivateProductionAssetPath(rawAssetPathname) ||
        runtime.isPrivateProductionAssetPath(pathname))
    ) {
      return jsonResponse(404, {
        status: 'error',
        service: definition.name,
        message: 'Resource not found.',
      })
    }

    const incomingHost = resolveSsrForwardedHost(
      headerValue(request.headers, 'x-forwarded-host'),
      headerValue(request.headers, 'host'),
      serverOptions.trustProxy
    )
    if (!incomingHost) {
      const html = isHtmlNavigation(request, pathname)
      return {
        statusCode: 400,
        body: html
          ? renderSsrErrorDocument('Invalid request', 'The Host header is invalid.')
          : JSON.stringify({ status: 'error', message: 'Invalid Host header.' }),
        headers: {
          'content-type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          ...htmlSecurityHeaders,
        },
      }
    }
    const hostResolution = resolveSsrHostEntry(
      definition.applications,
      incomingHost,
      definition.defaultApplicationId
    )
    if (!hostResolution) {
      return jsonResponse(421, {
        status: 'error',
        service: definition.name,
        message: 'No application serves this host.',
      })
    }
    const entry = hostResolution.entry
    selectedEntryId = entry.id
    const requestRender = entry.resolveRouteRender
      ? await scope.run(() => entry.resolveRouteRender!(`${pathname}${requestUrl.search}`))
      : entry.kind
    safeSsrLog(serverOptions.logger, 'debug', 'ssr.host_resolved', {
      entryId: entry.id,
      category: hostResolution.category,
      specificity: hostResolution.specificity,
      matchedPattern: hostResolution.matchedPattern,
      hostname: hostResolution.normalizedHostname,
      role: serverOptions.role || 'default',
    })
    if (entry.roles?.length && serverOptions.role && !entry.roles.includes(serverOptions.role)) {
      const message = `Runtime role does not serve application "${entry.id}".`
      const html = isHtmlNavigation(request, pathname)
      return {
        statusCode: 421,
        body: html
          ? renderSsrErrorDocument('Misdirected request', message)
          : JSON.stringify({ status: 'error', message }),
        headers: {
          'content-type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          ...htmlSecurityHeaders,
        },
      }
    }

    const protocol = resolveSsrForwardedProtocol(
      headerValue(request.headers, 'x-forwarded-proto'),
      request.protocol,
      serverOptions.trustProxy
    )
    const domain = snapshotRequestDomain(
      resolveSsrDomainContext(incomingHost, entry, definition.development, protocol)
    )
    const cookie = filterSsrCookieHeader(
      headerValue(request.headers, 'cookie'),
      entry.cookieAllowlist,
      entry.cookieDenylist
    )
    const url = new URL(
      `${requestUrl.pathname}${requestUrl.search}`,
      `${protocol}://${incomingHost}`
    ).href
    const publicConfigRequest: SsrPublicConfigRequest = Object.freeze({
      requestId: request.requestId,
      url,
      host: incomingHost,
      protocol,
      method: request.method,
      headers: request.headers,
      cookie,
      domain,
      signal,
      pathname,
      search: requestUrl.search,
      entryId: entry.id,
    })
    const publicConfig = await scope.run(() =>
      resolvePublicConfigValue(entry.publicConfigFactory ?? entry.publicConfig, publicConfigRequest)
    )
    const renderRequest: SsrHttpRequest<any> = {
      requestId: request.requestId,
      url,
      host: incomingHost,
      protocol,
      method: request.method,
      headers: request.headers,
      cookie,
      publicConfig,
      signal,
      domain,
      pathname,
      search: requestUrl.search,
      entryId: entry.id,
    }
    activeRenderRequest = renderRequest
    renderRequest.siteOrigin = await scope.run(() =>
      resolveServerSiteOrigin({
        siteUrl: entry.application?.seo?.siteUrl,
        publicUrl: readPublicUrl(),
        resolveSiteUrl: definition.resolveSiteUrl,
        request: renderRequest,
        production: runtime.production,
        requireProductionOrigin: requiresProductionSeoOrigin(
          requestRender === 'spa' && !entry.hasRouteRenderOverrides ? 'spa' : 'ssr',
          entry.application?.seo
        ),
        allowHttpOrigin: entry.application?.seo?.allowHttpOrigin,
      })
    )
    const needsSiteSeo =
      isHtmlNavigation(request, pathname) ||
      pathname === '/robots.txt' ||
      pathname === '/sitemap.xml' ||
      /^\/sitemap-[1-9]\d*\.xml$/.test(pathname)
    if (needsSiteSeo) {
      const resolution = await scope.run(() =>
        resolveSiteSeoForRequest(renderRequest, entry.id, renderRequest.siteOrigin!, entry.siteSeo)
      )
      if (resolution?.status === 'not-found') {
        return {
          statusCode: resolution.responseStatus ?? 404,
          headers: { 'cache-control': 'private, no-store' },
        }
      }
    }

    const endpointTools: SsrEndpointTools = {
      signal,
      logger: createSafeSsrLogger(serverOptions.logger),
    }
    for (const endpoint of entry.endpoints) {
      if (!endpoint.match(renderRequest)) continue
      const result = await scope.run(() => endpoint.handle(renderRequest, endpointTools))
      if (result) return validateSsrHttpResponse(result)
    }

    if (runtime.production && (request.method === 'GET' || request.method === 'HEAD')) {
      if (
        await scope.run(() =>
          runtime.serveProductionAsset(
            rawAssetPathname,
            definition.applications.map(({ template }) => template),
            signal
          )
        )
      ) {
        return undefined
      }
    } else if (
      runtime.serveViteRequest &&
      (pathname.startsWith('/src/') ||
        pathname.startsWith('/@') ||
        pathname.includes('.') ||
        pathname === '/__vite_ping')
    ) {
      if (await scope.run(runtime.serveViteRequest)) return undefined
    }

    if (!isHtmlNavigation(request, pathname)) {
      return jsonResponse(404, {
        status: 'error',
        service: definition.name,
        message: 'Resource not found.',
      })
    }

    const privateSeoHtml = requestRender === 'ssr' && isPrivateSeoMode(entry.application?.seo)
    const responseCache = requestRender === 'ssr' && !privateSeoHtml ? entry.responseCache : undefined
    let responseCacheKey: string | null = null
    try {
      responseCacheKey = await scope.run(() =>
        resolveSsrResponseCacheKey(entry.id, renderRequest, responseCache)
      )
    } catch (error) {
      scope.throwIfAborted()
      safeSsrLog(serverOptions.logger, 'warn', 'ssr.cache.key.failed', {
        entryId: entry.id,
        requestId: renderRequest.requestId,
        error: error instanceof Error ? error.message : 'Unknown cache error',
      })
    }
    if (responseCache && responseCacheKey) {
      let cachedResponse: SsrHttpResponse | null = null
      try {
        cachedResponse = await scope.run(() =>
          responseCache.store.get(responseCacheKey!, { signal })
        )
      } catch (error) {
        scope.throwIfAborted()
        safeSsrLog(serverOptions.logger, 'warn', 'ssr.cache.read.failed', {
          entryId: entry.id,
          requestId: renderRequest.requestId,
          error: error instanceof Error ? error.message : 'Unknown cache error',
        })
      }
      if (cachedResponse) {
        return validateSsrHttpResponse({
          ...cachedResponse,
          headers: { ...cachedResponse.headers, 'server-timing': 'cache;desc="hit"' },
        })
      }
    }

    if (requestRender === 'spa') {
      const template = await scope.run(() =>
        runtime.loadTemplate(definition, entry, request.url || '/', signal)
      )
      return {
        statusCode: 200,
        body: injectSpaDomainState(template, entry.id, domain, publicConfig),
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': entry.cacheControl || 'private, no-store',
          vary: 'Host, X-Forwarded-Host',
          ...htmlSecurityHeaders,
        },
      }
    }

    const application = entry.application!
    const template = await scope.run(() =>
      runtime.loadPreparedSsrTemplate(definition, entry, request.url || '/', signal)
    )
    const remainingRequestMs = scope.remainingMs()
    const configuredResolutionMs = serverOptions.resolutionDeadlineMs
    const resolutionDeadlineMs =
      remainingRequestMs > 0
        ? Math.min(configuredResolutionMs, remainingRequestMs)
        : configuredResolutionMs
    const rendered = await scope.run(() =>
      renderSsrApplication(application, renderRequest, {
        maxResolutionPasses: serverOptions.maxResolutionPasses,
        resolutionDeadlineMs,
        diagnostics: serverOptions.diagnostics,
        logger: serverOptions.logger,
      })
    )
    if (rendered.response.redirect) {
      const redirect = rendered.response.redirect
      const target = new URL(redirect.location, renderRequest.url)
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error('SSR redirects must use HTTP or HTTPS.')
      }
      if (target.username || target.password || /[\u0000-\u001f\u007f]/.test(redirect.location)) {
        throw new Error('SSR redirects must not contain credentials or control characters.')
      }
      if (!redirect.allowExternal && target.origin !== new URL(renderRequest.url).origin) {
        throw new Error('Cross-origin redirect requires allowExternal: true.')
      }
      return {
        statusCode: redirect.statusCode ?? 302,
        headers: { location: target.href, 'cache-control': 'no-store' },
      }
    }
    const renderedAssets = runtime.production
      ? resolveRenderedApplicationAssets({
          applicationId: application.id,
          moduleIds: rendered.renderedModules,
          base: runtime.viteBase,
          manifest: runtime.ssrManifest!,
        })
      : await scope.run(() =>
          runtime.resolveDevelopmentAssets(application.id, rendered.renderedModules)
        )
    const document = injectSsrHtml(template, {
      applicationId: application.id,
      html: rendered.html,
      teleports: rendered.teleports,
      head: rendered.head,
      state: rendered.hydrationState,
      assets: renderedAssets,
    })
    safeSsrMetrics(serverOptions.onMetrics, rendered.metrics)
    safeSsrLog(serverOptions.logger, 'info', 'ssr.render.complete', rendered.metrics as any)
    const responseHeaders: Record<string, string | string[]> = {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': entry.cacheControl || 'private, no-store',
      vary: 'Host, X-Forwarded-Host',
      'server-timing': [
        `context;dur=${rendered.metrics.contextDurationMs.toFixed(1)}`,
        `route;dur=${rendered.metrics.routeDurationMs.toFixed(1)}`,
        `render;dur=${rendered.metrics.renderDurationMs.toFixed(1)}`,
      ].join(', '),
      ...rendered.response.headers,
      ...htmlSecurityHeaders,
    }
    if (privateSeoHtml) {
      for (const name of Object.keys(responseHeaders)) {
        if (name.toLowerCase() === 'cache-control') delete responseHeaders[name]
      }
      responseHeaders['cache-control'] = 'private, no-store'
    }
    const result: SsrHttpResponse = {
      statusCode: rendered.response.statusCode,
      body: document,
      headers: responseHeaders,
    }
    if (responseCache && responseCacheKey && isSsrResponseCacheable(result, renderRequest, responseCache)) {
      try {
        const consumerTags = await scope.run(() => responseCache.tags?.(renderRequest) ?? [])
        const tags = [...consumerTags, ...(renderRequest.siteSeoMeta?.cacheTags ?? [])]
        await scope.run(() =>
          responseCache.store.set(responseCacheKey!, result, {
            ttlMs: responseCache.ttlMs,
            tags,
            signal,
          })
        )
      } catch (error) {
        scope.throwIfAborted()
        safeSsrLog(serverOptions.logger, 'warn', 'ssr.cache.write.failed', {
          entryId: entry.id,
          requestId: renderRequest.requestId,
          error: error instanceof Error ? error.message : 'Unknown cache error',
        })
      }
    }
    return result
  } catch (error) {
    if (error instanceof SsrRequestCancelledError) throw error
    const definition = activeDefinition
    safeSsrLog(definition.server.logger, 'error', 'ssr.request.failed', {
      requestId: request.requestId,
      entryId: selectedEntryId,
      pathname,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    let timeout =
      error instanceof SsrRequestTimeoutError ||
      signal.reason instanceof SsrRequestTimeoutError
    const seoProviderFailure =
      error instanceof SeoProviderFailure ||
      pathname === '/robots.txt' ||
      pathname === '/sitemap.xml' ||
      /^\/sitemap-[1-9]\d*\.xml$/.test(pathname)
    let statusCode = timeout ? 504 : seoProviderFailure ? 503 : 500
    if (definition.server.renderError) {
      try {
        const renderedError = await runBoundedErrorRenderer(
          () =>
            definition.server.renderError!({
              error,
              kind: timeout ? 'timeout' : 'internal',
              production: runtime.production,
              request: activeRenderRequest,
              entryId: selectedEntryId === 'unknown' ? undefined : selectedEntryId,
            }),
          signal
        )
        if (renderedError) {
          return validateSsrHttpResponse({
            ...renderedError,
            statusCode: renderedError.statusCode >= 400 ? renderedError.statusCode : statusCode,
            headers: {
              ...renderedError.headers,
              'cache-control': 'no-store',
              ...htmlSecurityHeaders,
            },
          })
        }
      } catch (renderError) {
        if (renderError instanceof SsrRequestTimeoutError) {
          timeout = true
          statusCode = 504
        }
        safeSsrLog(definition.server.logger, 'error', 'ssr.error-renderer.failed', {
          entryId: selectedEntryId,
          error: renderError instanceof Error ? renderError.message : 'Unknown error renderer failure',
        })
      }
    }
    if (isHtmlNavigation(request, pathname)) {
      return {
        statusCode,
        body: renderSsrErrorDocument(
          timeout ? 'Request timed out' : 'Application unavailable',
          runtime.production
            ? 'The application could not render this page. Please try again.'
            : error instanceof Error
              ? error.message
              : 'Unknown rendering failure.'
        ),
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          ...htmlSecurityHeaders,
        },
      }
    }
    return jsonResponse(statusCode, { status: 'error', service: definition.name })
  }
}

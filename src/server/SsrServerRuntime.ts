import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import type { ViteDevServer } from 'vite'
import {
  compileSsrConfig,
  type SsrCompiledConfig,
} from '../SsrConfigCompileRuntime'
import { resolveSsrDomainContext } from '../SsrDomainRuntime'
import { renderSsrApplication } from '../SsrRenderRuntime'
import type {
  SsrHeaders,
  SsrEndpointTools,
  SsrHttpRequest,
  SsrHttpResponse,
} from '../SsrRuntimeTypes'
import { serializeSsrState } from '../SsrSerialization'
import { resolveSsrProductionAsset } from './SsrAssetRuntime'
import {
  filterSsrCookieHeader,
  resolveSsrForwardedHost,
  resolveSsrForwardedProtocol,
  resolveSsrHostEntry,
} from './SsrHostRuntime'
import {
  injectSsrHtml,
  prepareSsrHtmlTemplate,
  renderSsrErrorDocument,
} from './SsrHtmlRuntime'
import {
  isSsrResponseCacheable,
  resolveSsrResponseCacheKey,
} from './SsrResponseCacheRuntime'

export interface SsrManagedServerOptions {
  production: boolean
  root: string
  loadRuntime: () => Promise<unknown>
  vite?: ViteDevServer
}

export interface SsrManagedServer {
  nodeServer: ReturnType<typeof createServer>
  listen: () => Promise<void>
  close: () => Promise<void>
  address: () => { host: string; port: number }
}

class SsrRequestTimeoutError extends Error {
  constructor() {
    super('SSR request timed out.')
    this.name = 'SsrRequestTimeoutError'
  }
}

const parsePort = (value: number | undefined): number => {
  const port = value ?? 4173
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('SSR server port must be an integer between 0 and 65535.')
  }
  return port
}

const resolveLocalDisplayHost = (host: string): string => {
  if (host === '0.0.0.0' || host === '::' || host === '::1') return 'localhost'
  return host
}

const logServerReady = (host: string, port: number, role: string) => {
  const localUrl = `http://${resolveLocalDisplayHost(host)}:${port}/`
  console.log(
    [
      '',
      '✓  Server Ready',
      '',
      `  ➜ Local:  ${localUrl}`,
      `  ➜ Role:   ${role}`,
      '',
    ].join('\n')
  )
}

const resolveRuntime = async (
  loaded: unknown,
  options: Pick<SsrManagedServerOptions, 'root' | 'vite' | 'production'>
): Promise<SsrCompiledConfig> => {
  const definition = await compileSsrConfig(loaded, {
    development: !options.production,
    root: options.root,
    importModule: options.vite
      ? async (specifier) =>
          (await options.vite!.ssrLoadModule(specifier)) as Record<
            string,
            unknown
          >
      : undefined,
  })
  for (const application of definition.applications) {
    const enabledForRole =
      !application.roles?.length ||
      !definition.server.role ||
      application.roles.includes(definition.server.role)
    if (application.kind === 'ssr' && enabledForRole && !application.application) {
      throw new Error(
        `SSR application "${application.id}" requires an ssr application definition.`
      )
    }
  }
  return definition
}

const injectSpaDomainState = (
  template: string,
  applicationId: string,
  domain: ReturnType<typeof resolveSsrDomainContext>,
  publicConfig: Record<string, unknown>
): string => {
  const payload = serializeSsrState({
    version: 1,
    applicationId,
    domain,
    publicConfig,
  })
  const tag = `<script type="application/json" id="vue-ssr-lite-domain">${payload}</script>`
  if (template.includes('</body>')) {
    return template.replace(/<\/body>/i, `\t${tag}\n</body>`)
  }
  return `${template}\n${tag}`
}

const htmlSecurityHeaders = {
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
}

const isHtmlNavigation = (request: IncomingMessage, pathname: string): boolean => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  if (request.headers['sec-fetch-mode'] === 'navigate') return true
  const accept = String(request.headers.accept || '')
  if (accept.includes('text/html')) return true
  return (!accept || accept === '*/*') && !extname(pathname)
}

const endResponse = (
  request: IncomingMessage,
  response: ServerResponse,
  body: string | Uint8Array = ''
) => response.end(request.method === 'HEAD' ? '' : body)

const sendResponse = (
  request: IncomingMessage,
  response: ServerResponse,
  result: SsrHttpResponse
) => {
  response.writeHead(result.statusCode, result.headers ?? {})
  endResponse(request, response, result.body ?? '')
}

const sendJson = (
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>
) =>
  sendResponse(request, response, {
    statusCode,
    body: JSON.stringify(payload),
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController
): Promise<T> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      reject(new SsrRequestTimeoutError())
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

const requestHeaders = (request: IncomingMessage): SsrHeaders =>
  request.headers as SsrHeaders

const runViteMiddleware = (
  vite: ViteDevServer,
  request: IncomingMessage,
  response: ServerResponse
) =>
  new Promise<void>((resolveMiddleware, reject) => {
    vite.middlewares(request, response, (error?: Error) => {
      if (error) reject(error)
      else resolveMiddleware()
    })
  })

export const createSsrManagedServer = async (
  options: SsrManagedServerOptions
): Promise<SsrManagedServer> => {
  let shuttingDown = false
  const initialRuntime = await resolveRuntime(await options.loadRuntime(), options)
  const initialServerOptions = initialRuntime.server
  const host = initialServerOptions.host || '0.0.0.0'
  const port = parsePort(initialServerOptions.port)
  const clientRoot = resolve(
    initialServerOptions.root || options.root,
    initialServerOptions.clientOutDir || 'dist/client'
  )

  const loadDefinition = async () =>
    options.production
      ? initialRuntime
      : resolveRuntime(await options.loadRuntime(), options)

  const loadTemplate = async (
    definition: SsrCompiledConfig,
    templateName: string,
    requestUrl: string
  ) => {
    const runtimeRoot = definition.server.root || options.root
    const template = await readFile(
      resolve(options.production ? clientRoot : runtimeRoot, templateName),
      'utf8'
    )
    if (options.production || !options.vite) return template
    const templateUrl = `/${templateName
      .replaceAll('\\', '/')
      .replace(/^\/+/, '')}`
    return options.vite.transformIndexHtml(templateUrl, template, requestUrl)
  }

  const assertReady = async (definition: SsrCompiledConfig) => {
    const runtimeRoot = definition.server.root || options.root
    const enabledApplications = definition.applications.filter(
      (application) =>
        !application.roles?.length ||
        !definition.server.role ||
        application.roles.includes(definition.server.role)
    )
    await Promise.all(
      enabledApplications.map(async (application) => {
        const information = await stat(
          resolve(
            options.production ? clientRoot : runtimeRoot,
            application.template
          )
        )
        if (!information.isFile()) {
          throw new Error(`SSR client entry is missing: ${application.template}`)
        }
      })
    )
    await Promise.all((definition.readiness ?? []).map((probe) => probe.run()))
  }

  // Startup preflight validates applications and module shape without running
  // network readiness probes. `/readyz` owns external dependency checks.
  const initialEnabledApplications = initialRuntime.applications.filter(
    (application) =>
      !application.roles?.length ||
      !initialRuntime.server.role ||
      application.roles.includes(initialRuntime.server.role)
  )
  await Promise.all(
    initialEnabledApplications.map(async (application) => {
      const runtimeRoot = initialRuntime.server.root || options.root
      const information = await stat(
        resolve(
          options.production ? clientRoot : runtimeRoot,
          application.template
        )
      )
      if (!information.isFile()) {
        throw new Error(`Missing client entry: ${application.template}`)
      }
    })
  )

  const nodeServer = createServer(async (request, response) => {
    const startedAt = Date.now()
    let pathname = '/'
    let selectedEntryId = 'unknown'
    let activeRenderRequest: SsrHttpRequest<any> | undefined
    const controller = new AbortController()
    request.once('aborted', () => controller.abort())
    response.once('close', () => {
      if (!response.writableEnded) controller.abort()
    })

    try {
      const definition = await loadDefinition()
      const serverOptions = definition.server
      const requestUrl = new URL(request.url || '/', 'http://internal')
      pathname = requestUrl.pathname
      const healthPath = serverOptions.healthPath || '/healthz'
      const readinessPath = serverOptions.readinessPath || '/readyz'

      if (pathname === healthPath) {
        return sendJson(request, response, 200, {
          status: 'ok',
          service: definition.name,
          role: serverOptions.role || 'default',
          timestamp: new Date(startedAt).toISOString(),
        })
      }
      if (pathname === readinessPath) {
        if (shuttingDown) {
          return sendJson(request, response, 503, {
            status: 'error',
            service: definition.name,
            message: 'Server is shutting down.',
          })
        }
        try {
          await assertReady(definition)
          return sendJson(request, response, 200, {
            status: 'ok',
            service: definition.name,
            role: serverOptions.role || 'default',
          })
        } catch {
          return sendJson(request, response, 503, {
            status: 'error',
            service: definition.name,
            message: 'A required dependency is unavailable.',
          })
        }
      }

      const incomingHost = resolveSsrForwardedHost(
        request.headers['x-forwarded-host'],
        request.headers.host,
        serverOptions.trustProxy
      )
      if (!incomingHost) {
        return sendResponse(request, response, {
          statusCode: 400,
          body: isHtmlNavigation(request, pathname)
            ? renderSsrErrorDocument('Invalid request', 'The Host header is invalid.')
            : JSON.stringify({ status: 'error', message: 'Invalid Host header.' }),
          headers: {
            'content-type': isHtmlNavigation(request, pathname)
              ? 'text/html; charset=utf-8'
              : 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            ...htmlSecurityHeaders,
          },
        })
      }
      const hostResolution = resolveSsrHostEntry(
        definition.applications,
        incomingHost,
        definition.defaultApplicationId
      )
      if (!hostResolution) {
        return sendJson(request, response, 421, {
          status: 'error',
          service: definition.name,
          message: 'No application serves this host.',
        })
      }
      const entry = hostResolution.entry
      selectedEntryId = entry.id
      serverOptions.logger?.debug?.('ssr.host_resolved', {
        entryId: entry.id,
        category: hostResolution.category,
        specificity: hostResolution.specificity,
        matchedPattern: hostResolution.matchedPattern,
        hostname: hostResolution.normalizedHostname,
        role: serverOptions.role || 'default',
      })
      if (
        entry.roles?.length &&
        serverOptions.role &&
        !entry.roles.includes(serverOptions.role)
      ) {
        const message = `Runtime role does not serve application "${entry.id}".`
        return sendResponse(request, response, {
          statusCode: 421,
          body: isHtmlNavigation(request, pathname)
            ? renderSsrErrorDocument('Misdirected request', message)
            : JSON.stringify({ status: 'error', message }),
          headers: {
            'content-type': isHtmlNavigation(request, pathname)
              ? 'text/html; charset=utf-8'
              : 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            ...htmlSecurityHeaders,
          },
        })
      }

      const protocol = resolveSsrForwardedProtocol(
        request.headers['x-forwarded-proto'],
        (request.socket as any).encrypted ? 'https' : 'http',
        serverOptions.trustProxy
      )
      const domain = resolveSsrDomainContext(
        incomingHost,
        entry,
        definition.development
      )
      const cookie = filterSsrCookieHeader(
        request.headers.cookie,
        entry.cookieAllowlist,
        entry.cookieDenylist
      )
      const renderRequest: SsrHttpRequest<any> = {
        requestId:
          String(request.headers['x-request-id'] || '').trim() ||
          `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        url: new URL(
          `${requestUrl.pathname}${requestUrl.search}`,
          `${protocol}://${incomingHost}`
        ).href,
        host: incomingHost,
        protocol,
        method: request.method || 'GET',
        headers: requestHeaders(request),
        cookie,
        publicConfig: entry.publicConfig,
        domain,
        signal: controller.signal,
        pathname,
        search: requestUrl.search,
        entryId: entry.id,
      }
      activeRenderRequest = renderRequest
      const endpointTools: SsrEndpointTools = {
        signal: controller.signal,
        logger: serverOptions.logger,
      }

      for (const endpoint of entry.endpoints) {
        if (!endpoint.match(renderRequest)) continue
        const result = await withTimeout(
          Promise.resolve(endpoint.handle(renderRequest, endpointTools)),
          serverOptions.requestTimeoutMs ?? 15_000,
          controller
        )
        if (result) return sendResponse(request, response, result)
      }

      if (options.production) {
        const asset = await resolveSsrProductionAsset(
          clientRoot,
          pathname,
          definition.applications.map(({ template }) => template)
        )
        if (asset) return sendResponse(request, response, asset)
      } else if (
        options.vite &&
        (pathname.startsWith('/src/') ||
          pathname.startsWith('/@') ||
          pathname.includes('.') ||
          pathname === '/__vite_ping')
      ) {
        await runViteMiddleware(options.vite, request, response)
        if (response.writableEnded) return
      }

      if (!isHtmlNavigation(request, pathname)) {
        return sendJson(request, response, 404, {
          status: 'error',
          service: definition.name,
          message: 'Resource not found.',
        })
      }

      const responseCache = entry.kind === 'ssr' ? entry.responseCache : undefined
      let responseCacheKey: string | null = null
      try {
        responseCacheKey = await resolveSsrResponseCacheKey(
          entry.id,
          renderRequest,
          responseCache
        )
      } catch (error) {
        serverOptions.logger?.warn?.('ssr.cache.key.failed', {
          entryId: entry.id,
          requestId: renderRequest.requestId,
          error: error instanceof Error ? error.message : 'Unknown cache error',
        })
      }
      if (responseCache && responseCacheKey) {
        try {
          const cached = await responseCache.store.get(responseCacheKey)
          if (cached) {
            return sendResponse(request, response, {
              ...cached,
              headers: {
                ...cached.headers,
                'server-timing': 'cache;desc="hit"',
              },
            })
          }
        } catch (error) {
          serverOptions.logger?.warn?.('ssr.cache.read.failed', {
            entryId: entry.id,
            requestId: renderRequest.requestId,
            error: error instanceof Error ? error.message : 'Unknown cache error',
          })
        }
      }

      let template = await loadTemplate(definition, entry.template, request.url || '/')
      if (entry.kind === 'spa') {
        return sendResponse(request, response, {
          statusCode: 200,
          body: injectSpaDomainState(
            template,
            entry.id,
            domain,
            entry.publicConfig
          ),
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': entry.cacheControl || 'private, no-store',
            vary: 'Host, X-Forwarded-Host',
            ...htmlSecurityHeaders,
          },
        })
      }

      const application = entry.application!
      template = prepareSsrHtmlTemplate(
        template,
        entry.mountSelector || application.mountSelector || '#app'
      )
      const requestTimeoutMs = serverOptions.requestTimeoutMs ?? 15_000
      const rendered = await withTimeout(
        renderSsrApplication(application, renderRequest, {
          maxResolutionPasses: serverOptions.maxResolutionPasses,
          resolutionDeadlineMs:
            serverOptions.resolutionDeadlineMs ?? requestTimeoutMs,
          diagnostics: serverOptions.diagnostics ?? !options.production,
          logger: serverOptions.logger,
        }),
        requestTimeoutMs,
        controller
      )
      if (rendered.response.redirect) {
        const redirect = rendered.response.redirect
        const target = new URL(redirect.location, renderRequest.url)
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
          throw new Error('SSR redirects must use HTTP or HTTPS.')
        }
        if (!redirect.allowExternal && target.origin !== new URL(renderRequest.url).origin) {
          throw new Error('Cross-origin redirect requires allowExternal: true.')
        }
        return sendResponse(request, response, {
          statusCode: redirect.statusCode ?? 302,
          headers: {
            location: target.href,
            'cache-control': 'no-store',
          },
        })
      }
      const document = injectSsrHtml(template, {
        applicationId: application.id,
        html: rendered.html,
        teleports: rendered.teleports,
        head: rendered.head,
        state: rendered.hydrationState,
      })
      serverOptions.onMetrics?.(rendered.metrics)
      serverOptions.logger?.info?.('ssr.render.complete', rendered.metrics as any)
      const result: SsrHttpResponse = {
        statusCode: rendered.response.statusCode,
        body: document,
        headers: {
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
        },
      }
      if (
        responseCache &&
        responseCacheKey &&
        isSsrResponseCacheable(result, renderRequest, responseCache)
      ) {
        try {
          await responseCache.store.set(responseCacheKey, result, {
            ttlMs: responseCache.ttlMs,
            tags: await responseCache.tags?.(renderRequest),
          })
        } catch (error) {
          serverOptions.logger?.warn?.('ssr.cache.write.failed', {
            entryId: entry.id,
            requestId: renderRequest.requestId,
            error: error instanceof Error ? error.message : 'Unknown cache error',
          })
        }
      }
      return sendResponse(request, response, result)
    } catch (error) {
      options.vite?.ssrFixStacktrace(error as Error)
      const definition = await loadDefinition().catch(() => initialRuntime)
      definition.server.logger?.error?.('ssr.request.failed', {
        entryId: selectedEntryId,
        pathname,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      if (response.writableEnded) return
      if (response.headersSent) return response.destroy()
      const timeout = error instanceof SsrRequestTimeoutError
      const statusCode = timeout ? 504 : 500
      if (definition.server.renderError) {
        try {
          const renderedError = await definition.server.renderError({
            error,
            kind: timeout ? 'timeout' : 'internal',
            production: options.production,
            request: activeRenderRequest,
            entryId: selectedEntryId === 'unknown' ? undefined : selectedEntryId,
          })
          if (renderedError) {
            return sendResponse(request, response, {
              ...renderedError,
              statusCode:
                renderedError.statusCode >= 400
                  ? renderedError.statusCode
                  : statusCode,
              headers: {
                ...renderedError.headers,
                'cache-control': 'no-store',
                ...htmlSecurityHeaders,
              },
            })
          }
        } catch (renderError) {
          definition.server.logger?.error?.('ssr.error-renderer.failed', {
            entryId: selectedEntryId,
            error:
              renderError instanceof Error
                ? renderError.message
                : 'Unknown error renderer failure',
          })
        }
      }
      if (isHtmlNavigation(request, pathname)) {
        return sendResponse(request, response, {
          statusCode,
          body: renderSsrErrorDocument(
            timeout ? 'Request timed out' : 'Application unavailable',
            options.production
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
        })
      }
      return sendJson(request, response, statusCode, {
        status: 'error',
        service: definition.name,
      })
    }
  })

  return {
    nodeServer,
    address: () => {
      const address = nodeServer.address()
      return {
        host: typeof address === 'object' && address ? address.address : host,
        port: typeof address === 'object' && address ? address.port : port,
      }
    },
    listen: () =>
      new Promise<void>((resolveListen, rejectListen) => {
        const onError = (error: Error) => rejectListen(error)
        nodeServer.once('error', onError)
        nodeServer.listen(port, host, () => {
          nodeServer.off('error', onError)
          logServerReady(
            host,
            port,
            initialServerOptions.role || 'default'
          )
          resolveListen()
        })
      }),
    close: async () => {
      if (shuttingDown) return
      shuttingDown = true
      const timeoutMs = initialServerOptions.shutdownTimeoutMs ?? 10_000
      let forced: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.all([
            new Promise<void>((resolveClose, rejectClose) => {
              nodeServer.close((error) =>
                error ? rejectClose(error) : resolveClose()
              )
            }),
            options.vite?.close(),
          ]),
          new Promise<never>((_resolve, reject) => {
            forced = setTimeout(() => {
              nodeServer.closeAllConnections?.()
              reject(new Error('SSR server graceful shutdown timed out.'))
            }, timeoutMs)
          }),
        ])
      } finally {
        if (forced) clearTimeout(forced)
      }
    },
  }
}

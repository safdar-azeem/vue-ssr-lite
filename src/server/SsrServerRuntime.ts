import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { ViteDevServer } from 'vite'
import { compileSsrConfig, type SsrCompiledConfig } from '../SsrConfigCompileRuntime'
import { resolveSsrDomainContext } from '../SsrDomainRuntime'
import { createSafeSsrLogger, safeSsrLog, safeSsrMetrics } from '../SsrObservability'
import { resolvePublicConfigValue } from '../SsrPublicConfig'
import { renderSsrApplication } from '../SsrRenderRuntime'
import {
  assertProductionSeoOriginConfigured,
  readPublicUrl,
  requiresProductionSeoOrigin,
  resolveServerSiteOrigin,
} from './SsrSiteOriginRuntime'
import type {
  SsrHeaders,
  SsrEndpointTools,
  SsrHttpRequest,
  SsrHttpResponse,
  SsrPublicConfigRequest,
} from '../SsrRuntimeTypes'
import { serializeSsrState } from '../SsrSerialization'
import {
  parseSsrProductionAssetMetadata,
  SSR_PRODUCTION_ASSET_METADATA_PATH,
} from '../SsrAssetMetadata'
import {
  isExpectedUnavailableAssetError,
  isSsrPrivateProductionAssetPath,
  isSsrProductionAssetNotModified,
  parseSsrClientAssetManifest,
  resolveSsrProductionAsset,
  resolveSsrImmutableAssetPaths,
  updateSsrProductionAssetMetadata,
  type SsrResolvedProductionAsset,
} from './SsrAssetRuntime'
import {
  assertSupportedSsrViteBase,
  parseSsrViteManifest,
  resolveRenderedApplicationAssets,
  type SsrViteManifest,
} from '../SsrRenderedAssetRuntime'
import {
  resolveRenderedStyleDependencies,
  runWithSsrViteAssetResolutionContext,
} from '../vite/SsrViteAssetRuntime'
import {
  filterSsrCookieHeader,
  resolveSsrForwardedHost,
  resolveSsrForwardedProtocol,
  resolveSsrHostEntry,
} from './SsrHostRuntime'
import { injectSsrHtml, prepareSsrHtmlTemplate, renderSsrErrorDocument } from './SsrHtmlRuntime'
import { isSsrResponseCacheable, resolveSsrResponseCacheKey } from './SsrResponseCacheRuntime'
import { createSsrProductionTemplateStore } from './SsrProductionTemplateRuntime'
import { importSsrViteModule } from '../vite/SsrViteModuleRuntime'

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

class SsrRequestCancelledError extends Error {
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

// Error rendering is a failure-response escape hatch, not a second request
// lifetime. Keep it bounded even when the original request has already
// reached its deadline (and therefore has an aborted request signal).
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

interface SsrRequestScope {
  readonly signal: AbortSignal
  readonly remainingMs: () => number
  cancel(reason?: Error): void
  run<T>(work: () => T | Promise<T>): Promise<T>
  throwIfAborted(): void
  dispose(): void
}

const createRequestScope = (timeoutMs: number): SsrRequestScope => {
  const controller = new AbortController()
  const finiteTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
  const deadline = finiteTimeout ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | undefined

  if (finiteTimeout) {
    timer = setTimeout(() => {
      controller.abort(new SsrRequestTimeoutError())
    }, timeoutMs)
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
      if (!controller.signal.aborted) {
        controller.abort(new SsrRequestCancelledError())
      }
    },
  }
}

const parsePort = (value: number | undefined): number => {
  const environmentPort = Number(process.env.PORT)
  const port =
    value ?? (Number.isFinite(environmentPort) && environmentPort > 0 ? environmentPort : 4173)
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
    ['', '✓  Server Ready', '', `  ➜ Local:  ${localUrl}`, `  ➜ Role:   ${role}`, ''].join('\n')
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
      ? (specifier) => importSsrViteModule(options.vite!, specifier)
      : undefined,
  })
  for (const application of definition.applications) {
    const enabledForRole =
      !application.roles?.length ||
      !definition.server.role ||
      application.roles.includes(definition.server.role)
    if (application.kind === 'ssr' && enabledForRole && !application.application) {
      throw new Error(`SSR application "${application.id}" requires an ssr application definition.`)
    }
    if (
      options.production &&
      enabledForRole &&
      application.application &&
      requiresProductionSeoOrigin(application.kind, application.application.seo)
    ) {
      assertProductionSeoOriginConfigured({
        siteUrl: application.application.seo?.siteUrl,
        resolveSiteUrl: definition.resolveSiteUrl,
        allowHttpOrigin: application.application.seo?.allowHttpOrigin,
      })
    }
  }
  return definition
}

const injectSpaDomainState = (
  template: string,
  applicationId: string,
  domain: ReturnType<typeof resolveSsrDomainContext>,
  publicConfig: unknown
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

const productionAssetHeaders = (asset: SsrResolvedProductionAsset) => ({
  'content-type': asset.contentType,
  'content-length': String(asset.size),
  'cache-control': asset.cacheControl,
  etag: asset.etag,
  'last-modified': asset.lastModified,
})

const isUnavailableAssetError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR'
}

/**
 * Execute static-file HTTP semantics directly against ServerResponse. This is
 * intentionally separate from SsrHttpResponse so streams never acquire cache
 * or custom-endpoint ownership semantics.
 */
export const writeSsrProductionAsset = async (
  request: IncomingMessage,
  response: ServerResponse,
  resolvedAsset: SsrResolvedProductionAsset,
  signal: AbortSignal,
  openFile: typeof open = open
): Promise<boolean> => {
  let asset = resolvedAsset
  if (isSsrProductionAssetNotModified(asset, request.headers)) {
    response.writeHead(304, productionAssetHeaders(asset))
    response.end()
    return true
  }
  if (request.method === 'HEAD') {
    response.writeHead(200, productionAssetHeaders(asset))
    response.end()
    return true
  }

  signal.throwIfAborted()
  let file
  try {
    // Open before committing headers so a deletion between resolution and body
    // delivery can still fall through to the controlled not-found path.
    file = await openFile(asset.filePath, 'r')
    const information = await file.stat()
    if (!information.isFile()) {
      await file.close()
      return false
    }
    asset = updateSsrProductionAssetMetadata(asset, information)
  } catch (error) {
    await file?.close().catch(() => undefined)
    if (isUnavailableAssetError(error)) return false
    throw error
  }

  if (signal.aborted) {
    await file.close()
    signal.throwIfAborted()
  }
  // Metadata may have changed between resolver stat and open. Re-evaluate the
  // validator against the opened representation before sending any headers.
  if (isSsrProductionAssetNotModified(asset, request.headers)) {
    await file.close()
    response.writeHead(304, productionAssetHeaders(asset))
    response.end()
    return true
  }

  let source: ReturnType<typeof file.createReadStream> | undefined
  try {
    response.writeHead(200, productionAssetHeaders(asset))
    source = file.createReadStream()
    // pipeline owns source/destination error propagation, backpressure, and
    // AbortSignal teardown. FileHandle.createReadStream closes its descriptor.
    await pipeline(source, response, { signal })
  } catch (error) {
    if (source) source.destroy()
    else await file.close().catch(() => undefined)
    throw error
  }
  return true
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

const snapshotRequestHeaders = (request: IncomingMessage): SsrHeaders =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [
        name,
        Array.isArray(value) ? Object.freeze([...value]) : value,
      ])
    )
  ) as SsrHeaders

const snapshotRequestDomain = (
  domain: ReturnType<typeof resolveSsrDomainContext>
): ReturnType<typeof resolveSsrDomainContext> =>
  Object.freeze({
    ...domain,
    params: Object.freeze({ ...domain.params }),
  })

const runViteMiddleware = (
  vite: ViteDevServer,
  request: IncomingMessage,
  response: ServerResponse
) =>
  new Promise<void>((resolveMiddleware, reject) => {
    let settled = false
    const cleanup = () => {
      response.off('finish', onResponseComplete)
      response.off('close', onResponseComplete)
    }
    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolveMiddleware()
    }
    const onResponseComplete = () => settle()
    response.once('finish', onResponseComplete)
    response.once('close', onResponseComplete)
    try {
      vite.middlewares(request, response, (error?: Error) => settle(error))
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)))
    }
  })

const waitForStartedViteOptimizerWork = async (vite: ViteDevServer): Promise<void> => {
  const optimizers = Object.values(vite.environments ?? {}).flatMap((environment) =>
    environment.depsOptimizer ? [environment.depsOptimizer] : []
  )
  const settle = async (pending: Promise<void>[]) => {
    // Observe every started batch before reporting a failure. Promise.all
    // would short-circuit on the first rejection and could otherwise let
    // teardown close Vite underneath another still-running optimizer batch.
    const results = await Promise.allSettled(pending)
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    return rejected
      ? { rejected: true as const, reason: rejected.reason }
      : { rejected: false as const }
  }

  // Phase 1 waits for the scan promises that already exist. The scan can add
  // entries to metadata.discovered while it is pending, so that collection
  // must not be snapshotted until every scan has settled.
  const scanResult = await settle(
    optimizers
      .map((optimizer) => optimizer.scanProcessing)
      .filter((work): work is Promise<void> => Boolean(work))
  )

  // Phase 2 observes the optimizer processing promises created by the scan,
  // including dependencies that were absent when shutdown began.
  const processingResult = await settle(
    optimizers
      .flatMap((optimizer) =>
        Object.values(optimizer.metadata.discovered ?? {}).map(
          (dependency) => dependency.processing
        )
      )
      .filter((work): work is Promise<void> => Boolean(work))
  )

  if (scanResult.rejected) throw scanResult.reason
  if (processingResult.rejected) throw processingResult.reason
}

export const createSsrManagedServer = async (
  options: SsrManagedServerOptions
): Promise<SsrManagedServer> => {
  let shuttingDown = false
  let shutdownPromise: Promise<void> | undefined
  let activeRequestCount = 0
  let resolveRequestsDrained: (() => void) | undefined
  const waitForRequestsDrained = (): Promise<void> =>
    activeRequestCount === 0
      ? Promise.resolve()
      : new Promise((resolveDrained) => {
          resolveRequestsDrained = resolveDrained
        })
  const initialRuntime = await resolveRuntime(await options.loadRuntime(), options)
  const initialServerOptions = initialRuntime.server
  const host = initialServerOptions.host
  const port = parsePort(initialServerOptions.port)
  const clientRoot = resolve(initialServerOptions.root, initialServerOptions.clientOutDir)
  const hasEnabledSsrApplications =
    options.production &&
    initialRuntime.applications.some(
      (application) =>
        application.kind === 'ssr' &&
        (!application.roles?.length ||
          !initialServerOptions.role ||
          application.roles.includes(initialServerOptions.role))
    )
  let ssrManifest: SsrViteManifest | undefined
  const viteBase = hasEnabledSsrApplications
    ? assertSupportedSsrViteBase(initialRuntime.viteBase)
    : initialRuntime.viteBase || '/'
  let immutableAssetPaths: ReadonlySet<string> = new Set()
  if (options.production) {
    const clientManifestPath = resolve(clientRoot, '.vite/manifest.json')
    const assetMetadataPath = resolve(clientRoot, SSR_PRODUCTION_ASSET_METADATA_PATH)
    let manifestAssets: ReadonlySet<string> = new Set()
    let revisionedAssets: ReadonlySet<string> = new Set()
    try {
      manifestAssets = parseSsrClientAssetManifest(
        await readFile(clientManifestPath, 'utf8'),
        clientManifestPath
      )
    } catch (error) {
      if (!isExpectedUnavailableAssetError(error)) {
        throw new Error(
          `vue-ssr-lite could not load Vite's client manifest at ${clientManifestPath}. ${error instanceof Error ? error.message : String(error)}`
        )
      }
      // A manually assembled client directory remains servable, but without
      // authoritative build metadata every file gets conservative caching.
    }
    try {
      revisionedAssets = parseSsrProductionAssetMetadata(
        await readFile(assetMetadataPath, 'utf8'),
        assetMetadataPath
      )
    } catch (error) {
      if (!isExpectedUnavailableAssetError(error)) {
        throw new Error(
          `vue-ssr-lite could not load asset cache metadata at ${assetMetadataPath}. ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    immutableAssetPaths = resolveSsrImmutableAssetPaths(manifestAssets, revisionedAssets)
  }
  if (hasEnabledSsrApplications) {
    const manifestPath = resolve(clientRoot, '.vite/ssr-manifest.json')
    let source: string
    try {
      source = await readFile(manifestPath, 'utf8')
    } catch (error) {
      throw new Error(
        `vue-ssr-lite requires Vite's generated SSR manifest for production SSR applications at ${manifestPath}. Ensure build.ssrManifest is enabled. ${error instanceof Error ? error.message : String(error)}`
      )
    }
    ssrManifest = parseSsrViteManifest(source, manifestPath)
  }

  // Production build artifacts are immutable for a managed-server lifetime.
  // Replacing the server invalidates this server-local store after deployment.
  const productionTemplates = options.production
    ? createSsrProductionTemplateStore({
        load: (templatePath) => readFile(templatePath, 'utf8'),
        prepare: prepareSsrHtmlTemplate,
      })
    : undefined
  const productionTemplatePaths = new Map<string, string>()

  // Dev reloads the Vite SSR runtime on every request so HMR is picked up.
  // Coalesce concurrent loads (HMR storms) and keep the last good compile if a
  // reload throws mid-invalidation — otherwise one failed eval takes the site down.
  let lastDefinition = initialRuntime
  let loadingDefinition: Promise<SsrCompiledConfig> | null = null

  const loadDefinition = (): Promise<SsrCompiledConfig> => {
    if (options.production) return Promise.resolve(initialRuntime)
    if (loadingDefinition) return loadingDefinition
    loadingDefinition = (async () => {
      try {
        const next = await resolveRuntime(await options.loadRuntime(), options)
        lastDefinition = next
        return next
      } catch (error) {
        safeSsrLog(initialServerOptions.logger, 'error', 'ssr.runtime.reload.failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        })
        return lastDefinition
      } finally {
        loadingDefinition = null
      }
    })()
    return loadingDefinition
  }

  const resolveTemplatePath = (definition: SsrCompiledConfig, templateName: string) =>
    resolve(options.production ? clientRoot : definition.server.root, templateName)

  const loadTemplate = async (
    definition: SsrCompiledConfig,
    templateName: string,
    requestUrl: string,
    signal?: AbortSignal
  ) => {
    const templatePath = resolveTemplatePath(definition, templateName)
    if (productionTemplates) {
      return productionTemplates.load(productionTemplatePaths.get(templatePath) ?? templatePath)
    }
    const template = await readFile(templatePath, { encoding: 'utf8', signal })
    if (!options.vite) return template
    const templateUrl = `/${templateName.replaceAll('\\', '/').replace(/^\/+/, '')}`
    return options.vite.transformIndexHtml(templateUrl, template, requestUrl)
  }

  const loadPreparedSsrTemplate = async (
    definition: SsrCompiledConfig,
    templateName: string,
    mountSelector: string,
    requestUrl: string,
    signal?: AbortSignal
  ) => {
    if (productionTemplates) {
      const templatePath = resolveTemplatePath(definition, templateName)
      return productionTemplates.prepare(
        productionTemplatePaths.get(templatePath) ?? templatePath,
        mountSelector
      )
    }
    return prepareSsrHtmlTemplate(
      await loadTemplate(definition, templateName, requestUrl, signal),
      mountSelector
    )
  }

  const assertReady = async (definition: SsrCompiledConfig) => {
    const runtimeRoot = definition.server.root
    const enabledApplications = definition.applications.filter(
      (application) =>
        !application.roles?.length ||
        !definition.server.role ||
        application.roles.includes(definition.server.role)
    )
    await Promise.all(
      enabledApplications.map(async (application) => {
        const information = await stat(
          resolve(options.production ? clientRoot : runtimeRoot, application.template)
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
  const initialTemplatePaths = [
    ...new Set(
      initialEnabledApplications.map((application) =>
        resolveTemplatePath(initialRuntime, application.template)
      )
    ),
  ]
  await Promise.all(
    initialTemplatePaths.map(async (templatePath) => {
      const information = await stat(templatePath)
      if (!information.isFile()) {
        throw new Error(`Missing client entry: ${templatePath}`)
      }
      if (options.production) {
        productionTemplatePaths.set(templatePath, await realpath(templatePath))
      }
    })
  )

  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    activeRequestCount += 1
    const startedAt = Date.now()
    const requestId =
      String(request.headers['x-request-id'] || '').trim() ||
      `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    let pathname = '/'
    let rawAssetPathname = '/'
    let selectedEntryId = 'unknown'
    let activeRenderRequest: SsrHttpRequest<any> | undefined
    let activeDefinition = lastDefinition
    const scope = createRequestScope(lastDefinition.server.requestTimeoutMs)
    const cancelDisconnectedRequest = () => scope.cancel()
    const cancelClosedResponse = () => {
      if (!response.writableEnded) scope.cancel()
    }
    const closeIdleAfterResponse = () => {
      response.off('finish', closeIdleAfterResponse)
      response.off('close', closeIdleAfterResponse)
      // A connection carrying legitimate in-flight work was not idle when
      // shutdown began. Once its response finishes or closes it is safe to
      // reap resulting keep-alive sockets without disturbing application work.
      if (shuttingDown) nodeServer.closeIdleConnections?.()
    }
    request.once('aborted', cancelDisconnectedRequest)
    response.once('close', cancelClosedResponse)
    response.once('finish', closeIdleAfterResponse)
    response.once('close', closeIdleAfterResponse)

    try {
      const definition = await scope.run(loadDefinition)
      activeDefinition = definition
      const serverOptions = definition.server
      const requestUrl = new URL(request.url || '/', 'http://internal')
      pathname = requestUrl.pathname
      // WHATWG URL parsing normalizes encoded dot segments. Keep the raw path
      // for filesystem security checks so `%2e%2e` cannot be erased before the
      // asset resolver has a chance to reject it.
      rawAssetPathname = (request.url || '/').split('?', 1)[0]
      const healthPath = serverOptions.healthPath
      const readinessPath = serverOptions.readinessPath

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
          await scope.run(() => assertReady(definition))
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

      // Reserved Vite/framework metadata is never an application route. Make
      // this decision at the HTTP boundary so HTML Accept headers and browser
      // navigation hints cannot turn an unresolved private asset into the
      // SPA/SSR document fallback. Check both the raw path (for filesystem
      // security) and WHATWG-normalized pathname (for encoded dot segments).
      if (
        options.production &&
        (isSsrPrivateProductionAssetPath(rawAssetPathname, viteBase) ||
          isSsrPrivateProductionAssetPath(pathname, viteBase))
      ) {
        return sendJson(request, response, 404, {
          status: 'error',
          service: definition.name,
          message: 'Resource not found.',
        })
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
            : JSON.stringify({
                status: 'error',
                message: 'Invalid Host header.',
              }),
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
      const domain = snapshotRequestDomain(
        resolveSsrDomainContext(incomingHost, entry, definition.development, protocol)
      )
      const cookie = filterSsrCookieHeader(
        request.headers.cookie,
        entry.cookieAllowlist,
        entry.cookieDenylist
      )
      const headers = snapshotRequestHeaders(request)
      const method = request.method || 'GET'
      const url = new URL(
        `${requestUrl.pathname}${requestUrl.search}`,
        `${protocol}://${incomingHost}`
      ).href
      const publicConfigRequest: SsrPublicConfigRequest = Object.freeze({
        requestId,
        url,
        host: incomingHost,
        protocol,
        method,
        headers,
        cookie,
        domain,
        signal: scope.signal,
        pathname,
        search: requestUrl.search,
        entryId: entry.id,
      })
      const publicConfig = await scope.run(() =>
        resolvePublicConfigValue(
          entry.publicConfigFactory ?? entry.publicConfig,
          publicConfigRequest
        )
      )
      const renderRequest: SsrHttpRequest<any> = {
        requestId,
        url,
        host: incomingHost,
        protocol,
        method,
        headers,
        cookie,
        publicConfig,
        signal: scope.signal,
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
          production: options.production,
          requireProductionOrigin: requiresProductionSeoOrigin(entry.kind, entry.application?.seo),
          allowHttpOrigin: entry.application?.seo?.allowHttpOrigin,
        })
      )
      const endpointTools: SsrEndpointTools = {
        signal: scope.signal,
        logger: createSafeSsrLogger(serverOptions.logger),
      }

      for (const endpoint of entry.endpoints) {
        if (!endpoint.match(renderRequest)) continue
        const result = await scope.run(() => endpoint.handle(renderRequest, endpointTools))
        if (result) return sendResponse(request, response, result)
      }

      if (options.production && (request.method === 'GET' || request.method === 'HEAD')) {
        const asset = await scope.run(() =>
          resolveSsrProductionAsset({
            clientRoot,
            pathname: rawAssetPathname,
            protectedTemplates: definition.applications.map(({ template }) => template),
            viteBase,
            immutableAssetPaths,
            signal: scope.signal,
          })
        )
        if (
          asset &&
          (await scope.run(() => writeSsrProductionAsset(request, response, asset, scope.signal)))
        ) {
          return
        }
      } else if (
        options.vite &&
        (pathname.startsWith('/src/') ||
          pathname.startsWith('/@') ||
          pathname.includes('.') ||
          pathname === '/__vite_ping')
      ) {
        await scope.run(() => runViteMiddleware(options.vite!, request, response))
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
        try {
          const cached = await scope.run(() =>
            responseCache.store.get(responseCacheKey!, {
              signal: scope.signal,
            })
          )
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
          scope.throwIfAborted()
          safeSsrLog(serverOptions.logger, 'warn', 'ssr.cache.read.failed', {
            entryId: entry.id,
            requestId: renderRequest.requestId,
            error: error instanceof Error ? error.message : 'Unknown cache error',
          })
        }
      }

      if (entry.kind === 'spa') {
        const template = await scope.run(() =>
          loadTemplate(definition, entry.template, request.url || '/', scope.signal)
        )
        return sendResponse(request, response, {
          statusCode: 200,
          body: injectSpaDomainState(template, entry.id, domain, publicConfig),
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': entry.cacheControl || 'private, no-store',
            vary: 'Host, X-Forwarded-Host',
            ...htmlSecurityHeaders,
          },
        })
      }

      const application = entry.application!
      const template = await scope.run(() =>
        loadPreparedSsrTemplate(
          definition,
          entry.template,
          entry.mountSelector,
          request.url || '/',
          scope.signal
        )
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
      const renderedAssets = options.production
        ? resolveRenderedApplicationAssets({
            applicationId: application.id,
            moduleIds: rendered.renderedModules,
            base: viteBase,
            manifest: ssrManifest!,
          })
        : options.vite
          ? await scope.run(() =>
              resolveRenderedStyleDependencies(
                options.vite!,
                application.id,
                rendered.renderedModules
              )
            )
          : []
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
          const tags = await scope.run(() => responseCache.tags?.(renderRequest) ?? [])
          await scope.run(() =>
            responseCache.store.set(responseCacheKey!, result, {
              ttlMs: responseCache.ttlMs,
              tags,
              signal: scope.signal,
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
      return sendResponse(request, response, result)
    } catch (error) {
      const definition = activeDefinition
      const cancelled = error instanceof SsrRequestCancelledError
      if (cancelled) {
        if (!response.destroyed) response.destroy()
        return
      }
      safeSsrLog(definition.server.logger, 'error', 'ssr.request.failed', {
        requestId,
        entryId: selectedEntryId,
        pathname,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      if (response.writableEnded) return
      if (response.headersSent) return response.destroy()
      let timeout =
        error instanceof SsrRequestTimeoutError ||
        scope.signal.reason instanceof SsrRequestTimeoutError
      let statusCode = timeout ? 504 : 500
      if (definition.server.renderError) {
        try {
          const renderedError = await runBoundedErrorRenderer(
            () =>
              definition.server.renderError!({
                error,
                kind: timeout ? 'timeout' : 'internal',
                production: options.production,
                request: activeRenderRequest,
                entryId: selectedEntryId === 'unknown' ? undefined : selectedEntryId,
              }),
            scope.signal
          )
          if (renderedError) {
            return sendResponse(request, response, {
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
            error:
              renderError instanceof Error ? renderError.message : 'Unknown error renderer failure',
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
    } finally {
      request.off('aborted', cancelDisconnectedRequest)
      response.off('close', cancelClosedResponse)
      scope.dispose()
      activeRequestCount -= 1
      if (activeRequestCount === 0) {
        resolveRequestsDrained?.()
        resolveRequestsDrained = undefined
      }
    }
  }

  const nodeServer = createServer((request, response) =>
    options.vite
      ? runWithSsrViteAssetResolutionContext(() => handleRequest(request, response))
      : handleRequest(request, response)
  )

  const close = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise
    shuttingDown = true
    shutdownPromise = (async () => {
      const timeoutMs = initialServerOptions.shutdownTimeoutMs
      let forced: ReturnType<typeof setTimeout> | undefined
      let viteClosePromise: Promise<void> | undefined
      const closeVite = (): Promise<void> => {
        if (!options.vite) return Promise.resolve()
        if (!viteClosePromise) {
          // Promise.resolve().then() also captures a synchronous throw from a
          // Vite close implementation while preserving one invocation.
          viteClosePromise = Promise.resolve().then(() => options.vite!.close())
        }
        return viteClosePromise
      }
      const nodeClose = new Promise<void>((resolveClose, rejectClose) => {
        nodeServer.close((error) => {
          if (!error || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
            resolveClose()
          } else {
            rejectClose(error)
          }
        })
        // close() stops new accepts first. Explicitly draining idle keep-alive
        // sockets preserves active requests while avoiding needless shutdown
        // delay on platforms where close() does not reap them immediately.
        nodeServer.closeIdleConnections?.()
      })
      const gracefulClose = (async () => {
        // Do not close Vite underneath an application request that is still
        // using its transforms or ModuleRunner. Vite/HMR sockets are not part
        // of this managed HTTP request count.
        await waitForRequestsDrained()
        // On a cold start Vite may have already moved from dependency scanning
        // into an optimizer batch. Cancelling at that boundary can leave
        // Vite 7's close() waiting on the cancelled batch indefinitely. Drain
        // only the work Vite has already exposed as pending, then use its
        // normal close API for environments, ModuleRunner, HMR, and WebSockets.
        let shutdownError: unknown
        let hasShutdownError = false
        if (options.vite) {
          try {
            await waitForStartedViteOptimizerWork(options.vite)
          } catch (error) {
            shutdownError = error
            hasShutdownError = true
          }
          // Vite owns its environments, ModuleRunner, HMR, and WebSocket
          // server. Its cleanup is mandatory even when an optimizer batch
          // failed; report the optimizer failure only after cleanup is owned.
          try {
            await closeVite()
          } catch (error) {
            if (!hasShutdownError) {
              shutdownError = error
              hasShutdownError = true
            }
          }
        }
        await nodeClose
        if (hasShutdownError) throw shutdownError
      })()
      try {
        await Promise.race([
          gracefulClose,
          new Promise<never>((_resolve, reject) => {
            forced = setTimeout(() => {
              nodeServer.closeAllConnections?.()
              // A stuck optimizer drain must not leave Vite-owned resources
              // unclosed after the shutdown deadline. This is a forced
              // timeout path; normal application work still drains before
              // the regular closeVite() call above.
              void closeVite().catch(() => undefined)
              reject(new Error('SSR server graceful shutdown timed out.'))
            }, timeoutMs)
          }),
        ])
      } finally {
        if (forced) clearTimeout(forced)
      }
    })()
    return shutdownPromise
  }

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
          logServerReady(host, port, initialServerOptions.role || 'default')
          resolveListen()
        })
      }),
    close,
  }
}

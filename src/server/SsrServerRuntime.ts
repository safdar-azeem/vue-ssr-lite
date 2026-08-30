import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { ViteDevServer } from 'vite'
import { compileSsrConfig, type SsrCompiledConfig } from '../SsrConfigCompileRuntime'
import { safeSsrLog } from '../SsrObservability'
import {
  assertConfiguredProductionSeoOrigin,
  requiresProductionSeoOrigin,
} from './SsrSiteOriginRuntime'
import type { SsrHeaders, SsrHttpResponse } from '../SsrRuntimeTypes'
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
  type SsrViteManifest,
} from '../SsrRenderedAssetRuntime'
import {
  resolveRenderedStyleDependencies,
  runWithSsrViteAssetResolutionContext,
} from '../vite/SsrViteAssetRuntime'
import { prepareSsrHtmlTemplate, SSR_HTML_TEMPLATE } from './SsrHtmlRuntime'
import { createSsrProductionTemplateStore } from './SsrProductionTemplateRuntime'
import { importSsrViteModule } from '../vite/SsrViteModuleRuntime'
import {
  createSsrRequestScope,
  handleSsrRequest,
  SsrRequestCancelledError,
  type SsrNormalizedRequest,
} from './SsrRequestHandler'
import {
  createSsrAdmissionController,
  type SsrAdmissionEvent,
} from './SsrAdmissionRuntime'

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

const logServerReady = (host: string, port: number) => {
  const localUrl = `http://${resolveLocalDisplayHost(host)}:${port}/`
  console.log(
    ['', '✓  Server Ready', '', `  ➜ Local:  ${localUrl}`, ''].join('\n')
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
    if (
      (application.kind === 'ssr' || application.hasRouteRenderOverrides) &&
      !application.application
    ) {
      throw new Error(
        `SSR application "${application.id}" requires ${application.shell.main} and ${application.shell.root}.`
      )
    }
    if (
      options.production &&
      application.application &&
      requiresProductionSeoOrigin(
        application.kind === 'spa' && !application.hasRouteRenderOverrides ? 'spa' : 'ssr',
        application.application.seo,
      )
    ) {
      assertConfiguredProductionSeoOrigin({
        siteUrl: application.application.seo?.siteUrl,
        resolveSiteUrl: definition.resolveSiteUrl,
        allowHttpOrigin: application.application.seo?.allowHttpOrigin,
      })
    }
  }
  return definition
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
  const headers = result.headers ?? {}
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error(`[vue-ssr-lite] Invalid response header name "${name}".`)
    }
    const values = Array.isArray(value) ? value : [value]
    if (values.some((item) => /[\u0000-\u001f\u007f]/.test(item))) {
      throw new Error(`[vue-ssr-lite] Response header "${name}" contains control characters.`)
    }
  }
  response.writeHead(result.statusCode, headers)
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

const snapshotRequestHeaders = (request: IncomingMessage): SsrHeaders =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [
        name,
        Array.isArray(value) ? Object.freeze([...value]) : value,
      ])
    )
  ) as SsrHeaders

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
  const ssrAdmission = createSsrAdmissionController({
    maxConcurrent: initialServerOptions.maxConcurrentSsrRequests,
    maxQueued: initialServerOptions.maxQueuedSsrRequests,
    onEvent: (event: SsrAdmissionEvent) => {
      const details: Record<string, unknown> = { ...event }
      if (event.type === 'rejected') {
        safeSsrLog(initialServerOptions.logger, 'warn', 'ssr.admission.rejected', details)
      } else if (event.type === 'queued') {
        safeSsrLog(initialServerOptions.logger, 'info', 'ssr.admission.queued', details)
      } else if (event.type === 'admitted') {
        safeSsrLog(initialServerOptions.logger, 'info', 'ssr.admission.admitted', details)
      } else if (event.type === 'cancelled') {
        safeSsrLog(initialServerOptions.logger, 'debug', 'ssr.admission.cancelled', details)
      } else if (event.type === 'disposed' && event.rejectedQueuedCount > 0) {
        safeSsrLog(initialServerOptions.logger, 'info', 'ssr.admission.disposed', details)
      }
    },
  })
  const host = initialServerOptions.host
  const port = parsePort(initialServerOptions.port)
  const clientRoot = resolve(initialServerOptions.root, initialServerOptions.clientOutDir)
  const hasEnabledSsrApplications =
    options.production &&
    initialRuntime.applications.some(
      (application) => application.kind === 'ssr'
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

  const resolveTemplatePath = (
    definition: SsrCompiledConfig,
    entry: { id: string; template: string }
  ) => {
    if (!options.production) {
      return resolve(definition.server.root, entry.template)
    }
    const split = resolve(clientRoot, '.vue-ssr-lite', `${entry.id}.html`)
    if (existsSync(split)) return split
    return resolve(clientRoot, entry.template)
  }

  const loadTemplate = async (
    definition: SsrCompiledConfig,
    entry: SsrCompiledConfig['applications'][number],
    requestUrl: string,
    signal?: AbortSignal
  ) => {
    const templatePath = resolveTemplatePath(definition, entry)
    if (productionTemplates) {
      return productionTemplates.load(productionTemplatePaths.get(templatePath) ?? templatePath)
    }
    const template = entry.templateMissing
      ? SSR_HTML_TEMPLATE
      : await readFile(templatePath, { encoding: 'utf8', signal })
    if (!options.vite) return template
    // Keep the selected application id in the URL Vite uses as the HTML
    // identity. Shared templates (one index.html, several hosts) cannot be
    // disambiguated from the filesystem filename alone.
    const templateUrl = `/@vue-ssr-lite/html/${entry.id}`
    return options.vite.transformIndexHtml(templateUrl, template, requestUrl)
  }

  const loadPreparedSsrTemplate = async (
    definition: SsrCompiledConfig,
    entry: SsrCompiledConfig['applications'][number],
    requestUrl: string,
    signal?: AbortSignal
  ) => {
    if (productionTemplates) {
      const templatePath = resolveTemplatePath(definition, entry)
      return productionTemplates.prepare(
        productionTemplatePaths.get(templatePath) ?? templatePath,
        entry.mountSelector
      )
    }
    return prepareSsrHtmlTemplate(
      await loadTemplate(definition, entry, requestUrl, signal),
      entry.mountSelector
    )
  }

  const assertReady = async (definition: SsrCompiledConfig) => {
    await Promise.all(
      definition.applications.map(async (application) => {
        if (application.templateMissing && !options.production) return
        const information = await stat(resolveTemplatePath(definition, application))
        if (!information.isFile()) {
          throw new Error(`SSR client entry is missing: ${application.template}`)
        }
      })
    )
    await Promise.all((definition.readiness ?? []).map((probe) => probe.run()))
  }

  // Startup preflight validates applications and module shape without running
  // network readiness probes. `/readyz` owns external dependency checks.
  const initialTemplatePaths = [
    ...new Set(
      initialRuntime.applications
        .filter((application) => options.production || !application.templateMissing)
        .map((application) => resolveTemplatePath(initialRuntime, application))
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
      startedAt.toString(36) + '-' + Math.random().toString(36).slice(2, 10)
    const scope = createSsrRequestScope(lastDefinition.server.requestTimeoutMs)
    const cancelDisconnectedRequest = () => scope.cancel()
    const cancelClosedResponse = () => {
      if (!response.writableEnded) scope.cancel()
    }
    const closeIdleAfterResponse = () => {
      response.off('finish', closeIdleAfterResponse)
      response.off('close', closeIdleAfterResponse)
      if (shuttingDown) nodeServer.closeIdleConnections?.()
    }
    request.once('aborted', cancelDisconnectedRequest)
    response.once('close', cancelClosedResponse)
    response.once('finish', closeIdleAfterResponse)
    response.once('close', closeIdleAfterResponse)

    try {
      const normalizedRequest: SsrNormalizedRequest = Object.freeze({
        requestId,
        startedAt,
        method: request.method || 'GET',
        url: request.url || '/',
        headers: snapshotRequestHeaders(request),
        protocol: (request.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http',
      })
      const result = await handleSsrRequest(normalizedRequest, {
        production: options.production,
        scope,
        loadDefinition,
        fallbackDefinition: () => lastDefinition,
        shuttingDown: () => shuttingDown,
        assertReady,
        ssrAdmission,
        viteBase,
        ssrManifest,
        loadTemplate,
        loadPreparedSsrTemplate,
        resolveDevelopmentAssets: (applicationId, modules) =>
          options.vite
            ? resolveRenderedStyleDependencies(options.vite!, applicationId, modules)
            : Promise.resolve([]),
        isPrivateProductionAssetPath: (pathname) =>
          isSsrPrivateProductionAssetPath(pathname, viteBase),
        serveProductionAsset: async (pathname, protectedTemplates, signal) => {
          const asset = await resolveSsrProductionAsset({
            clientRoot,
            pathname,
            protectedTemplates,
            viteBase,
            immutableAssetPaths,
            signal,
          })
          return asset
            ? writeSsrProductionAsset(request, response, asset, signal)
            : false
        },
        serveViteRequest: options.vite
          ? async () => {
              await runViteMiddleware(options.vite!, request, response)
              return response.writableEnded
            }
          : undefined,
      })
      if (result && !response.writableEnded) sendResponse(request, response, result)
    } catch (error) {
      if (error instanceof SsrRequestCancelledError) {
        if (!response.destroyed) response.destroy()
        return
      }
      safeSsrLog(lastDefinition.server.logger, 'error', 'ssr.transport.failed', {
        requestId,
        error: error instanceof Error ? error.message : 'Unknown transport error',
      })
      if (!response.destroyed) response.destroy()
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
    // Stop new SSR admission and detach every queued request. Active leases
    // remain valid until their actual Vue render work settles.
    ssrAdmission.dispose()
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
        // A cancelled request can leave its underlying Vue render alive after
        // the transport handler exits. Do not close Vite or its ModuleRunner
        // until both managed handlers and authoritative admission leases drain.
        await Promise.all([
          waitForRequestsDrained(),
          ssrAdmission.waitForIdle(),
        ])
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
          logServerReady(host, port)
          resolveListen()
        })
      }),
    close,
  }
}

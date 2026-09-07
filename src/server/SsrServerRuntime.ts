import {
  createSsrRequestBodySource,
  productionAssetToWebResponse,
  resolveProductionAssetResponse,
  writeWebResponse,
} from './SsrWebHttpRuntime'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ViteDevServer } from 'vite'
import { compileSsrConfig, type SsrCompiledConfig } from '../SsrConfigCompileRuntime'
import { safeSsrLog } from '../SsrObservability'
import { createSsrPhaseTimings, readSsrPhaseTimings, type SsrPhaseTimings } from '../SsrDiagnosticsRuntime'
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
  parseSsrClientAssetManifest,
  resolveSsrImmutableAssetPaths,
  type SsrResolvedProductionAsset,
} from './SsrAssetRuntime'
import {
  assertSupportedSsrViteBase,
  createSsrRenderedAssetResolver,
  parseSsrViteManifest,
  type SsrViteManifest,
} from '../SsrRenderedAssetRuntime'
import {
  resolveApplicationStyleDependencies,
  resolveRenderedStyleDependencies,
  runWithSsrViteAssetResolutionContext,
} from '../vite/SsrViteAssetRuntime'
import { prepareSsrHtmlTemplate, SSR_HTML_TEMPLATE } from './SsrHtmlRuntime'
import { createSsrProductionTemplateStore } from './SsrProductionTemplateRuntime'
import { prepareSsrCompiledMetadata } from './SsrCompiledMetadata'
import { captureSsrViteRuntimeRevision, importSsrViteModule } from '../vite/SsrViteModuleRuntime'
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

export const resolveManagedServerPort = (value: number | undefined): number => {
  const environmentPort = Number(process.env.PORT)
  const port =
    Number.isFinite(environmentPort) && environmentPort > 0 ? environmentPort : value ?? 4173
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('SSR server port must be an integer between 0 and 65535.')
  }
  return port
}

export const resolveManagedServerHost = (configuredHost: string): string => {
  const environmentHost = process.env.HOST?.trim()
  return environmentHost || configuredHost
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

/** Internal compatibility adapter; managed requests use native asset Responses. */
export const writeSsrProductionAsset = async (
  request: IncomingMessage,
  response: ServerResponse,
  resolvedAsset: SsrResolvedProductionAsset,
  signal: AbortSignal,
  openFile: typeof open = open
): Promise<boolean> => {
  const result = await productionAssetToWebResponse(resolvedAsset, request.headers, request.method ?? 'GET', signal, openFile)
  if (!result) return false
  await writeWebResponse(request, response, result, signal)
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
  // The CLI starts this collector before creating Vite; programmatic hosts
  // measure their managed-server startup from this boundary instead.
  const inheritedStartupTimings = !options.production ? readSsrPhaseTimings(options) : undefined
  const startupTimings = !options.production ? inheritedStartupTimings ?? createSsrPhaseTimings() : undefined
  let shuttingDown = false
  let shutdownPromise: Promise<void> | undefined
  let activeRequestCount = 0
  let timedSsrRequestCount = 0
  let readyAt: number | undefined
  let resolveRequestsDrained: (() => void) | undefined
  const waitForRequestsDrained = (): Promise<void> =>
    activeRequestCount === 0
      ? Promise.resolve()
      : new Promise((resolveDrained) => {
          resolveRequestsDrained = resolveDrained
        })
  let templateRevision = 0
  let developmentTemplatePaths = new Set([resolve(options.root, 'index.html').replaceAll('\\', '/')])
  const onTemplateStructureChange = (file: string) => {
    if (developmentTemplatePaths.has(resolve(file).replaceAll('\\', '/'))) templateRevision += 1
  }
  const detachTemplateWatcher = () => {
    options.vite?.watcher.off('add', onTemplateStructureChange)
    options.vite?.watcher.off('unlink', onTemplateStructureChange)
  }
  if (options.vite && !options.production) {
    // Vite owns watching. Contents still pass through readFile/transformIndexHtml
    // per request; only existence changes affect compiled templateMissing.
    options.vite.watcher.on('add', onTemplateStructureChange)
    options.vite.watcher.on('unlink', onTemplateStructureChange)
  }
  const captureRuntimeRevision = (loaded?: unknown) => {
    const current = options.vite && captureSsrViteRuntimeRevision(options.vite, loaded)
    const templates = templateRevision
    return current ? () => templates === templateRevision && current() : undefined
  }
  const trackRuntimeTemplates = (definition: SsrCompiledConfig) => {
    developmentTemplatePaths = new Set(definition.applications.map((entry) =>
      resolve(options.root, entry.template).replaceAll('\\', '/')
    ))
  }
  const loadRuntimeRevision = async () => {
    for (;;) {
      if (shuttingDown) {
        return { error: new Error('SSR server is shutting down.'), isCurrent: undefined }
      }
      let isCurrent = captureRuntimeRevision()
      try {
        const loaded = await options.loadRuntime()
        isCurrent = captureRuntimeRevision(loaded)
        if (isCurrent && !isCurrent()) continue
        const definition = await resolveRuntime(loaded, options)
        // A config factory may await work while Vite replaces its dependencies.
        // Never publish that superseded compile as the current revision.
        if (isCurrent && !isCurrent()) continue
        return { definition, isCurrent }
      } catch (error) {
        // A failure from an older in-flight compile cannot mark a newer Vite
        // revision as failed. All waiters continue through the same refresh.
        if (isCurrent && !isCurrent()) continue
        // Preserve the guard for the failed attempt too. The caller may resume
        // after another invalidation and must not mark that newer revision bad.
        return { error, isCurrent }
      }
    }
  }
  const initialRevision = await loadRuntimeRevision()
  if ('error' in initialRevision) {
    detachTemplateWatcher()
    throw initialRevision.error
  }
  const initialRuntime = initialRevision.definition
  trackRuntimeTemplates(initialRuntime)
  const initialServerOptions = initialRuntime.server
  startupTimings?.mark('runtime')
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
  const host = resolveManagedServerHost(initialServerOptions.host)
  const port = resolveManagedServerPort(initialServerOptions.port)
  const clientRoot = resolve(initialServerOptions.root, initialServerOptions.clientOutDir)
  const hasEnabledSsrApplications =
    options.production &&
    initialRuntime.applications.some(
      (application) => application.kind === 'ssr' || application.hasRouteRenderOverrides
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
  const templatePaths = new WeakMap<SsrCompiledConfig['applications'][number], string>()
  const resolveProductionAssets = ssrManifest
    ? createSsrRenderedAssetResolver(ssrManifest, viteBase)
    : undefined

  // Reuse compiled code/metadata until Vite invalidates its dependency graph.
  // A refresh belongs to the server, so cancelling one waiter cannot cancel
  // shared compilation or publish a partially constructed definition.
  let lastDefinition = initialRuntime
  let isCurrentRevision = initialRevision.isCurrent
  let loadingDefinition: Promise<SsrCompiledConfig> | null = null

  const loadDefinition = (): Promise<SsrCompiledConfig> => {
    if (options.production) return Promise.resolve(initialRuntime)
    if (loadingDefinition) return loadingDefinition
    if (isCurrentRevision?.()) return Promise.resolve(lastDefinition)
    loadingDefinition = (async () => {
      try {
        for (;;) {
          const next = await loadRuntimeRevision()
          // Recheck at publication, after the await boundary. Both successful
          // and failed work can be superseded before this continuation resumes.
          if (next.isCurrent && !next.isCurrent()) continue
          isCurrentRevision = next.isCurrent
          if ('error' in next) {
            safeSsrLog(initialServerOptions.logger, 'error', 'ssr.runtime.reload.failed', {
              error: next.error instanceof Error ? next.error.message : 'Unknown error',
            })
          } else {
            lastDefinition = next.definition
            trackRuntimeTemplates(lastDefinition)
          }
          return lastDefinition
        }
      } finally {
        loadingDefinition = null
      }
    })()
    return loadingDefinition
  }

  const resolveTemplatePath = (
    definition: SsrCompiledConfig,
    entry: SsrCompiledConfig['applications'][number]
  ) => {
    const cached = templatePaths.get(entry)
    if (cached) return cached
    if (!options.production) {
      return prepareSsrCompiledMetadata(definition).applications.get(entry)!.templatePath
    }
    const split = resolve(clientRoot, '.vue-ssr-lite', `${entry.id}.html`)
    const path = existsSync(split) ? split : resolve(clientRoot, entry.template)
    templatePaths.set(entry, path)
    return path
  }

  const loadTemplate = async (
    definition: SsrCompiledConfig,
    entry: SsrCompiledConfig['applications'][number],
    requestUrl: string,
    signal?: AbortSignal,
    timings?: SsrPhaseTimings
  ) => {
    const templatePath = resolveTemplatePath(definition, entry)
    if (productionTemplates) {
      return productionTemplates.load(productionTemplatePaths.get(templatePath) ?? templatePath)
    }
    const finishRead = timings?.start('template read')
    let template: string
    try {
      template = entry.templateMissing
        ? SSR_HTML_TEMPLATE
        : await readFile(templatePath, { encoding: 'utf8', signal })
    } finally {
      finishRead?.()
    }
    if (!options.vite) return template
    // Keep the selected application id in the URL Vite uses as the HTML
    // identity. Shared templates (one index.html, several hosts) cannot be
    // disambiguated from the filesystem filename alone.
    const templateUrl = `/@vue-ssr-lite/html/${entry.id}`
    const finishVite = timings?.start('Vite HTML hooks')
    try {
      return await options.vite.transformIndexHtml(templateUrl, template, requestUrl)
    } finally {
      finishVite?.()
    }
  }

  const loadPreparedSsrTemplate = async (
    definition: SsrCompiledConfig,
    entry: SsrCompiledConfig['applications'][number],
    requestUrl: string,
    signal?: AbortSignal,
    timings?: SsrPhaseTimings
  ) => {
    if (productionTemplates) {
      const templatePath = resolveTemplatePath(definition, entry)
      return productionTemplates.prepare(
        productionTemplatePaths.get(templatePath) ?? templatePath,
        entry.mountSelector
      )
    }
    const template = await loadTemplate(definition, entry, requestUrl, signal, timings)
    const finishPrepare = timings?.start('template preparation')
    try {
      return prepareSsrHtmlTemplate(template, entry.mountSelector)
    } finally {
      finishPrepare?.()
    }
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

  startupTimings?.mark('template preflight')
  if (options.vite && !options.production) {
    // The SSR entry and its static imports were evaluated by loadRuntimeRevision.
    // Prepare the corresponding client shells without executing browser code
    // or following dynamic imports. Reuse the asset pipeline's eager graph so
    // the first template request also inherits its completed style analysis.
    await Promise.all(initialRuntime.applications.map(async (application) => {
      try {
        await resolveApplicationStyleDependencies(
          options.vite!, application.id, `/@vue-ssr-lite/client/${application.id}`
        )
      } catch (error) {
        // Warmup is best effort. A client transform error must retain Vite's
        // normal request/HMR recovery rather than prevent the server starting.
        safeSsrLog(initialServerOptions.logger, 'debug', 'ssr.warmup.failed', {
          applicationId: application.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }))
  }
  startupTimings?.mark('client shell warmup')
  if (initialServerOptions.diagnostics) {
    startupTimings?.report(initialServerOptions.logger, 'startup', 'all', {
      lifecycle: 'startup',
      scope: inheritedStartupTimings ? 'development server including Vite' : 'managed server',
    })
  }
  if (productionTemplates) {
    await Promise.all(initialRuntime.applications.map(async (application) => {
      const path = resolveTemplatePath(initialRuntime, application)
      const canonical = productionTemplatePaths.get(path) ?? path
      if (application.kind === 'ssr' || application.hasRouteRenderOverrides) {
        await productionTemplates.prepare(canonical, application.mountSelector)
      } else {
        await productionTemplates.load(canonical)
      }
    }))
  }

  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    activeRequestCount += 1
    const startedAt = Date.now()
    const requestId =
      String(request.headers['x-request-id'] || '').trim() ||
      startedAt.toString(36) + '-' + Math.random().toString(36).slice(2, 10)
    const scope = createSsrRequestScope(lastDefinition.server.requestTimeoutMs)
    const bodySource = createSsrRequestBodySource(request, scope.signal)
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
        openBody: bodySource.openBody,
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
        takeRenderTimingDetails: () => ({
          lifecycle: timedSsrRequestCount++ === 0 ? 'first-ssr' : 'warm-ssr',
          readyToRequestMs: readyAt === undefined ? undefined : startedAt - readyAt,
        }),
        resolveProductionAssets,
        loadTemplate,
        loadPreparedSsrTemplate,
        resolveDevelopmentAssets: (applicationId, modules) =>
          options.vite
            ? resolveRenderedStyleDependencies(options.vite!, applicationId, modules)
            : Promise.resolve([]),
        isPrivateProductionAssetPath: (pathname) =>
          isSsrPrivateProductionAssetPath(pathname, viteBase),
        resolveProductionAssetResponse: (pathname, protectedTemplates, headers, method, signal) =>
          resolveProductionAssetResponse({
            clientRoot,
            pathname,
            protectedTemplates,
            viteBase,
            immutableAssetPaths,
            signal,
          }, headers, method, signal),
        serveViteRequest: options.vite
          ? async () => {
              const originalUrl = request.url
              try {
                await runViteMiddleware(options.vite!, request, response)
                return response.writableEnded || response.destroyed
              } finally {
                // Vite strips its base and may rewrite module queries. A
                // declined request must retain its application URL.
                request.url = originalUrl
              }
            }
          : undefined,
      })
      if (result && !response.writableEnded) {
        if (result instanceof Response) await writeWebResponse(request, response, result, scope.signal)
        else sendResponse(request, response, result)
      }
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
      // Detach the pull bridge before resuming Node, otherwise an unread Web
      // body could pause the socket again. This invariant covers every exit.
      bodySource.release()
      if (!request.readableEnded) {
        if (!response.destroyed && !request.destroyed && !scope.signal.aborted) request.resume()
        else request.destroy()
      }
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
    detachTemplateWatcher()
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
        // A disconnected waiter can leave server-owned compilation in flight.
        await loadingDefinition
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
          readyAt = Date.now()
          logServerReady(host, port)
          resolveListen()
        })
      }),
    close,
  }
}

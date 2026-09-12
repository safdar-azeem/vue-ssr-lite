import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ViteDevServer } from 'vite'
import { readSsrPhaseTimings } from '../SsrDiagnosticsRuntime'
import {
  resolveApplicationStyleDependencies,
  resolveRenderedStyleDependencies,
  runWithSsrViteAssetResolutionContext,
} from '../vite/SsrViteAssetRuntime'
import { readSsrViteResolvedConfigPath } from '../vite/SsrViteResolvedConfigPath'
import {
  captureSsrViteRuntimeRevision,
  importSsrViteModule,
} from '../vite/SsrViteModuleRuntime'
import {
  createSsrRequestRuntime,
  resolveManagedServerHost,
  resolveManagedServerPort,
  writeSsrProductionAsset,
  type SsrManagedServer,
  type SsrRequestDevelopmentRuntime,
} from './SsrRequestRuntime'

export { resolveManagedServerHost, resolveManagedServerPort, writeSsrProductionAsset }
export type { SsrManagedServer }

export interface SsrManagedServerOptions {
  production: boolean
  root: string
  /**
   * Selected server-config path (`vueSsrLite({ config })` or `--config`).
   * When Vite is present, the plugin-published path is preferred so failed
   * startup uses the same identity as the runtime graph.
   */
  config?: string
  loadRuntime: () => Promise<unknown>
  vite?: ViteDevServer
}

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

  // The scan can add discovered optimizer work, so snapshot processing only
  // after all scans have settled.
  const scanResult = await settle(
    optimizers
      .map((optimizer) => optimizer.scanProcessing)
      .filter((work): work is Promise<void> => Boolean(work))
  )
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

const createDevelopmentRuntime = (vite: ViteDevServer): SsrRequestDevelopmentRuntime => ({
  importModule: (specifier) => importSsrViteModule(vite, specifier),
  resolvedConfigPath: () => readSsrViteResolvedConfigPath(vite),
  watchTemplateStructure: (onChange) => {
    vite.watcher.on('add', onChange)
    vite.watcher.on('unlink', onChange)
    return () => {
      vite.watcher.off('add', onChange)
      vite.watcher.off('unlink', onChange)
    }
  },
  captureRuntimeRevision: (loaded) => captureSsrViteRuntimeRevision(vite, loaded),
  transformIndexHtml: (url, html, requestUrl) =>
    vite.transformIndexHtml(url, html, requestUrl),
  warmApplicationStyles: (applicationId, clientEntry) =>
    resolveApplicationStyleDependencies(vite, applicationId, clientEntry),
  resolveRenderedStyles: (applicationId, modules) =>
    resolveRenderedStyleDependencies(vite, applicationId, modules),
  serveRequest: (request, response) => runViteMiddleware(vite, request, response),
  runWithAssetResolutionContext: (callback) =>
    runWithSsrViteAssetResolutionContext(callback),
  waitForStartedWork: () => waitForStartedViteOptimizerWork(vite),
  close: () => vite.close(),
})

export const createSsrManagedServer = async (
  options: SsrManagedServerOptions
): Promise<SsrManagedServer> => {
  const runtime = await createSsrRequestRuntime({
    production: options.production,
    root: options.root,
    config: options.config,
    loadRuntime: options.loadRuntime,
    development: options.vite ? createDevelopmentRuntime(options.vite) : undefined,
    startupTimings: !options.production ? readSsrPhaseTimings(options) : undefined,
  })
  return runtime.createManagedServer()
}

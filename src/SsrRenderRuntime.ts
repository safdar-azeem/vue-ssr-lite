import { renderToString } from 'vue/server-renderer'
import {
  createSsrApplication,
  snapshotSsrReconciliationState,
} from './SsrApplicationRuntime'
import { createSsrResolutionController } from './SsrRequestResolution'
import { createSsrMiddlewareExecutionController } from './middleware/SsrMiddlewareRuntime'
import { collectSsrRenderDiagnostics, readSsrPhaseTimings } from './SsrDiagnosticsRuntime'
import { resolveResponseStatusForRoute } from './SsrResponseStatus'
import { serializeSsrState } from './SsrSerialization'
import { safeSsrLog } from './SsrObservability'
import { runWithSsrFetchRuntime } from './data/fetch/runtime/SsrFetchServerRuntimeScope'
import type { ManagedHeadSnapshot } from './SsrManagedHead'
import type {
  SsrResolvedApplicationDefinition,
  SsrCreatedApplication,
  SsrHydrationState,
  SsrLogger,
  SsrRenderRequest,
  SsrRenderResult,
  SsrResponseState,
} from './SsrRuntimeTypes'

const now = () => globalThis.performance?.now?.() ?? Date.now()
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength

const snapshotSerializable = <T>(value: T): T =>
  value === undefined
    ? value
    : (JSON.parse(serializeSsrState(value)) as T)

const throwIfRequestAborted = (signal: AbortSignal): void => {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException('The SSR request was aborted.', 'AbortError')
}

export interface SsrRenderOptions {
  /**
   * Maximum render passes. The first always runs; further passes only occur
   * when a plugin explicitly invalidated the rendered tree.
   * Defaults to 4, clamped to at least 1.
   */
  maxResolutionPasses?: number
  /** Bound, in ms, for awaiting registered work after a render pass. */
  resolutionDeadlineMs?: number
  /** Enables development-only render diagnostics. Inert in production. */
  diagnostics?: boolean
  /** Structured logger for diagnostics and pass reporting. */
  logger?: SsrLogger
}

const reportDiagnostics = (
  logger: SsrLogger | undefined,
  requestId: string,
  applicationId: string,
  messages: { code: string; message: string }[]
) => {
  for (const diagnostic of messages) {
    const detail = { requestId, applicationId, code: diagnostic.code }
    if (
      !safeSsrLog(
        logger,
        'warn',
        `ssr.diagnostic.${diagnostic.code}`,
        detail
      )
    ) {
      try {
        console.warn(`[vue-ssr-lite] ${diagnostic.message}`, detail)
      } catch {
        // Diagnostics are best effort.
      }
    }
  }
}

const reportCleanupFailure = (
  logger: SsrLogger | undefined,
  event: string,
  requestId: string,
  applicationId: string,
  error: unknown
): void => {
  const details = {
    requestId,
    applicationId,
    error: error instanceof Error ? error.message : String(error),
  }
  if (safeSsrLog(logger, 'error', event, details)) return
  try {
    console.error(`[vue-ssr-lite] ${event}`, details)
  } catch {
    // Cleanup reporting must not become a cleanup failure.
  }
}

export const renderSsrApplication = async <
  TApplicationState extends Record<string, any> = Record<string, unknown>,
  TPublicConfig = unknown,
>(
  definition: SsrResolvedApplicationDefinition<
    TApplicationState,
    TPublicConfig
  >,
  request: SsrRenderRequest<TPublicConfig>,
  options: SsrRenderOptions = {}
): Promise<SsrRenderResult<TApplicationState, TPublicConfig>> => {
  throwIfRequestAborted(request.signal)
  const startedAt = now()
  const timings = readSsrPhaseTimings(request)
  const maxPasses = Math.max(1, Math.floor(options.maxResolutionPasses ?? 4))
  const deadlineMs = options.resolutionDeadlineMs ?? 0
  const diagnosticsEnabled =
    options.diagnostics ?? process.env.NODE_ENV !== 'production'

  // One resolution controller is shared across every pass so tracked work and
  // pass requests accumulate coherently while the app is recreated per pass.
  const resolution = createSsrResolutionController(true)
  const middlewareController = createSsrMiddlewareExecutionController({
    server: true,
    request,
  })

  let contextReadyAt = startedAt
  let routeReadyAt = startedAt
  let renderedAt = startedAt
  let carried: Record<string, unknown> | undefined
  let carriedReconciliation: Record<string, unknown> | undefined
  let carriedApplication: TApplicationState | undefined
  let carriedResponse: SsrResponseState | undefined
  let created:
    | SsrCreatedApplication<TApplicationState, TPublicConfig>
    | undefined
  let html = ''
  let teleports: Record<string, string> = {}
  let renderedModules: string[] = []
  let passes = 0
  let middlewareEarlyExit = false
  let deadlineSnapshot:
    | {
        application: TApplicationState
        plugins: Record<string, unknown> | undefined
        head: ManagedHeadSnapshot
        response: SsrResponseState
      }
    | undefined

  const disposeCurrent = async () => {
    if (!created) return
    const current = created
    created = undefined
    await runWithSsrFetchRuntime(current.fetchRuntime, async () => {
      try {
        await definition.cleanup?.(current.context)
      } catch (error) {
        reportCleanupFailure(
          options.logger,
          'ssr.application.cleanup.failed',
          request.requestId,
          definition.id,
          error
        )
      }
      try {
        current.hydration.dispose()
      } catch (error) {
        reportCleanupFailure(
          options.logger,
          'ssr.hydration.cleanup.failed',
          request.requestId,
          definition.id,
          error
        )
      }
    })
  }

  try {
    let finalized = false
    for (let pass = 0; pass < maxPasses && !finalized; pass += 1) {
      throwIfRequestAborted(request.signal)
      passes = pass + 1
      resolution.beginPass(pass)
      const finishCreation = timings?.start('app/router creation')
      created = await createSsrApplication(definition, {
        server: true,
        request,
        resumeState: pass === 0 ? undefined : carried,
        resumeReconciliationState:
          pass === 0 ? undefined : carriedReconciliation,
        resumeApplicationState:
          pass === 0 ? undefined : carriedApplication,
        resumeResponseState: pass === 0 ? undefined : carriedResponse,
        resolution,
        middlewareController,
        runWithFetchRuntime: runWithSsrFetchRuntime,
      })
      finishCreation?.()
      const active = created
      await runWithSsrFetchRuntime(active.fetchRuntime, async () => {
        throwIfRequestAborted(request.signal)
        if (pass === 0) contextReadyAt = now()

        if (active.router) {
          const finishRoute = timings?.start('router navigation')
          const url = new URL(request.url)
          await active.router.push(`${url.pathname}${url.search}${url.hash}`)
          if (
            active.context.response.redirect ||
            middlewareController.navigationOutcome()
          ) {
            finishRoute?.()
            routeReadyAt = now()
            renderedAt = routeReadyAt
            middlewareEarlyExit = true
            finalized = true
            return
          }
          await active.router.isReady()
          finishRoute?.()
          throwIfRequestAborted(request.signal)
          resolveResponseStatusForRoute(
            active.context.response,
            active.router.currentRoute.value
          )
        }
        if (pass === 0) routeReadyAt = now()

        const ssrContext: {
          teleports?: Record<string, string>
          modules?: Set<string>
        } = {}
        const finishVue = timings?.start('Vue render')
        html = await renderToString(active.app, ssrContext)
        finishVue?.()
        resolution.completeReactivityObservation()
        throwIfRequestAborted(request.signal)
        teleports = { ...(ssrContext.teleports ?? {}) }
        // Replace rather than union: only the pass that produced `html` may own
        // request assets. Earlier resolution passes are intentionally discarded.
        renderedModules = [...(ssrContext.modules ?? [])]
        renderedAt = now()

        const pending = resolution.pendingWork()
        const isLastPass = pass === maxPasses - 1
        let resolutionSettled = true

        // Tracked work gates final serialization, but does not by itself
        // invalidate the HTML. A plugin must explicitly request another pass
        // when settling that work changes render-visible state. Inspect the
        // request after draining as work may invalidate the tree asynchronously.
        if (pending.length > 0) {
          const fallbackSnapshot =
            Number.isFinite(deadlineMs) && deadlineMs > 0
              ? {
                  application: snapshotSerializable(active.context.state),
                  plugins: snapshotSerializable(active.hydration.collect()),
                  head: snapshotSerializable(active.managedHead.collect()),
                  response: snapshotSerializable(active.context.response),
                }
              : undefined
          resolutionSettled = await resolution.drain(
            deadlineMs,
            request.signal
          )
          throwIfRequestAborted(request.signal)
          if (!resolutionSettled) {
            deadlineSnapshot = fallbackSnapshot
            reportDiagnostics(options.logger, request.requestId, definition.id, [
              {
                code: 'resolution-deadline',
                message: `Resolution work did not settle within the ${deadlineMs}ms deadline; serializing the latest render.`,
              },
            ])
          }
        }

        // A deadline is terminal for this resolution cycle. Re-rendering before
        // tracked work settles cannot produce a known-final tree, so serialize
        // the latest completed render with the diagnostic above. Cancellation
        // has already propagated through throwIfRequestAborted().
        if (!resolutionSettled) {
          finalized = true
          return
        }

        resolution.completeReactivityPass()

        if (!resolution.additionalPassRequested()) {
          finalized = true
          return
        }

        if (isLastPass) {
          finalized = true
          reportDiagnostics(options.logger, request.requestId, definition.id, [
            {
              code: 'resolution-pass-limit',
              message: `Resolution did not settle within ${maxPasses} render passes; serializing the last render.`,
            },
          ])
          return
        }

        // The rendered tree was invalidated. Carry browser-safe plugin state and
        // request-local reconciliation history through separate channels, then
        // recreate the application warm for the next bounded pass.
        // Transfer owned snapshots before cleanup. A discarded application's
        // cleanup cannot mutate the state accepted by the next pass.
        carried = snapshotSsrReconciliationState(active.hydration.collect())
        carriedReconciliation = snapshotSsrReconciliationState(
          active.hydration.collectReconciliation()
        )
        carriedApplication = snapshotSsrReconciliationState(
          active.context.state
        )
        carriedResponse = snapshotSsrReconciliationState(
          active.context.response
        )
        await disposeCurrent()
      })
    }

    if (!created) throw new Error('SSR render produced no application instance.')
    const active = created
    return await runWithSsrFetchRuntime(active.fetchRuntime, async () => {
      const head =
        deadlineSnapshot?.head ??
        snapshotSsrReconciliationState(active.managedHead.collect())

      if (diagnosticsEnabled && !middlewareEarlyExit) {
        reportDiagnostics(
          options.logger,
          request.requestId,
          definition.id,
          collectSsrRenderDiagnostics({
            html,
            route: active.router?.currentRoute.value ?? null,
            requestUrl: request.url,
            applicationId: definition.id,
          })
        )
      }

      const finishSerialization = timings?.start('serialization')
      const hydrationState: SsrHydrationState<
        TApplicationState,
        TPublicConfig
      > = {
        version: 1,
        applicationId: definition.id,
        publicConfig: request.publicConfig,
        domain: request.domain,
        application:
          deadlineSnapshot?.application ??
          snapshotSsrReconciliationState(active.context.state),
        siteOrigin: active.context.siteOrigin,
        siteSeo: request.siteSeo,
        plugins: deadlineSnapshot
          ? deadlineSnapshot.plugins
          : snapshotSsrReconciliationState(active.hydration.collect()),
      }
      const stateBytes = byteLength(serializeSsrState(hydrationState))
      finishSerialization?.()
      const totalAt = now()

      return {
        html,
        teleports,
        renderedModules,
        head,
        response:
          deadlineSnapshot?.response ??
          snapshotSsrReconciliationState(active.context.response),
        hydrationState,
        metrics: {
          requestId: request.requestId,
          applicationId: definition.id,
          contextDurationMs: contextReadyAt - startedAt,
          routeDurationMs: routeReadyAt - contextReadyAt,
          renderDurationMs: renderedAt - routeReadyAt,
          totalDurationMs: totalAt - startedAt,
          htmlBytes: byteLength(html),
          stateBytes,
          renderPasses: passes,
        },
      }
    })
  } finally {
    await disposeCurrent()
    resolution.dispose()
    middlewareController.dispose()
  }
}

/** @internal SSR renderer bound to the same module graph as an application. */
export type SsrApplicationRenderer = typeof renderSsrApplication

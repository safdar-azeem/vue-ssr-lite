import { renderToString } from 'vue/server-renderer'
import { createSsrApplication } from './SsrApplicationRuntime'
import { createSsrResolutionController } from './SsrRequestResolution'
import { collectSsrRenderDiagnostics } from './SsrDiagnosticsRuntime'
import { resolveResponseStatusForRoute } from './SsrResponseStatus'
import { serializeSsrState } from './SsrSerialization'
import { safeSsrLog } from './SsrObservability'
import type {
  SsrResolvedApplicationDefinition,
  SsrCreatedApplication,
  SsrHydrationState,
  SsrLogger,
  SsrRenderRequest,
  SsrRenderResult,
} from './SsrRuntimeTypes'

const now = () => globalThis.performance?.now?.() ?? Date.now()
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength

const throwIfRequestAborted = (signal: AbortSignal): void => {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException('The SSR request was aborted.', 'AbortError')
}

export interface SsrRenderOptions {
  /**
   * Maximum render passes. The first always runs; further passes only occur
   * when a plugin left resolution work pending or asked for another pass.
   * Defaults to 4, clamped to at least 1.
   */
  maxResolutionPasses?: number
  /** Bound, in ms, for awaiting registered work between passes. */
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
  const maxPasses = Math.max(1, Math.floor(options.maxResolutionPasses ?? 4))
  const deadlineMs = options.resolutionDeadlineMs ?? 0
  const diagnosticsEnabled =
    options.diagnostics ?? process.env.NODE_ENV !== 'production'

  // One resolution controller is shared across every pass so tracked work and
  // pass requests accumulate coherently while the app is recreated per pass.
  const resolution = createSsrResolutionController(true)

  let contextReadyAt = startedAt
  let routeReadyAt = startedAt
  let renderedAt = startedAt
  let carried: Record<string, unknown> | undefined
  let created:
    | SsrCreatedApplication<TApplicationState, TPublicConfig>
    | undefined
  let html = ''
  let teleports: Record<string, string> = {}
  let passes = 0

  const disposeCurrent = async () => {
    if (!created) return
    const current = created
    created = undefined
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
  }

  try {
    let finalized = false
    for (let pass = 0; pass < maxPasses && !finalized; pass += 1) {
      throwIfRequestAborted(request.signal)
      passes = pass + 1
      resolution.beginPass(pass)
      created = await createSsrApplication(definition, {
        server: true,
        request,
        resumeState: pass === 0 ? undefined : carried,
        resolution,
      })
      throwIfRequestAborted(request.signal)
      if (pass === 0) contextReadyAt = now()

      if (created.router) {
        const url = new URL(request.url)
        await created.router.push(`${url.pathname}${url.search}${url.hash}`)
        await created.router.isReady()
        throwIfRequestAborted(request.signal)
        resolveResponseStatusForRoute(
          created.context.response,
          created.router.currentRoute.value
        )
      }
      if (pass === 0) routeReadyAt = now()

      const ssrContext: { teleports?: Record<string, string> } = {}
      html = await renderToString(created.app, ssrContext)
      throwIfRequestAborted(request.signal)
      teleports = { ...(ssrContext.teleports ?? {}) }
      renderedAt = now()

      const pending = resolution.pendingWork()
      const wantsAnotherPass = resolution.additionalPassRequested()
      const isLastPass = pass === maxPasses - 1

      if ((pending.length === 0 && !wantsAnotherPass) || isLastPass) {
        finalized = true
        if (isLastPass && (pending.length > 0 || wantsAnotherPass)) {
          reportDiagnostics(options.logger, request.requestId, definition.id, [
            {
              code: 'resolution-pass-limit',
              message: `Resolution did not settle within ${maxPasses} render passes; serializing the last render.`,
            },
          ])
        }
        break
      }

      // Another pass is warranted. Carry plugin state forward, await the
      // registered work (bounded), then recreate the app warm.
      await resolution.drain(deadlineMs, request.signal)
      throwIfRequestAborted(request.signal)
      carried = created.hydration.collect()
      await disposeCurrent()
    }

    if (!created) throw new Error('SSR render produced no application instance.')

    const head = created.managedHead.collect()

    if (diagnosticsEnabled) {
      reportDiagnostics(
        options.logger,
        request.requestId,
        definition.id,
        collectSsrRenderDiagnostics({
          html,
          route: created.router?.currentRoute.value ?? null,
          requestUrl: request.url,
          applicationId: definition.id,
        })
      )
    }

    const hydrationState: SsrHydrationState<
      TApplicationState,
      TPublicConfig
    > = {
      version: 1,
      applicationId: definition.id,
      publicConfig: request.publicConfig,
      domain: request.domain,
      application: created.context.state,
      siteOrigin: created.context.siteOrigin,
      plugins: created.hydration.collect(),
    }
    const stateBytes = byteLength(serializeSsrState(hydrationState))
    const totalAt = now()

    return {
      html,
      teleports,
      head,
      response: created.context.response,
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
  } finally {
    if (created) {
      try {
        await definition.cleanup?.(created.context)
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
        created.hydration.dispose()
      } catch (error) {
        reportCleanupFailure(
          options.logger,
          'ssr.hydration.cleanup.failed',
          request.requestId,
          definition.id,
          error
        )
      }
    }
    resolution.dispose()
  }
}

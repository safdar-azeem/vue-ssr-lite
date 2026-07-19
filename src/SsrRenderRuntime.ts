import { renderToString } from '@vue/server-renderer'
import { createSsrApplication } from './SsrApplicationRuntime'
import { createSsrResolutionController } from './SsrRequestResolution'
import { collectSsrRenderDiagnostics } from './SsrDiagnosticsRuntime'
import { serializeSsrState } from './SsrSerialization'
import type {
  SsrApplicationDefinition,
  SsrCreatedApplication,
  SsrHydrationState,
  SsrLogger,
  SsrRenderRequest,
  SsrRenderResult,
} from './SsrRuntimeTypes'

const now = () => globalThis.performance?.now?.() ?? Date.now()
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength

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
    if (logger?.warn) logger.warn(`ssr.diagnostic.${diagnostic.code}`, detail)
    else console.warn(`[vue-ssr-lite] ${diagnostic.message}`, detail)
  }
}

export const renderSsrApplication = async <
  TApplicationState extends Record<string, any> = Record<string, unknown>,
  TPublicConfig = unknown,
  TExtension = unknown,
>(
  definition: SsrApplicationDefinition<
    TApplicationState,
    TPublicConfig,
    TExtension
  >,
  request: SsrRenderRequest<TPublicConfig>,
  options: SsrRenderOptions = {}
): Promise<SsrRenderResult<TApplicationState, TPublicConfig>> => {
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
    | SsrCreatedApplication<TApplicationState, TPublicConfig, TExtension>
    | undefined
  let html = ''
  let teleports = ''
  let passes = 0
  let primaryError: unknown

  const disposeCurrent = async () => {
    if (!created) return
    const current = created
    created = undefined
    try {
      await definition.cleanup?.(current.context)
    } catch (error) {
      console.error('[vue-ssr-lite] application cleanup failed', error)
    }
    try {
      current.hydration.dispose()
    } catch (error) {
      console.error('[vue-ssr-lite] hydration cleanup failed', error)
    }
  }

  try {
    let finalized = false
    for (let pass = 0; pass < maxPasses && !finalized; pass += 1) {
      passes = pass + 1
      resolution.beginPass(pass)
      created = await createSsrApplication(definition, {
        server: true,
        request,
        resumeState: pass === 0 ? undefined : carried,
        resolution,
      })
      if (pass === 0) contextReadyAt = now()

      if (created.router) {
        const url = new URL(request.url)
        await created.router.push(`${url.pathname}${url.search}${url.hash}`)
        await created.router.isReady()
        if (created.router.currentRoute.value.matched.length === 0) {
          created.context.response.statusCode = 404
        }
      }
      if (pass === 0) routeReadyAt = now()

      const ssrContext: { teleports?: Record<string, string> } = {}
      html = await renderToString(created.app, ssrContext)
      teleports = ssrContext.teleports?.body ?? ''
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
      carried = created.hydration.collect()
      await disposeCurrent()
    }

    if (!created) throw new Error('SSR render produced no application instance.')

    const head =
      (await definition.resolveHead?.(created.context)) ??
      created.context.head.value

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
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    let cleanupError: unknown
    if (created) {
      try {
        await definition.cleanup?.(created.context)
      } catch (error) {
        cleanupError = error
        console.error('[vue-ssr-lite] application cleanup failed', error)
      }
      try {
        created.hydration.dispose()
      } catch (error) {
        console.error('[vue-ssr-lite] hydration cleanup failed', error)
        if (!cleanupError) cleanupError = error
      }
    }
    resolution.dispose()
    if (!primaryError && cleanupError) throw cleanupError
  }
}

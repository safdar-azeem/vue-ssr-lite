import { renderToString } from '@vue/server-renderer'
import { createSsrApplication } from './SsrApplicationRuntime'
import { serializeSsrState } from './SsrSerialization'
import type {
  SsrApplicationDefinition,
  SsrHydrationState,
  SsrRenderRequest,
  SsrRenderResult,
} from './SsrRuntimeTypes'

const now = () => globalThis.performance?.now?.() ?? Date.now()
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength

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
  request: SsrRenderRequest<TPublicConfig>
): Promise<SsrRenderResult<TApplicationState, TPublicConfig>> => {
  const startedAt = now()
  const created = await createSsrApplication(definition, {
    server: true,
    request,
  })
  const contextReadyAt = now()
  let primaryError: unknown

  try {
    if (created.router) {
      const url = new URL(request.url)
      await created.router.push(`${url.pathname}${url.search}${url.hash}`)
      await created.router.isReady()
      if (created.router.currentRoute.value.matched.length === 0) {
        created.context.response.statusCode = 404
      }
    }
    const routeReadyAt = now()
    const ssrContext: { teleports?: Record<string, string> } = {}
    const html = await renderToString(created.app, ssrContext)
    const renderedAt = now()
    const head =
      (await definition.resolveHead?.(created.context)) ??
      created.context.head.value
    const hydrationState: SsrHydrationState<
      TApplicationState,
      TPublicConfig
    > = {
      version: 1,
      applicationId: definition.id,
      publicConfig: request.publicConfig,
      application: created.context.state,
      plugins: created.hydration.collect(),
    }
    const stateBytes = byteLength(serializeSsrState(hydrationState))
    const totalAt = now()

    return {
      html,
      teleports: ssrContext.teleports?.body ?? '',
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
      },
    }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    let cleanupError: unknown
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
    if (!primaryError && cleanupError) throw cleanupError
  }
}

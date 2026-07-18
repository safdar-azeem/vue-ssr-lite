import { createApp, createSSRApp, ref } from 'vue'
import {
  createMemoryHistory,
  createRouter,
  createWebHistory,
} from 'vue-router'
import { SSR_REQUEST_CONTEXT } from './SsrRequestContext'
import {
  createSsrHydrationController,
  SSR_HYDRATION_CONTEXT,
} from './SsrHydrationRuntime'
import {
  createSsrResolutionController,
  SSR_REQUEST_RESOLUTION,
  type SsrResolutionController,
} from './SsrRequestResolution'
import type {
  SsrApplicationDefinition,
  SsrCreatedApplication,
  SsrHydrationState,
  SsrRenderRequest,
  SsrRequestContext,
} from './SsrRuntimeTypes'

export interface SsrCreateApplicationOptions<
  TApplicationState,
  TPublicConfig,
> {
  server: boolean
  request: SsrRenderRequest<TPublicConfig>
  hydrationState?: SsrHydrationState<TApplicationState, TPublicConfig> | null
  /**
   * Pure client-side SPA mount (no server markup to hydrate). Uses `createApp`
   * instead of `createSSRApp` so Vue performs a full client render.
   */
  spa?: boolean
  /**
   * Server re-render only: opaque plugin state carried from the previous pass,
   * restored so plugins (an API client cache, an i18n loader) resume warm.
   */
  resumeState?: Record<string, unknown> | null
  /**
   * Reuse a resolution controller across render passes of the same request.
   * A fresh one is created when omitted.
   */
  resolution?: SsrResolutionController
}

export const createSsrApplication = async <
  TApplicationState extends Record<string, any> = Record<string, unknown>,
  TPublicConfig = unknown,
  TExtension = unknown,
>(
  definition: SsrApplicationDefinition<
    TApplicationState,
    TPublicConfig,
    TExtension
  >,
  options: SsrCreateApplicationOptions<TApplicationState, TPublicConfig>
): Promise<SsrCreatedApplication<TApplicationState, TPublicConfig, TExtension>> => {
  if (!definition?.id || !definition.rootComponent) {
    throw new Error('An SSR application requires an id and rootComponent.')
  }
  if (
    options.hydrationState &&
    options.hydrationState.applicationId !== definition.id
  ) {
    throw new Error('Hydration state belongs to a different SSR application.')
  }

  const routes =
    typeof definition.routes === 'function'
      ? definition.routes()
      : definition.routes
  const router = routes
    ? createRouter({
        history: options.server ? createMemoryHistory() : createWebHistory(),
        routes,
        scrollBehavior(to, from, savedPosition) {
          if (savedPosition) return savedPosition
          if (to.hash) return { el: to.hash, top: 24 }
          if (to.fullPath === from.fullPath) return
          return { left: 0, top: 0 }
        },
      })
    : null

  const state =
    options.hydrationState?.application ??
    definition.createInitialState?.() ??
    ({} as TApplicationState)
  const response = {
    statusCode: 200,
    headers: {},
    redirect: null,
  }

  // The hydration controller owns generic plugin state contribution and
  // restoration. On the browser it carries the plugin state serialized during
  // the server render so installed plugins can restore before mount. On a
  // server re-render pass it carries `resumeState` so plugins resume warm.
  const hydration = createSsrHydrationController(
    options.hydrationState?.plugins ?? options.resumeState,
    options.server
  )
  // The resolution controller is shared across render passes of one request so
  // registered work and pass requests accumulate coherently.
  const resolution =
    options.resolution ?? createSsrResolutionController(options.server)

  const baseContext = {
    applicationId: definition.id,
    request: options.request,
    url: new URL(options.request.url),
    host: options.request.host,
    publicConfig: options.request.publicConfig,
    state,
    head: ref(null),
    response,
    hydration,
    resolution,
  }
  const extension = definition.createExtension
    ? await definition.createExtension(baseContext as any)
    : (undefined as TExtension)
  const context: SsrRequestContext<
    TApplicationState,
    TPublicConfig,
    TExtension
  > = { ...baseContext, extension }

  try {
    const app = options.spa
      ? createApp(definition.rootComponent)
      : createSSRApp(definition.rootComponent)
    if (router) app.use(router)
    // Provide the generic hydration and resolution contracts BEFORE the
    // application installs its own plugins, so a plugin's `install()` can
    // inject them (via `app.runWithContext`) to restore state ahead of the
    // first component and register in-flight work.
    app.provide(SSR_HYDRATION_CONTEXT, hydration)
    app.provide(SSR_REQUEST_RESOLUTION, resolution)
    app.provide(SSR_REQUEST_CONTEXT, context)
    for (const plugin of definition.plugins ?? []) app.use(plugin)
    await definition.install?.({
      app,
      router,
      context,
      hydration,
      resolution,
      server: options.server,
    })

    return { app, router, context, hydration, resolution }
  } catch (error) {
    hydration.dispose()
    throw error
  }
}

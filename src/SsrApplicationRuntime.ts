import { createApp, createSSRApp, ref } from 'vue'
import {
  createMemoryHistory,
  createRouter,
  createWebHistory,
  type Router,
} from 'vue-router'
import {
  installSsrDomainContext,
  SSR_DOMAIN_CONTEXT,
} from './SsrDomainRuntime'
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
  SsrCreatedApplication,
  SsrHydrationState,
  SsrRenderRequest,
  SsrRequestContext,
  SsrResolvedApplicationDefinition,
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
  definition: SsrResolvedApplicationDefinition<
    TApplicationState,
    TPublicConfig,
    TExtension
  >,
  options: SsrCreateApplicationOptions<TApplicationState, TPublicConfig>
): Promise<SsrCreatedApplication<TApplicationState, TPublicConfig, TExtension>> => {
  if (!definition?.id || !definition.root) {
    throw new Error(
      'A resolved application requires an internal id and a root component.'
    )
  }
  if (
    options.hydrationState &&
    options.hydrationState.applicationId !== definition.id
  ) {
    throw new Error('Hydration state belongs to a different SSR application.')
  }

  if (definition.routes && definition.router) {
    throw new Error(
      `Application "${definition.id}" cannot declare both routes and router.`
    )
  }
  const routes =
    typeof definition.routes === 'function'
      ? definition.routes()
      : definition.routes
  let router: Router | null = null
  if (definition.router || routes) {
    // Do not touch Vue Router at all for router-less applications. This is
    // important during browser hydration where a test or embedded document may
    // not have a usable location URL yet.
    const history = options.server ? createMemoryHistory() : createWebHistory()
    router = definition.router
      ? definition.router({ history, server: options.server })
      : createRouter({
          history,
          routes: routes!,
          scrollBehavior:
            definition.scrollBehavior ??
            ((to, from, savedPosition) => {
              if (savedPosition) return savedPosition
              if (to.hash) return { el: to.hash, top: 24 }
              if (to.fullPath === from.fullPath) return
              return { left: 0, top: 0 }
            }),
        })
  }

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
  // Browser SPA/hydration only: keep a process-local domain for route guards
  // and other non-setup callers. Server requests stay concurrent-safe via
  // Vue provide/inject on each app instance.
  const uninstallDomain = options.server
    ? () => undefined
    : installSsrDomainContext(options.request.domain)
  const disposeHydration = hydration.dispose.bind(hydration)
  hydration.dispose = () => {
    uninstallDomain()
    disposeHydration()
  }

  const baseContext = {
    applicationId: definition.id,
    request: options.request,
    url: new URL(options.request.url),
    host: options.request.host,
    domain: options.request.domain,
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
      ? createApp(definition.root)
      : createSSRApp(definition.root)
    if (router) app.use(router)
    app.provide(SSR_DOMAIN_CONTEXT, options.request.domain)
    // Provide the generic hydration and resolution contracts BEFORE the
    // application installs its own plugins, so a plugin's `install()` can
    // inject them (via `app.runWithContext`) to restore state ahead of the
    // first component and register in-flight work.
    app.provide(SSR_HYDRATION_CONTEXT, hydration)
    app.provide(SSR_REQUEST_RESOLUTION, resolution)
    app.provide(SSR_REQUEST_CONTEXT, context)
    const plugins =
      typeof definition.plugins === 'function'
        ? definition.plugins()
        : definition.plugins ?? []
    for (const plugin of plugins) app.use(plugin)
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

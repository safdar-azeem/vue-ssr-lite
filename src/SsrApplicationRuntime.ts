import { createApp, createSSRApp, reactive, toRaw } from 'vue'
import {
  createMemoryHistory,
  createRouter,
  createWebHistory,
  type Router,
} from 'vue-router'
import {
  createExtensionRuntime,
  SSR_EXTENSION_RUNTIME,
} from './core/extensions/ExtensionRuntime'
import { resolveBuiltInExtensions } from './extensions/resolveBuiltInExtensions'
import {
  recomputeSeoResponseStatus,
  type SeoState,
} from './extensions/seo/state'
import { isPrivateSeoMode, isSeoEnabled } from './extensions/seo/types'
import {
  isSsrProduction,
  resolveCanonicalOrigin,
} from './SsrCanonicalOrigin'
import {
  installSsrDomainContext,
  SSR_DOMAIN_CONTEXT,
} from './SsrDomainRuntime'
import { createManagedHeadController } from './SsrManagedHead'
import {
  installSsrRequestContextObservation,
  SSR_REQUEST_CONTEXT,
  unwrapSsrRequestObservation,
} from './SsrRequestContext'
import { resolveResponseStatusForRoute } from './SsrResponseStatus'
import { serializeSsrState } from './SsrSerialization'
import { fingerprintSsrReconciliationState } from './SsrReconciliationFingerprint'
import {
  createSsrHydrationController,
  SSR_HYDRATION_CONTEXT,
} from './SsrHydrationRuntime'
import {
  createSsrResolutionController,
  SSR_REQUEST_RESOLUTION,
  type SsrResolutionController,
} from './SsrRequestResolution'
import { installCrossRenderNavigation } from './SsrRouteRenderRuntime'
import type {
  SsrCreatedApplication,
  SsrHydrationState,
  SsrRenderRequest,
  SsrRequestContext,
  SsrResolvedApplicationDefinition,
} from './SsrRuntimeTypes'

const resolveApplicationSiteOrigin = (
  definition: SsrResolvedApplicationDefinition<any, any>,
  request: SsrRenderRequest<any>,
  production: boolean,
  requireSeoOrigin: boolean
): string => {
  const requireProductionOrigin =
    production &&
    requireSeoOrigin &&
    isSeoEnabled(definition.seo) &&
    !isPrivateSeoMode(definition.seo)
  return resolveCanonicalOrigin({
    siteUrl: definition.seo?.siteUrl,
    requestOrigin: request.siteOrigin,
    fallbackOrigin: new URL(request.url).origin,
    production,
    requireProductionOrigin,
    allowHttpOrigin: definition.seo?.allowHttpOrigin,
  })
}

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
   * Server reconciliation only: application state accepted from the prior pass.
   */
  resumeApplicationState?: TApplicationState | null
  /** Server reconciliation only: response state accepted from the prior pass. */
  resumeResponseState?: SsrRequestContext<
    TApplicationState,
    TPublicConfig
  >['response'] | null
  /**
   * Reuse a resolution controller across render passes of the same request.
   * A fresh one is created when omitted.
   */
  resolution?: SsrResolutionController
}

export const createSsrApplication = async <
  TApplicationState extends Record<string, any> = Record<string, unknown>,
  TPublicConfig = unknown,
>(
  definition: SsrResolvedApplicationDefinition<
    TApplicationState,
    TPublicConfig
  >,
  options: SsrCreateApplicationOptions<TApplicationState, TPublicConfig>
): Promise<SsrCreatedApplication<TApplicationState, TPublicConfig>> => {
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

  const initialState =
    options.hydrationState?.application ??
    options.resumeApplicationState ??
    definition.createInitialState?.() ??
    ({} as TApplicationState)
  // `createInitialState` is once per request. Reconciliation apps receive an
  // owned snapshot from the prior accepted pass and wrap that snapshot in a
  // fresh Vue proxy; install hooks still execute for every recreated app.
  const state = reactive(initialState) as unknown as TApplicationState
  const response = options.resumeResponseState ?? {
    statusCode: 200,
    headers: {},
    redirect: null,
  }
  const production = isSsrProduction()
  const siteOrigin =
    options.hydrationState?.siteOrigin ??
    resolveApplicationSiteOrigin(
      definition,
      options.request,
      production,
      !options.spa
    )
  const managedHead = createManagedHeadController(options.server)

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

  const context: SsrRequestContext<TApplicationState, TPublicConfig> = {
    applicationId: definition.id,
    request: options.request,
    url: new URL(options.request.url),
    host: options.request.host,
    domain: options.request.domain,
    publicConfig: options.request.publicConfig,
    siteOrigin,
    state,
    response,
    hydration,
    resolution,
  }
  if (options.server) installSsrRequestContextObservation(context)
  resolution.setReactivityCheckpointReader(() =>
    fingerprintSsrReconciliationState(
      {
        application: context.state,
        plugins: hydration.collect(),
        head: managedHead.collect(),
        response: context.response,
      },
      unwrapSsrRequestObservation
    )
  )
  const extensionRuntime = createExtensionRuntime(
    resolveBuiltInExtensions(
      definition,
      options.hydrationState?.siteSeo ?? options.request.siteSeo
    ),
    definition.extensions ?? [],
    {
      applicationId: definition.id,
      server: options.server,
      production,
      getRoute: () => router?.currentRoute.value ?? null,
      getSiteOrigin: () => siteOrigin,
      getPathname: () => router?.currentRoute.value.path ?? context.url.pathname,
      getResponseStatus: () => context.response.statusCode,
      getRedirected: () => Boolean(context.response.redirect),
      managedHead,
    }
  )
  Object.assign(context, {
    managedHead,
    [SSR_EXTENSION_RUNTIME]: extensionRuntime,
  })

  try {
    const app = options.spa
      ? createApp(definition.root)
      : createSSRApp(definition.root)
    if (router) {
      if (!options.server) {
        installCrossRenderNavigation(router, definition.defaultRender ?? 'ssr')
      }
      app.use(router)
      router.afterEach((to, _from, failure) => {
        if (failure) return
        resolveResponseStatusForRoute(context.response, to)
        const seoState = extensionRuntime.getState<SeoState>('seo')
        if (seoState) recomputeSeoResponseStatus(seoState, context.response, to)
        if (!options.server) managedHead.invalidate()
      })
    }
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
    extensionRuntime.setup()
    hydration.onDispose(() => {
      extensionRuntime.dispose()
      managedHead.dispose()
    })

    return { app, router, context, hydration, resolution, managedHead }
  } catch (error) {
    extensionRuntime.dispose()
    managedHead.dispose()
    hydration.dispose()
    throw error
  }
}

const cloneReconciliationValue = (
  value: unknown,
  seen: WeakMap<object, unknown>
): unknown => {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return value
  }
  if (typeof value === 'function') return value
  const raw = toRaw(unwrapSsrRequestObservation(value))
  const existing = seen.get(raw)
  if (existing !== undefined) return existing
  if (raw instanceof Date) return new Date(raw.getTime())
  if (raw instanceof RegExp) return new RegExp(raw.source, raw.flags)
  if (raw instanceof Map) {
    const cloned = new Map()
    seen.set(raw, cloned)
    for (const [key, entry] of raw) {
      cloned.set(
        cloneReconciliationValue(key, seen),
        cloneReconciliationValue(entry, seen)
      )
    }
    return cloned
  }
  if (raw instanceof Set) {
    const cloned = new Set()
    seen.set(raw, cloned)
    for (const entry of raw) {
      cloned.add(cloneReconciliationValue(entry, seen))
    }
    return cloned
  }
  const cloned: Record<PropertyKey, unknown> | unknown[] = Array.isArray(raw)
    ? []
    : Object.create(Object.getPrototypeOf(raw))
  seen.set(raw, cloned)
  for (const key of Reflect.ownKeys(raw)) {
    if (Array.isArray(raw) && key === 'length') continue
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)
    if (!descriptor) continue
    if ('value' in descriptor) {
      descriptor.value = cloneReconciliationValue(descriptor.value, seen)
    }
    Object.defineProperty(cloned, key, descriptor)
  }
  return cloned
}

/**
 * Transfer application state between recreated SSR apps without retaining the
 * discarded app's live reactive proxy. The snapshot preserves supported
 * request-local object graphs, Maps, Sets, descriptors, and circular ownership.
 */
export const snapshotSsrReconciliationState = <T>(value: T): T =>
  cloneReconciliationValue(value, new WeakMap()) as T

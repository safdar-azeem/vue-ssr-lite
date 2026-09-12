import type { App } from 'vue'
import {
  isNavigationFailure,
  NavigationFailureType,
  START_LOCATION,
  createWebHistory,
} from 'vue-router'
import { createSsrApplicationCore } from './SsrApplicationCore'
import { createSsrBrowserResolution } from './SsrBrowserResolution'
import { markSsrBrowserIdle, markSsrBrowserPhase } from './SsrBrowserTiming'
import { completeSsrBrowserHydration } from './SsrHydrationRuntime'
import type { SsrDomainContext } from './SsrConfigTypes'
import { getSsrStateElementId } from './SsrSerialization'
import { resolveResponseStatusForRoute } from './SsrResponseStatus'
import type {
  SsrHydrationState,
  SsrApplicationDefinition,
  SsrRenderRequest,
} from './SsrRuntimeTypes'

/** Application definition after the server/config integration assigns its id. */
export type SsrClientApplicationDefinition<
  TApplicationState = Record<string, unknown>,
  TPublicConfig = unknown,
> = SsrApplicationDefinition<TApplicationState, TPublicConfig> & { id: string }

const browserHost = {
  createHistory: createWebHistory,
  createResolution: createSsrBrowserResolution,
}

const createSsrApplication = (
  definition: SsrClientApplicationDefinition<any, any>,
  options: Parameters<typeof createSsrApplicationCore>[1]
) => createSsrApplicationCore(definition, options, browserHost)

export interface SsrHydrateOptions {
  mountSelector?: string
  stateElementId?: string
}

export interface SsrSpaMountOptions<TPublicConfig = unknown> {
  mountSelector?: string
  /** Client-side public config. Defaults to injected SPA domain state. */
  publicConfig?: TPublicConfig
  /** Initial URL to route to. Defaults to `window.location`. */
  url?: string
  /** Domain context. Defaults to `#vue-ssr-lite-domain` injection. */
  domain?: SsrDomainContext
}

export interface SsrMountedApplication {
  app: App
  /** Unmount the app and dispose per-request resources. */
  unmount: () => void
}

const browserRequest = <TPublicConfig>(
  publicConfig: TPublicConfig,
  domain: SsrDomainContext,
  url: string,
  prefix: string,
  signal: AbortSignal
): SsrRenderRequest<TPublicConfig> => ({
  requestId: `${prefix}-${Date.now().toString(36)}`,
  // Browser callers may provide a Vue Router-style relative target. Request
  // context consumers require an absolute URL, while navigation continues to
  // use the original target passed to mountSpaApplication().
  url: new URL(url, window.location.href).href,
  host: window.location.host,
  protocol: window.location.protocol === 'https:' ? 'https' : 'http',
  method: 'GET',
  headers: {},
  publicConfig,
  domain,
  signal,
})

const readSpaDomainState = <TPublicConfig>(): {
  publicConfig: TPublicConfig
  domain: SsrDomainContext
  applicationId?: string
} | null => {
  const element = document.getElementById('vue-ssr-lite-domain')
  if (!element?.textContent) return null
  try {
    return JSON.parse(element.textContent) as {
      publicConfig: TPublicConfig
      domain: SsrDomainContext
      applicationId?: string
    }
  } catch {
    return null
  }
}

export const hydrateSsrApplication = async (
  definition: SsrClientApplicationDefinition<any, any>,
  options: SsrHydrateOptions = {}
): Promise<void> => {
  markSsrBrowserPhase(definition.id, 'hydrate-start')
  const stateElementId =
    options.stateElementId ?? getSsrStateElementId(definition.id)
  const stateElement = document.getElementById(stateElementId)
  if (!stateElement?.textContent) {
    throw new Error(`SSR hydration state element "${stateElementId}" is missing.`)
  }
  const hydrationState = JSON.parse(
    stateElement.textContent
  ) as SsrHydrationState<any, any>
  if (hydrationState.version !== 1) {
    throw new Error(`Unsupported SSR hydration state version.`)
  }
  if (!hydrationState.domain) {
    throw new Error('SSR hydration state is missing domain context.')
  }
  const controller = new AbortController()
  const request = {
    ...browserRequest(
      hydrationState.publicConfig,
      hydrationState.domain,
      window.location.href,
      'browser',
      controller.signal
    ),
    siteOrigin: hydrationState.siteOrigin,
  }
  let created: Awaited<ReturnType<typeof createSsrApplication>> | undefined
  try {
    created = await createSsrApplication(definition, {
      server: false,
      request,
      hydrationState,
    })
    markSsrBrowserPhase(definition.id, 'application-ready')
    if (created.router) {
      try {
        const target =
          `${window.location.pathname}${window.location.search}${window.location.hash}`
        const targetFullPath = created.router.resolve(target).fullPath
        const current = created.router.currentRoute.value
        const middlewareOutcomeBeforePush =
          created.middleware?.navigationOutcome(targetFullPath)
        const automaticNavigationHandled =
          Boolean(middlewareOutcomeBeforePush) ||
          (current !== START_LOCATION &&
            (current.fullPath === targetFullPath ||
              current.redirectedFrom?.fullPath === targetFullPath))
        const navigationFailure = automaticNavigationHandled
          ? undefined
          : await created.router.push(target)
        const middlewareOutcome =
          created.middleware?.navigationOutcome(targetFullPath)
        const navigationAborted = isNavigationFailure(
          navigationFailure,
          NavigationFailureType.aborted
        )
        if (!middlewareOutcome && !navigationAborted) {
          await created.router.isReady()
          markSsrBrowserPhase(definition.id, 'router-ready')
          resolveResponseStatusForRoute(
            created.context.response,
            created.router.currentRoute.value
          )
        } else if (middlewareOutcome === 'redirect') {
          controller.abort()
          created.hydration.dispose()
          return
        }
      } finally {
        created.middleware?.completeBrowserBootstrap()
      }
    }

    // The initial START_LOCATION navigation is intentionally outside browser
    // loading UI. Server markup remains visible until this hydration mount;
    // RouterView and LoadingIndicator observe subsequent navigations only.
    markSsrBrowserPhase(definition.id, 'mount-start')
    created.app.mount(options.mountSelector ?? '#app')
    await completeSsrBrowserHydration(created.app, created.hydration)
    created.managedHead.hydrate(document.head)
    stateElement.remove()
    markSsrBrowserPhase(definition.id, 'hydrate-complete')
    markSsrBrowserIdle(definition.id, controller.signal, created.hydration)
  } catch (error) {
    controller.abort()
    try {
      created?.hydration.dispose()
    } catch (cleanupError) {
      console.error('[vue-ssr-lite] hydration cleanup failed', cleanupError)
    }
    throw error
  }
}

/**
 * Mounts a resolved universal application as a pure client-side SPA.
 * Domain context is restored from the server-injected `#vue-ssr-lite-domain`
 * payload so SPA and SSR share the same library-owned resolution.
 */
export const mountSpaApplication = async <
  TApplicationState extends Record<string, any> = Record<string, unknown>,
  TPublicConfig = unknown,
>(
  definition: SsrClientApplicationDefinition<
    TApplicationState,
    TPublicConfig
  >,
  options: SsrSpaMountOptions<TPublicConfig> = {}
): Promise<SsrMountedApplication> => {
  markSsrBrowserPhase(definition.id, 'spa-start')
  const injected = readSpaDomainState<TPublicConfig>()
  const domain = options.domain ?? injected?.domain
  if (!domain) {
    throw new Error(
      'vue-ssr-lite SPA mount requires domain context. Ensure the managed server injected #vue-ssr-lite-domain.'
    )
  }
  const publicConfig =
    options.publicConfig ?? injected?.publicConfig ?? ({} as TPublicConfig)
  const controller = new AbortController()
  const request = browserRequest(
    publicConfig,
    domain,
    options.url ?? window.location.href,
    'spa',
    controller.signal
  )
  let created: Awaited<ReturnType<typeof createSsrApplication>> | undefined
  try {
    created = await createSsrApplication(definition, {
      server: false,
      spa: true,
      request,
    })
    markSsrBrowserPhase(definition.id, 'application-ready')
    if (created.router) {
      try {
        const target =
          options.url ??
          `${window.location.pathname}${window.location.search}${window.location.hash}`
        const targetFullPath = created.router.resolve(target).fullPath
        const current = created.router.currentRoute.value
        const middlewareOutcomeBeforePush =
          created.middleware?.navigationOutcome(targetFullPath)
        const automaticNavigationHandled =
          Boolean(middlewareOutcomeBeforePush) ||
          (current !== START_LOCATION &&
            (current.fullPath === targetFullPath ||
              current.redirectedFrom?.fullPath === targetFullPath))
        const navigationFailure = automaticNavigationHandled
          ? undefined
          : await created.router.push(target)
        const middlewareOutcome =
          created.middleware?.navigationOutcome(targetFullPath)
        const navigationAborted = isNavigationFailure(
          navigationFailure,
          NavigationFailureType.aborted
        )
        if (!middlewareOutcome && !navigationAborted) {
          await created.router.isReady()
          markSsrBrowserPhase(definition.id, 'router-ready')
          resolveResponseStatusForRoute(
            created.context.response,
            created.router.currentRoute.value
          )
        } else if (middlewareOutcome === 'redirect') {
          controller.abort()
          created.hydration.dispose()
          return { app: created.app, unmount: () => undefined }
        }
      } finally {
        created.middleware?.completeBrowserBootstrap()
      }
    }
    const app = created.app
    const activeCreated = created
    // The static index.html shell owns initial SPA feedback. Framework loading
    // components mount only after middleware accepted the initial navigation.
    markSsrBrowserPhase(definition.id, 'mount-start')
    app.mount(options.mountSelector ?? '#app')
    activeCreated.managedHead.hydrate(document.head)
    document.getElementById('vue-ssr-lite-domain')?.remove()
    markSsrBrowserPhase(definition.id, 'spa-mounted')
    markSsrBrowserIdle(definition.id, controller.signal, activeCreated.hydration)
    return {
      app,
      unmount: () => {
        controller.abort()
        app.unmount()
        try {
          activeCreated.hydration.dispose()
        } catch (cleanupError) {
          console.error('[vue-ssr-lite] SPA cleanup failed', cleanupError)
        }
      },
    }
  } catch (error) {
    controller.abort()
    try {
      created?.hydration.dispose()
    } catch (cleanupError) {
      console.error('[vue-ssr-lite] SPA cleanup failed', cleanupError)
    }
    throw error
  }
}

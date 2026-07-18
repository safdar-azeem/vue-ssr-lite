import type { App } from 'vue'
import { createSsrApplication } from './SsrApplicationRuntime'
import { getSsrStateElementId } from './SsrSerialization'
import type {
  SsrApplicationDefinition,
  SsrHydrationState,
  SsrRenderRequest,
} from './SsrRuntimeTypes'

export interface SsrHydrateOptions {
  mountSelector?: string
  stateElementId?: string
  removeHeadSelector?: string
}

export interface SsrSpaMountOptions<TPublicConfig = unknown> {
  mountSelector?: string
  /** Client-side public config. Defaults to `{}` for a self-contained SPA. */
  publicConfig?: TPublicConfig
  /** Initial URL to route to. Defaults to `window.location`. */
  url?: string
}

export interface SsrMountedApplication {
  app: App
  /** Unmount the app and dispose per-request resources. */
  unmount: () => void
}

const browserRequest = <TPublicConfig>(
  publicConfig: TPublicConfig,
  url: string,
  prefix: string,
  signal: AbortSignal
): SsrRenderRequest<TPublicConfig> => ({
  requestId: `${prefix}-${Date.now().toString(36)}`,
  url,
  host: window.location.host,
  protocol: window.location.protocol === 'https:' ? 'https' : 'http',
  method: 'GET',
  headers: {},
  publicConfig,
  signal,
})

export const hydrateSsrApplication = async (
  definition: SsrApplicationDefinition<any, any, any>,
  options: SsrHydrateOptions = {}
): Promise<void> => {
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
  const controller = new AbortController()
  const request = browserRequest(
    hydrationState.publicConfig,
    window.location.href,
    'browser',
    controller.signal
  )
  let created: Awaited<ReturnType<typeof createSsrApplication>> | undefined
  try {
    created = await createSsrApplication(definition, {
      server: false,
      request,
      hydrationState,
    })
    if (created.router) {
      await created.router.push(
        `${window.location.pathname}${window.location.search}${window.location.hash}`
      )
      await created.router.isReady()
    }

    created.app.mount(options.mountSelector ?? definition.mountSelector ?? '#app')
    document.head
      .querySelectorAll(
        options.removeHeadSelector ?? '[data-vue-ssr-lite-head]'
      )
      .forEach((element) => element.remove())
    stateElement.remove()
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
 * Mounts an {@link SsrApplicationDefinition} as a pure client-side SPA — the
 * third mode alongside server render and browser hydration. The SAME definition
 * (root component, routes, plugins, install hook, public config delivery) drives
 * all three, so a consumer's SPA entry and SSR entry cannot drift. No server
 * markup is required: Vue performs a full client render.
 */
export const mountSpaApplication = async <
  TApplicationState extends Record<string, any> = Record<string, unknown>,
  TPublicConfig = unknown,
  TExtension = unknown,
>(
  definition: SsrApplicationDefinition<
    TApplicationState,
    TPublicConfig,
    TExtension
  >,
  options: SsrSpaMountOptions<TPublicConfig> = {}
): Promise<SsrMountedApplication> => {
  const controller = new AbortController()
  const request = browserRequest(
    (options.publicConfig ?? {}) as TPublicConfig,
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
    if (created.router) {
      await created.router.push(
        options.url ??
          `${window.location.pathname}${window.location.search}${window.location.hash}`
      )
      await created.router.isReady()
    }
    const app = created.app
    const activeCreated = created
    app.mount(options.mountSelector ?? definition.mountSelector ?? '#app')
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

import type { App } from 'vue'
import { createSsrApplication } from './SsrApplicationRuntime'
import type { SsrDomainContext } from './SsrConfigTypes'
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
  url,
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
  if (!hydrationState.domain) {
    throw new Error('SSR hydration state is missing domain context.')
  }
  const controller = new AbortController()
  const request = browserRequest(
    hydrationState.publicConfig,
    hydrationState.domain,
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
 * Mounts an {@link SsrApplicationDefinition} as a pure client-side SPA.
 * Domain context is restored from the server-injected `#vue-ssr-lite-domain`
 * payload so SPA and SSR share the same library-owned resolution.
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
    document.getElementById('vue-ssr-lite-domain')?.remove()
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

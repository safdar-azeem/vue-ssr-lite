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
  const request: SsrRenderRequest<any> = {
    requestId: `browser-${Date.now().toString(36)}`,
    url: window.location.href,
    host: window.location.host,
    protocol: window.location.protocol === 'https:' ? 'https' : 'http',
    method: 'GET',
    headers: {},
    publicConfig: hydrationState.publicConfig,
    signal: controller.signal,
  }
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

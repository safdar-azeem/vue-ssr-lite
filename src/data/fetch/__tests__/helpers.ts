import { createSsrHydrationController } from '../../../SsrHydrationRuntime'
import { createSsrResolutionController } from '../../../SsrServerResolution'
import { createTestRenderRequest } from '../../../SsrTestFixtures'
import type { SsrRenderRequest, SsrRequestContext } from '../../../SsrRuntimeTypes'
import { SsrFetchRuntime, type HookConsumer } from '../runtime/SsrFetchRuntime'
import {
  FETCH_HYDRATION_KEY,
  type HydratedFetchRecord,
  type ReconciledFetchRecord,
} from '../runtime/SsrFetchHydration'
import type { UseFetchOptionsBase } from '../types/SsrFetchTypes'

export const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

export const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json' },
})

export const createFetchHarness = (options: {
  server?: boolean
  hydrating?: boolean
  restored?: Record<string, HydratedFetchRecord>
  reconciliation?: Record<string, ReconciledFetchRecord>
  request?: Partial<SsrRenderRequest>
} = {}) => {
  const server = options.server ?? false
  const request = createTestRenderRequest('fetch.test', options.request)
  const hydration = createSsrHydrationController(
    options.restored ? { [FETCH_HYDRATION_KEY]: options.restored } : undefined,
    server,
    options.reconciliation ? { [FETCH_HYDRATION_KEY]: options.reconciliation } : undefined
  )
  const resolution = createSsrResolutionController(server)
  const context: SsrRequestContext = {
    applicationId: 'fetch-tests', request, url: new URL(request.url), host: request.host,
    domain: request.domain, publicConfig: {}, siteOrigin: 'https://seo-only.test', state: {},
    response: { statusCode: 200, headers: {} }, hydration, resolution,
  }
  const runtime = new SsrFetchRuntime(server, context, hydration, options.hydrating ?? false)
  const attach = (url = '/api/items', settings: UseFetchOptionsBase<unknown, object> = {}, variables?: unknown) => {
    const consumer = runtime.createConsumer(runtime.resolve(url, variables, settings), settings, () => undefined)
    return { consumer, initial: runtime.initialize(consumer) }
  }
  const change = (consumer: HookConsumer, url: string, variables?: unknown) => {
    if (runtime.move(consumer, runtime.resolve(url, variables, consumer.options))) return runtime.automatic(consumer)
    return Promise.resolve()
  }
  return {
    runtime, hydration, resolution, attach, change,
    snapshot: () => hydration.collect()?.[FETCH_HYDRATION_KEY] as Record<string, HydratedFetchRecord>,
    reconciliationSnapshot: () => hydration.collectReconciliation()?.[FETCH_HYDRATION_KEY] as Record<string, ReconciledFetchRecord>,
    dispose: () => { hydration.dispose(); resolution.dispose() },
  }
}

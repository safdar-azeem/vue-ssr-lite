import { createSsrRequestRuntime } from './SsrRequestRuntime'
import {
  createSsrRequestScope,
  SsrRequestCancelledError,
  SsrRequestTimeoutError,
  type SsrNormalizedRequest,
  type SsrRequestScope,
} from './SsrRequestHandler'
import { ssrHttpResponseToWebResponse } from './SsrWebHttpRuntime'
import {
  normalizeServerResponse, sanitizeFetchedResponseHeaders,
  rememberLegacyResponseHeaders, unchangedLegacyResponseHeaders,
} from '../server-routes/SsrServerResponseRuntime'
import { renderSsrErrorDocument } from './SsrHtmlRuntime'
import { safeSsrLog } from '../SsrObservability'

/** A failed cold start is retryable; concurrent cold requests share one attempt. */
export const createSsrProductionRequestHandler = (options: {
  root: string
  loadRuntime: () => Promise<unknown>
}) => {
  let initialization: ReturnType<typeof createSsrRequestRuntime> | undefined
  const initialize = () => initialization ??= createSsrRequestRuntime({ ...options, production: true })
    .catch((error) => { initialization = undefined; throw error })

  return async (request: SsrNormalizedRequest, signal: AbortSignal): Promise<Response> => {
    if (signal.aborted) throw new SsrRequestCancelledError()
    let scope: SsrRequestScope | undefined
    const onAbort = () => scope?.cancel()
    const dispose = () => {
      signal.removeEventListener('abort', onAbort)
      scope?.dispose()
    }
    let runtime: Awaited<ReturnType<typeof createSsrRequestRuntime>> | undefined
    try {
      let cancelInitialization: (() => void) | undefined
      try {
        runtime = await Promise.race([
          initialize(),
          new Promise<never>((_resolve, reject) => {
            cancelInitialization = () => reject(new SsrRequestCancelledError())
            signal.addEventListener('abort', cancelInitialization, { once: true })
            if (signal.aborted) cancelInitialization()
          }),
        ])
      } finally {
        if (cancelInitialization) signal.removeEventListener('abort', cancelInitialization)
      }
      if (signal.aborted) throw new SsrRequestCancelledError()
      scope = createSsrRequestScope(runtime.definition().server.requestTimeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      const result = await runtime.execute(request, scope)
      if (!result) throw new Error('Production request did not produce a response.')
      const response = normalizeServerResponse(result instanceof Response ? result : ssrHttpResponseToWebResponse(result))
      sanitizeFetchedResponseHeaders(response)
      const withBody = (body: BodyInit | null) => {
        const wrapped = new Response(body, response)
        rememberLegacyResponseHeaders(wrapped, unchangedLegacyResponseHeaders(response))
        return wrapped
      }
      if (request.method === 'HEAD' || !response.body) {
        if (response.body) void response.body.cancel().catch(() => undefined)
        dispose()
        return withBody(null)
      }
      // Core converts an elapsed request deadline into a safe, finite 504 body.
      // That error response must remain deliverable after its work signal aborted.
      if (scope.signal.aborted) { dispose(); return response }

      const reader = response.body.getReader()
      let finished = false
      let controller: ReadableStreamDefaultController<Uint8Array>
      const finish = () => {
        if (finished) return
        finished = true
        scope!.signal.removeEventListener('abort', abortBody)
        dispose()
      }
      const abortBody = () => {
        if (finished) return
        const reason = scope!.signal.reason
        if (reason instanceof SsrRequestTimeoutError) {
          safeSsrLog(runtime!.definition().server.logger, 'error', 'ssr.transport.failed', {
            requestId: request.requestId, pathname: request.url, error: reason,
          })
        }
        finish()
        void reader.cancel(reason).catch(() => undefined)
        controller.error(reason)
      }
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value
          scope!.signal.addEventListener('abort', abortBody, { once: true })
          if (scope!.signal.aborted) abortBody()
        },
        async pull() {
          try {
            const chunk = await reader.read()
            if (finished) return
            if (chunk.done) { finish(); controller.close() }
            else controller.enqueue(chunk.value)
          } catch (error) {
            if (finished) return
            finish()
            safeSsrLog(runtime!.definition().server.logger, 'error', 'ssr.transport.failed', {
              requestId: request.requestId, pathname: request.url, error,
            })
            controller.error(error)
          }
        },
        cancel(reason) {
          finish()
          return reader.cancel(reason)
        },
      }, { highWaterMark: 0 })
      return withBody(body)
    } catch (error) {
      dispose()
      if (signal.aborted || error instanceof SsrRequestCancelledError) throw new SsrRequestCancelledError()
      safeSsrLog(runtime?.definition().server.logger, 'error', 'ssr.runtime.failed', {
        requestId: request.requestId, applicationId: 'unknown', pathname: request.url, error,
      })
      return new Response(request.method === 'HEAD' ? null : renderSsrErrorDocument(
        'Application unavailable', 'The application could not render this page. Please try again.'
      ), {
        status: 500,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
  }
}

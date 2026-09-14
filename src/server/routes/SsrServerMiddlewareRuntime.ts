import type { ServerMiddlewareBaseContext, ServerMiddlewareList } from './SsrServerRouteTypes'
import { normalizeServerResponse } from './SsrServerResponseRuntime'

export const assertServerResponse = normalizeServerResponse

/** One mutable request context, onion unwinding, and one continuation per layer. */
export const executeServerMiddleware = async (
  middleware: ServerMiddlewareList,
  request: Request,
  context: ServerMiddlewareBaseContext,
  terminal: () => Response | Promise<Response>
): Promise<Response> => {
  const dispatch = async (index: number): Promise<Response> => {
    const current = middleware[index]
    if (!current) return assertServerResponse(await terminal())
    let called = false
    const next = (): Promise<Response> => {
      if (called) throw new Error('Server middleware next() may only be called once.')
      called = true
      const downstream = dispatch(index + 1)
      // Missing `return next()` is reported by the return contract below. Observe
      // late rejections too, without changing what an awaited next() receives.
      void downstream.catch(() => undefined)
      return downstream
    }
    return assertServerResponse(await current(request, context, next))
  }
  return dispatch(0)
}

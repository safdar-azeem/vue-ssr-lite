import type { ServerMiddleware, ServerMiddlewareHandler } from './SsrServerRouteTypes'

/** Separate from Vue navigation middleware. Native Request in, native Response out. */
export function defineServerMiddleware<Provides extends object = {}, Requires extends object = {}>(
  handler: ServerMiddlewareHandler<Provides, Requires>
): ServerMiddleware<Provides, Requires> {
  return handler as ServerMiddleware<Provides, Requires>
}

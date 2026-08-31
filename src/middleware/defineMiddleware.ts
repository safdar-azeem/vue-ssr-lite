import type { Middleware } from './SsrMiddlewareTypes'

/** Typed identity helper for universal application middleware. */
export const defineMiddleware = <TPublicConfig = unknown>(
  middleware: Middleware<TPublicConfig>
): Middleware<TPublicConfig> => middleware

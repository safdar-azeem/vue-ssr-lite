import type { RouteLocationNormalized } from 'vue-router'
import type { Middleware } from './SsrMiddlewareTypes'

/** Shared executor-presence semantics. Do not invoke meta.middleware getters. */
export const requiresSsrMiddlewareRuntime = (
  middleware: readonly Middleware<any>[],
  route: RouteLocationNormalized
): boolean => middleware.length > 0 || route.matched.some((record) => 'middleware' in record.meta)

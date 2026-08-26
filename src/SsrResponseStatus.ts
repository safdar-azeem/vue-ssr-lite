import type { RouteLocationNormalizedLoaded } from 'vue-router'
import { useSsrRequestContext } from './SsrRequestContext'
import type { SsrResponseState } from './SsrRuntimeTypes'

const runtimeStatus = new WeakSet<SsrResponseState>()

export const isValidResponseStatus = (status: unknown): status is number =>
  typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599

export const validateResponseStatus = (status: unknown): number => {
  if (!isValidResponseStatus(status)) {
    throw new Error(
      `[vue-ssr-lite] Invalid HTTP status ${String(status)}. Status must be a finite integer between 100 and 599.`
    )
  }
  return status
}

const validateNonRedirectResponseStatus = (status: unknown): number => {
  const validated = validateResponseStatus(status)
  if (validated >= 300 && validated < 400) {
    throw new Error('[vue-ssr-lite] 3xx status requires setResponseRedirect().')
  }
  return validated
}

export const applyRuntimeResponseStatus = (response: SsrResponseState, status: unknown): number => {
  const validated = validateResponseStatus(status)
  response.statusCode = validated
  runtimeStatus.add(response)
  return validated
}

export const hasRuntimeResponseStatus = (response: SsrResponseState): boolean =>
  runtimeStatus.has(response)

export const resetRouteResponseStatus = (response: SsrResponseState): void => {
  runtimeStatus.delete(response)
  response.statusCode = 200
}

export interface SsrResponseStatusSnapshot {
  statusCode: number
  runtime: boolean
}

export const snapshotResponseStatus = (response: SsrResponseState): SsrResponseStatusSnapshot => ({
  statusCode: response.statusCode,
  runtime: runtimeStatus.has(response),
})

export const restoreResponseStatus = (
  response: SsrResponseState,
  snapshot: SsrResponseStatusSnapshot
): void => {
  response.statusCode = snapshot.statusCode
  if (snapshot.runtime) runtimeStatus.add(response)
  else runtimeStatus.delete(response)
}

export const readRouteSeoStatus = (
  route: RouteLocationNormalizedLoaded | null | undefined
): number | undefined => {
  const matched = route?.matched ?? []
  for (let index = matched.length - 1; index >= 0; index -= 1) {
    const status = matched[index]?.meta?.seo?.status
    if (status !== undefined) return validateNonRedirectResponseStatus(status)
  }
  const status = route?.meta?.seo?.status
  return status === undefined ? undefined : validateNonRedirectResponseStatus(status)
}

export const applyRouteResponseStatus = (
  response: SsrResponseState,
  route: RouteLocationNormalizedLoaded | null | undefined
): number => {
  if (runtimeStatus.has(response)) return response.statusCode
  response.statusCode = readRouteSeoStatus(route) ?? 200
  return response.statusCode
}

export const resolveResponseStatusForRoute = (
  response: SsrResponseState,
  route: RouteLocationNormalizedLoaded | null | undefined
): number => {
  resetRouteResponseStatus(response)
  if (!route || route.matched.length === 0) {
    response.statusCode = 404
    return response.statusCode
  }
  return applyRouteResponseStatus(response, route)
}

/** Recalculate the scoped declarative SEO status without outranking Core overrides. */
export const applySeoLayerResponseStatus = (
  response: SsrResponseState,
  route: RouteLocationNormalizedLoaded | null | undefined,
  status: number | undefined
): number => {
  if (runtimeStatus.has(response)) return response.statusCode
  response.statusCode = status === undefined
    ? readRouteSeoStatus(route) ?? (route && route.matched.length === 0 ? 404 : 200)
    : validateNonRedirectResponseStatus(status)
  return response.statusCode
}

export const isErrorResponseStatus = (status: number): boolean => status >= 400 && status <= 599

/** Dynamic SSR status override. Wins over `meta.seo.status` for the current route. */
export const setResponseStatus = (status: number): number =>
  applyRuntimeResponseStatus(
    useSsrRequestContext().response,
    validateNonRedirectResponseStatus(status)
  )

export interface SsrResponseRedirectOptions {
  status?: 301 | 302 | 303 | 307 | 308
  allowExternal?: boolean
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const REDIRECT_CONTROL = /[\u0000-\u001f\u007f]/

/** Record a validated HTTP redirect during SSR. Browser calls are intentionally inert. */
export const setResponseRedirect = (
  location: string,
  options: SsrResponseRedirectOptions = {}
): void => {
  if (typeof window !== 'undefined') return
  if (typeof location !== 'string' || !location || REDIRECT_CONTROL.test(location)) {
    throw new Error('[vue-ssr-lite] Redirect location must be a non-empty URL without control characters.')
  }
  const status = options.status ?? 302
  if (!REDIRECT_STATUS.has(status)) {
    throw new Error('[vue-ssr-lite] Redirect status must be 301, 302, 303, 307, or 308.')
  }
  const context = useSsrRequestContext()
  let target: URL
  try {
    target = new URL(location, context.url)
  } catch {
    throw new Error('[vue-ssr-lite] Redirect location must be a valid URL.')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('[vue-ssr-lite] Redirect location must use HTTP or HTTPS.')
  }
  if (target.username || target.password) {
    throw new Error('[vue-ssr-lite] Redirect location must not contain credentials.')
  }
  if (!options.allowExternal && target.origin !== context.url.origin) {
    throw new Error('[vue-ssr-lite] Cross-origin redirect requires allowExternal: true.')
  }
  context.response.redirect = {
    location: target.href,
    statusCode: status,
    allowExternal: options.allowExternal ?? false,
  }
}

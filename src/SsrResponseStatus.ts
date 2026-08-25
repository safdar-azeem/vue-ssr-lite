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

export const applyRuntimeResponseStatus = (response: SsrResponseState, status: unknown): number => {
  const validated = validateResponseStatus(status)
  response.statusCode = validated
  runtimeStatus.add(response)
  return validated
}

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
    if (status !== undefined) return validateResponseStatus(status)
  }
  const status = route?.meta?.seo?.status
  return status === undefined ? undefined : validateResponseStatus(status)
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

export const isErrorResponseStatus = (status: number): boolean => status >= 400 && status <= 599

/** Dynamic SSR status override. Wins over `meta.seo.status` for the current route. */
export const setResponseStatus = (status: number): number =>
  applyRuntimeResponseStatus(useSsrRequestContext().response, status)

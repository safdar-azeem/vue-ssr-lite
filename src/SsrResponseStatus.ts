import { getCurrentInstance, onActivated, onDeactivated, onUnmounted } from 'vue'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import { useSsrRequestContext } from './SsrRequestContext'
import type { SsrResponseState } from './SsrRuntimeTypes'

const runtimeStatus = new WeakSet<SsrResponseState>()

interface BrowserResponseStatusOwner {
  status: number
  active: boolean
  order: number
  lifecycleInstalled: boolean
}

interface BrowserResponseStatusState {
  owners: Map<object, BrowserResponseStatusOwner>
  declarativeStatus: number
  nextOrder: number
}

const browserResponseStatus = new WeakMap<SsrResponseState, BrowserResponseStatusState>()

const getBrowserResponseStatusState = (
  response: SsrResponseState,
  create = false
): BrowserResponseStatusState | undefined => {
  if (typeof window === 'undefined') return undefined
  const existing = browserResponseStatus.get(response)
  if (existing || !create) return existing
  const state: BrowserResponseStatusState = {
    owners: new Map(),
    declarativeStatus: response.statusCode,
    nextOrder: 1,
  }
  browserResponseStatus.set(response, state)
  return state
}

const activeBrowserResponseStatus = (
  state: BrowserResponseStatusState
): number | undefined => {
  let selected: BrowserResponseStatusOwner | undefined
  for (const owner of state.owners.values()) {
    if (!owner.active || (selected && selected.order > owner.order)) continue
    selected = owner
  }
  return selected?.status
}

const reconcileBrowserResponseStatus = (
  response: SsrResponseState,
  state: BrowserResponseStatusState
): number => {
  const owned = activeBrowserResponseStatus(state)
  if (owned !== undefined) {
    response.statusCode = owned
    runtimeStatus.add(response)
    return owned
  }
  runtimeStatus.delete(response)
  response.statusCode = state.declarativeStatus
  return response.statusCode
}

const invalidateBrowserResponseHead = (context: unknown): void => {
  const managedHead = (context as { managedHead?: { invalidate(): void } }).managedHead
  managedHead?.invalidate()
}

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
    throw new Error('[vue-ssr-lite] A 3xx status is a redirect; use redirectTo().')
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
  const browserState = getBrowserResponseStatusState(response)
  if (browserState) {
    browserState.declarativeStatus = 200
    reconcileBrowserResponseStatus(response, browserState)
    return
  }
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
  const routeStatus = readRouteSeoStatus(route) ?? 200
  const browserState = getBrowserResponseStatusState(response)
  if (browserState) {
    browserState.declarativeStatus = routeStatus
    if (activeBrowserResponseStatus(browserState) !== undefined) {
      return reconcileBrowserResponseStatus(response, browserState)
    }
  }
  if (runtimeStatus.has(response)) return response.statusCode
  response.statusCode = routeStatus
  return response.statusCode
}

export const resolveResponseStatusForRoute = (
  response: SsrResponseState,
  route: RouteLocationNormalizedLoaded | null | undefined
): number => {
  const routeStatus =
    !route || route.matched.length === 0
      ? 404
      : readRouteSeoStatus(route) ?? 200
  const browserState = getBrowserResponseStatusState(response, true)
  if (browserState) {
    browserState.declarativeStatus = routeStatus
    return reconcileBrowserResponseStatus(response, browserState)
  }
  resetRouteResponseStatus(response)
  response.statusCode = routeStatus
  return response.statusCode
}

/** Recalculate the scoped declarative SEO status without outranking Core overrides. */
export const applySeoLayerResponseStatus = (
  response: SsrResponseState,
  route: RouteLocationNormalizedLoaded | null | undefined,
  status: number | undefined
): number => {
  const declarativeStatus = status === undefined
    ? readRouteSeoStatus(route) ?? (route && route.matched.length === 0 ? 404 : 200)
    : validateNonRedirectResponseStatus(status)
  const browserState = getBrowserResponseStatusState(response)
  if (browserState) {
    browserState.declarativeStatus = declarativeStatus
    if (activeBrowserResponseStatus(browserState) !== undefined) {
      return reconcileBrowserResponseStatus(response, browserState)
    }
  }
  if (runtimeStatus.has(response)) return response.statusCode
  response.statusCode = declarativeStatus
  return response.statusCode
}

export const isErrorResponseStatus = (status: number): boolean => status >= 400 && status <= 599

/**
 * Dynamic SSR status override. In the browser a call made during component
 * setup is owned by that component; calls outside setup remain validated no-ops.
 */
export const setHttpStatus = (status: number): number => {
  const validated = validateNonRedirectResponseStatus(status)
  if (typeof window !== 'undefined') {
    const instance = getCurrentInstance()
    if (!instance || instance.isUnmounted) return validated
    let context: ReturnType<typeof useSsrRequestContext>
    try {
      context = useSsrRequestContext()
    } catch {
      return validated
    }
    const response = context.response
    if (context.resolution.server) {
      return applyRuntimeResponseStatus(response, validated)
    }
    const state = getBrowserResponseStatusState(response, true)!
    let owner = state.owners.get(instance)
    if (!owner) {
      owner = {
        status: validated,
        active: true,
        order: state.nextOrder++,
        lifecycleInstalled: false,
      }
      state.owners.set(instance, owner)
    } else {
      owner.status = validated
      owner.active = true
      owner.order = state.nextOrder++
    }
    reconcileBrowserResponseStatus(response, state)
    invalidateBrowserResponseHead(context)
    if (!owner.lifecycleInstalled) {
      owner.lifecycleInstalled = true
      onDeactivated(() => {
        owner!.active = false
        reconcileBrowserResponseStatus(response, state)
        invalidateBrowserResponseHead(context)
      })
      onActivated(() => {
        owner!.active = true
        owner!.order = state.nextOrder++
        reconcileBrowserResponseStatus(response, state)
        invalidateBrowserResponseHead(context)
      })
      onUnmounted(() => {
        state.owners.delete(instance)
        reconcileBrowserResponseStatus(response, state)
        invalidateBrowserResponseHead(context)
      })
    }
    return validated
  }
  return applyRuntimeResponseStatus(useSsrRequestContext().response, validated)
}

export interface SsrResponseRedirectOptions {
  status?: 301 | 302 | 303 | 307 | 308
  allowExternal?: boolean
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const REDIRECT_CONTROL = /[\u0000-\u001f\u007f]/

/** Record a validated HTTP redirect during SSR. Browser calls are intentionally inert. */
export const redirectTo = (
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

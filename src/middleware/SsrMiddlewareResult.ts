import type { RouteLocationRaw } from 'vue-router'
import type {
  MiddlewareRedirectOptions,
  MiddlewareRedirectResult,
  MiddlewareRedirectStatus,
  MiddlewareResult,
} from './SsrMiddlewareTypes'

const REDIRECT_STATUS = new Set<MiddlewareRedirectStatus>([
  301,
  302,
  303,
  307,
  308,
])

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isRouteLocationObject = (value: Record<string, unknown>): boolean => {
  if (hasOwn(value, 'path')) return typeof value.path === 'string'
  if (hasOwn(value, 'name')) {
    return typeof value.name === 'string' || typeof value.name === 'symbol'
  }
  return ['params', 'query', 'hash', 'replace', 'state', 'force'].some((key) =>
    hasOwn(value, key)
  )
}

export const createMiddlewareRedirectResult = (
  location: RouteLocationRaw,
  options: MiddlewareRedirectOptions = {}
): MiddlewareRedirectResult => {
  if (typeof location === 'string') {
    if (!location || /[\u0000-\u001f\u007f]/.test(location)) {
      throw new Error(
        '[vue-ssr-lite] Middleware redirect location must be a non-empty value without control characters.'
      )
    }
  } else if (!isRecord(location) || !isRouteLocationObject(location)) {
    throw new Error(
      '[vue-ssr-lite] Middleware redirect location must be a Vue Router location.'
    )
  }
  const status = options.status ?? 302
  if (!REDIRECT_STATUS.has(status)) {
    throw new Error(
      '[vue-ssr-lite] Middleware redirect status must be 301, 302, 303, 307, or 308.'
    )
  }
  return {
    __vueSsrLiteMiddlewareRedirect: true,
    location,
    external: options.external ?? false,
    status,
  }
}

export type ClassifiedMiddlewareResult =
  | { kind: 'continue' }
  | { kind: 'cancel' }
  | { kind: 'redirect'; location: RouteLocationRaw }
  | { kind: 'props'; props: Record<string, unknown> }
  | { kind: 'special-redirect'; redirect: MiddlewareRedirectResult }

const isSpecialRedirect = (
  value: Record<string, unknown>
): value is Record<string, unknown> & MiddlewareRedirectResult =>
  value.__vueSsrLiteMiddlewareRedirect === true

export const classifyMiddlewareResult = (
  result: MiddlewareResult,
  label: string,
  target: string
): ClassifiedMiddlewareResult => {
  if (result === undefined || result === true) return { kind: 'continue' }
  if (result === false) return { kind: 'cancel' }
  if (typeof result === 'string') {
    if (!result || /[\u0000-\u001f\u007f]/.test(result)) {
      throw new Error(
        `[vue-ssr-lite] ${label} returned an invalid route redirect while navigating to "${target}".`
      )
    }
    return { kind: 'redirect', location: result }
  }
  if (isRecord(result)) {
    if (isSpecialRedirect(result)) {
      if (typeof result.external !== 'boolean') {
        throw new Error(
          `[vue-ssr-lite] ${label} returned an invalid special redirect while navigating to "${target}".`
        )
      }
      return {
        kind: 'special-redirect',
        redirect: createMiddlewareRedirectResult(result.location, {
          external: result.external,
          status: result.status,
        }),
      }
    }
    if (hasOwn(result, 'props')) {
      if (!isRecord(result.props)) {
        throw new Error(
          `[vue-ssr-lite] ${label} returned invalid props while navigating to "${target}". Middleware props must be an object.`
        )
      }
      return {
        kind: 'props',
        props: { ...result.props },
      }
    }
    if (isRouteLocationObject(result)) {
      return { kind: 'redirect', location: result as RouteLocationRaw }
    }
  }
  throw new Error(
    `[vue-ssr-lite] ${label} returned an unsupported result while navigating to "${target}".`
  )
}

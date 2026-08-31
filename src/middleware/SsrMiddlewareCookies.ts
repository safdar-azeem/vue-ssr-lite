import type { SsrRenderRequest, SsrResponseState } from '../SsrRuntimeTypes'
import type {
  MiddlewareCookieOptions,
  MiddlewareCookies,
} from './SsrMiddlewareTypes'

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const COOKIE_CONTROL = /[\u0000-\u001f\u007f]/
const COOKIE_DOMAIN = /^\.?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/

const assertCookieName = (name: string): void => {
  if (typeof name !== 'string' || !COOKIE_NAME.test(name)) {
    throw new Error('[vue-ssr-lite] Cookie name contains invalid characters.')
  }
}

const decodeCookieValue = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const parseCookieHeader = (header: string): Map<string, string> => {
  const cookies = new Map<string, string>()
  for (const segment of header.split(';')) {
    const separator = segment.indexOf('=')
    if (separator <= 0) continue
    const name = segment.slice(0, separator).trim()
    if (!COOKIE_NAME.test(name) || cookies.has(name)) continue
    let value = segment.slice(separator + 1).trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1)
    }
    if (COOKIE_CONTROL.test(value)) continue
    cookies.set(name, decodeCookieValue(value))
  }
  return cookies
}

const readHeader = (
  request: SsrRenderRequest<unknown>,
  name: string
): string | undefined => {
  const entry = Object.entries(request.headers).find(
    ([key]) => key.toLowerCase() === name
  )
  const value = entry?.[1]
  if (typeof value === 'string' || value === undefined) return value
  return [...value].join('; ')
}

const normalizeCookieOptions = (
  options: MiddlewareCookieOptions
): Required<Pick<MiddlewareCookieOptions, 'path'>> & MiddlewareCookieOptions => {
  const path = options.path ?? '/'
  if (!path.startsWith('/') || COOKIE_CONTROL.test(path) || path.includes(';')) {
    throw new Error(
      '[vue-ssr-lite] Cookie path must start with "/" and contain no control characters or semicolons.'
    )
  }
  if (
    options.domain !== undefined &&
    (COOKIE_CONTROL.test(options.domain) || !COOKIE_DOMAIN.test(options.domain))
  ) {
    throw new Error('[vue-ssr-lite] Cookie domain is invalid.')
  }
  if (
    options.expires !== undefined &&
    (!(options.expires instanceof Date) || Number.isNaN(options.expires.getTime()))
  ) {
    throw new Error('[vue-ssr-lite] Cookie expires must be a valid Date.')
  }
  if (
    options.maxAge !== undefined &&
    (!Number.isFinite(options.maxAge) || !Number.isInteger(options.maxAge))
  ) {
    throw new Error(
      '[vue-ssr-lite] Cookie maxAge must be a finite integer number of seconds.'
    )
  }
  if (
    options.sameSite !== undefined &&
    options.sameSite !== true &&
    options.sameSite !== false &&
    options.sameSite !== 'lax' &&
    options.sameSite !== 'strict' &&
    options.sameSite !== 'none'
  ) {
    throw new Error(
      '[vue-ssr-lite] Cookie sameSite must be "lax", "strict", "none", or a boolean.'
    )
  }
  if (options.sameSite === 'none' && !options.secure) {
    throw new Error('[vue-ssr-lite] SameSite=None cookies must also be Secure.')
  }
  return { ...options, path }
}

export const serializeMiddlewareCookie = (
  name: string,
  value: string,
  input: MiddlewareCookieOptions = {}
): string => {
  assertCookieName(name)
  if (typeof value !== 'string' || COOKIE_CONTROL.test(value)) {
    throw new Error('[vue-ssr-lite] Cookie value contains invalid control characters.')
  }
  const options = normalizeCookieOptions(input)
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path}`]
  if (options.domain) parts.push(`Domain=${options.domain}`)
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`)
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`)
  if (options.httpOnly) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  if (options.sameSite) {
    const sameSite = options.sameSite === true
      ? 'Strict'
      : `${options.sameSite[0]!.toUpperCase()}${options.sameSite.slice(1)}`
    parts.push(`SameSite=${sameSite}`)
  }
  return parts.join('; ')
}

const appendSetCookie = (response: SsrResponseState, value: string): void => {
  const existingName = Object.keys(response.headers).find(
    (name) => name.toLowerCase() === 'set-cookie'
  )
  const name = existingName ?? 'set-cookie'
  const existing = response.headers[name]
  if (existing === undefined) response.headers[name] = [value]
  else if (Array.isArray(existing)) response.headers[name] = [...existing, value]
  else response.headers[name] = [existing, value]
}

export const createMiddlewareCookies = (options: {
  server: boolean
  request: SsrRenderRequest<unknown>
  response: SsrResponseState
}): MiddlewareCookies => {
  const initialHeader = options.server
    ? readHeader(options.request, 'cookie') ?? options.request.cookie ?? ''
    : typeof document === 'undefined'
      ? ''
      : document.cookie
  const values = parseCookieHeader(initialHeader)

  const write = (
    name: string,
    value: string,
    cookieOptions: MiddlewareCookieOptions
  ) => {
    const serialized = serializeMiddlewareCookie(name, value, cookieOptions)
    if (options.server) appendSetCookie(options.response, serialized)
    else {
      if (cookieOptions.httpOnly) {
        throw new Error(
          '[vue-ssr-lite] Browser middleware cannot create HttpOnly cookies.'
        )
      }
      if (typeof document === 'undefined') {
        throw new Error('[vue-ssr-lite] Browser cookie API requires document.cookie.')
      }
      document.cookie = serialized
    }
  }

  return {
    get(name) {
      assertCookieName(name)
      return values.get(name)
    },
    set(name, value, cookieOptions = {}) {
      assertCookieName(name)
      write(name, value, cookieOptions)
      values.set(name, value)
    },
    remove(name, cookieOptions = {}) {
      assertCookieName(name)
      write(name, '', {
        ...cookieOptions,
        expires: new Date(0),
        maxAge: 0,
      })
      values.delete(name)
    },
  }
}

import type { SsrRenderRequest } from '../../../SsrRuntimeTypes'
import type {
  UseFetchOptionsBase,
  UseFetchVariablePrimitive,
  UseFetchVariables,
} from '../types/SsrFetchTypes'

export interface FetchIdentity {
  publicKey: string
  /** Private, application-local representation identity. Never contribute this to hydration. */
  fingerprint: string
  runtimeKey: string
  url: string
  init: RequestInit & { method: 'GET' | 'HEAD'; headers: Headers }
  variables: Readonly<UseFetchVariables>
  variablesKey: string
  /** Whether this request has anonymous, cross-environment-reconstructible semantics. */
  browserReusable: boolean
}

const isPrimitive = (value: unknown): value is UseFetchVariablePrimitive =>
  value == null || ['string', 'number', 'boolean'].includes(typeof value)

export const snapshotFetchVariables = (input: unknown): Readonly<UseFetchVariables> => {
  if (input === undefined) return Object.freeze({})
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('useFetch() variables must be an object of primitive query values or arrays of primitives.')
  }
  const result: UseFetchVariables = Object.create(null)
  for (const key of Object.keys(input).sort()) {
    const value = (input as Record<string, unknown>)[key]
    if (Array.isArray(value)) {
      if (!value.every(isPrimitive)) {
        throw new Error('useFetch() variables do not support nested objects or arrays.')
      }
      result[key] = Object.freeze([...value])
    } else if (isPrimitive(value)) {
      result[key] = value
    } else {
      throw new Error('useFetch() variables do not support nested objects or non-primitive values.')
    }
  }
  return Object.freeze(result)
}

export const resolveFetchIdentity = (
  input: string | URL,
  variablesInput: unknown,
  options: UseFetchOptionsBase<unknown, object>,
  environment: { server: boolean; request: SsrRenderRequest }
): FetchIdentity => {
  const method = options.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    throw new Error('useFetch() supports only GET and HEAD requests.')
  }
  if (options.key !== undefined && typeof options.key !== 'string') {
    throw new Error('useFetch() key must be a string namespace.')
  }
  const origin = new URL(environment.request.url).origin
  const base = environment.server
    ? environment.request.url
    : typeof document !== 'undefined' ? document.baseURI : environment.request.url
  let url: URL
  try {
    url = new URL(input, base)
  } catch {
    // Do not echo userinfo or otherwise invalid, potentially secret URL material.
    throw new Error('useFetch() requires a valid HTTP(S) URL.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('useFetch() requires an HTTP(S) URL without embedded credentials.')
  }
  const variables = snapshotFetchVariables(variablesInput)
  for (const key of Object.keys(variables)) {
    url.searchParams.delete(key)
    const value = variables[key]
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) url.searchParams.append(key, item === null ? '' : String(item))
    }
  }
  url.hash = ''
  // URLSearchParams.sort is stable: repeated query values retain their order.
  url.searchParams.sort()
  const sameOrigin = url.origin === origin
  const location = `${sameOrigin ? '' : url.origin}${url.pathname}${url.search}`
  const publicKey = JSON.stringify([method, location, options.key ?? null])
  const headers = new Headers(options.headers)
  headers.delete('proxy-authorization')
  let forwardedCredentials = false
  if (environment.server && sameOrigin && options.credentials !== 'omit') {
    if (!headers.has('cookie') && environment.request.cookie) {
      headers.set('cookie', environment.request.cookie)
      forwardedCredentials = true
    }
    const authorization = environment.request.headers.authorization
    if (!headers.has('authorization') && authorization) {
      headers.set('authorization', typeof authorization === 'string' ? authorization : authorization.join(', '))
      forwardedCredentials = true
    }
  }
  const init: FetchIdentity['init'] = {
    method,
    headers,
    credentials: options.credentials ?? 'same-origin',
    mode: options.mode ?? 'cors',
    redirect: options.redirect ?? 'follow',
    referrer: options.referrer ?? 'about:client',
    referrerPolicy: options.referrerPolicy ?? '',
    integrity: options.integrity ?? '',
    cache: options.cache ?? 'default',
  }
  const fingerprint = JSON.stringify([
    [...headers.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    init.credentials, init.mode, init.redirect, init.referrer,
    init.referrerPolicy, init.integrity, init.cache,
  ])
  // A public identity cannot prove equality of arbitrary caller options across
  // SSR and hydration. Neither values nor hashes of those options may be sent
  // to the browser. Limit persistent adoption to one anonymous baseline that
  // both environments can independently establish. In particular, a browser's
  // ambient cookies cannot be compared with Core's filtered server cookie.
  // Require omit even cross-origin: a redirect can return to the browser's
  // origin and introduce ambient credentials under same-origin semantics.
  const browserReusable = !forwardedCredentials && [...headers].length === 0 &&
    init.credentials === 'omit' &&
    init.mode === 'cors' && init.redirect === 'follow' && init.referrer === 'about:client' &&
    init.referrerPolicy === '' && init.integrity === '' && init.cache === 'default'
  // Preserve distinctions such as omitted versus explicitly undefined variables
  // without making them a second request-identity dimension.
  const variablesKey = JSON.stringify(Object.entries(variables).map(([key, value]) => [
    key,
    Array.isArray(value)
      ? ['array', value.map((item) => [typeof item, item])]
      : [typeof value, value],
  ]))
  return {
    publicKey,
    fingerprint,
    runtimeKey: JSON.stringify([publicKey, fingerprint]),
    url: environment.server || !sameOrigin ? url.href : `${url.pathname}${url.search}`,
    init,
    variables,
    variablesKey,
    browserReusable,
  }
}

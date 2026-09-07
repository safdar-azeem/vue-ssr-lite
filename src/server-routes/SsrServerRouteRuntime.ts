import type { SsrEndpointDefinition } from '../SsrRuntimeTypes'
import type {
  ServerMiddlewareBaseContext,
  ServerMiddlewareList,
  ServerRouteMethod,
  ServerRoutesDefinition,
} from './SsrServerRouteTypes'
import type {
  SsrCompiledServerRoute,
  SsrCompiledServerRouteMethod,
  SsrCompiledServerRoutes,
  SsrServerRouteMatch,
} from './SsrServerRouteInternalTypes'
import { executeServerMiddleware } from './SsrServerMiddlewareRuntime'

const CANONICAL_ALLOW_ORDER = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const
const METHODS = new Set<string>(CANONICAL_ALLOW_ORDER)
const PARAM = /^:([A-Za-z_][A-Za-z0-9_]*)$/
const trimTrailingSlash = (path: string): string => path.replace(/\/+$/, '') || '/'
const escapeRegex = (segment: string): string => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const configurationError = (message: string): never => { throw new Error(message) }
const objectRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return configurationError(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

const normalizePattern = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    return configurationError(`${label} must begin with '/'.`)
  }
  const normalized = trimTrailingSlash(value)
  if (normalized.includes('//')) configurationError(`${label} must not contain internal '//'.`)
  if (/[?#*()[\]\\\u0000-\u0020\u007f]/.test(normalized)) {
    configurationError(`${label} contains unsupported route syntax: ${value}`)
  }
  for (const segment of normalized.split('/').filter(Boolean)) {
    if (segment === '.' || segment === '..' || (segment.includes(':') && !PARAM.test(segment))) {
      configurationError(`${label} contains an invalid segment: ${segment}`)
    }
    try {
      const decoded = decodeURIComponent(segment)
      if (decoded === '.' || decoded === '..') configurationError(`${label} contains a dot segment.`)
    } catch {
      configurationError(`${label} contains malformed percent encoding.`)
    }
  }
  return normalized
}

export const snapshotServerMiddleware = (value: unknown, label: string): ServerMiddlewareList => {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || Array.from(value).some((middleware) => typeof middleware !== 'function')) {
    return configurationError(`${label} must be an array of server middleware functions.`)
  }
  return Object.freeze([...value]) as ServerMiddlewareList
}

/** Build a new immutable application-local route table for every config revision. */
export const compileServerRoutes = (
  definitions: readonly ServerRoutesDefinition[] = [],
  options: {
    healthPath?: string
    readinessPath?: string
    endpoints?: readonly SsrEndpointDefinition<any>[]
  } = {}
): SsrCompiledServerRoutes => {
  if (!Array.isArray(definitions)) configurationError('serverRoutes must be an array of route groups.')
  const records = new Map<string, {
    pattern: string
    matcher: RegExp
    paramNames: string[]
    specificity: number[]
    methods: Partial<Record<ServerRouteMethod, SsrCompiledServerRouteMethod>>
  }>()
  const dynamicStructures = new Set<string>()
  const controls = [options.healthPath ?? '/healthz', options.readinessPath ?? '/readyz']
  for (const definition of definitions) {
    const group = objectRecord(definition, 'Server route group')
    for (const key of Object.keys(group)) {
      if (!['prefix', 'middleware', 'routes'].includes(key)) configurationError(`Unknown server route group field: ${key}`)
    }
    const prefix = group.prefix === undefined ? '' : normalizePattern(group.prefix, 'Server route prefix')
    const groupMiddleware = snapshotServerMiddleware(group.middleware, 'Group middleware')
    for (const [childPath, input] of Object.entries(objectRecord(group.routes, 'Server routes'))) {
      const child = normalizePattern(childPath, 'Server route path')
      const pattern = `${prefix === '/' ? '' : prefix}${child === '/' ? '' : child}` || '/'
      const path = objectRecord(input, `Server route ${pattern}`)
      const paramNames: string[] = []
      const segments = pattern.split('/').filter(Boolean)
      const specificity = segments.map((segment) => segment.startsWith(':') ? 0 : 1)
      const matcher = new RegExp(`^${pattern === '/' ? '/' : segments.map((segment) => {
        if (!segment.startsWith(':')) return `/${escapeRegex(segment)}`
        const name = segment.slice(1)
        if (paramNames.includes(name)) configurationError(`Duplicate server route parameter "${name}" in ${pattern}.`)
        paramNames.push(name)
        return '/([^/]+)'
      }).join('')}$`)
      for (const control of controls) {
        if (matcher.test(trimTrailingSlash(control))) {
          configurationError(`Server route pattern "${pattern}" matches reserved framework control path "${control}". Reserved control paths cannot be intercepted or shadowed by server routes.`)
        }
      }
      if (paramNames.length) {
        const structure = segments.map((segment) => segment.startsWith(':') ? ':' : segment).join('/')
        if (dynamicStructures.has(structure)) configurationError(`Duplicate dynamic server route structure: ${pattern}`)
        dynamicStructures.add(structure)
      } else {
        for (const endpoint of options.endpoints ?? []) {
          if (endpoint.ownedPaths?.some((owned) => trimTrailingSlash(owned) === pattern)) {
            configurationError(`Duplicate owned path "${pattern}" declared by both serverRoutes and legacy endpoint "${endpoint.id}".`)
          }
        }
      }
      const record: NonNullable<ReturnType<typeof records.get>> = records.get(pattern) ?? { pattern, matcher, paramNames, specificity, methods: {} }
      const pathMiddleware = snapshotServerMiddleware(path.middleware, `Path middleware for ${pattern}`)
      let count = 0
      for (const [method, value] of Object.entries(path)) {
        if (method === 'middleware') continue
        if (!METHODS.has(method)) configurationError(`Unsupported server route method "${method}" on ${pattern}.`)
        count++
        const key = method as ServerRouteMethod
        if (record.methods[key]) configurationError(`Duplicate server route: ${method} ${pattern}`)
        const methodConfig: Record<string, unknown> = typeof value === 'function' ? { handler: value } : objectRecord(value, `${method} ${pattern}`)
        for (const field of Object.keys(methodConfig)) {
          if (field !== 'handler' && field !== 'middleware') configurationError(`Unknown ${method} ${pattern} field: ${field}`)
        }
        if (typeof methodConfig.handler !== 'function') configurationError(`Server route ${method} ${pattern} requires a handler function.`)
        record.methods[key] = Object.freeze({
          handler: methodConfig.handler as SsrCompiledServerRouteMethod['handler'],
          middleware: Object.freeze([
            ...groupMiddleware,
            ...pathMiddleware,
            ...snapshotServerMiddleware(methodConfig.middleware, `Method middleware for ${method} ${pattern}`),
          ]),
        })
      }
      if (!count) configurationError(`Server route ${pattern} must declare at least one HTTP method.`)
      records.set(pattern, record)
    }
  }
  const staticRoutes: Record<string, SsrCompiledServerRoute> = Object.create(null)
  const dynamicRoutes: SsrCompiledServerRoute[] = []
  for (const record of records.values()) {
    const compiled: SsrCompiledServerRoute = Object.freeze({
      ...record,
      matcher: Object.freeze(record.matcher),
      paramNames: Object.freeze(record.paramNames),
      specificity: Object.freeze(record.specificity),
      methods: Object.freeze(record.methods),
      allow: CANONICAL_ALLOW_ORDER.filter((method) =>
        method === 'OPTIONS' || Boolean(record.methods[method]) || (method === 'HEAD' && Boolean(record.methods.GET))
      ).join(', '),
    })
    if (compiled.paramNames.length) dynamicRoutes.push(compiled)
    else staticRoutes[compiled.pattern] = compiled
  }
  dynamicRoutes.sort((left, right) => {
    for (let index = 0; index < Math.min(left.specificity.length, right.specificity.length); index++) {
      const difference = right.specificity[index] - left.specificity[index]
      if (difference) return difference
    }
    return right.specificity.length - left.specificity.length || (left.pattern < right.pattern ? -1 : 1)
  })
  return Object.freeze({
    staticRoutes: Object.freeze(staticRoutes),
    dynamicRoutes: Object.freeze(dynamicRoutes),
    ownedPaths: Object.freeze(Object.keys(staticRoutes).sort()),
  })
}

export class SsrServerRouteBadRequest extends Error {
  constructor() { super('Malformed percent encoding in request pathname.'); this.name = 'SsrServerRouteBadRequest' }
}

/** Validate even unmatched paths; decode params once, after method-blind ownership. */
export const matchServerRoute = (
  routes: SsrCompiledServerRoutes | undefined,
  pathname: string
): SsrServerRouteMatch | null => {
  try { decodeURIComponent(pathname) } catch { throw new SsrServerRouteBadRequest() }
  if (!routes) return null
  const path = trimTrailingSlash(pathname)
  const exact = routes.staticRoutes[path]
  if (exact) return { route: exact, params: Object.freeze(Object.create(null)) }
  for (const route of routes.dynamicRoutes) {
    const match = route.matcher.exec(path)
    if (!match) continue
    const params: Record<string, string> = Object.create(null)
    route.paramNames.forEach((name, index) => { params[name] = decodeURIComponent(match[index + 1]) })
    return { route, params: Object.freeze(params) }
  }
  return null
}

export const dispatchServerRoute = async (
  match: SsrServerRouteMatch,
  request: Request,
  context: ServerMiddlewareBaseContext
): Promise<Response> => {
  const { route, params } = match
  const method = request.method
  const resolved = Object.prototype.hasOwnProperty.call(route.methods, method)
    ? route.methods[method as ServerRouteMethod]
    : method === 'HEAD' ? route.methods.GET : undefined
  if (!resolved) {
    return new Response(null, { status: method === 'OPTIONS' ? 204 : 405, headers: { Allow: route.allow } })
  }
  Object.defineProperty(context, 'params', { value: params, enumerable: true, writable: false, configurable: false })
  return executeServerMiddleware(resolved.middleware, request, context, () => resolved.handler(request, context))
}

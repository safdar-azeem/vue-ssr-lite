import { inject, type InjectionKey } from 'vue'
import type {
  SsrApplicationDomainConfig,
  SsrDomainContext,
  SsrDomainMode,
  SsrDomainParamDefinition,
} from './SsrConfigTypes'
import {
  normalizeSsrHost,
  normalizeSsrHostname,
  readSsrHostPort,
} from './SsrHostnameRuntime'
import { useSsrRequestContext } from './SsrRequestContext'

export const SSR_DOMAIN_CONTEXT = Symbol.for(
  'vue-ssr:domain-context'
) as InjectionKey<SsrDomainContext>

export interface SsrDomainApplicationRef {
  id: string
  domain: {
    development: string
    production: string
    mode: SsrDomainMode
    localAliases: boolean
    customDomains: boolean
    params?: SsrApplicationDomainConfig['params']
  }
}

const resolveDomainParams = (
  definitions: Record<string, SsrDomainParamDefinition> | undefined,
  options: {
    hostname: string
    subdomain: string | null
    isCustomDomain: boolean
  }
): Record<string, string> => {
  const params: Record<string, string> = {}
  for (const [name, definition] of Object.entries(definitions || {})) {
    if (definition.source === 'last-subdomain-label') {
      if (options.subdomain) {
        const labels = options.subdomain.split('.').filter(Boolean)
        params[name] = labels[labels.length - 1] || ''
      } else {
        params[name] = ''
      }
      continue
    }
    if (definition.source === 'subdomain-or-hostname') {
      params[name] = options.isCustomDomain
        ? options.hostname
        : options.subdomain || ''
    }
  }
  return params
}

export const resolveSsrDomainContext = (
  host: string,
  application: SsrDomainApplicationRef,
  development: boolean,
  protocol: 'http' | 'https' = development ? 'http' : 'https'
): SsrDomainContext => {
  const authority = normalizeSsrHost(host)
  const hostname = normalizeSsrHostname(host)
  const productionBase = normalizeSsrHostname(application.domain.production)
  const developmentBase = normalizeSsrHostname(application.domain.development)
  const configuredBase = development ? developmentBase : productionBase
  const bases = development
    ? [...new Set([developmentBase, productionBase])]
    : [productionBase]

  let matchedBase: string | null = null
  let subdomain: string | null = null
  for (const base of bases) {
    if (!base) continue
    if (hostname === base || hostname === `www.${base}`) {
      matchedBase = base
      subdomain = null
      break
    }
    if (hostname.endsWith(`.${base}`)) {
      matchedBase = base
      subdomain = hostname.slice(0, -(base.length + 1))
      break
    }
  }

  const isCustomDomain = !matchedBase && application.domain.customDomains
  // A convention-based single application owns the incoming host, so there is
  // intentionally no configured apex to resolve here.
  const activeBase = matchedBase || configuredBase || hostname

  return {
    entry: application.id,
    authority,
    protocol,
    port: readSsrHostPort(authority),
    hostname,
    baseDomain: activeBase,
    subdomain,
    isCustomDomain,
    development,
    params: resolveDomainParams(application.domain.params, {
      hostname,
      subdomain,
      isCustomDomain,
    }),
  }
}

export interface SsrCreateDomainUrlOptions {
  /** Active apex for the target application. */
  baseDomain: string
  /**
   * Nested subdomain labels under the apex (e.g. `department.company1`).
   * Labels may include dots; each label is sanitized individually.
   */
  subdomain?: string | null
  path?: string
  query?: Record<string, string | number | boolean | null | undefined>
  hash?: string
  protocol?: 'http' | 'https'
  port?: string | number
  development?: boolean
}

const sanitizeSubdomainLabel = (label: string): string =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')

const sanitizeSubdomain = (value: string): string =>
  value
    .split('.')
    .map(sanitizeSubdomainLabel)
    .filter(Boolean)
    .join('.')

const buildPathWithQueryHash = (
  path: string | undefined,
  query: SsrCreateDomainUrlOptions['query'],
  hash: string | undefined
): string => {
  const normalizedPath = !path
    ? '/'
    : path.startsWith('/')
      ? path
      : `/${path}`
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null) continue
    params.set(key, String(value))
  }
  const search = params.toString()
  const hashPart = !hash ? '' : hash.startsWith('#') ? hash : `#${hash}`
  return `${normalizedPath}${search ? `?${search}` : ''}${hashPart}`
}

const normalizeUrlPort = (value: string | number | undefined): string => {
  if (value == null || value === '') return ''
  const raw = String(value).replace(/^:/, '')
  const parsed = Number(raw)
  if (
    !/^\d+$/.test(raw) ||
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > 65535
  ) {
    throw new Error('createDomainUrl port must be an integer between 1 and 65535.')
  }
  return `:${raw}`
}

/** Build an absolute URL for a domain family (supports nested subdomains). */
export const createDomainUrl = (options: SsrCreateDomainUrlOptions): string => {
  const base = normalizeSsrHostname(options.baseDomain)
  if (!base) {
    throw new Error('createDomainUrl requires a baseDomain.')
  }
  const development =
    options.development ??
    (base === 'localhost' || base.endsWith('.localhost'))
  const protocol = options.protocol || (development ? 'http' : 'https')
  const withPort = normalizeUrlPort(options.port)
  const suffix = buildPathWithQueryHash(options.path, options.query, options.hash)
  const subdomain = options.subdomain ? sanitizeSubdomain(options.subdomain) : ''
  const displayBase = base.includes(':') ? `[${base}]` : base
  if (!subdomain) {
    return `${protocol}://${displayBase}${withPort}${suffix}`
  }
  if (base.includes(':')) {
    throw new Error('createDomainUrl cannot add a subdomain to an IPv6 host.')
  }
  return `${protocol}://${subdomain}.${base}${withPort}${suffix}`
}

/** @deprecated Prefer createDomainUrl. Kept as a thin wrapper. */
export const buildSsrSubdomainUrl = (options: {
  baseDomain: string
  subdomain: string
  path?: string
  protocol?: 'http' | 'https'
  port?: string | number
  development?: boolean
}): string =>
  createDomainUrl({
    baseDomain: options.baseDomain,
    subdomain: options.subdomain,
    path: options.path,
    protocol: options.protocol,
    port: options.port,
    development: options.development,
  })

export interface SsrDomainApi extends SsrDomainContext {
  buildSubdomainUrl: (
    subdomain: string,
    path?: string,
    options?: { port?: string | number; protocol?: 'http' | 'https' }
  ) => string
  createUrl: (
    options: Omit<SsrCreateDomainUrlOptions, 'baseDomain' | 'development'> & {
      subdomain?: string | null
    }
  ) => string
}

const toDomainApi = (domain: SsrDomainContext): SsrDomainApi => ({
  ...domain,
  buildSubdomainUrl: (subdomain, path = '/', options = {}) =>
    createDomainUrl({
      baseDomain: domain.baseDomain,
      subdomain,
      path,
      port: options.port ?? domain.port,
      protocol: options.protocol ?? domain.protocol,
      development: domain.development,
    }),
  createUrl: (options) =>
    createDomainUrl({
      ...options,
      baseDomain: domain.baseDomain,
      development: domain.development,
      port: options.port ?? domain.port,
      protocol: options.protocol ?? domain.protocol,
    }),
})

let activeDomainContext: SsrDomainContext | null = null

export const installSsrDomainContext = (
  domain: SsrDomainContext
): (() => void) => {
  activeDomainContext = domain
  return () => {
    if (activeDomainContext === domain) activeDomainContext = null
  }
}

const readBrowserDomainContext = (): SsrDomainContext | null => {
  if (typeof document === 'undefined') return null
  const element = document.getElementById('vue-ssr-lite-domain')
  if (!element?.textContent) return null
  try {
    const parsed = JSON.parse(element.textContent) as {
      domain?: SsrDomainContext
    }
    return parsed.domain ?? null
  } catch {
    return null
  }
}

export const useSsrDomain = (): SsrDomainApi => {
  const injected = inject(SSR_DOMAIN_CONTEXT, null)
  if (injected) return toDomainApi(injected)

  try {
    const context = useSsrRequestContext()
    if (context.domain) return toDomainApi(context.domain)
  } catch {
    // Outside a Vue request context (e.g. router beforeEnter).
  }

  if (activeDomainContext) return toDomainApi(activeDomainContext)

  const fromBrowser = readBrowserDomainContext()
  if (fromBrowser) return toDomainApi(fromBrowser)

  throw new Error('vue-ssr-lite domain context is not installed.')
}

export type { SsrDomainContext } from './SsrConfigTypes'

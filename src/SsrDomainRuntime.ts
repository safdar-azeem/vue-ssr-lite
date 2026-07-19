import { inject, type InjectionKey } from 'vue'
import type {
  SsrApplicationDomainConfig,
  SsrDomainContext,
  SsrDomainMode,
} from './SsrConfigTypes'
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
    expose?: SsrApplicationDomainConfig['expose']
  }
}

const normalizeHostname = (value: string): string =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^(?:https?):?(?:\/\/)/i, '')
    .split(/[/?#]/, 1)[0]
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .replace(/^\.+|\.+$/g, '')

export const resolveSsrDomainContext = (
  host: string,
  application: SsrDomainApplicationRef,
  development: boolean
): SsrDomainContext => {
  const hostname = normalizeHostname(host)
  const productionBase = normalizeHostname(application.domain.production)
  const developmentBase = normalizeHostname(application.domain.development)
  const baseDomain = development ? developmentBase : productionBase
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
  const activeBase = matchedBase || baseDomain
  const params: Record<string, string> = {}
  const expose = application.domain.expose || {}

  if (expose.subdomainAs) {
    if (subdomain) {
      const labels = subdomain.split('.').filter(Boolean)
      params[expose.subdomainAs] = labels[labels.length - 1] || ''
    } else {
      params[expose.subdomainAs] = ''
    }
  }

  if (expose.subdomainOrHostnameAs) {
    params[expose.subdomainOrHostnameAs] = isCustomDomain
      ? hostname
      : subdomain || ''
  }

  return {
    entry: application.id,
    hostname,
    baseDomain: activeBase,
    subdomain,
    isCustomDomain,
    development,
    params,
  }
}

export const buildSsrSubdomainUrl = (options: {
  baseDomain: string
  subdomain: string
  path?: string
  protocol?: 'http' | 'https'
  port?: string | number
  development?: boolean
}): string => {
  const sanitized = String(options.subdomain || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
  const path = !options.path
    ? '/'
    : options.path.startsWith('/')
      ? options.path
      : `/${options.path}`
  if (!sanitized) return path

  const base = normalizeHostname(options.baseDomain)
  const development =
    options.development ??
    (base === 'localhost' || base.endsWith('.localhost'))
  const protocol = options.protocol || (development ? 'http' : 'https')
  const port =
    options.port == null || options.port === ''
      ? ''
      : `:${String(options.port).replace(/^:/, '')}`
  const withPort =
    development || base === 'localhost' || base.endsWith('.localhost')
      ? port
      : ''
  return `${protocol}://${sanitized}.${base}${withPort}${path}`
}

export interface SsrDomainApi extends SsrDomainContext {
  buildSubdomainUrl: (
    subdomain: string,
    path?: string,
    options?: { port?: string | number; protocol?: 'http' | 'https' }
  ) => string
}

const toDomainApi = (domain: SsrDomainContext): SsrDomainApi => ({
  ...domain,
  buildSubdomainUrl: (subdomain, path = '/', options = {}) =>
    buildSsrSubdomainUrl({
      baseDomain: domain.baseDomain,
      subdomain,
      path,
      port:
        options.port ??
        (typeof window !== 'undefined' ? window.location.port : ''),
      protocol: options.protocol,
      development: domain.development,
    }),
})

/**
 * Process-local active domain for the current SPA/SSR application instance.
 * Lets route guards and non-setup callers read the same context without
 * requiring Vue `inject()` currentInstance.
 */
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

/**
 * Domain context for the application selected for the current request.
 * Works during SSR, SPA mounting, endpoint handling, route guards, and
 * browser hydration.
 */
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

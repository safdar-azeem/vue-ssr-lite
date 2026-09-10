import type {
  SsrLogger,
  SsrRenderMetrics,
} from './SsrRuntimeTypes'
import { readSsrInitializationPhase, readSsrProductionFailure } from './SsrProductionError'

type SsrLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Never echo arbitrary exception text: it can contain upstream bodies or credentials. */
export const describeSsrFailure = (error: unknown): string => {
  const productionFailure = readSsrProductionFailure(error)
  if (productionFailure) return productionFailure.message
  let message = ''
  try { message = error instanceof Error ? error.message : typeof error === 'string' ? error : '' } catch { /* hostile getter */ }
  if (message.includes('localhost origin in production')) {
    return 'Local production origin rejected. Automatic local smoke testing requires a direct loopback Node connection. Use an HTTPS public origin for remote or proxied requests.'
  }
  if (message.includes('Public production origins must use https://')) {
    return 'Production HTTP origin rejected. Configure HTTPS PUBLIC_URL/seo.siteUrl, or the existing intentional seo.allowHttpOrigin exception.'
  }
  if (message.includes('valid site origin is required') || /site origin must|seo.siteUrl must|PUBLIC_URL must/.test(message)) {
    return 'Invalid canonical origin configuration. Check PUBLIC_URL, seo.siteUrl and resolveSiteUrl.'
  }
  if (/timed out|TimeoutError/.test(message)) return 'The request exceeded its configured deadline.'
  if (/Missing client entry|SSR client entry is missing|ENOENT/.test(message)) return 'A required production file is missing. Deploy the complete client and server build together.'
  if (/Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/.test(message)) return 'A server runtime dependency is missing from the deployment.'
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT/.test(message)) return 'An upstream request failed. Check the configured service endpoint and connectivity.'
  if (/Cannot read properties of (?:undefined|null)/.test(message)) return 'Application code accessed a property on a missing value.'
  if (/is not a function/.test(message)) return 'Application code attempted to call a value that is not a function.'
  if (/is not defined/.test(message)) return 'Application code referenced an undefined variable.'
  if (/Maximum call stack size exceeded/.test(message)) return 'Application recursion exceeded the call stack limit.'
  if (/response header|Response header|response status/.test(message)) return 'A handler returned an invalid HTTP response.'
  if (/SeoProviderFailure|SEO provider|siteSeo\.resolve\(\)|siteRobots\.resolve\(\)/.test(message)) return 'An SEO provider failed while serving this request.'
  return 'Application request failed. Exception contents were omitted because they may contain private data.'
}

const failureType = (error: unknown): string => {
  if (readSsrProductionFailure(error)) return 'SsrProductionArtifactError'
  try {
    if (error instanceof Error && ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError',
      'URIError', 'SsrRequestTimeoutError', 'SeoProviderFailure'].includes(error.name)) return error.name
  } catch { /* Do not invoke an untrusted error serializer. */ }
  return 'Error'
}

const safeIdentifier = (value: unknown): string =>
  typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : 'unknown'

const diagnosticDetails = (details?: Record<string, unknown>): Record<string, unknown> => {
  // Only these fields may reach the default sink. Never serialize unknown
  // objects, Error.cause, config, headers or an upstream response body.
  const rawPath = typeof details?.pathname === 'string' ? details.pathname : '/'
  const pathname = rawPath.split(/[?#]/, 1)[0].replace(/[\u0000-\u0020\u007f]/g, '')
    .replace(/(\/(?:token|session|password|secret|authorization|reset-password)\/)[^/]+/gi, '$1[redacted]')
    .replace(/[a-f0-9]{32,}/gi, '[redacted]')
    .replace(/[^/]{80,}/g, '[redacted]').slice(0, 512)
  const productionFailure = readSsrProductionFailure(details?.error)
  const initializationPhase = readSsrInitializationPhase(details?.error)
  return {
    requestId: safeIdentifier(details?.requestId),
    applicationId: safeIdentifier(details?.applicationId ?? details?.entryId),
    ...(details?.entryId === undefined ? {} : { entryId: safeIdentifier(details.entryId) }),
    pathname: pathname.startsWith('/') && !pathname.startsWith('//') ? pathname : '/',
    ...(details?.error === undefined ? {} : { error: describeSsrFailure(details.error), errorType: failureType(details.error) }),
    ...(initializationPhase ? { phase: initializationPhase } : {}),
    ...(productionFailure ? { code: productionFailure.code, artifact: productionFailure.artifact, reason: productionFailure.reason } : {}),
  }
}

const writeFallbackDiagnostic = (
  level: SsrLogLevel, event: string, details?: Record<string, unknown>
): boolean => {
  if (level !== 'error' && level !== 'warn') return false
  try {
    console[level](JSON.stringify({ level, event: safeIdentifier(event), ...diagnosticDetails(details) }))
  } catch { /* A broken console or an untrusted getter cannot affect availability. */ }
  return true
}

const reportObservabilityFailure = (
  kind: string,
  _error: unknown
): void => {
  try {
    console.warn(
      `[vue-ssr-lite] ${kind} observability hook failed`
    )
  } catch {
    // Observability is deliberately terminal here. Never recurse through the
    // configured logger while reporting a logger/metrics failure.
  }
}

/** Invoke a user logger without allowing observability to affect availability. */
export const safeSsrLog = (
  logger: SsrLogger | undefined,
  level: SsrLogLevel,
  event: string,
  details?: Record<string, unknown>
): boolean => {
  try {
    const safeDetails = level === 'error' || (level === 'warn' && details?.error !== undefined)
      ? diagnosticDetails(details) : details
    const sink = logger?.[level]
    if (!sink) return writeFallbackDiagnostic(level, event, details)
    const result = sink.call(logger, event, safeDetails)
    void Promise.resolve(result).catch((error) => {
      writeFallbackDiagnostic(level, event, details)
      reportObservabilityFailure(`logger.${level}`, error)
    })
    return true
  } catch (error) {
    writeFallbackDiagnostic(level, event, details)
    reportObservabilityFailure(`logger.${level}`, error)
    return true
  }
}

/** A logger facade safe to hand to cooperative request integrations. */
export const createSafeSsrLogger = (
  logger: SsrLogger | undefined
): SsrLogger | undefined =>
  logger
    ? {
        debug: (event, details) => {
          safeSsrLog(logger, 'debug', event, details)
        },
        info: (event, details) => {
          safeSsrLog(logger, 'info', event, details)
        },
        warn: (event, details) => {
          safeSsrLog(logger, 'warn', event, details)
        },
        error: (event, details) => {
          safeSsrLog(logger, 'error', event, details)
        },
      }
    : undefined

/** Invoke the metrics sink as best-effort observability. */
export const safeSsrMetrics = (
  onMetrics:
    | ((metrics: SsrRenderMetrics) => void | Promise<void>)
    | undefined,
  metrics: SsrRenderMetrics
): void => {
  try {
    const result = onMetrics?.(metrics)
    void Promise.resolve(result).catch((error) => {
      reportObservabilityFailure('metrics', error)
    })
  } catch (error) {
    reportObservabilityFailure('metrics', error)
  }
}

import type {
  SsrLogger,
  SsrRenderMetrics,
} from './SsrRuntimeTypes'
import {
  createSsrOperatorLogDetails,
  hasSsrThrownValue,
  observeSsrFailure,
  safeSsrLogIdentifier,
} from './SsrErrorDiagnostic'

export { describeSsrFailure } from './SsrErrorDiagnostic'

type SsrLogLevel = 'debug' | 'info' | 'warn' | 'error'

const writeFallbackDiagnostic = (
  level: SsrLogLevel, event: string, details?: Record<string, unknown>
): boolean => {
  if (level !== 'error' && level !== 'warn') return false
  try {
    console[level](
      `[vue-ssr-lite] ${safeSsrLogIdentifier(event)}`,
      createSsrOperatorLogDetails(details)
    )
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
    const observed = hasSsrThrownValue(details)
      ? observeSsrFailure(details.error, details.errorId, details.occurrence)
      : undefined
    if (level === 'error' && observed?.occurrence.logged) return true
    const diagnosticDetails = observed
      ? { ...details, error: observed.original, errorId: observed.occurrence.errorId }
      : details
    const sinkDetails = level === 'error' || (level === 'warn' && hasSsrThrownValue(details))
      ? createSsrOperatorLogDetails(diagnosticDetails) : details
    const sink = logger?.[level]
    if (!sink) {
      const written = writeFallbackDiagnostic(level, event, diagnosticDetails)
      if (level === 'error' && observed) observed.occurrence.logged = true
      return written
    }
    const result = sink.call(logger, event, sinkDetails)
    if (level === 'error' && observed) observed.occurrence.logged = true
    void Promise.resolve(result).catch((error) => {
      writeFallbackDiagnostic(level, event, diagnosticDetails)
      reportObservabilityFailure(`logger.${level}`, error)
    })
    return true
  } catch (error) {
    writeFallbackDiagnostic(level, event, details)
    if (hasSsrThrownValue(details)) {
      observeSsrFailure(details.error, details.errorId, details.occurrence).occurrence.logged = true
    }
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

import type {
  SsrLogger,
  SsrRenderMetrics,
} from './SsrRuntimeTypes'

type SsrLogLevel = 'debug' | 'info' | 'warn' | 'error'

const reportObservabilityFailure = (
  kind: string,
  error: unknown
): void => {
  try {
    console.warn(
      `[vue-ssr-lite] ${kind} observability hook failed`,
      error
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
    const sink = logger?.[level]
    if (!sink) return false
    const result = sink(event, details)
    void Promise.resolve(result).catch((error) => {
      reportObservabilityFailure(`logger.${level}`, error)
    })
    return true
  } catch (error) {
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

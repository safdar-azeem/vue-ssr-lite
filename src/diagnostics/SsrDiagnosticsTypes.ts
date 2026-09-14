export interface SsrRenderMetrics {
  requestId: string
  applicationId: string
  contextDurationMs: number
  routeDurationMs: number
  renderDurationMs: number
  totalDurationMs: number
  htmlBytes: number
  stateBytes: number
  /** Number of render passes the resolution contract required. Usually 1. */
  renderPasses: number
}

export interface SsrLogger {
  debug?: (event: string, details?: Record<string, unknown>) => void | Promise<void>
  info?: (event: string, details?: Record<string, unknown>) => void | Promise<void>
  warn?: (event: string, details?: Record<string, unknown>) => void | Promise<void>
  error?: (event: string, details?: Record<string, unknown>) => void | Promise<void>
}

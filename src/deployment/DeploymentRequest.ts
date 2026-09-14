import { randomUUID } from 'node:crypto'
import type { SsrHeaders } from '../request/SsrRequestTypes'
import type { SsrNormalizedRequest } from '../server/runtime/SsrRequestHandler'

/** Provider adapters supply authoritative metadata, never client Forwarded values. */
export const normalizeDeploymentRequest = (options: {
  method: string
  url: string
  host: string
  protocol: 'http' | 'https'
  headers: SsrHeaders
  openBody?: () => ReadableStream<Uint8Array>
}): SsrNormalizedRequest => {
  const headers: Record<string, string | readonly string[] | undefined> = {}
  for (const [name, value] of Object.entries(options.headers)) {
    const lower = name.toLowerCase()
    if (lower === 'forwarded' || lower === 'x-forwarded-host' || lower === 'x-forwarded-proto' || lower === 'host') continue
    headers[lower] = Array.isArray(value) ? Object.freeze([...value]) : value
  }
  // Keep existing trustProxy consumers compatible without opting other apps in.
  headers.host = options.host
  headers['x-forwarded-host'] = options.host
  headers['x-forwarded-proto'] = options.protocol
  return Object.freeze({
    requestId: randomUUID(),
    startedAt: Date.now(),
    method: options.method,
    url: options.url,
    protocol: options.protocol,
    headers: Object.freeze(headers),
    openBody: options.openBody,
  })
}

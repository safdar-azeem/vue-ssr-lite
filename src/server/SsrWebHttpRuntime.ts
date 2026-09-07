import { open } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { SsrHeaders, SsrHttpResponse } from '../SsrRuntimeTypes'
import type { SsrNormalizedRequest } from './SsrRequestHandler'
import { normalizeServerResponse, rememberLegacyResponseHeaders, sanitizeFetchedResponseHeaders, unchangedLegacyResponseHeaders } from '../server-routes/SsrServerResponseRuntime'
import {
  isExpectedUnavailableAssetError,
  isSsrProductionAssetNotModified,
  resolveSsrProductionAsset,
  updateSsrProductionAssetMetadata,
  type SsrProductionAssetResolutionOptions,
  type SsrResolvedProductionAsset,
} from './SsrAssetRuntime'

/** Transport-owned, pull-based bridge. Releasing it never destroys a keep-alive socket. */
export const createSsrRequestBodySource = (incoming: IncomingMessage, signal: AbortSignal): {
  openBody: (() => ReadableStream<Uint8Array>) | undefined
  release: () => void
} => {
  let opened = false
  let release = () => {}
  const method = incoming.method ?? 'GET'
  return {
    openBody: method === 'GET' || method === 'HEAD' ? undefined : () => {
      if (opened) throw new Error('Request body stream was already opened')
      opened = true
      let controller: ReadableStreamDefaultController<Uint8Array>
      let pending: (() => void) | undefined
      let finished = false
      const settlePull = () => { const resolve = pending; pending = undefined; resolve?.() }
      const detach = () => {
        incoming.off('readable', onReadable)
        incoming.off('end', onEnd)
        incoming.off('error', onError)
        signal.removeEventListener('abort', onAbort)
        settlePull()
      }
      const finish = (error?: unknown) => {
        if (finished) return
        finished = true
        detach()
        if (error !== undefined) controller.error(error)
        else controller.close()
      }
      const read = (): boolean => {
        if (finished) return true
        const chunk: Buffer | null = incoming.read()
        if (chunk !== null) { controller.enqueue(chunk); return true }
        if (incoming.readableEnded) { finish(); return true }
        return false
      }
      const onReadable = () => { if (pending && read()) settlePull() }
      const onEnd = () => finish()
      const onError = (error: Error) => finish(error)
      const onAbort = () => finish(signal.reason ?? new Error('Request body aborted.'))
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value
          incoming.on('readable', onReadable)
          incoming.once('end', onEnd)
          incoming.once('error', onError)
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        },
        pull() {
          if (read()) return
          return new Promise<void>((resolve) => { pending = resolve })
        },
        cancel() { finished = true; detach() },
      }, { highWaterMark: 0 })
      release = () => finish()
      return body
    },
    release: () => release(),
  }
}

const webHeaders = (input: SsrHeaders): Headers => {
  const headers = new Headers()
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue
    for (const item of typeof value === 'string' ? [value] : value) headers.append(name, item)
  }
  return headers
}

/** Core calls this only after host/protocol normalization and application selection. */
export const isFetchForbiddenMethod = (method: string): boolean =>
  ['TRACE', 'TRACK', 'CONNECT'].includes(method.toUpperCase())

export const createWebRequest = (
  normalized: SsrNormalizedRequest,
  trustedUrl: string,
  signal: AbortSignal
): Request => {
  if (isFetchForbiddenMethod(normalized.method)) throw new TypeError('HTTP method cannot be represented by a native Request.')
  const body = normalized.openBody?.()
  const init: RequestInit & { duplex?: 'half' } = {
    method: normalized.method,
    headers: webHeaders(normalized.headers),
    signal,
    ...(body ? { body, duplex: 'half' as const } : {}),
  }
  return new Request(trustedUrl, init)
}

/** Internal transport transfer: informational legacy responses have no Web equivalent. */
export class SsrLegacyInformationalResponse extends Error {
  constructor(readonly response: SsrHttpResponse) { super('Legacy informational response requires Node transport.') }
}

export const ssrHttpResponseToWebResponse = (legacy: SsrHttpResponse): Response => {
  if (legacy.statusCode >= 100 && legacy.statusCode < 200) throw new SsrLegacyInformationalResponse(legacy)
  const body = typeof legacy.body === 'string' ? new TextEncoder().encode(legacy.body) : legacy.body
  const response = new Response(
    [204, 205, 304].includes(legacy.statusCode) ? null : (body as BodyInit | undefined) ?? null,
    { status: legacy.statusCode, headers: webHeaders(legacy.headers ?? {}) }
  )
  rememberLegacyResponseHeaders(response, legacy.headers ?? {})
  return response
}

/** Stream through Node's pipeline so backpressure, cancellation and errors share ownership. */
export const writeWebResponse = async (
  request: Pick<IncomingMessage, 'method'>,
  outgoing: ServerResponse,
  response: Response,
  signal: AbortSignal
): Promise<void> => {
  try {
    signal.throwIfAborted()
    response = normalizeServerResponse(response)
    sanitizeFetchedResponseHeaders(response)
    outgoing.statusCode = response.status
    if (response.statusText) outgoing.statusMessage = response.statusText
    const headers = response.headers as Headers & { getSetCookie?: () => string[] }
    const original = unchangedLegacyResponseHeaders(response)
    for (const [name, value] of headers) {
      if (name === 'set-cookie' && typeof headers.getSetCookie === 'function') continue
      outgoing.setHeader(name, original[name] ?? value)
    }
    if (typeof headers.getSetCookie === 'function') {
      const cookies = headers.getSetCookie()
      if (cookies.length) outgoing.setHeader('set-cookie', original['set-cookie'] ?? cookies)
    }
    if (request.method === 'HEAD' || !response.body) {
      // Cancellation is observed but cannot delay header delivery indefinitely.
      if (response.body) void response.body.cancel().catch(() => undefined)
      outgoing.end()
      return
    }
    const source = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>)
    await pipeline(source, outgoing, { signal })
  } catch (error) {
    if (response.body && !response.body.locked) void response.body.cancel(error).catch(() => undefined)
    throw error
  }
}

export const productionAssetHeaders = (asset: SsrResolvedProductionAsset) => ({
  'content-type': asset.contentType,
  'content-length': String(asset.size),
  'cache-control': asset.cacheControl,
  etag: asset.etag,
  'last-modified': asset.lastModified,
})

/** Open before committing a Response; an unavailable representation still permits fallthrough. */
export const productionAssetToWebResponse = async (
  resolvedAsset: SsrResolvedProductionAsset,
  requestHeaders: SsrHeaders,
  requestMethod: string,
  signal: AbortSignal,
  openFile: typeof open = open
): Promise<Response | null> => {
  signal.throwIfAborted()
  let asset = resolvedAsset
  if (isSsrProductionAssetNotModified(asset, requestHeaders)) {
    return new Response(null, { status: 304, headers: productionAssetHeaders(asset) })
  }
  if (requestMethod === 'HEAD') return new Response(null, { headers: productionAssetHeaders(asset) })
  let file
  try {
    file = await openFile(asset.filePath, 'r')
    const information = await file.stat()
    if (!information.isFile()) { await file.close(); return null }
    asset = updateSsrProductionAssetMetadata(asset, information)
  } catch (error) {
    await file?.close().catch(() => undefined)
    if (signal.aborted) throw error
    if (isExpectedUnavailableAssetError(error) || (error as NodeJS.ErrnoException)?.code === 'EISDIR') return null
    throw error
  }
  if (signal.aborted) { await file.close(); signal.throwIfAborted() }
  if (isSsrProductionAssetNotModified(asset, requestHeaders)) {
    await file.close()
    return new Response(null, { status: 304, headers: productionAssetHeaders(asset) })
  }
  let source: ReturnType<typeof file.createReadStream> | undefined
  try {
    source = file.createReadStream({ signal })
    // Keep bytes as bytes and bound eager read-ahead while middleware unwinds.
    const body = Readable.toWeb(source, {
      strategy: { highWaterMark: source.readableHighWaterMark, size: (chunk: Uint8Array) => chunk.byteLength },
    }) as ReadableStream<Uint8Array>
    return new Response(body, { headers: productionAssetHeaders(asset) })
  } catch (error) {
    if (source) source.destroy()
    else await file.close().catch(() => undefined)
    throw error
  }
}

/** Reuses all existing resolver security, base, cache-policy and validator metadata. */
export const resolveProductionAssetResponse = async (
  options: SsrProductionAssetResolutionOptions,
  requestHeaders: SsrHeaders,
  requestMethod: string,
  signal: AbortSignal,
  openFile: typeof open = open
): Promise<Response | null> => {
  const asset = await resolveSsrProductionAsset({ ...options, signal })
  return asset ? productionAssetToWebResponse(asset, requestHeaders, requestMethod, signal, openFile) : null
}

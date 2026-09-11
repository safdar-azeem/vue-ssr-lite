import type { IncomingMessage, ServerResponse } from 'node:http'
import { createSsrProductionRequestHandler } from '../../server/SsrProductionRequestRuntime'
import { createSsrRequestBodySource, writeWebResponse } from '../../server/SsrWebHttpRuntime'
import { safeSsrLog } from '../../SsrObservability'
import {
  assertSsrRuntimeModuleExport,
  createSsrRuntimeLoadFailure,
} from '../../SsrRuntimeLoadDiagnostics'
import { normalizeDeploymentRequest } from '../DeploymentRequest'

/** Unwrap the generated SsrRuntime.js contract without evaluating application rendering. */
export const readVercelRuntimeConfig = async (
  loaded: unknown
): Promise<Record<string, unknown>> => {
  assertSsrRuntimeModuleExport(loaded)
  const exported = loaded && typeof loaded === 'object'
    ? (loaded as { default?: unknown }).default ?? loaded
    : loaded
  const config = typeof exported === 'function' ? await exported() : exported
  if (config == null || typeof config !== 'object' || Array.isArray(config)) {
    throw createSsrRuntimeLoadFailure('invalid-runtime-export')
  }
  return config as Record<string, unknown>
}

/** Build Output API Nodejs launcher, with helpers/body parsing disabled. No listener. */
export const createVercelHandler = (options: Parameters<typeof createSsrProductionRequestHandler>[0]) => {
  const execute = createSsrProductionRequestHandler(options)
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const controller = new AbortController()
    const cancel = () => controller.abort()
    const close = () => { if (!response.writableEnded) cancel() }
    request.once('aborted', cancel)
    response.once('close', close)
    if (request.aborted || response.destroyed) cancel()
    const body = createSsrRequestBodySource(request, controller.signal)
    // Vercel documents Host as the original domain (including custom domains),
    // and x-forwarded-proto as its proxy's protocol. Never use a client-supplied
    // forwarded host, deployment URL, or rewrite/original-URL header for routing.
    const protocol = request.headers['x-forwarded-proto']
    const normalized = normalizeDeploymentRequest({
      method: request.method || 'GET',
      url: request.url || '/',
      host: request.headers.host || '',
      protocol: protocol === 'http' ? 'http' : 'https',
      headers: request.headers,
      openBody: body.openBody,
    })
    try {
      if (protocol !== undefined && protocol !== 'http' && protocol !== 'https') {
        response.writeHead(400, { 'cache-control': 'no-store' })
        response.end()
        return
      }
      const result = await execute(normalized, controller.signal)
      await writeWebResponse(request, response, result, controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) safeSsrLog(undefined, 'error', 'ssr.transport.failed', {
        requestId: normalized.requestId, pathname: normalized.url, error,
      })
      if (!response.destroyed) response.destroy()
    } finally {
      // A native route can stream request.body back as its Response. Retain
      // the pull bridge until that response finishes; only then discard unread
      // provider bytes. The provider owns connection reuse after this callback.
      body.release()
      request.off('aborted', cancel)
      response.off('close', close)
      if (!request.readableEnded && !request.destroyed) request.resume()
    }
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeSsrFailure, safeSsrLog, safeSsrMetrics } from './SsrObservability'
import { PRODUCTION_HTTP_ORIGIN_ERROR } from './SsrCanonicalOrigin'
import {
  markSsrInitializationFailure,
  readSsrInitializationPhase,
  readSsrProductionFailure,
  SsrProductionArtifactError,
} from './SsrProductionError'
import { parseSsrViteManifest, createSsrRenderedAssetResolver } from './SsrRenderedAssetRuntime'
import { parseSsrProductionAssetMetadata } from './SsrAssetMetadata'
import { parseSsrClientAssetManifest } from './server/SsrAssetRuntime'

afterEach(() => vi.restoreAllMocks())

describe('safe operator diagnostics', () => {
  it.each([
    { code: 'client-manifest.invalid-json', fail: () => parseSsrClientAssetManifest('{secret', '/private/client.json') },
    { code: 'client-manifest.invalid-schema', fail: () => parseSsrClientAssetManifest('{"secret":{}}') },
    { code: 'client-manifest.invalid-path', fail: () => parseSsrClientAssetManifest('{"secret":{"file":"../private/file.js"}}') },
    { code: 'asset-cache-metadata.invalid-json', fail: () => parseSsrProductionAssetMetadata('{secret', '/private/cache.json') },
    { code: 'asset-cache-metadata.invalid-schema', fail: () => parseSsrProductionAssetMetadata('{"version":999,"secret":"token"}') },
    { code: 'asset-cache-metadata.invalid-path', fail: () => parseSsrProductionAssetMetadata('{"version":1,"immutable":["../private/file.js"]}') },
    { code: 'ssr-manifest.invalid-json', fail: () => parseSsrViteManifest('{secret', '/private/ssr.json') },
    { code: 'ssr-manifest.invalid-schema', fail: () => parseSsrViteManifest('{"/private/Page.vue":"secret"}') },
    { code: 'rendered-assets.invalid-asset', fail: () => createSsrRenderedAssetResolver({ '/private/Page.vue': ['javascript:secret.css'] }, '/') },
    { code: 'rendered-assets.invalid-asset', fail: () => createSsrRenderedAssetResolver({ 'src/Page.vue': ['https://[invalid/assets/page.js'] }, '/') },
    { code: 'rendered-assets.invalid-asset', fail: () => createSsrRenderedAssetResolver({ 'src/Page.vue': ['../private/image.svg'] }, '/') },
    { code: 'rendered-assets.module-not-in-manifest', fail: () => createSsrRenderedAssetResolver({}, '/')('app', ['/private/Page.vue?token=secret']) },
  ])('reports $code without disclosing raw paths or exception content', ({ code, fail }) => {
    const sink = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let failure: unknown
    try { fail() } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(SsrProductionArtifactError)
    expect(readSsrProductionFailure(failure)?.code).toBe(code)
    safeSsrLog(undefined, 'error', 'ssr.request.failed', { requestId: 'request-1', error: failure })
    const output = String(sink.mock.calls[0]![0])
    const [artifact, reason] = code.split('.')
    expect(JSON.parse(output)).toMatchObject({ code, artifact, reason, errorType: 'SsrProductionArtifactError' })
    expect(output).not.toMatch(/\/private|secret|Page\.vue|stack/)
    expect(String(failure)).not.toMatch(/\/private|secret|Page\.vue/)
  })

  it('does not interpret arbitrary errors mentioning manifest as missing build files', () => {
    const message = describeSsrFailure(new Error('upstream manifest token=secret /private/file'))
    expect(message).not.toContain('metadata could not be loaded')
    expect(message).not.toMatch(/secret|\/private|upstream manifest/)
  })

  it('preserves safe reason codes across module graphs and custom loggers', () => {
    const logger = { error: vi.fn() }
    const foreignError = Object.assign(new Error('secret stack /private/file'), {
      [Symbol.for('vue-ssr-lite.internal.production-failure')]: 'ssr-manifest.missing',
    })
    safeSsrLog(logger, 'error', 'ssr.start.failed', { error: foreignError })
    expect(logger.error).toHaveBeenCalledWith('ssr.start.failed', expect.objectContaining({
      code: 'ssr-manifest.missing', artifact: 'ssr-manifest', reason: 'missing',
    }))
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/secret|\/private/)
    expect(readSsrProductionFailure({
      [Symbol.for('vue-ssr-lite.internal.production-failure')]: 'ssr-manifest.secret-token',
    })).toBeUndefined()
  })

  it('emits only allowlisted initialization phases without exposing exception contents', () => {
    const logger = { error: vi.fn() }
    const failure = markSsrInitializationFailure(
      new SyntaxError('private-token /private/SsrRuntime.js'),
      'runtime-load'
    )
    safeSsrLog(logger, 'error', 'ssr.runtime.failed', { error: failure })
    expect(logger.error).toHaveBeenCalledWith('ssr.runtime.failed', expect.objectContaining({
      phase: 'runtime-load',
      errorType: 'SyntaxError',
    }))
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/private-token|SsrRuntime\.js/)
    expect(readSsrInitializationPhase({
      [Symbol.for('vue-ssr-lite.internal.initialization-phase')]: 'consumer-secret',
    })).toBeUndefined()
  })

  it('emits an actionable structured production origin error without a configured logger', () => {
    const sink = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    safeSsrLog(undefined, 'error', 'ssr.request.failed', {
      requestId: 'request-1', entryId: 'shop', pathname: '/about?token=secret',
      error: PRODUCTION_HTTP_ORIGIN_ERROR,
    })
    expect(JSON.parse(sink.mock.calls[0]![0])).toMatchObject({
      requestId: 'request-1', applicationId: 'shop', pathname: '/about', event: 'ssr.request.failed',
      error: expect.stringContaining('Production HTTP origin rejected'),
    })
  })

  it('never serializes arbitrary exceptions, causes, headers, private config or stack traces', () => {
    const sink = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const error = new Error('Bearer secret-token Cookie: session=secret-cookie /private/server.ts', {
      cause: { password: 'secret-password' },
    })
    safeSsrLog(undefined, 'error', 'ssr.request.failed', {
      error, requestId: 'request-2', entryId: 'app', pathname: '/page?key=secret-query',
      headers: { authorization: 'secret-header' }, privateConfig: { secret: 'private-value' },
    })
    const serialized = String(sink.mock.calls[0]![0])
    expect(serialized).not.toMatch(/secret-|private-value|server\.ts|stack|Bearer/)
    expect(describeSsrFailure(error)).toContain('private data')
  })

  it('prefers the consumer logger and never lets logger or metrics failures escape', async () => {
    const sink = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const logger = { error: vi.fn() }
    safeSsrLog(logger, 'error', 'ssr.request.failed', { error: PRODUCTION_HTTP_ORIGIN_ERROR })
    expect(logger.error).toHaveBeenCalledOnce()
    expect(sink).not.toHaveBeenCalled()
    expect(() => safeSsrLog({ error: () => { throw new Error('secret') } }, 'error', 'failure')).not.toThrow()
    safeSsrMetrics(async () => { throw new Error('secret') }, {} as never)
    await Promise.resolve()
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('secret')
    warnings.mockImplementation(() => { throw new Error('console failed') })
    sink.mockImplementation(() => { throw new Error('console failed') })
    expect(() => safeSsrLog(undefined, 'error', 'failure')).not.toThrow()
  })
})

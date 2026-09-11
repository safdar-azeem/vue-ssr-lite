import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeSsrFailure, safeSsrLog, safeSsrMetrics } from './SsrObservability'
import { carrySsrFailure, observeSsrFailure } from './SsrErrorDiagnostic'
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

const consoleDiagnostic = () => {
  const call = vi.mocked(console.error).mock.calls.at(-1)
  expect(String(call?.[0])).toMatch(/^\[vue-ssr-lite\] /)
  return call![1] as Record<string, unknown>
}

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
  ])('reports $code without disclosing raw artifact contents', ({ code, fail }) => {
    const sink = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let failure: unknown
    try { fail() } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(SsrProductionArtifactError)
    expect(readSsrProductionFailure(failure)?.code).toBe(code)
    safeSsrLog(undefined, 'error', 'ssr.request.failed', { requestId: 'request-1', error: failure })
    const diagnostic = consoleDiagnostic()
    const output = JSON.stringify(diagnostic)
    const [artifact, reason] = code.split('.')
    expect(diagnostic).toMatchObject({ code, artifact, reason, errorType: 'SsrProductionArtifactError' })
    expect(diagnostic.errorId).toMatch(/^vssl_[a-f0-9]{16}$/)
    expect(diagnostic.message).toEqual(expect.stringContaining(code))
    expect(output).not.toMatch(/secret|token=secret|javascript:secret/)
    expect(String(failure)).not.toMatch(/\/private|secret|Page\.vue/)
    expect(String(sink.mock.calls[0]![0])).toBe('[vue-ssr-lite] ssr.request.failed')
  })

  it('does not interpret arbitrary errors mentioning manifest as missing build files', () => {
    const message = describeSsrFailure(new Error('upstream manifest token=secret /private/file'))
    expect(message).not.toContain('metadata could not be loaded')
    expect(message).not.toMatch(/secret|\/private|upstream manifest/)
    expect(message).toContain('private data')
  })

  it('preserves safe reason codes across module graphs and custom loggers', () => {
    const logger = { error: vi.fn() }
    const foreignError = Object.assign(new Error('secret stack /private/file'), {
      [Symbol.for('vue-ssr-lite.internal.production-failure')]: 'ssr-manifest.missing',
    })
    safeSsrLog(logger, 'error', 'ssr.start.failed', { error: foreignError })
    expect(logger.error).toHaveBeenCalledWith('ssr.start.failed', expect.objectContaining({
      code: 'ssr-manifest.missing', artifact: 'ssr-manifest', reason: 'missing',
      errorId: expect.stringMatching(/^vssl_[a-f0-9]{16}$/),
      message: expect.stringContaining('secret stack'),
    }))
    expect(readSsrProductionFailure({
      [Symbol.for('vue-ssr-lite.internal.production-failure')]: 'ssr-manifest.secret-token',
    })).toBeUndefined()
  })

  it('emits allowlisted initialization phases plus the original exception to operators', () => {
    const logger = { error: vi.fn() }
    const failure = markSsrInitializationFailure(
      new SyntaxError('private-token /private/SsrRuntime.js'),
      'runtime-load'
    )
    safeSsrLog(logger, 'error', 'ssr.runtime.failed', { error: failure })
    expect(logger.error).toHaveBeenCalledWith('ssr.runtime.failed', expect.objectContaining({
      phase: 'runtime-load',
      errorType: 'SyntaxError',
      reason: 'runtime-load-failed',
      message: 'private-token /private/SsrRuntime.js',
      errorId: expect.stringMatching(/^vssl_[a-f0-9]{16}$/),
    }))
    expect(readSsrInitializationPhase({
      [Symbol.for('vue-ssr-lite.internal.initialization-phase')]: 'consumer-secret',
    })).toBeUndefined()
  })

  it('emits a structured runtime-load reason and the original loader message', () => {
    const logger = { error: vi.fn() }
    const fixturePackage = 'fixture-runtime-package'
    const fixtureExport = 'missingExport'
    const failure = markSsrInitializationFailure(
      Object.assign(
        new SyntaxError(
          `The requested module '${fixturePackage}' does not provide an export named '${fixtureExport}'`
        ),
        {
          cause: { password: 'secret-password', stack: 'private-stack /private/build/SsrRuntime.js' },
          stack: `SyntaxError: The requested module '${fixturePackage}' does not provide an export named '${fixtureExport}'\n    at ModuleJob._instantiate (node:internal/modules/esm/module_job.js:123:9)`,
        }
      ),
      'runtime-load'
    )
    safeSsrLog(logger, 'error', 'ssr.runtime.failed', { error: failure })
    const details = logger.error.mock.calls[0]![1] as Record<string, unknown>
    expect(details).toMatchObject({
      phase: 'runtime-load',
      errorType: 'SyntaxError',
      reason: 'missing-named-export',
      package: fixturePackage,
      export: fixtureExport,
      message: expect.stringContaining('does not provide an export named'),
    })
    expect(details.stack).toEqual(expect.stringContaining('ModuleJob._instantiate'))
    expect(JSON.stringify(details)).not.toMatch(/secret-password|private-stack/)
  })

  it('does not copy identifier-looking fragments from spoofed application errors', () => {
    const logger = { error: vi.fn() }
    const failure = markSsrInitializationFailure(
      new Error("The requested module 'secret-password' does not provide an export named 'privateToken'"),
      'runtime-load'
    )
    safeSsrLog(logger, 'error', 'ssr.runtime.failed', { error: failure })
    expect(logger.error).toHaveBeenCalledWith('ssr.runtime.failed', expect.objectContaining({
      phase: 'runtime-load',
      reason: 'runtime-load-failed',
      message: expect.stringContaining('secret-password'),
    }))
    expect(logger.error.mock.calls[0]![1]).not.toHaveProperty('package')
    expect(logger.error.mock.calls[0]![1]).not.toHaveProperty('export')
  })

  it('does not copy identifier-looking fragments from spoofed Vite prefixes or error codes', () => {
    const logger = { error: vi.fn() }
    for (const [error, reason] of [
      [
        new Error("[vite] Named export 'privateToken' not found. The requested module 'secret-password' is a CommonJS module, which may not support all module.exports as named exports."),
        'missing-named-export',
      ],
      [
        Object.assign(
          new Error("Cannot find package 'secret-password' imported from /private/build/user/project/SsrRuntime.js"),
          { code: 'ERR_MODULE_NOT_FOUND' }
        ),
        'missing-runtime-dependency',
      ],
    ] as const) {
      logger.error.mockClear()
      safeSsrLog(logger, 'error', 'ssr.runtime.failed', {
        error: markSsrInitializationFailure(error, 'runtime-load'),
      })
      expect(logger.error).toHaveBeenCalledWith('ssr.runtime.failed', expect.objectContaining({ reason }))
      const details = logger.error.mock.calls[0]![1] as Record<string, unknown>
      expect(details).not.toHaveProperty('package')
      expect(details).not.toHaveProperty('module')
      expect(details).not.toHaveProperty('export')
    }
  })

  it('emits an actionable structured production origin error without a configured logger', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    safeSsrLog(undefined, 'error', 'ssr.request.failed', {
      requestId: 'request-1', entryId: 'shop', pathname: '/about?token=secret',
      error: PRODUCTION_HTTP_ORIGIN_ERROR,
    })
    expect(consoleDiagnostic()).toMatchObject({
      requestId: 'request-1', applicationId: 'shop', pathname: '/about',
      error: expect.stringContaining('Production HTTP origin rejected'),
      message: expect.stringContaining('https://'),
    })
    expect(consoleDiagnostic().errorId).toMatch(/^vssl_[a-f0-9]{16}$/)
  })

  it('logs a TypeError message and stack to operators without copying headers or cause', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const error = new TypeError("Cannot read properties of undefined (reading 'items')", {
      cause: { password: 'secret-password' },
    })
    safeSsrLog(undefined, 'error', 'ssr.request.failed', {
      error,
      requestId: 'request-2',
      entryId: 'app',
      pathname: '/page?key=secret-query',
      headers: { authorization: 'secret-header' },
      privateConfig: { secret: 'private-value' },
    })
    const diagnostic = consoleDiagnostic()
    expect(diagnostic).toMatchObject({
      errorType: 'TypeError',
      message: "Cannot read properties of undefined (reading 'items')",
      error: 'Application code accessed a property on a missing value.',
    })
    expect(diagnostic.stack).toEqual(expect.stringContaining('TypeError'))
    expect(JSON.stringify(diagnostic)).not.toMatch(/secret-header|private-value|secret-password/)
    expect(describeSsrFailure(error)).toContain('missing value')
  })

  it('never copies headers, cookies, bodies, config or cause into operator logs', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const error = new Error('Bearer secret-token Cookie: session=secret-cookie /private/server.ts', {
      cause: { password: 'secret-password' },
    })
    safeSsrLog(undefined, 'error', 'ssr.request.failed', {
      error, requestId: 'request-2', entryId: 'app', pathname: '/page?key=secret-query',
      headers: { authorization: 'secret-header' }, privateConfig: { secret: 'private-value' },
    })
    const serialized = JSON.stringify(consoleDiagnostic())
    expect(consoleDiagnostic().message).toContain('Bearer secret-token')
    expect(serialized).not.toMatch(/secret-header|private-value|secret-password/)
    expect(describeSsrFailure(error)).toContain('private data')
  })

  it('does not crash when Error getters throw', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const error = new Error('safe')
    Object.defineProperty(error, 'message', { get() { throw new Error('hostile message') } })
    Object.defineProperty(error, 'stack', { get() { throw new Error('hostile stack') } })
    Object.defineProperty(error, 'name', { get() { throw new Error('hostile name') } })
    expect(() => safeSsrLog(undefined, 'error', 'ssr.request.failed', { error })).not.toThrow()
    expect(consoleDiagnostic()).toMatchObject({
      errorType: 'Error',
      message: 'Unknown error.',
    })
  })

  it('emits one diagnostic when a carried failure crosses another layer', () => {
    const logger = { error: vi.fn() }
    const error = new TypeError('stream exploded')
    const { occurrence } = observeSsrFailure(error)
    safeSsrLog(logger, 'error', 'ssr.request.failed', { requestId: 'request-1', error, occurrence })
    safeSsrLog(logger, 'error', 'ssr.transport.failed', {
      requestId: 'request-1',
      error: carrySsrFailure(error, occurrence),
    })
    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith('ssr.request.failed', expect.objectContaining({
      message: 'stream exploded',
      errorId: occurrence.errorId,
    }))
  })

  it('logs a reused Error independently even when request ids match or sanitize to unknown', () => {
    const logger = { error: vi.fn() }
    const error = new Error('Database unavailable')
    safeSsrLog(logger, 'error', 'ssr.request.failed', { requestId: 'upstream-request', error })
    safeSsrLog(logger, 'error', 'ssr.request.failed', { requestId: 'upstream-request', error })
    safeSsrLog(logger, 'error', 'ssr.request.failed', { requestId: '***', error })
    safeSsrLog(logger, 'error', 'ssr.request.failed', { requestId: 'not a valid id', error })
    expect(logger.error).toHaveBeenCalledTimes(4)
    const ids = logger.error.mock.calls.map(([, details]) => (details as { errorId: string }).errorId)
    expect(new Set(ids).size).toBe(4)
  })

  it('logs independent primitive failures that share a value or message', () => {
    const logger = { error: vi.fn() }
    safeSsrLog(logger, 'error', 'ssr.request.failed', { requestId: 'request-1', error: 'cleanup failed' })
    safeSsrLog(logger, 'error', 'ssr.error-renderer.failed', { requestId: 'request-1', error: 'cleanup failed' })
    safeSsrLog(logger, 'error', 'ssr.request.failed', { requestId: 'request-1', error: 'boom' })
    safeSsrLog(logger, 'error', 'ssr.error-renderer.failed', { requestId: 'request-1', error: new Error('boom') })
    expect(logger.error).toHaveBeenCalledTimes(4)
    const ids = logger.error.mock.calls.map(([, details]) => (details as { errorId: string }).errorId)
    expect(new Set(ids).size).toBe(4)
  })

  it('emits one diagnostic when a carried primitive or non-extensible Error crosses a layer', () => {
    const logger = { error: vi.fn() }
    const error = Object.preventExtensions(new TypeError('stream exploded'))
    const observed = observeSsrFailure(error)
    safeSsrLog(logger, 'error', 'ssr.transport.failed', {
      requestId: 'request-1', error, occurrence: observed.occurrence,
    })
    safeSsrLog(logger, 'error', 'ssr.transport.failed', {
      requestId: 'request-1',
      error: carrySsrFailure(error, observed.occurrence),
    })
    expect(logger.error).toHaveBeenCalledOnce()
    logger.error.mockClear()
    const primitive = observeSsrFailure('stream exploded')
    safeSsrLog(logger, 'error', 'ssr.transport.failed', {
      requestId: 'request-3', error: 'stream exploded', occurrence: primitive.occurrence,
    })
    safeSsrLog(logger, 'error', 'ssr.transport.failed', {
      requestId: 'request-3',
      error: carrySsrFailure('stream exploded', primitive.occurrence),
    })
    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith('ssr.transport.failed', expect.objectContaining({
      message: 'stream exploded',
      errorId: primitive.occurrence.errorId,
    }))
  })

  it('represents an explicit undefined throw in operator logs', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => safeSsrLog(undefined, 'error', 'ssr.request.failed', { error: undefined })).not.toThrow()
    expect(consoleDiagnostic()).toMatchObject({
      errorType: 'Error',
      message: 'undefined',
      errorId: expect.stringMatching(/^vssl_[a-f0-9]{16}$/),
    })
  })

  it('prefers the consumer logger and never lets logger or metrics failures escape', async () => {
    const sink = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const logger = { error: vi.fn() }
    safeSsrLog(logger, 'error', 'ssr.request.failed', { error: PRODUCTION_HTTP_ORIGIN_ERROR })
    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith('ssr.request.failed', expect.objectContaining({
      errorId: expect.stringMatching(/^vssl_[a-f0-9]{16}$/),
      message: expect.any(String),
    }))
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

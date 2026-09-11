import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  carrySsrFailure,
  createSsrErrorDiagnostic,
  createSsrErrorId,
  createSsrFallbackErrorId,
  createSsrOperatorLogDetails,
  describeSsrThrownValue,
  isSsrErrorId,
  observeSsrFailure,
} from './SsrErrorDiagnostic'
import { markSsrInitializationFailure } from './SsrProductionError'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SsrErrorDiagnostic', () => {
  it('creates collision-resistant ids that carry no error content', () => {
    const id = createSsrErrorId()
    expect(isSsrErrorId(id)).toBe(true)
    expect(id).toMatch(/^vssl_[a-f0-9]{16}$/)
    expect(createSsrErrorId()).not.toBe(id)
  })

  it('keeps fallback ids unique in the same millisecond', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const ids = new Set(Array.from({ length: 8 }, () => createSsrFallbackErrorId()))
    expect(ids.size).toBe(8)
    for (const id of ids) expect(isSsrErrorId(id)).toBe(true)
  })

  it('creates a new occurrence unless the failure is carried across a boundary', () => {
    const error = new TypeError('Cannot read properties of undefined (reading "items")')
    const first = observeSsrFailure(error)
    const second = observeSsrFailure(error)
    expect(first.occurrence).not.toBe(second.occurrence)
    expect(first.occurrence.errorId).not.toBe(second.occurrence.errorId)
    expect(createSsrErrorDiagnostic({ error, requestId: 'request-1' }).errorId).not.toBe(first.occurrence.errorId)
    const carried = carrySsrFailure(error, first.occurrence)
    const observed = observeSsrFailure(carried)
    expect(observed.occurrence).toBe(first.occurrence)
    expect(observed.original).toBe(error)
    expect(Object.getOwnPropertySymbols(error)).toEqual([])
  })

  it('carries non-extensible Errors and primitive throws without mutating them', () => {
    const error = Object.preventExtensions(new TypeError('stream exploded'))
    const observed = observeSsrFailure(error)
    const carried = carrySsrFailure(error, observed.occurrence)
    expect(carried).not.toBe(error)
    expect(observeSsrFailure(carried).occurrence).toBe(observed.occurrence)
    expect(observeSsrFailure(carried).original).toBe(error)
    expect(Object.getOwnPropertySymbols(error)).toEqual([])
    const primitive = observeSsrFailure('stream exploded')
    expect(observeSsrFailure(carrySsrFailure('stream exploded', primitive.occurrence)).original).toBe('stream exploded')
    expect(observeSsrFailure(new TypeError('stream exploded')).occurrence.errorId)
      .not.toBe(primitive.occurrence.errorId)
  })

  it('represents an explicit undefined throw in operator diagnostics', () => {
    expect(() => createSsrErrorDiagnostic({ error: undefined, requestId: 'request-1' })).not.toThrow()
    const details = createSsrOperatorLogDetails({ error: undefined, requestId: 'request-1' })
    expect(details).toMatchObject({
      requestId: 'request-1',
      errorType: 'Error',
      message: 'undefined',
      errorId: expect.stringMatching(/^vssl_[a-f0-9]{16}$/),
    })
    expect(createSsrOperatorLogDetails({ requestId: 'request-1' })).not.toHaveProperty('message')
  })

  it('represents Error, string and unknown throws without [object Object]', () => {
    expect(describeSsrThrownValue(new TypeError('missing'))).toMatchObject({
      name: 'TypeError',
      message: 'missing',
    })
    expect(describeSsrThrownValue('plain string failure')).toEqual({
      name: 'Error',
      message: 'plain string failure',
    })
    expect(describeSsrThrownValue(undefined)).toEqual({ name: 'Error', message: 'undefined' })
    expect(describeSsrThrownValue({ nested: true })).toEqual({
      name: 'Error',
      message: 'Non-Error value was thrown.',
    })
    expect(describeSsrThrownValue({ name: 'CustomError', message: 'from object' })).toMatchObject({
      name: 'CustomError',
      message: 'from object',
    })
  })

  it('does not crash or walk cause when Error getters are hostile', () => {
    const error = new Error('safe')
    Object.defineProperty(error, 'name', { get() { throw new Error('hostile name') } })
    Object.defineProperty(error, 'message', { get() { throw new Error('hostile message') } })
    Object.defineProperty(error, 'stack', { get() { throw new Error('hostile stack') } })
    Object.defineProperty(error, 'cause', { get() { throw new Error('hostile cause') } })
    expect(describeSsrThrownValue(error)).toEqual({ name: 'Error', message: 'Unknown error.' })
    expect(() => createSsrErrorDiagnostic({ error, requestId: 'request-1' })).not.toThrow()
  })

  it('keeps operator details bounded and drops headers, cookies, body, config and cause', () => {
    const error = new TypeError('Cannot read properties of undefined (reading "items")', {
      cause: { password: 'secret-password', headers: { authorization: 'secret' } },
    })
    const details = createSsrOperatorLogDetails({
      requestId: 'request-1',
      entryId: 'shop',
      pathname: '/cart?token=secret',
      error,
      headers: { authorization: 'secret-header', cookie: 'session=secret' },
      cookies: { session: 'secret' },
      body: '{"password":"secret"}',
      privateConfig: { secret: 'private-value' },
      env: { SECRET: 'private-env' },
    })
    expect(details).toMatchObject({
      requestId: 'request-1',
      applicationId: 'shop',
      pathname: '/cart',
      errorType: 'TypeError',
      message: 'Cannot read properties of undefined (reading "items")',
    })
    expect(details.errorId).toMatch(/^vssl_[a-f0-9]{16}$/)
    expect(details.stack).toEqual(expect.stringContaining('TypeError'))
    expect(JSON.stringify(details)).not.toMatch(/secret-header|session=secret|private-value|private-env|secret-password/)
    expect(details).not.toHaveProperty('headers')
    expect(details).not.toHaveProperty('cookies')
    expect(details).not.toHaveProperty('body')
    expect(details).not.toHaveProperty('privateConfig')
    expect(details).not.toHaveProperty('env')
    expect(details).not.toHaveProperty('cause')
  })

  it('preserves runtime-load classification beside the original loader message', () => {
    const failure = markSsrInitializationFailure(
      Object.assign(
        new SyntaxError("The requested module 'fixture-runtime-package' does not provide an export named 'missingExport'"),
        {
          stack: "SyntaxError: The requested module 'fixture-runtime-package' does not provide an export named 'missingExport'\n    at ModuleJob._instantiate (node:internal/modules/esm/module_job.js:123:9)",
        }
      ),
      'runtime-load'
    )
    const diagnostic = createSsrErrorDiagnostic({ error: failure, requestId: 'startup' })
    expect(diagnostic).toMatchObject({
      phase: 'runtime-load',
      reason: 'missing-named-export',
      package: 'fixture-runtime-package',
      export: 'missingExport',
      errorType: 'SyntaxError',
      message: expect.stringContaining('does not provide an export named'),
    })
  })
})

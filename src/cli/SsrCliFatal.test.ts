import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportSsrCliFatal } from './SsrCliFatal'

afterEach(() => vi.restoreAllMocks())

describe('reportSsrCliFatal', () => {
  it('prints operator diagnostics for vue-ssr-lite start failures', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const error = new TypeError("Cannot read properties of undefined (reading 'boot')")
    error.stack = `${error.name}: ${error.message}\n    at start (SsrRuntime.js:1:1)`
    reportSsrCliFatal('start', error)
    expect(vi.mocked(console.error).mock.calls[0]![0]).toBe('[vue-ssr-lite] ssr.start.failed')
    expect(vi.mocked(console.error).mock.calls[0]![1]).toMatchObject({
      requestId: 'startup',
      errorType: 'TypeError',
      message: "Cannot read properties of undefined (reading 'boot')",
      stack: expect.stringContaining('SsrRuntime.js'),
      errorId: expect.stringMatching(/^vssl_[a-f0-9]{16}$/),
    })
  })

  it('keeps non-start fatal output on the generic console path', () => {
    const sink = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const error = new Error('dev failed')
    reportSsrCliFatal('dev', error)
    expect(sink).toHaveBeenCalledWith('fatal error', error)
  })
})

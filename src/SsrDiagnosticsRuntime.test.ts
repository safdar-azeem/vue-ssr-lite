import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSsrPhaseTimings, hasSsrTimingSink } from './SsrDiagnosticsRuntime'

afterEach(() => vi.restoreAllMocks())

describe('internal performance diagnostics', () => {
  it('does not turn development diagnostics into default console traces', () => {
    const output = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const info = vi.fn()
    const timings = createSsrPhaseTimings()
    timings.mark('runtime')
    timings.report(undefined, 'request', 'app')
    timings.report({ info }, 'request', 'app')
    expect(output).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
  })

  it('reports through the existing debug sink without sharing mutable snapshots', () => {
    const debug = vi.fn()
    const timings = createSsrPhaseTimings()
    timings.mark('runtime')
    timings.report({ debug }, 'first', 'app', { lifecycle: 'first-ssr' })
    const first = debug.mock.calls[0][1]
    first.phases.runtime = -1
    timings.mark('template')
    timings.report({ debug }, 'warm', 'app', { lifecycle: 'warm-ssr' })
    const warm = debug.mock.calls[1][1]
    expect(warm.phases.runtime).toBeGreaterThanOrEqual(0)
    expect(warm.phases.template).toBeGreaterThanOrEqual(0)
    expect(first.phases.template).toBeUndefined()
    expect(warm.lifecycle).toBe('warm-ssr')
  })

  it('contains throwing and rejecting debug hooks', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const timings = createSsrPhaseTimings()
    expect(() => timings.report({ debug: () => { throw new Error('logger failed') } }, 'request', 'app')).not.toThrow()
    expect(() => timings.report({ debug: async () => { throw new Error('async logger failed') } }, 'request', 'app')).not.toThrow()
    await Promise.resolve()
  })

  it('does not let a throwing logger getter affect a request', () => {
    const logger = { get debug(): never { throw new Error('unavailable debug sink') } }
    expect(hasSsrTimingSink(logger)).toBe(false)
    expect(() => createSsrPhaseTimings().report(logger, 'request', 'app')).not.toThrow()
  })
})

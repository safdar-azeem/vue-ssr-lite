import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyRouteResponseStatus,
  applyRuntimeResponseStatus,
  isValidResponseStatus,
  resetRouteResponseStatus,
  resolveResponseStatusForRoute,
  restoreResponseStatus,
  setResponseStatus,
  snapshotResponseStatus,
  validateResponseStatus,
} from './SsrResponseStatus'
import type { SsrResponseState } from './SsrRuntimeTypes'

const response = (): SsrResponseState => ({
  statusCode: 200,
  headers: {},
})

afterEach(() => vi.unstubAllGlobals())

describe('response status validation', () => {
  it.each([200, 404, 503, 100, 599])('accepts %s', (status) => {
    expect(isValidResponseStatus(status)).toBe(true)
    expect(validateResponseStatus(status)).toBe(status)
  })

  it.each([0, -1, 999, Number.NaN, 404.5])('rejects %s', (status) => {
    expect(isValidResponseStatus(status)).toBe(false)
    expect(() => validateResponseStatus(status)).toThrow(/Invalid HTTP status/)
  })

  it('validates and ignores status updates in the browser', () => {
    vi.stubGlobal('window', {})
    expect(setResponseStatus(404)).toBe(404)
    expect(() => setResponseStatus(302)).toThrow(/redirect/)
    expect(() => setResponseStatus(0)).toThrow(/Invalid HTTP status/)
  })

  it('still requires a request context in Node', () => {
    expect(() => setResponseStatus(404)).toThrow(/request context is not installed/)
  })

  it('gives runtime status precedence over route metadata', () => {
    const state = response()
    applyRouteResponseStatus(state, {
      meta: { seo: { status: 404 } },
      matched: [{ meta: { seo: { status: 404 } } }],
    } as any)
    expect(state.statusCode).toBe(404)
    applyRuntimeResponseStatus(state, 410)
    applyRouteResponseStatus(state, {
      meta: { seo: { status: 404 } },
      matched: [{ meta: { seo: { status: 404 } } }],
    } as any)
    expect(state.statusCode).toBe(410)
  })

  it('resets a previous runtime override so the next route can return to 200', () => {
    const state = response()
    applyRuntimeResponseStatus(state, 404)
    resetRouteResponseStatus(state)
    applyRouteResponseStatus(state, {
      meta: {},
      matched: [{ meta: {} }],
    } as any)
    expect(state.statusCode).toBe(200)
  })

  it('resolves route status as runtime > meta.seo.status > 200', () => {
    const state = response()
    expect(
      resolveResponseStatusForRoute(state, {
        meta: { seo: { status: 404 } },
        matched: [{ meta: { seo: { status: 404 } } }],
      } as any)
    ).toBe(404)
    expect(
      resolveResponseStatusForRoute(state, {
        meta: {},
        matched: [{ meta: {} }],
      } as any)
    ).toBe(200)
    applyRuntimeResponseStatus(state, 410)
    expect(
      applyRouteResponseStatus(state, {
        meta: { seo: { status: 200 } },
        matched: [{ meta: { seo: { status: 200 } } }],
      } as any)
    ).toBe(410)
  })

  it('restores a snapshotted runtime override after a discarded transition', () => {
    const state = response()
    applyRuntimeResponseStatus(state, 404)
    const snapshot = snapshotResponseStatus(state)
    resolveResponseStatusForRoute(state, {
      meta: {},
      matched: [{ meta: {} }],
    } as any)
    expect(state.statusCode).toBe(200)
    restoreResponseStatus(state, snapshot)
    expect(state.statusCode).toBe(404)
    applyRouteResponseStatus(state, {
      meta: {},
      matched: [{ meta: {} }],
    } as any)
    expect(state.statusCode).toBe(404)
  })
})

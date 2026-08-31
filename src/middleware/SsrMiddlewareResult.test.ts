import { describe, expect, it } from 'vitest'
import {
  classifyMiddlewareResult,
  createMiddlewareRedirectResult,
} from './SsrMiddlewareResult'

describe('middleware result classification', () => {
  it('classifies continue, cancellation, Vue Router redirects, and props', () => {
    expect(classifyMiddlewareResult(undefined, 'test', '/target')).toEqual({
      kind: 'continue',
    })
    expect(classifyMiddlewareResult(true, 'test', '/target')).toEqual({
      kind: 'continue',
    })
    expect(classifyMiddlewareResult(false, 'test', '/target')).toEqual({
      kind: 'cancel',
    })
    expect(classifyMiddlewareResult('/login', 'test', '/target')).toEqual({
      kind: 'redirect',
      location: '/login',
    })
    expect(
      classifyMiddlewareResult({ name: 'login' }, 'test', '/target')
    ).toEqual({ kind: 'redirect', location: { name: 'login' } })
    expect(
      classifyMiddlewareResult({ props: { role: 'admin' } }, 'test', '/target')
    ).toEqual({ kind: 'props', props: { role: 'admin' } })
  })

  it('keeps context.redirect results distinct from normal route locations', () => {
    const redirect = createMiddlewareRedirectResult('https://example.test/login', {
      external: true,
      status: 307,
    })
    expect(classifyMiddlewareResult(redirect, 'test', '/target')).toEqual({
      kind: 'special-redirect',
      redirect,
    })
  })

  it('rejects undocumented result shapes with a useful target label', () => {
    expect(() =>
      classifyMiddlewareResult({ unexpected: true } as never, 'authMiddleware', '/private')
    ).toThrow(/authMiddleware.*\/private/)
    expect(() =>
      classifyMiddlewareResult({ props: null } as never, 'authMiddleware', '/private')
    ).toThrow(/props must be an object/)
  })
})

import { describe, expect, it } from 'vitest'
import { createTestRenderRequest } from '../SsrTestFixtures'
import type { SsrResponseState } from '../SsrRuntimeTypes'
import {
  createMiddlewareCookies,
  serializeMiddlewareCookie,
} from './SsrMiddlewareCookies'

const response = (): SsrResponseState => ({
  statusCode: 200,
  headers: {},
  redirect: null,
})

describe('server middleware cookies', () => {
  it('reads the raw incoming Cookie header instead of filtered passthrough cookies', () => {
    const cookies = createMiddlewareCookies({
      server: true,
      request: createTestRenderRequest('cookies.test', {
        headers: { Cookie: 'single_session=raw-session; theme=dark' },
        cookie: 'theme=dark',
      }),
      response: response(),
    })
    expect(cookies.get('single_session')).toBe('raw-session')
    expect(cookies.get('theme')).toBe('dark')
  })

  it('updates the local jar and preserves every Set-Cookie value', () => {
    const state = response()
    const cookies = createMiddlewareCookies({
      server: true,
      request: createTestRenderRequest('cookies.test'),
      response: state,
    })
    cookies.set('session', 'yes', { sameSite: 'lax', httpOnly: true })
    expect(cookies.get('session')).toBe('yes')
    cookies.set('theme', 'dark', { secure: true })
    cookies.remove('session', { httpOnly: true })
    expect(cookies.get('session')).toBeUndefined()
    expect(state.headers['set-cookie']).toEqual([
      'session=yes; Path=/; HttpOnly; SameSite=Lax',
      'theme=dark; Path=/; Secure',
      'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly',
    ])
  })

  it('rejects values that could produce unsafe cookie headers', () => {
    expect(() => serializeMiddlewareCookie('bad name', 'value')).toThrow(/name/)
    expect(() => serializeMiddlewareCookie('safe', 'bad\nvalue')).toThrow(/value/)
    expect(() =>
      serializeMiddlewareCookie('safe', 'value', { path: '/ok; injected=true' })
    ).toThrow(/path/)
    expect(() =>
      serializeMiddlewareCookie('safe', 'value', { sameSite: 'none' })
    ).toThrow(/Secure/)
  })
})

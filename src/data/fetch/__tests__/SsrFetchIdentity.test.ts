import { describe, expect, it } from 'vitest'
import { createTestRenderRequest } from '../../../SsrTestFixtures'
import { resolveFetchIdentity, snapshotFetchVariables } from '../runtime/SsrFetchIdentity'
import type { UseFetchOptionsBase } from '../types/SsrFetchTypes'

const identity = (url: string, variables?: unknown, options: UseFetchOptionsBase<unknown, object> = {}) =>
  resolveFetchIdentity(url, variables, options, {
    server: true,
    request: createTestRenderRequest('app.test', {
      url: 'https://app.test/shop/deep',
      cookie: 'allowed=selected',
      headers: { cookie: 'secret=unfiltered', authorization: 'Bearer incoming', 'proxy-authorization': 'proxy-secret' },
    }),
  })

describe('fetch request identity and credentials', () => {
  it('canonicalizes equivalent relative, absolute and variables-derived URLs', () => {
    const a = identity('/api/items?z=1&page=2#fragment')
    const b = identity('https://app.test/api/items?page=2&z=1')
    const c = identity('/api/items?z=1', { page: 2 })
    expect(a.publicKey).toBe(b.publicKey)
    expect(a.runtimeKey).toBe(c.runtimeKey)
    expect(a.url).toBe('https://app.test/api/items?page=2&z=1')
    expect(identity('https://other.test/api/items?page=2&z=1').publicKey).not.toBe(a.publicKey)
    expect(identity('/api/items').url).toBe('https://app.test/api/items')
    expect(identity('api/items').url).toBe('https://app.test/shop/api/items')
    expect(identity('./api/items').url).toBe('https://app.test/shop/api/items')
    expect(identity('../api/items').url).toBe('https://app.test/api/items')
    const browser = resolveFetchIdentity('api/items', undefined, {}, {
      server: false,
      request: createTestRenderRequest('app.test', { url: 'https://app.test/shop/deep' }),
    })
    expect(browser.publicKey).toBe(identity('api/items').publicKey)
    expect(browser.url).toBe('/shop/api/items')
  })

  it('replaces query keys, omits undefined, preserves array ordering and sorts keys', () => {
    const resolved = identity('/api/items?replace=old&omit=old&same=x&same=y', {
      replace: [3, null, undefined, 'a b', false], omit: undefined, nil: null, empty: [],
    })
    expect(resolved.url).toBe('https://app.test/api/items?nil=&replace=3&replace=&replace=a+b&replace=false&same=x&same=y')
    expect(identity('/api/items', { page: 2 }).publicKey).toBe(identity('/api/items?page=2').publicKey)
  })

  it('copies and freezes primitive variable snapshots, including arrays and special keys', () => {
    const values = { order: [1, 2] }
    const snapshot = snapshotFetchVariables(values)
    values.order.push(3)
    expect(snapshot.order).toEqual([1, 2])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.order)).toBe(true)
    expect(snapshotFetchVariables(JSON.parse('{"__proto__":"safe"}'))['__proto__']).toBe('safe')
    for (const invalid of [{ nested: {} }, { nested: [[1]] }, { date: new Date() }, { fn: () => 1 }]) {
      expect(() => snapshotFetchVariables(invalid)).toThrow(/variables/)
    }
  })

  it('normalizes native headers and keeps request representation out of the public identity', () => {
    const a = identity('/api/items', undefined, { headers: { Authorization: 'Bearer private', 'X-Name': ' value ' } })
    const b = identity('/api/items', undefined, { headers: [['x-name', 'value'], ['authorization', 'Bearer private']] })
    expect(a.runtimeKey).toBe(b.runtimeKey)
    for (const settings of [
      { headers: { authorization: 'Bearer different' } }, { credentials: 'omit' }, { mode: 'same-origin' },
      { redirect: 'manual' }, { referrer: 'https://private.test/secret' }, { referrerPolicy: 'no-referrer' },
      { integrity: 'sha256-secret' }, { cache: 'no-store' },
    ] as UseFetchOptionsBase<unknown, object>[]) {
      const other = identity('/api/items', undefined, settings)
      expect(other.publicKey).toBe(a.publicKey)
      expect(other.runtimeKey).not.toBe(a.runtimeKey)
    }
    expect(a.publicKey).not.toMatch(/Bearer|private|cookie|credentials|fingerprint/)
    expect(identity('/api/items', undefined, { key: 'admin-profile' }).publicKey).not.toBe(a.publicKey)
    expect(identity('/api/items', undefined, { method: 'HEAD' }).publicKey).not.toBe(a.publicKey)
  })

  it('excludes observer signals and fetch policies from request identity', () => {
    expect(identity('/api/items', undefined, {
      signal: new AbortController().signal, fetchPolicy: 'cache-first', timeout: 42,
    }).runtimeKey).toBe(identity('/api/items').runtimeKey)
  })

  it('forwards filtered cookies and normalized Authorization only to the request origin', () => {
    const headers = identity('/api/items').init.headers
    expect(headers.get('cookie')).toBe('allowed=selected')
    expect(headers.get('authorization')).toBe('Bearer incoming')
    expect(headers.has('proxy-authorization')).toBe(false)
    const external = identity('https://outside.test/items').init.headers
    expect(external.has('cookie')).toBe(false)
    expect(external.has('authorization')).toBe(false)
    const omit = identity('/api/items', undefined, { credentials: 'omit' }).init.headers
    expect(omit.has('cookie')).toBe(false)
    expect(omit.has('authorization')).toBe(false)
    expect(identity('/api/items', undefined, { headers: { authorization: 'explicit' } }).init.headers.get('authorization')).toBe('explicit')
    expect(identity('https://outside.test/items', undefined, {
      credentials: 'omit', headers: { authorization: 'explicit', 'proxy-authorization': 'never' },
    }).init.headers.get('authorization')).toBe('explicit')
    expect(identity('/api/items', undefined, { headers: { 'proxy-authorization': 'never' } }).init.headers.has('proxy-authorization')).toBe(false)
  })

  it('only authorizes persistent hydration cache reuse for an anonymous baseline', () => {
    expect(identity('/api/items').browserReusable).toBe(false)
    expect(identity('/api/items', undefined, { credentials: 'omit' }).browserReusable).toBe(true)
    expect(identity('https://outside.test/items').browserReusable).toBe(false)
    expect(identity('https://outside.test/items', undefined, { credentials: 'omit' }).browserReusable).toBe(true)
    expect(identity('https://outside.test/items', undefined, { credentials: 'include' }).browserReusable).toBe(false)
    for (const headers of [{ authorization: 'explicit' }, { cookie: 'explicit=1' }, { 'x-api-key': 'secret' }]) {
      expect(identity('/api/items', undefined, { credentials: 'omit', headers }).browserReusable).toBe(false)
    }
    const noIncomingCredentials = resolveFetchIdentity('/api/items', undefined, {}, {
      server: true, request: createTestRenderRequest('app.test'),
    })
    // Absence of server cookies does not prove absence of browser/HTTP-only cookies.
    expect(noIncomingCredentials.browserReusable).toBe(false)
  })

  it('rejects non-HTTP URLs and embedded credentials without echoing secrets', () => {
    for (const url of ['file:///etc/passwd', 'https://user:private-password@app.test/items', 'http://[invalid']) {
      expect(() => identity(url)).toThrow(/useFetch\(\)/)
      try { identity(url) } catch (error) { expect(String(error)).not.toContain('private-password') }
    }
  })
})

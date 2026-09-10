import { describe, expect, it } from 'vitest'
import { normalizeDeploymentRequest } from '../DeploymentRequest'
import { resolveSsrForwardedHost, resolveSsrForwardedProtocol } from '../../server/SsrHostRuntime'

describe('authoritative provider request normalization', () => {
  it.each([false, true])('preserves external metadata with trustProxy=%s without trusting spoofed forwarded headers', (trustProxy) => {
    const body = new ReadableStream<Uint8Array>()
    const openBody = () => body
    const request = normalizeDeploymentRequest({
      method: 'POST', url: '/api/order?a=1&a=2&encoded=%2F', host: 'customer.example:8443', protocol: 'https', openBody,
      headers: {
        Host: 'internal.invalid', 'X-Forwarded-Host': 'evil.invalid', 'X-Forwarded-Proto': 'http',
        Forwarded: 'host=evil.invalid;proto=http', Cookie: 'session=A', Authorization: 'Bearer private',
      },
    })
    expect(resolveSsrForwardedHost(request.headers['x-forwarded-host'], request.headers.host, trustProxy)).toBe('customer.example:8443')
    expect(resolveSsrForwardedProtocol(request.headers['x-forwarded-proto'], request.protocol, trustProxy)).toBe('https')
    expect(request.headers.forwarded).toBeUndefined()
    expect(request.headers.cookie).toBe('session=A')
    expect(request.headers.authorization).toBe('Bearer private')
    expect(request.url).toBe('/api/order?a=1&a=2&encoded=%2F')
    expect(request.openBody).toBe(openBody)
    expect(Object.isFrozen(request.headers)).toBe(true)
  })

  it('creates fresh ids and immutable snapshots, independent of caller-owned arrays', () => {
    const values = ['one']
    const input = { method: 'GET', url: '/', host: 'a.test', protocol: 'https' as const, headers: { accept: values } }
    const a = normalizeDeploymentRequest(input)
    const b = normalizeDeploymentRequest(input)
    values.push('two')
    expect(a.requestId).not.toBe(b.requestId)
    expect(a.headers.accept).toEqual(['one'])
  })

  it('does not manufacture local transport permission from provider or client metadata', () => {
    const request = normalizeDeploymentRequest({
      method: 'GET', url: '/', host: 'localhost', protocol: 'http',
      headers: { host: 'localhost', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'localhost',
        forwarded: 'for=127.0.0.1;host=localhost;proto=http', trustedLocalConnection: 'true' },
    })
    expect(request.trustedLocalConnection).toBeUndefined()
  })
})

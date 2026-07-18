import { describe, expect, it } from 'vitest'
import {
  filterSsrCookieHeader,
  matchesSsrHostPattern,
  normalizeSsrHost,
  resolveSsrEntry,
  resolveSsrForwardedHost,
  resolveSsrForwardedProtocol,
} from './SsrHostRuntime'

describe('SSR host and proxy contract', () => {
  it.each([
    ['Example.COM:443', 'example.com:443'],
    ['example.com.', 'example.com'],
    ['::1', '[::1]'],
    ['[::1]:4302', '[::1]:4302'],
    ['bad host', ''],
    ['https://example.com', ''],
    ['user@example.com', ''],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeSsrHost(input)).toBe(expected)
  })

  it('matches exact, wildcard, nested subdomain, and fallback entries', () => {
    const entries = [
      { id: 'admin', kind: 'spa' as const, template: 'index.html', hosts: ['app.test', '*.app.test'] },
      { id: 'public', kind: 'ssr' as const, template: 'site.html', hosts: ['*'], application: {} as any },
    ]
    expect(matchesSsrHostPattern('workspace.app.test', '*.app.test')).toBe(true)
    expect(matchesSsrHostPattern('nested.workspace.app.test', '*.app.test')).toBe(true)
    expect(resolveSsrEntry(entries, 'app.test')?.id).toBe('admin')
    expect(resolveSsrEntry(entries, 'custom.test')?.id).toBe('public')
  })

  it('trusts forwarded authority and protocol only when enabled', () => {
    expect(resolveSsrForwardedHost('public.test', 'internal.test', false)).toBe('internal.test')
    expect(resolveSsrForwardedHost('public.test', 'internal.test', true)).toBe('public.test')
    expect(resolveSsrForwardedProtocol('https', 'http', false)).toBe('http')
    expect(resolveSsrForwardedProtocol('https', 'http', true)).toBe('https')
  })

  it('forwards only explicitly allowed, non-denied cookies', () => {
    expect(
      filterSsrCookieHeader(
        'customer=public; auth_token=private; preference=dark',
        ['customer', 'auth_token'],
        ['auth_token']
      )
    ).toBe('customer=public')
    expect(filterSsrCookieHeader('customer=public', [])).toBeUndefined()
  })
})

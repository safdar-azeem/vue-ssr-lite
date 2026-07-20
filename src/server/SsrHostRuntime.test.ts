import { describe, expect, it } from 'vitest'
import {
  filterSsrCookieHeader,
  matchesSsrHostPattern,
  normalizeSsrHost,
  normalizeSsrHostPattern,
  resolveSsrForwardedHost,
  resolveSsrForwardedProtocol,
  resolveSsrHostEntry,
  scoreSsrHostMatch,
  SsrHostConfigurationError,
  validateSsrHostEntries,
} from './SsrHostRuntime'

describe('SSR host matching', () => {
  it.each([
    ['Example.COM:443', 'example.com:443'],
    ['example.com.', 'example.com'],
    ['::1', '[::1]'],
    ['bad host', ''],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeSsrHost(input)).toBe(expected)
  })

  it('scores specificity independently of declaration order', () => {
    const apps = [
      { id: 'erp', hosts: ['localhost', '*.localhost'] },
      {
        id: 'storefront',
        hosts: ['shop.localhost', '*.shop.localhost', '*'],
      },
    ]
    expect(resolveSsrHostEntry(apps, 'company1.localhost')?.entry.id).toBe('erp')
    expect(
      resolveSsrHostEntry(apps, 'store.shop.localhost')?.entry.id
    ).toBe('storefront')
    expect(
      resolveSsrHostEntry([...apps].reverse(), 'store.shop.localhost')?.entry.id
    ).toBe('storefront')
    expect(scoreSsrHostMatch('a.shop.localhost', '*.shop.localhost')!.specificity).toBeGreaterThan(
      scoreSsrHostMatch('a.localhost', '*.localhost')!.specificity
    )
  })

  it('validates duplicate ownership and multiple catch-alls', () => {
    expect(() =>
      validateSsrHostEntries([
        { id: 'a', hosts: ['app.test'] },
        { id: 'b', hosts: ['app.test'] },
      ])
    ).toThrow(SsrHostConfigurationError)
    expect(() =>
      validateSsrHostEntries([
        { id: 'a', hosts: ['*'] },
        { id: 'b', hosts: ['*'] },
      ])
    ).toThrow(/Multiple catch-all/)
  })

  it('trusts forwarded authority only when enabled', () => {
    expect(resolveSsrForwardedHost('public.test', 'internal.test', false)).toBe(
      'internal.test'
    )
    expect(resolveSsrForwardedHost('public.test', 'internal.test', true)).toBe(
      'public.test'
    )
    expect(resolveSsrForwardedProtocol('https', 'http', true)).toBe('https')
  })

  it('matches nested wildcards and rejects invalid patterns', () => {
    expect(matchesSsrHostPattern('nested.workspace.app.test', '*.app.test')).toBe(
      true
    )
    expect(normalizeSsrHostPattern('*.*.outnax.com')).toBe('')
  })

  it('filters cookies by allow/deny lists', () => {
    expect(
      filterSsrCookieHeader(
        'customer=public; auth_token=private',
        ['customer', 'auth_token'],
        ['auth_token']
      )
    ).toBe('customer=public')
  })

  it('forwards nothing when both allow and deny are empty', () => {
    expect(
      filterSsrCookieHeader('session=a; theme=dark', [], [])
    ).toBeUndefined()
  })

  it('supports deny-only filtering when allow is empty', () => {
    expect(
      filterSsrCookieHeader(
        'session=a; auth_token=private; theme=dark',
        [],
        ['auth_token']
      )
    ).toBe('session=a; theme=dark')
  })
})

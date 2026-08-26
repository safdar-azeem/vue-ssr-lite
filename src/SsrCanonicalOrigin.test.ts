import { describe, expect, it } from 'vitest'
import {
  assertPublicProductionOrigin,
  composeCanonicalUrl,
  normalizeCanonicalPath,
  normalizeSiteOrigin,
  PRODUCTION_HTTP_ORIGIN_ERROR,
  PRODUCTION_ORIGIN_ERROR,
  resolveCanonicalHref,
  resolveCanonicalOrigin,
} from './SsrCanonicalOrigin'

describe('canonical origin and path', () => {
  it('normalizes origins and rejects paths, query, and hash by using origin only', () => {
    expect(normalizeSiteOrigin('https://ex.com/p?q=1#h')).toBe('https://ex.com')
  })

  it('rejects credentials and control characters in authoritative origins', () => {
    expect(() => normalizeSiteOrigin('https://user:pass@example.com')).toThrow(/credentials/)
    expect(() => normalizeSiteOrigin('https://example.com\n.evil.test')).toThrow(/control/)
  })

  it('strips query and hash from canonical paths', () => {
    expect(normalizeCanonicalPath('/about?utm=1#team')).toBe('/about')
    expect(normalizeCanonicalPath('/about/', false)).toBe('/about')
    expect(normalizeCanonicalPath('/about/', true)).toBe('/about/')
    expect(normalizeCanonicalPath('/')).toBe('/')
  })

  it('supports path, absolute, and disabled canonicals', () => {
    expect(resolveCanonicalHref('https://ex.com', '/about', undefined)).toBe(
      'https://ex.com/about'
    )
    expect(resolveCanonicalHref('https://ex.com', '/about', '/blog/a')).toBe(
      'https://ex.com/blog/a'
    )
    expect(
      resolveCanonicalHref(
        'https://ex.com',
        '/about',
        'https://other.test/article/'
      )
    ).toBe('https://other.test/article')
    expect(resolveCanonicalHref('https://ex.com', '/about', false)).toBeNull()
  })

  it('fails production public SEO without an authoritative origin', () => {
    expect(() =>
      resolveCanonicalOrigin({
        production: true,
        requireProductionOrigin: true,
        fallbackOrigin: 'http://localhost:4173',
      })
    ).toThrow(PRODUCTION_ORIGIN_ERROR)
  })

  it('rejects localhost in production', () => {
    expect(() =>
      resolveCanonicalOrigin({
        production: true,
        requireProductionOrigin: true,
        requestOrigin: 'http://localhost:4173',
      })
    ).toThrow(/localhost/)
  })

  it('composes root without a double slash', () => {
    expect(composeCanonicalUrl('https://ex.com', '/')).toBe('https://ex.com/')
  })

  it('accepts https production origins', () => {
    expect(
      assertPublicProductionOrigin('https://example.com', 'seo.siteUrl')
    ).toBe('https://example.com')
    expect(
      resolveCanonicalOrigin({
        production: true,
        requireProductionOrigin: true,
        siteUrl: 'https://example.com',
      })
    ).toBe('https://example.com')
    expect(
      resolveCanonicalOrigin({
        production: true,
        requireProductionOrigin: true,
        requestOrigin: 'https://example.com',
      })
    ).toBe('https://example.com')
  })

  it('rejects http production origins by default', () => {
    expect(() =>
      assertPublicProductionOrigin('http://example.com', 'PUBLIC_URL')
    ).toThrow(PRODUCTION_HTTP_ORIGIN_ERROR)
    expect(() =>
      resolveCanonicalOrigin({
        production: true,
        requireProductionOrigin: true,
        siteUrl: 'http://example.com',
      })
    ).toThrow(PRODUCTION_HTTP_ORIGIN_ERROR)
    expect(() =>
      resolveCanonicalOrigin({
        production: true,
        requireProductionOrigin: true,
        requestOrigin: 'http://example.com',
      })
    ).toThrow(PRODUCTION_HTTP_ORIGIN_ERROR)
  })

  it('rejects localhost in production even over https', () => {
    expect(() =>
      assertPublicProductionOrigin('https://localhost', 'seo.siteUrl')
    ).toThrow(/localhost/)
  })

  it('keeps development localhost valid', () => {
    expect(
      resolveCanonicalOrigin({
        production: false,
        requireProductionOrigin: false,
        fallbackOrigin: 'http://localhost:4173',
      })
    ).toBe('http://localhost:4173')
  })

  it('allows an explicit http production exception', () => {
    expect(
      assertPublicProductionOrigin('http://example.com', 'seo.siteUrl', {
        allowHttpOrigin: true,
      })
    ).toBe('http://example.com')
    expect(
      resolveCanonicalOrigin({
        production: true,
        requireProductionOrigin: true,
        siteUrl: 'http://example.com',
        allowHttpOrigin: true,
      })
    ).toBe('http://example.com')
  })
})

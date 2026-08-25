import { describe, expect, it } from 'vitest'
import { createSsrMemoryResponseCache, resolveSsrResponseCacheKey } from './SsrResponseCacheRuntime'

const request = (host = 'public.test', publicConfig: Record<string, unknown> = {}) => ({
  requestId: host,
  url: `https://${host}/products?page=1`,
  host,
  protocol: 'https' as const,
  method: 'GET',
  headers: {},
  publicConfig,
  signal: new AbortController().signal,
  pathname: '/products',
  search: '?page=1',
  entryId: 'storefront',
})

describe('SSR response cache controls', () => {
  it('bounds values and invalidates selected public responses', async () => {
    const store = createSsrMemoryResponseCache({ maxEntries: 2 })
    await store.set(
      'one',
      { statusCode: 200, body: 'one' },
      {
        ttlMs: 1_000,
        tags: ['site:one'],
      }
    )
    await store.set('two', { statusCode: 200, body: 'two' }, { ttlMs: 1_000 })
    await store.set('three', { statusCode: 200, body: 'three' }, { ttlMs: 1_000 })

    expect(await store.get('one')).toBeNull()
    expect((await store.get('three'))?.body).toBe('three')
    expect(await store.invalidate({ keys: ['three'] })).toBe(1)
    expect(await store.get('three')).toBeNull()
  })

  it('keys by application, host, route, and public variation', async () => {
    const store = createSsrMemoryResponseCache()
    const strategy = {
      store,
      ttlMs: 1_000,
      vary: () => 'publication:v3|locale:en',
    }
    const left = await resolveSsrResponseCacheKey('storefront', request('left.test'), strategy)
    const right = await resolveSsrResponseCacheKey('storefront', request('right.test'), strategy)
    const otherApplication = await resolveSsrResponseCacheKey(
      'admin',
      request('left.test'),
      strategy
    )
    const authenticated = await resolveSsrResponseCacheKey(
      'storefront',
      { ...request('left.test'), cookie: 'session=private' },
      strategy
    )

    expect(left).not.toBe(right)
    expect(left).not.toBe(otherApplication)
    expect(left).toContain('publication:v3')
    expect(authenticated).toBeNull()
    expect(JSON.parse(left!)[0]).toBe('vue-ssr-lite:v2')
  })

  it('varies by resolved public config output while retaining consumer variation', async () => {
    const strategy = {
      store: createSsrMemoryResponseCache(),
      ttlMs: 1_000,
      vary: () => 'publication:v3',
    }
    const english = await resolveSsrResponseCacheKey(
      'storefront',
      request('public.test', { locale: 'en' }),
      strategy
    )
    const arabic = await resolveSsrResponseCacheKey(
      'storefront',
      request('public.test', { locale: 'ar' }),
      strategy
    )
    const englishAgain = await resolveSsrResponseCacheKey(
      'storefront',
      {
        ...request('public.test', { locale: 'en' }),
        headers: { 'x-irrelevant': 'different input, same output' },
      },
      strategy
    )

    expect(english).not.toBe(arabic)
    expect(englishAgain).toBe(english)
    const parts = JSON.parse(english!)
    expect(parts[0]).toBe('vue-ssr-lite:v2')
    expect(parts[6]).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(parts[7]).toBe('publication:v3')
  })

  it.each([
    ['cookie', 'session=private'],
    ['Cookie', 'session=private'],
    ['authorization', 'Bearer private'],
    ['proxy-authorization', 'Basic private'],
  ])('bypasses shared caching for a non-empty %s header', async (name, value) => {
    const strategy = {
      store: createSsrMemoryResponseCache(),
      ttlMs: 1_000,
      vary: () => 'stable',
    }
    expect(
      await resolveSsrResponseCacheKey(
        'storefront',
        { ...request(), headers: { [name]: value } },
        strategy
      )
    ).toBeNull()
  })

  it('keeps empty credential headers cacheable', async () => {
    const strategy = {
      store: createSsrMemoryResponseCache(),
      ttlMs: 1_000,
    }
    expect(
      await resolveSsrResponseCacheKey(
        'storefront',
        {
          ...request(),
          headers: {
            cookie: ' ',
            authorization: '',
            'proxy-authorization': [],
          },
        },
        strategy
      )
    ).not.toBeNull()
  })
})

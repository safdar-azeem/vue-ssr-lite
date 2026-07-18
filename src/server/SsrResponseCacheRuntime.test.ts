import { describe, expect, it } from 'vitest'
import {
  createSsrMemoryResponseCache,
  resolveSsrResponseCacheKey,
} from './SsrResponseCacheRuntime'

const request = (host = 'public.test') => ({
  requestId: host,
  url: `https://${host}/products?page=1`,
  host,
  protocol: 'https' as const,
  method: 'GET',
  headers: {},
  publicConfig: {},
  signal: new AbortController().signal,
  pathname: '/products',
  search: '?page=1',
  entryId: 'storefront',
})

describe('SSR response cache controls', () => {
  it('bounds values and invalidates selected public responses', async () => {
    const store = createSsrMemoryResponseCache({ maxEntries: 2 })
    await store.set('one', { statusCode: 200, body: 'one' }, {
      ttlMs: 1_000,
      tags: ['site:one'],
    })
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
    const left = await resolveSsrResponseCacheKey(
      'storefront',
      request('left.test'),
      strategy
    )
    const right = await resolveSsrResponseCacheKey(
      'storefront',
      request('right.test'),
      strategy
    )
    const authenticated = await resolveSsrResponseCacheKey(
      'storefront',
      { ...request('left.test'), cookie: 'session=private' },
      strategy
    )

    expect(left).not.toBe(right)
    expect(left).toContain('publication:v3')
    expect(authenticated).toBeNull()
  })
})

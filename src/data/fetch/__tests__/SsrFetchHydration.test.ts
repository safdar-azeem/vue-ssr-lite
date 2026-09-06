import { afterEach, describe, expect, it, vi } from 'vitest'
import { FETCH_HYDRATION_KEY } from '../runtime/SsrFetchHydration'
import { createFetchHarness, jsonResponse } from './helpers'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
const anonymous = { credentials: 'omit' } as const

describe('fetch hydration continuation and collision accounting', () => {
  it('keeps records outside the runtime cache until consumers bind their browser fingerprints', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('SSR')))
    const server = createFetchHarness({ server: true })
    await server.attach('/api/items', anonymous).initial
    const payload = JSON.parse(JSON.stringify(server.snapshot()))
    expect(Object.values(payload)[0]).toMatchObject({ cache: { browserReusable: true } })
    expect(JSON.stringify(payload)).not.toMatch(/fingerprint|credentials|headers/)
    const fetcher = vi.fn(async () => jsonResponse('browser'))
    vi.stubGlobal('fetch', fetcher)
    const browser = createFetchHarness({ hydrating: true, restored: payload })
    expect(browser.runtime.cache.entries.size).toBe(0)
    const done = vi.fn()
    const a = browser.attach('/api/items', { ...anonymous, onDone: done })
    const b = browser.attach('/api/items', anonymous)
    await Promise.all([a.initial, b.initial])
    expect(a.consumer.data.value).toBe('SSR')
    expect(a.consumer.pending.value).toBe(false)
    expect(a.consumer.entry).toBe(b.consumer.entry)
    expect(a.consumer.entry.hasData).toBe(true)
    expect(a.consumer.entry.fingerprint).toBe(a.consumer.identity.fingerprint)
    expect(done).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    browser.hydration.completeHydration()
    const cached = browser.attach('/api/items', { ...anonymous, fetchPolicy: 'cache-first' })
    expect(cached.consumer.data.value).toBe('SSR')
    const network = browser.attach('/api/items', anonymous)
    expect(network.consumer.data.value).toBeUndefined()
    expect(network.consumer.pending.value).toBe(true)
    await network.initial
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(browser.hydration.read(FETCH_HYDRATION_KEY)).toBeUndefined()
    server.dispose(); browser.dispose()
  })

  it.each([
    { headers: { authorization: 'private-token-A' } },
    { cookie: 'server-secret=1' },
    { cookie: 'server-secret=1', headers: { authorization: 'private-token-A' } },
  ])('hydrates request-only credential state without seeding a different browser cache: %j', async (request) => {
    const serverFetch = vi.fn<typeof fetch>(async () => jsonResponse({ name: 'User A' }))
    vi.stubGlobal('fetch', serverFetch)
    const server = createFetchHarness({ server: true, request })
    const original = server.attach('/api/me')
    await original.initial
    const payload = JSON.parse(JSON.stringify(server.snapshot()))
    expect(payload[original.consumer.identity.publicKey].cache.browserReusable).toBe(false)
    expect(JSON.stringify(payload)).not.toMatch(/private-token-A|server-secret|fingerprint|authorization|cookie/)

    const browserFetch = vi.fn<typeof fetch>(async () => jsonResponse({ name: 'User B' }))
    vi.stubGlobal('fetch', browserFetch)
    const browser = createFetchHarness({ hydrating: true, restored: payload })
    const done = vi.fn()
    const options = { headers: { authorization: 'browser-token-B' }, onDone: done }
    const restored = browser.attach('/api/me', options)
    const sibling = browser.attach('/api/me', options)
    await Promise.all([restored.initial, sibling.initial])
    expect(restored.consumer.data.value).toEqual({ name: 'User A' })
    expect(restored.consumer.pending.value).toBe(false)
    expect(restored.consumer.progressed).toBe(true)
    expect(restored.consumer.entry.hasData).toBe(false)
    expect(restored.consumer.entry.data).toBeUndefined()
    expect(browserFetch).not.toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()

    browser.hydration.completeHydration()
    const later = browser.attach('/api/me', { ...options, fetchPolicy: 'cache-first' })
    expect(later.consumer.pending.value).toBe(true)
    expect(later.consumer.data.value).toBeUndefined()
    await later.initial
    expect(browserFetch).toHaveBeenCalledTimes(1)
    expect(new Headers(browserFetch.mock.calls[0]![1]!.headers).get('authorization')).toBe('browser-token-B')
    expect(later.consumer.data.value).toEqual({ name: 'User B' })
    expect(done).toHaveBeenCalledTimes(1)
    server.dispose(); browser.dispose()
  })

  it('preserves non-reusable provenance across server reconciliation, cache hits and later failures', async () => {
    const fetcher = vi.fn(async () => jsonResponse('credential-dependent'))
    vi.stubGlobal('fetch', fetcher)
    const request = { headers: { authorization: 'private-token-A' } }
    const server = createFetchHarness({ server: true, request })
    const a = server.attach('/api/me')
    await a.initial
    const resumed = createFetchHarness({
      server: true,
      request,
      restored: server.snapshot(),
      reconciliation: server.reconciliationSnapshot(),
    })
    const b = resumed.attach('/api/me', { fetchPolicy: 'cache-first' })
    await b.initial
    expect(b.consumer.entry.hasData).toBe(true)
    expect(resumed.snapshot()[b.consumer.identity.publicKey]!.cache?.browserReusable).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    await resumed.runtime.refresh(b.consumer)
    expect(resumed.snapshot()[b.consumer.identity.publicKey]!.cache).toEqual({ data: 'credential-dependent', browserReusable: false })
    server.dispose(); resumed.dispose()
  })

  it('rejects changed private identity across SSR passes without exposing either credential', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ name: 'User A' }))
    vi.stubGlobal('fetch', fetcher)
    const first = createFetchHarness({ server: true })
    await first.attach('/api/me', { headers: { authorization: 'Bearer A secret' } }).initial
    const resumed = createFetchHarness({
      server: true,
      restored: first.snapshot(),
      reconciliation: first.reconciliationSnapshot(),
    })

    let failure: unknown
    try {
      resumed.attach('/api/me', { headers: { authorization: 'Bearer B secret' } })
    } catch (error) {
      failure = error
    }
    expect(String(failure)).toMatch(/useFetch\(\) SSR configuration mismatch.*distinct explicit keys/)
    expect(String(failure)).not.toMatch(/Bearer A secret|Bearer B secret/)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect([...resumed.runtime.cache.entries.values()].every((entry) => !entry.hasData)).toBe(true)
    first.dispose(); resumed.dispose()
  })

  it('fails closed when public SSR continuation lacks request-local identity metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('settled')))
    const first = createFetchHarness({ server: true })
    await first.attach('/api/items').initial
    const resumed = createFetchHarness({ server: true, restored: first.snapshot() })
    expect(() => resumed.attach('/api/items')).toThrow(/SSR configuration mismatch/)
    first.dispose(); resumed.dispose()
  })

  it.each([
    { credentials: 'omit' as const, headers: { authorization: 'browser-token' } },
    { credentials: 'include' as const },
    { credentials: 'omit' as const, headers: { 'x-tenant': 'another-tenant' } },
    { credentials: 'omit' as const, referrer: 'https://fetch.test/another-context' },
  ])('does not re-key even anonymous SSR cache into incompatible browser options: %j', async (options) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('anonymous')))
    const server = createFetchHarness({ server: true })
    await server.attach('/api/items', anonymous).initial
    const browser = createFetchHarness({ hydrating: true, restored: server.snapshot() })
    const restored = browser.attach('/api/items', options)
    expect(restored.consumer.data.value).toBe('anonymous')
    expect(restored.consumer.entry.hasData).toBe(false)
    server.dispose(); browser.dispose()
  })

  it('treats cache from an older payload without provenance as non-reusable in the browser', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('old-server')))
    const server = createFetchHarness({ server: true })
    const a = server.attach('/api/items', anonymous)
    await a.initial
    const payload = server.snapshot()
    delete payload[a.consumer.identity.publicKey]!.cache!.browserReusable
    const browser = createFetchHarness({ hydrating: true, restored: payload })
    const b = browser.attach('/api/items', anonymous)
    expect(b.consumer.data.value).toBe('old-server')
    expect(b.consumer.entry.hasData).toBe(false)
    server.dispose(); browser.dispose()
  })

  it('does not adopt explicitly credentialed SSR data into an anonymous browser entry', async () => {
    const fetcher = vi.fn(async () => jsonResponse('private'))
    vi.stubGlobal('fetch', fetcher)
    const server = createFetchHarness({ server: true })
    await server.attach('/api/me', { ...anonymous, headers: { authorization: 'explicit-server-token' } }).initial
    const browser = createFetchHarness({ hydrating: true, restored: server.snapshot() })
    const restored = browser.attach('/api/me', anonymous)
    expect(restored.consumer.data.value).toBe('private')
    expect(restored.consumer.entry.hasData).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
    browser.hydration.completeHydration()
    await browser.attach('/api/me', { ...anonymous, fetchPolicy: 'cache-first' }).initial
    expect(fetcher).toHaveBeenCalledTimes(2)
    server.dispose(); browser.dispose()
  })

  it('rejects incompatible hydrating fingerprints before copying cache into a second entry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('SSR')))
    const server = createFetchHarness({ server: true })
    await server.attach().initial
    const browser = createFetchHarness({ hydrating: true, restored: server.snapshot() })
    const a = browser.attach('/api/items', { headers: { authorization: 'A' } })
    expect(() => browser.attach('/api/items', { headers: { authorization: 'B' } })).toThrow(/hydration configuration mismatch.*distinct explicit keys/)
    expect(browser.runtime.cache.entries.size).toBe(1)
    expect(a.consumer.data.value).toBe('SSR')
    server.dispose(); browser.dispose()
  })

  it('restores handled errors without callback replay and does not treat the error as a cache hit', async () => {
    const fetcher = vi.fn(async () => new Response('bad', { status: 503, statusText: 'Unavailable' }))
    vi.stubGlobal('fetch', fetcher)
    const server = createFetchHarness({ server: true })
    const a = server.attach()
    await a.initial
    const payload = JSON.parse(JSON.stringify(server.snapshot()))
    expect(payload[a.consumer.identity.publicKey].cache).toBeUndefined()
    const onError = vi.fn()
    const browser = createFetchHarness({ hydrating: true, restored: payload })
    const b = browser.attach('/api/items', { onError, nextFetchPolicy: 'cache-first' })
    await b.initial
    expect(b.consumer.pending.value).toBe(false)
    expect(b.consumer.error.value).toEqual(a.consumer.error.value)
    expect(b.consumer.progressed).toBe(true)
    expect(onError).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
    browser.hydration.completeHydration()
    await browser.attach('/api/items', { fetchPolicy: 'cache-first' }).initial
    expect(fetcher).toHaveBeenCalledTimes(2)
    server.dispose(); browser.dispose()
  })

  it('restores failure markup and independently adopts a prior successful cache value', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse('V1'))
      .mockResolvedValueOnce(new Response('bad', { status: 500 }))
    vi.stubGlobal('fetch', fetcher)
    const server = createFetchHarness({ server: true })
    const seed = server.attach('/api/items', anonymous)
    await seed.initial
    server.runtime.release(seed.consumer)
    const failed = server.attach('/api/items', anonymous)
    await failed.initial
    const payload = JSON.parse(JSON.stringify(server.snapshot()))
    const record = payload[failed.consumer.identity.publicKey]
    expect(record.state.data).toBeUndefined()
    expect(record.state.error.kind).toBe('http')
    expect(record.cache.data).toBe('V1')
    const browser = createFetchHarness({ hydrating: true, restored: payload })
    const hydrated = browser.attach('/api/items', anonymous)
    expect(hydrated.consumer.data.value).toBeUndefined()
    expect(hydrated.consumer.error.value?.kind).toBe('http')
    expect(hydrated.consumer.pending.value).toBe(false)
    browser.hydration.completeHydration()
    const cached = browser.attach('/api/items', { ...anonymous, fetchPolicy: 'cache-first' })
    expect(cached.consumer.data.value).toBe('V1')
    expect(cached.consumer.error.value).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
    server.dispose(); browser.dispose()
  })

  it('rejects different settled server fingerprints and allows explicit namespaces', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('same-data')))
    const harness = createFetchHarness({ server: true })
    await harness.attach('/api/items', { headers: { authorization: 'secret-A' } }).initial
    await harness.attach('/api/items', { headers: { authorization: 'secret-B' } }).initial
    expect(() => harness.snapshot()).toThrow(/SSR configuration mismatch.*distinct explicit keys/)
    try { harness.snapshot() } catch (error) { expect(String(error)).not.toMatch(/secret-A|secret-B/) }
    harness.dispose()
    const namespaced = createFetchHarness({ server: true })
    await namespaced.attach('/api/items', { key: 'customer-profile', headers: { authorization: 'secret-A' } }).initial
    await namespaced.attach('/api/items', { key: 'admin-profile', headers: { authorization: 'secret-B' } }).initial
    expect(Object.keys(namespaced.snapshot())).toHaveLength(2)
    namespaced.dispose()
  })

  it('checks all live consumers, including successful parent and failed child states', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse('success'))
      .mockResolvedValueOnce(new Response('bad', { status: 500 })))
    const harness = createFetchHarness({ server: true })
    await harness.attach().initial
    await harness.attach().initial
    expect(harness.runtime.consumers.size).toBe(2)
    expect([...harness.runtime.cache.entries.values()][0]!.execution).toBeUndefined()
    expect(() => harness.snapshot()).toThrow(/distinct explicit keys/)
    // Intermediate reactivity checkpoints are not final hydration snapshots.
    expect(() => harness.hydration.collect(false)).not.toThrow()
    harness.dispose()
  })

  it('rejects server:false skeletons sharing a public identity with completed server consumers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('success')))
    const harness = createFetchHarness({ server: true })
    const skeleton = harness.attach('/api/items', { server: false })
    await harness.attach().initial
    expect(skeleton.consumer.pending.value).toBe(true)
    expect(() => harness.snapshot()).toThrow(/distinct explicit keys/)
    harness.dispose()
  })

  it('preserves a successful undefined cache value through JSON hydration', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetcher)
    const server = createFetchHarness({ server: true })
    await server.attach('/api/items', anonymous).initial
    const browser = createFetchHarness({ hydrating: true, restored: JSON.parse(JSON.stringify(server.snapshot())) })
    const hydrated = browser.attach('/api/items', anonymous)
    expect(hydrated.consumer.entry.hasData).toBe(true)
    browser.hydration.completeHydration()
    const cached = browser.attach('/api/items', { ...anonymous, fetchPolicy: 'cache-first' })
    await cached.initial
    expect(cached.consumer.data.value).toBeUndefined()
    expect(cached.consumer.pending.value).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
    server.dispose(); browser.dispose()
  })

  it('keeps caller-aborted and timed-out consumers in SSR continuation after detachment', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(() => new Promise<Response>(() => undefined))
    vi.stubGlobal('fetch', fetcher)
    const harness = createFetchHarness({ server: true })
    const abort = new AbortController()
    const a = harness.attach('/api/abort', { signal: abort.signal })
    const b = harness.attach('/api/timeout', { timeout: 10 })
    abort.abort()
    await vi.advanceTimersByTimeAsync(10)
    await Promise.all([a.initial, b.initial])
    const payload = harness.snapshot()
    expect(payload[a.consumer.identity.publicKey]!.state).toEqual({ data: undefined, pending: false, error: null })
    expect(payload[b.consumer.identity.publicKey]!.state.error?.kind).toBe('timeout')
    expect(harness.runtime.consumers.size).toBe(2)
    harness.dispose()
  })

  it('does not advance policy for a restored cancelled initial decision without a successful result', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))
    const server = createFetchHarness({ server: true })
    const abort = new AbortController()
    const a = server.attach('/api/items', { signal: abort.signal })
    abort.abort()
    await a.initial
    const browser = createFetchHarness({ hydrating: true, restored: server.snapshot() })
    const b = browser.attach('/api/items', { nextFetchPolicy: 'cache-first' })
    await b.initial
    expect(b.consumer.pending.value).toBe(false)
    expect(b.consumer.error.value).toBeNull()
    expect(b.consumer.progressed).toBe(false)
    server.dispose(); browser.dispose()
  })

  it('compares serialized snapshots rather than object identity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ value: 1 })))
    const harness = createFetchHarness({ server: true })
    const a = harness.attach()
    const b = harness.attach()
    await Promise.all([a.initial, b.initial])
    a.consumer.data.value = { value: 1 }
    expect(a.consumer.data.value).not.toBe(b.consumer.data.value)
    expect(() => harness.snapshot()).not.toThrow()
    a.consumer.pending.value = true
    expect(() => harness.snapshot()).toThrow(/distinct explicit keys/)
    harness.dispose()
  })

  it('defers the server:false skeleton until hydration completes, using the first policy', async () => {
    const fetcher = vi.fn(async () => jsonResponse('browser-only'))
    vi.stubGlobal('fetch', fetcher)
    const server = createFetchHarness({ server: true })
    const a = server.attach('/api/items', { server: false, fetchPolicy: 'network-only', nextFetchPolicy: 'cache-first' })
    await a.initial
    expect(a.consumer.data.value).toBeUndefined()
    expect(a.consumer.pending.value).toBe(true)
    expect(a.consumer.progressed).toBe(false)
    expect(server.snapshot()[a.consumer.identity.publicKey]!.cache).toBeUndefined()
    const browser = createFetchHarness({ hydrating: true, restored: server.snapshot() })
    const b = browser.attach('/api/items', a.consumer.options)
    await b.initial
    expect(fetcher).not.toHaveBeenCalled()
    expect(b.consumer.pending.value).toBe(true)
    expect(b.consumer.progressed).toBe(false)
    // A cache value must not accidentally promote this first network-only decision.
    b.consumer.entry.hasData = true
    b.consumer.entry.data = 'older'
    browser.hydration.completeHydration()
    await browser.runtime.refresh(b.consumer)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(b.consumer.data.value).toBe('browser-only')
    expect(b.consumer.progressed).toBe(true)
    server.dispose(); browser.dispose()
  })

  it('immediate:false wins over server:false across hydration and identity changes', async () => {
    const fetcher = vi.fn(async () => jsonResponse('manual'))
    vi.stubGlobal('fetch', fetcher)
    const server = createFetchHarness({ server: true })
    const a = server.attach('/api/items', { immediate: false, server: false })
    const browser = createFetchHarness({ hydrating: true, restored: server.snapshot() })
    const b = browser.attach('/api/items', a.consumer.options)
    browser.hydration.completeHydration()
    await browser.change(b.consumer, '/api/new')
    expect(b.consumer.pending.value).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
    await browser.runtime.refresh(b.consumer)
    expect(fetcher).toHaveBeenCalledTimes(1)
    server.dispose(); browser.dispose()
  })

  it.each(['success', 'failure'] as const)('resumes settled SSR %s without network or callback replay', async (outcome) => {
    const fetcher = vi.fn(async () => outcome === 'success' ? jsonResponse('settled') : new Response('bad', { status: 500 }))
    vi.stubGlobal('fetch', fetcher)
    const first = createFetchHarness({ server: true })
    const a = first.attach()
    await a.initial
    const resumed = createFetchHarness({
      server: true,
      restored: first.snapshot(),
      reconciliation: first.reconciliationSnapshot(),
    })
    const callback = vi.fn()
    const b = resumed.attach('/api/items', { onDone: callback, onError: callback })
    await b.initial
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(callback).not.toHaveBeenCalled()
    expect(b.consumer.data.value).toEqual(a.consumer.data.value)
    expect(b.consumer.error.value).toEqual(a.consumer.error.value)
    first.dispose(); resumed.dispose()
  })

  it.each(['complete', 'dispose'] as const)('discards unconsumed records on hydration %s', async (action) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('SSR')))
    const server = createFetchHarness({ server: true })
    await server.attach('/api/consumed', anonymous).initial
    await server.attach('/api/unconsumed', anonymous).initial
    const browser = createFetchHarness({ hydrating: true, restored: server.snapshot() })
    const consumed = browser.attach('/api/consumed', anonymous)
    if (action === 'complete') browser.hydration.completeHydration()
    else browser.dispose()
    expect(browser.hydration.read(FETCH_HYDRATION_KEY)).toBeUndefined()
    const identity = browser.runtime.resolve('/api/unconsumed', undefined, {})
    expect(browser.runtime.continuation.restore(identity, consumed.consumer.entry)).toBeUndefined()
    if (action === 'complete') expect(consumed.consumer.entry.data).toBe('SSR')
    server.dispose(); browser.dispose()
  })
})

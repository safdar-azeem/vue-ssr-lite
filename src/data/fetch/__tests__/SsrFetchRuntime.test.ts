import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleFetchTimeout } from '../runtime/SsrFetchExecution'
import { createFetchHarness, deferred, jsonResponse } from './helpers'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('fetch runtime execution ownership', () => {
  it('replaces and snapshots application request context without retaining caller state', () => {
    const harness = createFetchHarness()
    const callerHeaders = new Headers({
      authorization: 'Bearer A',
      'x-workspace': 'workspace_1',
    })
    harness.runtime.setContext({ headers: callerHeaders })
    callerHeaders.set('authorization', 'Bearer mutated')

    const firstSnapshot = harness.runtime.getContextSnapshot()
    expect(firstSnapshot.get('authorization')).toBe('Bearer A')
    firstSnapshot.set('authorization', 'Bearer snapshot-mutation')
    expect(harness.runtime.getContextSnapshot().get('authorization')).toBe(
      'Bearer A'
    )

    harness.runtime.setContext({ headers: { 'x-workspace': 'workspace_2' } })
    const replaced = harness.runtime.resolve('/api/items', undefined, {})
    expect(replaced.init.headers.get('x-workspace')).toBe('workspace_2')
    expect(replaced.init.headers.has('authorization')).toBe(false)

    harness.runtime.setContext({ headers: {} })
    expect(
      harness.runtime.resolve('/api/items', undefined, {}).init.headers.has(
        'x-workspace'
      )
    ).toBe(false)
    harness.runtime.setContext({})
    expect([...harness.runtime.getContextSnapshot()]).toEqual([])
    harness.dispose()
  })

  it('uses the latest context on refresh without refetching when context alone changes', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      jsonResponse(new Headers(init?.headers).get('authorization'))
    )
    vi.stubGlobal('fetch', fetcher)
    const harness = createFetchHarness()
    harness.runtime.setContext({
      headers: { authorization: 'Bearer A' },
    })
    const attached = harness.attach()
    await attached.initial
    expect(attached.consumer.data.value).toBe('Bearer A')

    harness.runtime.setContext({
      headers: { authorization: 'Bearer B' },
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    harness.runtime.move(
      attached.consumer,
      harness.runtime.resolve(
        '/api/items',
        undefined,
        attached.consumer.options
      )
    )
    await harness.runtime.refresh(attached.consumer)
    expect(attached.consumer.data.value).toBe('Bearer B')
    expect(fetcher).toHaveBeenCalledTimes(2)

    harness.runtime.setContext({
      headers: { authorization: 'Bearer C' },
    })
    await harness.change(attached.consumer, '/api/other')
    expect(attached.consumer.data.value).toBe('Bearer C')
    expect(fetcher).toHaveBeenCalledTimes(3)
    harness.dispose()
  })

  it('keeps in-flight context immutable and separates authenticated deduplication identities', async () => {
    const first = deferred<Response>()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async (_url, init) =>
        jsonResponse(new Headers(init?.headers).get('authorization'))
      )
    vi.stubGlobal('fetch', fetcher)
    const harness = createFetchHarness()
    harness.runtime.setContext({
      headers: { authorization: 'Bearer A' },
    })
    const a = harness.attach('/api/profile')

    harness.runtime.setContext({
      headers: { authorization: 'Bearer B' },
    })
    const b = harness.attach('/api/profile')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(a.consumer.identity.runtimeKey).not.toBe(
      b.consumer.identity.runtimeKey
    )
    expect(
      new Headers(fetcher.mock.calls[0]![1]?.headers).get('authorization')
    ).toBe('Bearer A')
    expect(
      new Headers(fetcher.mock.calls[1]![1]?.headers).get('authorization')
    ).toBe('Bearer B')

    first.resolve(jsonResponse('Bearer A'))
    await Promise.all([a.initial, b.initial])
    expect(a.consumer.data.value).toBe('Bearer A')
    expect(b.consumer.data.value).toBe('Bearer B')
    harness.dispose()
  })

  it('keeps context false in force across refresh while preserving local headers', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      jsonResponse(Object.fromEntries(new Headers(init?.headers)))
    )
    vi.stubGlobal('fetch', fetcher)
    const harness = createFetchHarness({
      server: true,
      request: {
        cookie: 'session=abc',
        headers: { authorization: 'Bearer incoming' },
      },
    })
    harness.runtime.setContext({
      headers: {
        authorization: 'Bearer context-A',
        'x-workspace': 'workspace_1',
      },
    })
    const attached = harness.attach('/api/public-feed', {
      context: false,
      credentials: 'omit',
      headers: { 'x-trace': 'trace-123' },
    })
    await attached.initial
    expect(attached.consumer.data.value).toEqual({ 'x-trace': 'trace-123' })

    harness.runtime.setContext({
      headers: { authorization: 'Bearer context-B' },
    })
    harness.runtime.move(
      attached.consumer,
      harness.runtime.resolve(
        '/api/public-feed',
        undefined,
        attached.consumer.options
      )
    )
    await harness.runtime.refresh(attached.consumer)
    expect(attached.consumer.data.value).toEqual({ 'x-trace': 'trace-123' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    harness.dispose()
  })

  it('matches request-local header identity and browser hydration semantics', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse('profile')))
    const fromContext = createFetchHarness({ server: true })
    const fromRequest = createFetchHarness({ server: true })
    fromContext.runtime.setContext({
      headers: { authorization: 'Bearer equivalence-secret' },
    })
    const contextExecution = fromContext.attach('/api/profile')
    const requestExecution = fromRequest.attach('/api/profile', {
      headers: { authorization: 'Bearer equivalence-secret' },
    })
    await Promise.all([contextExecution.initial, requestExecution.initial])

    expect(contextExecution.consumer.identity.fingerprint).toBe(
      requestExecution.consumer.identity.fingerprint
    )
    expect(contextExecution.consumer.identity.publicKey).toBe(
      requestExecution.consumer.identity.publicKey
    )
    expect(fromContext.snapshot()).toEqual(fromRequest.snapshot())
    expect(JSON.stringify(fromContext.snapshot())).not.toContain(
      'equivalence-secret'
    )
    fromContext.dispose()
    fromRequest.dispose()
  })

  it('does not overflow long timeout durations into immediate cancellation', async () => {
    vi.useFakeTimers()
    const expire = vi.fn()
    const cancel = scheduleFetchTimeout(2 ** 31 + 10, expire)
    await vi.advanceTimersByTimeAsync(2 ** 31 - 1)
    expect(expire).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(11)
    expect(expire).toHaveBeenCalledTimes(1)
    cancel()
  })

  it('shares physical work while preserving per-hook callbacks and immutable execution variables', async () => {
    const gate = deferred<Response>()
    const fetcher = vi.fn<typeof fetch>(() => gate.promise)
    vi.stubGlobal('fetch', fetcher)
    const harness = createFetchHarness()
    const doneA = vi.fn()
    const doneB = vi.fn()
    const variables = { page: 2, tags: ['a', 'b'] }
    const a = harness.attach('/api/items', { onDone: doneA }, variables)
    const b = harness.attach('/api/items?page=2&tags=a&tags=b', { onDone: doneB })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(a.consumer.pending.value).toBe(true)
    expect(a.consumer.data.value).toBeUndefined()
    variables.tags.push('c')
    gate.resolve(jsonResponse(['items']))
    await Promise.all([a.initial, b.initial])
    expect(a.consumer.data.value).toEqual(['items'])
    expect(a.consumer.data).not.toBe(b.consumer.data)
    expect(doneA).toHaveBeenCalledTimes(1)
    expect(doneB).toHaveBeenCalledTimes(1)
    expect(doneA.mock.calls[0]![0].variables).toEqual({ page: 2, tags: ['a', 'b'] })
    expect(Object.isFrozen(doneA.mock.calls[0]![0].variables.tags)).toBe(true)
    expect(doneB.mock.calls[0]![0].variables).toEqual({})
    expect(doneA.mock.calls[0]![0].key).toBe(doneB.mock.calls[0]![0].key)
    expect(doneA.mock.calls[0]![0]).not.toHaveProperty('response')
    harness.dispose()
  })

  it('settles only an aborted observer immediately and keeps shared network work alive', async () => {
    const gate = deferred<Response>()
    const fetcher = vi.fn<typeof fetch>(() => gate.promise)
    vi.stubGlobal('fetch', fetcher)
    const harness = createFetchHarness({ server: true })
    const signal = new AbortController()
    const onError = vi.fn()
    const a = harness.attach('/api/items', { signal: signal.signal, onError })
    const b = harness.attach()
    signal.abort()
    await a.initial
    expect(a.consumer.pending.value).toBe(false)
    expect(a.consumer.error.value).toBeNull()
    expect(b.consumer.pending.value).toBe(true)
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(false)
    expect(onError).not.toHaveBeenCalled()
    expect(harness.runtime.consumers.has(a.consumer)).toBe(true)
    expect(a.consumer.progressed).toBe(false)
    gate.resolve(jsonResponse('B'))
    await b.initial
    expect(b.consumer.data.value).toBe('B')
    harness.dispose()
  })

  it('gives timeout its own terminal error and callback without cancelling another observer', async () => {
    vi.useFakeTimers()
    const gate = deferred<Response>()
    const fetcher = vi.fn<typeof fetch>(() => gate.promise)
    vi.stubGlobal('fetch', fetcher)
    const harness = createFetchHarness({ server: true })
    const onError = vi.fn()
    const a = harness.attach('/api/items', { timeout: 5, onError })
    const b = harness.attach()
    await vi.advanceTimersByTimeAsync(5)
    await a.initial
    expect(a.consumer.error.value?.kind).toBe('timeout')
    expect(a.consumer.pending.value).toBe(false)
    expect(b.consumer.pending.value).toBe(true)
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
    gate.resolve(jsonResponse('B'))
    await b.initial
    expect(a.consumer.error.value?.kind).toBe('timeout')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(() => harness.snapshot()).toThrow(/distinct explicit keys/)
    harness.dispose()
  })

  it.each(['scope', 'app', 'request'] as const)('aborts physical work and settles observers on %s disposal', async (mode) => {
    const requestAbort = new AbortController()
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined))
    vi.stubGlobal('fetch', fetcher)
    const harness = createFetchHarness({ server: true, request: { signal: requestAbort.signal } })
    const onError = vi.fn()
    const a = harness.attach('/api/items', { onError })
    if (mode === 'scope') harness.runtime.release(a.consumer)
    if (mode === 'app') harness.dispose()
    if (mode === 'request') requestAbort.abort()
    await a.initial
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    expect(a.consumer.pending.value).toBe(false)
    expect(a.consumer.error.value).toBeNull()
    expect(onError).not.toHaveBeenCalled()
    harness.dispose()
  })

  it('starts no request for an already aborted caller or SSR request', async () => {
    const signal = new AbortController()
    signal.abort()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const a = createFetchHarness()
    const b = createFetchHarness({ server: true, request: { signal: signal.signal } })
    const first = a.attach('/api/items', { signal: signal.signal })
    const second = b.attach()
    await Promise.all([first.initial, second.initial])
    expect(fetcher).not.toHaveBeenCalled()
    expect(first.consumer.pending.value).toBe(false)
    expect(second.consumer.error.value).toBeNull()
    a.dispose(); b.dispose()
  })

  it('retains local data on refresh cancellation while another hook keeps the physical request', async () => {
    const gate = deferred<Response>()
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse('V1')).mockReturnValueOnce(gate.promise)
    vi.stubGlobal('fetch', fetcher)
    const harness = createFetchHarness()
    const abort = new AbortController()
    const a = harness.attach('/api/items', { signal: abort.signal })
    await a.initial
    const refresh = harness.runtime.refresh(a.consumer)
    const b = harness.attach()
    abort.abort()
    await refresh
    expect(a.consumer.data.value).toBe('V1')
    expect(a.consumer.pending.value).toBe(false)
    expect(a.consumer.error.value).toBeNull()
    expect(b.consumer.pending.value).toBe(true)
    expect(fetcher.mock.calls[1]![1].signal.aborted).toBe(false)
    gate.resolve(jsonResponse('V2'))
    await b.initial
    expect(a.consumer.data.value).toBe('V2')
    expect(a.consumer.error.value).toBeNull()
    harness.dispose()
  })

  it('aborts orphaned identities and ignores transports that resolve after cancellation', async () => {
    const old = deferred<Response>()
    const next = deferred<Response>()
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    vi.stubGlobal('fetch', fetcher)
    const harness = createFetchHarness()
    const onDone = vi.fn()
    const a = harness.attach('/api/old', { onDone })
    const current = harness.change(a.consumer, '/api/new')
    await a.initial
    expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true)
    expect(a.consumer.data.value).toBeUndefined()
    next.resolve(jsonResponse('new'))
    await current
    old.resolve(jsonResponse('old'))
    await old.promise
    await Promise.resolve()
    expect(a.consumer.data.value).toBe('new')
    expect(onDone).toHaveBeenCalledTimes(1)
    harness.dispose()
  })

  it('isolates callback exceptions from successful state and awaited settlement', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('ok')))
    const harness = createFetchHarness({ server: true })
    const a = harness.attach('/api/items', { onDone: () => { throw new Error('callback') } })
    await a.initial
    expect(a.consumer.data.value).toBe('ok')
    expect(a.consumer.error.value).toBeNull()
    const b = harness.attach('/api/items', { onDone: async () => { throw new Error('async callback') } })
    await b.initial
    expect(b.consumer.error.value).toBeNull()
    harness.dispose()
  })
})

describe('fetch policies and successful cache ownership', () => {
  it('keeps network-only and cache-first state independent and propagates successful commits passively', async () => {
    const gate = deferred<Response>()
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse('V1')).mockReturnValueOnce(gate.promise)
    vi.stubGlobal('fetch', fetcher)
    const harness = createFetchHarness()
    const seed = harness.attach()
    await seed.initial
    const done = vi.fn()
    const network = harness.attach('/api/items', { onDone: done })
    const passiveDone = vi.fn()
    const passive = harness.attach('/api/items', { fetchPolicy: 'cache-first', onDone: passiveDone })
    expect(network.consumer.data.value).toBeUndefined()
    expect(network.consumer.pending.value).toBe(true)
    expect(passive.consumer.data.value).toBe('V1')
    expect(passive.consumer.pending.value).toBe(false)
    gate.resolve(jsonResponse('V2'))
    await network.initial
    expect(passive.consumer.data.value).toBe('V2')
    expect(passive.consumer.pending.value).toBe(false)
    expect(passiveDone).not.toHaveBeenCalled()
    expect(done).toHaveBeenCalledTimes(1)
    harness.dispose()
  })

  it('preserves cache, local refresh data and passive errors across unrelated failures and successes', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse('V1'))
      .mockResolvedValueOnce(new Response('bad', { status: 500 }))
      .mockResolvedValueOnce(new Response('bad', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse('V2'))
    vi.stubGlobal('fetch', fetcher)
    const harness = createFetchHarness()
    const done = vi.fn()
    const seed = harness.attach('/api/items', { onDone: done })
    await seed.initial
    const refresh = harness.runtime.refresh(seed.consumer)
    expect(seed.consumer.data.value).toBe('V1')
    expect(seed.consumer.pending.value).toBe(true)
    await refresh
    const error = seed.consumer.error.value
    expect(error?.kind).toBe('http')
    const passive = harness.attach('/api/items', { fetchPolicy: 'cache-first' })
    const failed = harness.attach()
    await failed.initial
    expect(failed.consumer.data.value).toBeUndefined()
    expect(passive.consumer.data.value).toBe('V1')
    expect(passive.consumer.error.value).toBeNull()
    const success = harness.attach()
    await success.initial
    expect(seed.consumer.data.value).toBe('V2')
    expect(seed.consumer.error.value).toBe(error)
    expect(done).toHaveBeenCalledTimes(1)
    expect(failed.consumer.error.value?.status).toBe(503)
    harness.dispose()
  })

  it('refresh joins automatic work, adds its own logical callback, waits, and does not advance policy', async () => {
    const gate = deferred<Response>()
    const fetcher = vi.fn(() => gate.promise)
    vi.stubGlobal('fetch', fetcher)
    const harness = createFetchHarness()
    const done = vi.fn()
    const automatic = harness.attach()
    const manual = harness.attach('/api/items', { immediate: false, onDone: done, nextFetchPolicy: 'cache-first' })
    const first = harness.runtime.refresh(manual.consumer)
    const second = harness.runtime.refresh(manual.consumer)
    let refreshed = false
    void first.then(() => { refreshed = true })
    await Promise.resolve()
    expect(refreshed).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
    gate.resolve(jsonResponse('fresh'))
    await Promise.all([automatic.initial, first, second])
    expect(done).toHaveBeenCalledTimes(2)
    expect(manual.consumer.progressed).toBe(false)
    harness.dispose()
  })

  it('advances nextFetchPolicy after completed automatic decisions, and resets for a new hook', async () => {
    const fetcher = vi.fn(async () => jsonResponse('value'))
    vi.stubGlobal('fetch', fetcher)
    const harness = createFetchHarness()
    const a = harness.attach('/api/a', { nextFetchPolicy: 'cache-first' })
    await a.initial
    await harness.change(a.consumer, '/api/b')
    await harness.change(a.consumer, '/api/a')
    expect(fetcher).toHaveBeenCalledTimes(2)
    await harness.attach('/api/a', { nextFetchPolicy: 'cache-first' }).initial
    expect(fetcher).toHaveBeenCalledTimes(3)
    await harness.runtime.refresh(a.consumer)
    expect(fetcher).toHaveBeenCalledTimes(4)
    harness.dispose()
  })

  it('advances cache hits and handled errors but preserves first policy after cancellation', async () => {
    const old = deferred<Response>()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse('cached'))
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(new Response('bad', { status: 500 }))
    vi.stubGlobal('fetch', fetcher)
    const harness = createFetchHarness()
    await harness.attach('/api/cached').initial
    const hit = harness.attach('/api/cached', { fetchPolicy: 'cache-first', nextFetchPolicy: 'network-only' })
    expect(hit.consumer.progressed).toBe(true)
    const a = harness.attach('/api/old', { nextFetchPolicy: 'cache-first' })
    await harness.change(a.consumer, '/api/cached')
    await a.initial
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(a.consumer.error.value?.kind).toBe('http')
    expect(a.consumer.progressed).toBe(true)
    harness.dispose()
  })

  it('keeps immediate:false manual through identity changes and refreshes the current identity', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse('current'))
    vi.stubGlobal('fetch', fetcher)
    const harness = createFetchHarness({ server: true })
    const a = harness.attach('/api/old', { immediate: false, server: false })
    await a.initial
    expect(a.consumer.pending.value).toBe(false)
    expect(a.consumer.data.value).toBeUndefined()
    await harness.change(a.consumer, '/api/new', { page: 2 })
    expect(fetcher).not.toHaveBeenCalled()
    await harness.runtime.refresh(a.consumer)
    expect(fetcher.mock.calls[0]![0]).toBe('https://fetch.test/api/new?page=2')
    expect(a.consumer.progressed).toBe(false)
    harness.dispose()
  })

  it('keeps at most 100 successful orphans, retains active entries, and removes orphaned failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('failure')
      ? new Response('', { status: 500 }) : jsonResponse(url)))
    const harness = createFetchHarness()
    const active = harness.attach('/api/active')
    await active.initial
    for (let index = 0; index < 105; index++) {
      const a = harness.attach(`/api/${index}`)
      await a.initial
      harness.runtime.release(a.consumer)
    }
    expect(harness.runtime.cache.entries.size).toBe(101)
    expect(harness.runtime.cache.entries.has(active.consumer.identity.runtimeKey)).toBe(true)
    expect([...harness.runtime.cache.entries.values()].some((entry) => entry.publicKey.includes('/api/0"'))).toBe(false)
    const failure = harness.attach('/api/failure')
    await failure.initial
    harness.runtime.release(failure.consumer)
    expect(harness.runtime.cache.entries.has(failure.consumer.identity.runtimeKey)).toBe(false)
    harness.dispose()
    expect(harness.runtime.cache.entries.size).toBe(0)
  })

  it('isolates concurrent tenants and browser application caches', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => jsonResponse(new Headers(init.headers).get('cookie')))
    vi.stubGlobal('fetch', fetcher)
    const a = createFetchHarness({ server: true, request: { cookie: 'tenant=a' } })
    const b = createFetchHarness({ server: true, request: { cookie: 'tenant=b' } })
    const first = a.attach()
    const second = b.attach()
    await Promise.all([first.initial, second.initial])
    expect(first.consumer.data.value).toBe('tenant=a')
    expect(second.consumer.data.value).toBe('tenant=b')
    const c = createFetchHarness()
    const d = createFetchHarness()
    await c.attach('/api/items', { fetchPolicy: 'cache-first' }).initial
    await d.attach('/api/items', { fetchPolicy: 'cache-first' }).initial
    expect(fetcher).toHaveBeenCalledTimes(4)
    a.dispose(); b.dispose(); c.dispose(); d.dispose()
  })
})

describe('native response parsing and safe errors', () => {
  it.each([
    ['json', () => jsonResponse({ ok: true }), undefined, { ok: true }],
    ['suffix JSON', () => new Response('{"ok":true}', { headers: { 'content-type': 'application/problem+json; charset=UTF-8' } }), undefined, { ok: true }],
    ['text', () => new Response('text'), undefined, 'text'],
    ['HEAD', () => new Response('not-json', { headers: { 'content-type': 'application/json' } }), 'HEAD', undefined],
    ['204', () => new Response(null, { status: 204 }), undefined, undefined],
    ['205', () => new Response(null, { status: 205 }), undefined, undefined],
  ] as const)('parses %s', async (_label, response, method, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => response()))
    const harness = createFetchHarness()
    const a = harness.attach('/api/items', { method })
    await a.initial
    expect(a.consumer.data.value).toEqual(expected)
    expect(a.consumer.entry.hasData).toBe(true)
    expect(a.consumer.error.value).toBeNull()
    harness.dispose()
  })

  it.each(['http', 'network', 'parse'] as const)('handles %s without rejecting or exposing native errors', async (kind) => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (kind === 'network') throw new Error('secret-token and stack')
      return new Response('secret-token', {
        status: kind === 'http' ? 403 : 200,
        statusText: kind === 'http' ? 'Forbidden' : 'OK',
        headers: { 'content-type': 'application/json', 'set-cookie': 'secret-cookie=1' },
      })
    }))
    const harness = createFetchHarness({ server: true })
    const onError = vi.fn()
    const a = harness.attach('/api/items', { onError })
    await expect(a.initial).resolves.toBeUndefined()
    expect(a.consumer.error.value?.kind).toBe(kind)
    expect(JSON.stringify(harness.snapshot())).not.toMatch(/secret-token|secret-cookie|stack|set-cookie/)
    expect(harness.runtime.context.response.headers).toEqual({})
    expect(onError).toHaveBeenCalledTimes(1)
    expect(a.consumer.entry.hasData).toBe(false)
    harness.dispose()
  })
})

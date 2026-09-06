// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://fetch.test/"}
import {
  createSSRApp, defineComponent, h, inject, nextTick, onServerPrefetch, ref, Suspense, watch,
  type App, type ShallowRef,
} from 'vue'
import { renderToString } from 'vue/server-renderer'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createSsrApplication } from '../../../SsrApplicationRuntime'
import { hydrateSsrApplication, mountSpaApplication } from '../../../SsrBrowserRuntime'
import { renderSsrApplication } from '../../../SsrRenderRuntime'
import { createTestDomain, createTestRenderRequest } from '../../../SsrTestFixtures'
import { getSsrStateElementId } from '../../../SsrSerialization'
import { RouterView } from '../../../navigation/RouterView'
import { SSR_NAVIGATION_RUNTIME } from '../../../navigation/SsrNavigationRuntime'
import { SSR_FETCH_RUNTIME, type SsrFetchRuntime } from '../runtime/SsrFetchRuntime'
import { FETCH_HYDRATION_KEY, type HydratedFetchRecord } from '../runtime/SsrFetchHydration'
import { useFetch } from '../composables/useFetch'
import type { UseFetchError, UseFetchResult, UseFetchReturn } from '../types/SsrFetchTypes'
import { deferred, jsonResponse } from './helpers'

const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  window.history.replaceState({}, '', '/')
})

const flush = async () => {
  for (let index = 0; index < 12; index++) await nextTick()
}

const mount = async (root: Parameters<typeof createSsrApplication>[0]['root']) => {
  document.body.innerHTML = '<div id="app"></div>'
  const created = await createSsrApplication({ id: 'fetch-app', root }, {
    server: false, spa: true, request: createTestRenderRequest('fetch.test'),
  })
  disposers.push(() => { created.app.unmount(); created.hydration.dispose() })
  created.app.mount('#app')
  return created
}

describe('optional await in SSR and the browser', () => {
  it.each([false, true])('renders SSR data with await=%s and starts during setup', async (awaited) => {
    const gate = deferred<Response>()
    const fetcher = vi.fn(() => gate.promise)
    vi.stubGlobal('fetch', fetcher)
    let marker: unknown
    let beforeAwaitCalls = 0
    const render = (result: UseFetchReturn<string[]>) => () => h('main', result.data.value?.join(',') ?? 'skeleton')
    const root = awaited ? defineComponent({
      async setup() {
        const result = useFetch<string[]>('/api/items')
        beforeAwaitCalls = fetcher.mock.calls.length
        const base = await result
        marker = base.data.value
        expect(base).not.toHaveProperty('then')
        return render(base)
      },
    }) : defineComponent({
      setup() {
        const result = useFetch<string[]>('/api/items')
        beforeAwaitCalls = fetcher.mock.calls.length
        marker = result.data.value
        return render(result)
      },
    })
    const created = await createSsrApplication({ id: 'fetch-app', root }, {
      server: true, request: createTestRenderRequest('fetch.test'),
    })
    disposers.push(() => created.hydration.dispose())
    const rendered = renderToString(created.app)
    expect(beforeAwaitCalls).toBe(1)
    expect(marker).toBeUndefined()
    gate.resolve(jsonResponse(['product']))
    expect(await rendered).toContain('product')
    expect(marker).toEqual(awaited ? ['product'] : undefined)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('mounts browser skeleton before network settlement with await=%s', async (awaited) => {
    const gate = deferred<Response>()
    const fetcher = vi.fn(() => gate.promise)
    vi.stubGlobal('fetch', fetcher)
    let result!: UseFetchReturn<string>
    const render = () => h('main', result.pending.value ? 'skeleton' : result.data.value)
    const Page = awaited ? defineComponent({
      async setup() { result = await useFetch<string>('/api/items'); return render },
    }) : defineComponent({
      setup() { result = useFetch<string>('/api/items'); return render },
    })
    await mount(defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(Page) }) }))
    await flush()
    expect(document.querySelector('main')?.textContent).toBe('skeleton')
    expect(result.pending.value).toBe(true)
    gate.resolve(jsonResponse('loaded'))
    await result.refresh()
    await flush()
    expect(document.querySelector('main')?.textContent).toBe('loaded')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('keeps then tied to initial execution while refresh genuinely waits on either platform', async () => {
    for (const server of [true, false]) {
      const fresh = deferred<Response>()
      const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse('initial')).mockReturnValueOnce(fresh.promise)
      vi.stubGlobal('fetch', fetcher)
      let result!: UseFetchResult<string>
      const root = defineComponent({ setup() { result = useFetch<string>('/api/items'); return () => h('main') } })
      const created = await createSsrApplication({ id: 'fixed-then', root }, {
        server, spa: !server, request: createTestRenderRequest('fetch.test'),
      })
      if (server) await renderToString(created.app)
      else {
        document.body.innerHTML = '<div id="app"></div>'
        created.app.mount('#app')
        await flush()
      }
      const refresh = result.refresh()
      let finished = false
      void refresh.then(() => { finished = true })
      const base = await result
      expect(base).not.toHaveProperty('then')
      expect(base.pending.value).toBe(true)
      expect(finished).toBe(false)
      fresh.resolve(jsonResponse('fresh'))
      await refresh
      expect(result.data.value).toBe('fresh')
      created.hydration.dispose()
      if (!server) created.app.unmount()
    }
  })

  it.each(['manual', 'server-disabled'] as const)('SSR await resolves immediately for %s', async (mode) => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const root = defineComponent({ async setup() {
      const { data, pending, error } = await useFetch('/api/items', mode === 'manual' ? { immediate: false } : { server: false })
      expect(data.value).toBeUndefined()
      expect(error.value).toBeNull()
      return () => h('main', pending.value ? 'skeleton' : 'idle')
    } })
    const rendered = await renderSsrApplication({ id: 'disabled', root }, createTestRenderRequest('fetch.test'))
    expect(rendered.html).toContain(mode === 'manual' ? 'idle' : 'skeleton')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reacts to URL getters and nested variable arrays, and keeps manual mode inert', async () => {
    const fetcher = vi.fn(async (url: string) => jsonResponse(url))
    vi.stubGlobal('fetch', fetcher)
    const url = ref('/api/first')
    const variables = ref({ tags: ['a'] })
    let automatic!: UseFetchResult<string>
    let manual!: UseFetchResult<string>
    await mount(defineComponent({ setup() {
      automatic = useFetch<string>(() => url.value, { variables })
      manual = useFetch<string>(() => url.value, { key: 'manual', variables, immediate: false })
      return () => h('main', automatic.data.value)
    } }))
    await flush()
    variables.value.tags.push('b')
    await flush()
    url.value = '/api/second'
    expect(automatic.data.value).toBeUndefined()
    await flush()
    expect(automatic.data.value).toBe('/api/second?tags=a&tags=b')
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(manual.pending.value).toBe(false)
    await manual.refresh()
    expect(manual.data.value).toBe('/api/second?tags=a&tags=b')
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('rejects calls outside component setup and components without the application runtime', async () => {
    expect(() => useFetch('/api/items')).toThrow(/synchronously from component setup/)
    let error: unknown
    await renderToString(createSSRApp(defineComponent({ setup() {
      try { useFetch('/api/items') } catch (caught) { error = caught }
      return () => h('main')
    } })))
    expect(String(error)).toMatch(/active vue-ssr-lite application/)
    const created = await createSsrApplication({ id: 'not-setup', root: { render: () => null } }, {
      server: true, request: createTestRenderRequest('fetch.test'),
    })
    expect(() => created.app.runWithContext(() => useFetch('/api/items'))).toThrow(/component setup/)
    created.hydration.dispose()
  })

  it.each(['success', 'error'] as const)('does not repeat settled %s during renderer reconciliation', async (outcome) => {
    const fetcher = vi.fn(async () => outcome === 'success' ? jsonResponse('products') : new Response('', { status: 500 }))
    vi.stubGlobal('fetch', fetcher)
    const callback = vi.fn()
    const root = defineComponent({ setup() {
      const runtime = inject(SSR_FETCH_RUNTIME)!
      const result = useFetch<string>('/api/items', {
        headers: { authorization: 'Bearer RECONCILIATION_SECRET' },
        onDone: callback,
        onError: callback,
      })
      onServerPrefetch(() => {
        if (runtime.context.resolution.pass === 0) runtime.context.resolution.requestAdditionalPass()
      })
      return () => h('main', result.error.value ? 'handled-error' : result.data.value)
    } })
    const rendered = await renderSsrApplication({ id: 'reconcile-fetch', root }, createTestRenderRequest('fetch.test'))
    expect(rendered.metrics.renderPasses).toBe(2)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(rendered.html).toContain(outcome === 'success' ? 'products' : 'handled-error')
    expect(JSON.stringify(rendered.hydrationState)).not.toContain('RECONCILIATION_SECRET')
  })

  it('rejects a private request identity change during SSR reconciliation', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ name: 'User A' }))
    vi.stubGlobal('fetch', fetcher)
    const root = defineComponent({ setup() {
      const runtime = inject(SSR_FETCH_RUNTIME)!
      const authorization = runtime.context.resolution.pass === 0
        ? 'Bearer USER_A_SECRET'
        : 'Bearer USER_B_SECRET'
      const result = useFetch<{ name: string }>('/api/me', {
        headers: { authorization },
      })
      onServerPrefetch(() => {
        if (runtime.context.resolution.pass === 0) {
          runtime.context.resolution.requestAdditionalPass()
        }
      })
      return () => h('main', result.data.value?.name)
    } })

    let failure: unknown
    try {
      await renderSsrApplication(
        { id: 'private-reconciliation', root },
        createTestRenderRequest('fetch.test')
      )
    } catch (error) {
      failure = error
    }
    expect(String(failure)).toMatch(/useFetch\(\) SSR configuration mismatch.*distinct explicit keys/)
    expect(String(failure)).not.toMatch(/USER_A_SECRET|USER_B_SECRET/)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('omits fetch records not visited by the final SSR pass from browser hydration state', async () => {
    const fetcher = vi.fn(async () => jsonResponse('SECRET_VALUE'))
    vi.stubGlobal('fetch', fetcher)
    let privateKey = ''
    const root = defineComponent({ setup() {
      const runtime = inject(SSR_FETCH_RUNTIME)!
      const pass = runtime.context.resolution.pass
      const result = pass === 0
        ? useFetch<string>('/api/private', {
            headers: { authorization: 'Bearer PRIVATE_CREDENTIAL' },
          })
        : undefined
      if (pass === 0) {
        privateKey = runtime.resolve('/api/private', undefined, {
          headers: { authorization: 'Bearer PRIVATE_CREDENTIAL' },
        }).publicKey
      }
      onServerPrefetch(() => {
        if (pass === 0) runtime.context.resolution.requestAdditionalPass()
      })
      return () => h('main', result?.data.value ?? 'public-page')
    } })

    const rendered = await renderSsrApplication(
      { id: 'final-pass-projection', root },
      createTestRenderRequest('fetch.test')
    )
    const records = rendered.hydrationState.plugins?.[FETCH_HYDRATION_KEY] as Record<string, HydratedFetchRecord>
    expect(rendered.metrics.renderPasses).toBe(2)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(rendered.html).toContain('public-page')
    expect(rendered.html).not.toContain('SECRET_VALUE')
    expect(JSON.stringify(rendered.hydrationState)).not.toMatch(/SECRET_VALUE|PRIVATE_CREDENTIAL/)
    expect(Object.hasOwn(records, privateKey)).toBe(false)
    expect(Object.keys(records)).toHaveLength(0)
  })

  it('retains absent fetch history request-locally for a matching later SSR pass', async () => {
    const fetcher = vi.fn(async () => jsonResponse('restored-private-data'))
    vi.stubGlobal('fetch', fetcher)
    const root = defineComponent({ setup() {
      const runtime = inject(SSR_FETCH_RUNTIME)!
      const pass = runtime.context.resolution.pass
      const result = pass === 1
        ? undefined
        : useFetch<string>('/api/private', {
            headers: { authorization: 'Bearer SAME_CREDENTIAL' },
          })
      onServerPrefetch(() => {
        if (pass < 2) runtime.context.resolution.requestAdditionalPass()
      })
      return () => h('main', result?.data.value ?? 'temporarily-absent')
    } })

    const rendered = await renderSsrApplication(
      { id: 'returning-fetch', root },
      createTestRenderRequest('fetch.test')
    )
    expect(rendered.metrics.renderPasses).toBe(3)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(rendered.html).toContain('restored-private-data')
    expect(JSON.stringify(rendered.hydrationState)).not.toContain('SAME_CREDENTIAL')
  })

  it('rejects a changed private identity when an absent fetch returns in a later SSR pass', async () => {
    const fetcher = vi.fn(async () => jsonResponse('User A private data'))
    vi.stubGlobal('fetch', fetcher)
    const root = defineComponent({ setup() {
      const runtime = inject(SSR_FETCH_RUNTIME)!
      const pass = runtime.context.resolution.pass
      const result = pass === 1
        ? undefined
        : useFetch<string>('/api/private', {
            headers: {
              authorization: pass === 0 ? 'Bearer HISTORY_A_SECRET' : 'Bearer HISTORY_B_SECRET',
            },
          })
      onServerPrefetch(() => {
        if (pass < 2) runtime.context.resolution.requestAdditionalPass()
      })
      return () => h('main', result?.data.value ?? 'temporarily-absent')
    } })

    let failure: unknown
    try {
      await renderSsrApplication(
        { id: 'changed-returning-fetch', root },
        createTestRenderRequest('fetch.test')
      )
    } catch (error) {
      failure = error
    }
    expect(String(failure)).toMatch(/useFetch\(\) SSR configuration mismatch.*distinct explicit keys/)
    expect(String(failure)).not.toMatch(/HISTORY_A_SECRET|HISTORY_B_SECRET/)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('initial application hydration and navigation', () => {
  it('uses browser-relative URL semantics on nested SSR pages and makes no hydration request', async () => {
    window.history.replaceState({}, '', '/shop/deep')
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse('nested-products'))
    vi.stubGlobal('fetch', fetcher)
    let app!: App
    let runtime!: SsrFetchRuntime
    const root = defineComponent({ setup() {
      const result = useFetch<string>('api/items')
      return () => h('main', result.pending.value ? 'pending' : result.data.value)
    } })
    const definition = { id: 'relative-hydration', root }
    const request = createTestRenderRequest('fetch.test', {
      url: 'https://fetch.test/shop/deep',
    })
    const rendered = await renderSsrApplication(definition, request)
    expect(rendered.html).toContain('nested-products')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]![0]).toBe('https://fetch.test/shop/api/items')
    const records = rendered.hydrationState.plugins?.[FETCH_HYDRATION_KEY] as Record<string, HydratedFetchRecord>
    const serverPublicKey = Object.keys(records)[0]!
    const stateId = getSsrStateElementId(definition.id)
    document.body.innerHTML = `<div id="app">${rendered.html}</div><script id="${stateId}"></script>`
    document.getElementById(stateId)!.textContent = JSON.stringify(rendered.hydrationState)

    await hydrateSsrApplication({ ...definition, install({ app: installed }) {
      app = installed
      runtime = app.runWithContext(() => inject(SSR_FETCH_RUNTIME)!)
    } })
    disposers.push(() => app.unmount())
    expect(document.querySelector('main')?.textContent).toBe('nested-products')
    expect(runtime.resolve('api/items', undefined, {}).publicKey).toBe(serverPublicKey)
    expect(runtime.resolve('api/items', undefined, {}).url).toBe('/shop/api/items')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('renders credential-dependent SSR state without trusting it as browser-token cache data', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ name: 'User A' }))
    vi.stubGlobal('fetch', fetcher)
    let browser = false
    const laterVisible = ref(false)
    let app!: App
    let runtime!: SsrFetchRuntime
    const done = vi.fn()
    const options = () => browser ? { headers: { authorization: 'Bearer USER_B_TOKEN' }, onDone: done } : {}
    const Page = defineComponent({ setup() {
      const result = useFetch<{ name: string }>('/api/me', options())
      return () => h('main', result.pending.value ? 'pending' : result.data.value?.name)
    } })
    const Later = defineComponent({ setup() {
      const result = useFetch<{ name: string }>('/api/me', { ...options(), fetchPolicy: 'cache-first' })
      return () => h('aside', result.pending.value ? 'pending' : result.data.value?.name)
    } })
    const root = defineComponent({ setup: () => () => h('div', [h(Page), laterVisible.value ? h(Later) : null]) })
    const definition = { id: 'credential-hydration', root }
    const rendered = await renderSsrApplication(definition, createTestRenderRequest('fetch.test', {
      headers: { authorization: 'Bearer USER_A_TOKEN' }, cookie: 'server-only=1',
    }))
    expect(rendered.html).toContain('User A')
    expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get('authorization')).toBe('Bearer USER_A_TOKEN')
    expect(JSON.stringify(rendered.hydrationState.plugins)).not.toMatch(/USER_A_TOKEN|server-only|fingerprint/)
    const stateId = getSsrStateElementId(definition.id)
    document.body.innerHTML = `<div id="app">${rendered.html}</div><script id="${stateId}"></script>`
    document.getElementById(stateId)!.textContent = JSON.stringify(rendered.hydrationState)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    browser = true
    await hydrateSsrApplication({ ...definition, install({ app: installed }) {
      app = installed
      runtime = app.runWithContext(() => inject(SSR_FETCH_RUNTIME)!)
    } })
    disposers.push(() => app.unmount())
    expect(document.querySelector('main')?.textContent).toBe('User A')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(done).not.toHaveBeenCalled()
    expect(warning.mock.calls.flat().join(' ')).not.toMatch(/mismatch/)
    expect(runtime.cache.entries.size).toBe(1)
    expect([...runtime.cache.entries.values()].every((entry) => !entry.hasData)).toBe(true)

    const response = deferred<Response>()
    fetcher.mockImplementation(() => response.promise)
    laterVisible.value = true
    await flush()
    expect(document.querySelector('aside')?.textContent).toBe('pending')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(new Headers(fetcher.mock.calls[1]![1]!.headers).get('authorization')).toBe('Bearer USER_B_TOKEN')
    response.resolve(jsonResponse({ name: 'User B' }))
    await flush()
    expect(document.querySelector('aside')?.textContent).toBe('User B')
    expect(done).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('restores SSR HTML with await=%s and uses normal policies on later mounts', async (awaited) => {
    const fetcher = vi.fn(async () => jsonResponse('SSR-products'))
    vi.stubGlobal('fetch', fetcher)
    const visible = ref(false)
    let app!: App
    let runtime!: SsrFetchRuntime
    const callback = vi.fn()
    const render = (result: UseFetchReturn<string>) => () => h('main', result.pending.value ? 'skeleton' : result.data.value)
    const Page = awaited ? defineComponent({ async setup() { return render(await useFetch<string>('/api/items', { onDone: callback })) } })
      : defineComponent({ setup() { return render(useFetch<string>('/api/items', { onDone: callback })) } })
    const Late = defineComponent({ setup() {
      const result = useFetch<string>('/api/items')
      return () => h('aside', result.pending.value ? 'late-pending' : result.data.value)
    } })
    const root = defineComponent({ setup: () => () => h('div', [
      h(Suspense, null, { default: () => h(Page) }), visible.value ? h(Late) : null,
    ]) })
    const definition = { id: 'hydrate-fetch', root }
    const rendered = await renderSsrApplication(definition, createTestRenderRequest('fetch.test'))
    const stateId = getSsrStateElementId(definition.id)
    document.body.innerHTML = `<div id="app">${rendered.html}</div><script id="${stateId}" type="application/json"></script>`
    document.getElementById(stateId)!.textContent = JSON.stringify(rendered.hydrationState)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await hydrateSsrApplication({ ...definition, install({ app: installed }) {
      app = installed
      runtime = app.runWithContext(() => inject(SSR_FETCH_RUNTIME)!)
    } })
    disposers.push(() => app.unmount())
    expect(document.querySelector('main')?.textContent).toBe('SSR-products')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(warning.mock.calls.flat().join(' ')).not.toMatch(/mismatch/)
    const late = deferred<Response>()
    fetcher.mockImplementation(() => late.promise)
    visible.value = true
    await flush()
    expect(document.querySelector('aside')?.textContent).toBe('late-pending')
    expect(fetcher).toHaveBeenCalledTimes(2)
    late.resolve(jsonResponse('later'))
    await flush()
    expect(runtime.cache.entries.size).toBe(1)
    expect(document.querySelector('aside')?.textContent).toBe('later')
  })

  it('waits for initial async setup descendants before clearing continuation records', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('child-data')))
    let app!: App
    const gate = deferred<void>()
    let browser = false
    const Child = defineComponent({ setup() {
      const result = useFetch<string>('/api/child')
      return () => h('p', result.data.value)
    } })
    const AsyncParent = defineComponent({ async setup() {
      if (browser) await gate.promise
      return () => h(Child)
    } })
    const root = defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(AsyncParent) }) })
    const definition = { id: 'async-hydration', root }
    const rendered = await renderSsrApplication(definition, createTestRenderRequest('fetch.test'))
    const stateId = getSsrStateElementId(definition.id)
    document.body.innerHTML = `<div id="app">${rendered.html}</div><script id="${stateId}"></script>`
    document.getElementById(stateId)!.textContent = JSON.stringify(rendered.hydrationState)
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    browser = true
    const hydration = hydrateSsrApplication({ ...definition, install({ app: installed }) {
      app = installed
      const mount = app.mount.bind(app)
      app.mount = (...args) => {
        const root = mount(...args)
        // Match production Vue, where the devtools instance is not retained.
        app._instance = null
        return root
      }
    } })
    await flush()
    gate.resolve()
    await hydration
    disposers.push(() => app.unmount())
    expect(document.querySelector('p')?.textContent).toBe('child-data')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('clears continuation on hydration failure and application teardown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('SSR')))
    const root = defineComponent({ setup() {
      const result = useFetch('/api/items')
      return () => h('p', String(result.data.value))
    } })
    const rendered = await renderSsrApplication({ id: 'failed-hydration', root }, createTestRenderRequest('fetch.test'))
    const stateId = getSsrStateElementId('failed-hydration')
    document.body.innerHTML = `<div id="app">${rendered.html}</div><script id="${stateId}"></script>`
    document.getElementById(stateId)!.textContent = JSON.stringify(rendered.hydrationState)
    let runtime!: SsrFetchRuntime
    await expect(hydrateSsrApplication({ id: 'failed-hydration', root, install({ app }) {
      runtime = app.runWithContext(() => inject(SSR_FETCH_RUNTIME)!)
      throw new Error('installation failed')
    } })).rejects.toThrow('installation failed')
    expect(runtime.cache.entries.size).toBe(0)
    expect(runtime.context.hydration.read('vue-ssr-lite:fetch')).toBeUndefined()
  })

  it('starts server:false immediately on ordinary browser mounts and aborts it on app.unmount', async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined))
    vi.stubGlobal('fetch', fetcher)
    let result!: UseFetchResult<string>
    let runtime!: SsrFetchRuntime
    const created = await mount(defineComponent({ setup() {
      runtime = inject(SSR_FETCH_RUNTIME)!
      result = useFetch<string>('/api/items', { server: false })
      // A sync watcher that refreshes during teardown must not resurrect work.
      watch(result.pending, (pending) => { if (!pending) void result.refresh() }, { flush: 'sync' })
      return () => h('main', result.pending.value ? 'pending' : 'settled')
    } }))
    expect(fetcher).toHaveBeenCalledTimes(1)
    created.app.unmount()
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    expect(result.pending.value).toBe(false)
    expect(runtime.consumers.size).toBe(0)
    expect(runtime.cache.entries.size).toBe(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('clears unconsumed continuation when an initial async setup rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('SSR')))
    const gate = deferred<void>()
    let browser = false
    let runtime!: SsrFetchRuntime
    let app!: App
    const Child = defineComponent({ setup() {
      const result = useFetch<string>('/api/items')
      return () => h('p', result.data.value)
    } })
    const AsyncParent = defineComponent({ async setup() {
      if (browser) await gate.promise
      return () => h(Child)
    } })
    const root = defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(AsyncParent) }) })
    const rendered = await renderSsrApplication({ id: 'async-failure', root }, createTestRenderRequest('fetch.test'))
    const stateId = getSsrStateElementId('async-failure')
    document.body.innerHTML = `<div id="app">${rendered.html}</div><script id="${stateId}"></script>`
    document.getElementById(stateId)!.textContent = JSON.stringify(rendered.hydrationState)
    browser = true
    const hydration = hydrateSsrApplication({ id: 'async-failure', root, install({ app: installed }) {
      app = installed
      app.config.errorHandler = () => undefined
      runtime = app.runWithContext(() => inject(SSR_FETCH_RUNTIME)!)
    } })
    // Attach the rejection assertion before releasing the failing setup gate.
    const failed = expect(hydration).rejects.toThrow('async setup failed')
    await flush()
    gate.reject(new Error('async setup failed'))
    await failed
    disposers.push(() => app.unmount())
    expect(runtime.context.hydration.read('vue-ssr-lite:fetch')).toBeUndefined()
    expect(runtime.cache.entries.size).toBe(0)
  })

  it('does not let a reentrant pending watcher start work for an obsolete identity', async () => {
    const first = deferred<Response>()
    const last = deferred<Response>()
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise)
    vi.stubGlobal('fetch', fetcher)
    const url = ref('/api/first')
    let result!: UseFetchResult<string>
    const done = vi.fn()
    await mount(defineComponent({ setup() {
      result = useFetch<string>(() => url.value, { onDone: done })
      watch(result.pending, (pending) => {
        if (pending && url.value === '/api/middle') url.value = '/api/last'
      }, { flush: 'sync' })
      return () => h('main', result.data.value)
    } }))
    first.resolve(jsonResponse('first'))
    await flush()
    url.value = '/api/middle'
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/first', '/api/last'])
    last.resolve(jsonResponse('last'))
    await flush()
    expect(result.data.value).toBe('last')
    expect(done).toHaveBeenCalledTimes(2)
  })

  it('ends enhanced RouterView navigation while an awaited hook still owns local network pending', async () => {
    const gate = deferred<Response>()
    const fetcher = vi.fn(() => gate.promise)
    vi.stubGlobal('fetch', fetcher)
    document.body.innerHTML = '<div id="app"></div>'
    let router!: NonNullable<Awaited<ReturnType<typeof createSsrApplication>>['router']>
    let result!: UseFetchReturn<string>
    const starts: number[] = []
    const settles: number[] = []
    const Page = defineComponent({ async setup() {
      result = await useFetch<string>('/api/items')
      return () => h('main', result.pending.value ? 'local-skeleton' : result.data.value)
    } })
    const mounted = await mountSpaApplication({
      id: 'fetch-navigation',
      root: defineComponent({ setup: () => () => h(RouterView, { delay: 0 }, { fallback: () => h('span', 'navigation-loading') }) }),
      routes: [
        { path: '/', component: { render: () => h('main', 'home') } },
        { path: '/products', component: Page },
      ],
      install({ app, router: installed }) {
        router = installed!
        const navigation = app.runWithContext(() => inject(SSR_NAVIGATION_RUNTIME)!)
        navigation.subscribe({ start: ({ id }) => starts.push(id), settle: (id) => settles.push(id) })
      },
    }, { domain: createTestDomain('fetch.test') })
    disposers.push(mounted.unmount)
    await router.push('/products')
    await flush()
    expect(document.querySelector('main')?.textContent).toBe('local-skeleton')
    expect(result.pending.value).toBe(true)
    expect(starts).toHaveLength(1)
    expect(settles).toEqual(starts)
    expect(document.body.textContent).not.toContain('navigation-loading')
    gate.resolve(jsonResponse('products'))
    await result.refresh()
    await flush()
    expect(document.querySelector('main')?.textContent).toBe('products')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

// These consumer examples are deliberately not invoked: they specify the
// compile-time contract without violating the synchronous setup requirement.
async function publicTypeContract() {
  interface Product { id: number; name: string }
  interface Variables { category: string; page?: number }
  const sync = useFetch<Product[]>('/api/items')
  const awaited = await useFetch<Product[]>('/api/items')
  expectTypeOf(sync.data).toEqualTypeOf<ShallowRef<Product[] | undefined>>()
  expectTypeOf(awaited.data).toEqualTypeOf<ShallowRef<Product[] | undefined>>()
  expectTypeOf(awaited.error).toEqualTypeOf<Readonly<ShallowRef<UseFetchError | null>>>()
  useFetch<Product[], Variables>('/api/items', {
    variables: { category: 'books', page: 2 },
    onDone(ctx) {
      expectTypeOf(ctx.data).toEqualTypeOf<Product[]>()
      expectTypeOf(ctx.variables).toEqualTypeOf<Readonly<Variables>>()
    },
  })
  // @ts-expect-error Required variables make the options argument mandatory.
  useFetch<Product[], Variables>('/api/items')
  // @ts-expect-error The required variables option cannot be omitted.
  useFetch<Product[], Variables>('/api/items', {})
  // @ts-expect-error Unknown variable properties are rejected.
  useFetch<Product[], Variables>('/api/items', { variables: { category: 'books', unknown: 1 } })
  // @ts-expect-error Variable property types are preserved.
  useFetch<Product[], Variables>('/api/items', { variables: { category: 42 } })
  // @ts-expect-error Nested variable values are outside v1.
  useFetch<unknown, { nested: { value: number } }>('/api/items', { variables: { nested: { value: 1 } } })
  useFetch<unknown, { optional?: number }>('/api/items')
  useFetch('/api/items', { variables: ref({ page: 2 }) })
  // @ts-expect-error Only data is writable.
  sync.pending.value = false
}
void publicTypeContract

// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://fetch.test/"}
import { defineComponent, h, nextTick } from 'vue'
import { RouterView, type Router } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSpaApplication } from '../../../SsrBrowserRuntime'
import { renderSsrApplication } from '../../../SsrRenderRuntime'
import type { SsrApplicationSetup } from '../../../SsrRuntimeTypes'
import {
  createTestDomain,
  createTestRenderRequest,
} from '../../../SsrTestFixtures'
import { setContext } from '../context/setContext'
import { useFetch } from '../composables/useFetch'
import type { UseFetchReturn } from '../types/SsrFetchTypes'
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
  for (let index = 0; index < 12; index += 1) await nextTick()
}

describe('setContext application ownership', () => {
  it('fails explicitly without an active application', () => {
    expect(() => setContext({})).toThrow(
      'setContext() requires an active vue-ssr-lite application.'
    )
  })

  it('resolves the owning runtime from component setup and nested composables', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      jsonResponse(new Headers(init?.headers).get('x-application'))
    )
    vi.stubGlobal('fetch', fetcher)
    const installContext = () => {
      setContext({ headers: { 'x-application': 'setup-context' } })
    }
    const root = defineComponent({
      setup() {
        installContext()
        const result = useFetch<string>('/api/profile')
        return () => h('main', result.data.value)
      },
    })

    const rendered = await renderSsrApplication(
      { id: 'context-component-setup', root },
      createTestRenderRequest('fetch.test')
    )
    expect(rendered.html).toContain('setup-context')
    expect(
      new Headers(fetcher.mock.calls[0]![1]?.headers).get('x-application')
    ).toBe('setup-context')
  })

  it('isolates overlapping SSR initializers across asynchronous work and hydration', async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    let initializerCount = 0
    const observedHeaders: string[] = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => {
      const authorization =
        new Headers(init?.headers).get('authorization') ?? 'missing'
      observedHeaders.push(authorization)
      return jsonResponse(
        authorization === 'Bearer secret-A' ? 'profile-a' : 'profile-b'
      )
    }))

    const root = defineComponent({
      setup() {
        const profile = useFetch<string>('/api/profile')
        return () => h('main', profile.data.value)
      },
    })
    const definition = {
      id: 'context-concurrency',
      root,
      async install({ context }: SsrApplicationSetup<
        Record<string, unknown>,
        unknown
      >) {
        initializerCount += 1
        if (initializerCount === 2) entered.resolve()
        await release.promise
        const value = context.request.headers['x-context-token']
        const token = typeof value === 'string' ? value : value?.[0]
        setContext({
          headers: { authorization: `Bearer ${token}` },
        })
      },
    }

    const leftPromise = renderSsrApplication(
      definition,
      createTestRenderRequest('fetch.test', {
        requestId: 'context-left',
        headers: { 'x-context-token': 'secret-A' },
      })
    )
    const rightPromise = renderSsrApplication(
      definition,
      createTestRenderRequest('fetch.test', {
        requestId: 'context-right',
        headers: { 'x-context-token': 'secret-B' },
      })
    )
    await entered.promise
    release.resolve()
    const [left, right] = await Promise.all([leftPromise, rightPromise])

    expect(left.html).toContain('profile-a')
    expect(right.html).toContain('profile-b')
    expect(observedHeaders.sort()).toEqual([
      'Bearer secret-A',
      'Bearer secret-B',
    ])
    expect(JSON.stringify([left.hydrationState, right.hydrationState])).not.toMatch(
      /secret-A|secret-B/
    )
  })

  it('persists through browser navigation, supports later auth actions, and clears on disposal', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      jsonResponse(
        new Headers(init?.headers).get('authorization') ?? 'anonymous'
      )
    )
    vi.stubGlobal('fetch', fetcher)
    document.body.innerHTML = '<div id="app"></div>'

    let router!: Router
    const results: Record<string, UseFetchReturn<string>> = {}
    const page = (name: string) => defineComponent({
      setup() {
        const result = useFetch<string>(`/api/${name}`)
        results[name] = result
        return () => h('main', result.data.value)
      },
    })
    const mounted = await mountSpaApplication(
      {
        id: 'context-browser-lifecycle',
        root: defineComponent({ render: () => h(RouterView) }),
        routes: [
          { path: '/', component: page('first') },
          { path: '/second', component: page('second') },
        ],
        async install({ router: installed }) {
          router = installed!
          await Promise.resolve()
          setContext({
            headers: { authorization: 'Bearer browser-A' },
          })
        },
      },
      { domain: createTestDomain('fetch.test') }
    )
    disposers.push(mounted.unmount)
    await flush()
    expect(
      new Headers(fetcher.mock.calls[0]![1]?.headers).get('authorization')
    ).toBe('Bearer browser-A')

    await router.push('/second')
    await flush()
    expect(
      new Headers(fetcher.mock.calls[1]![1]?.headers).get('authorization')
    ).toBe('Bearer browser-A')

    setContext({
      headers: { authorization: 'Bearer browser-B' },
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await results.second!.refresh()
    expect(
      new Headers(fetcher.mock.calls[2]![1]?.headers).get('authorization')
    ).toBe('Bearer browser-B')

    mounted.unmount()
    expect(() => setContext({ headers: {} })).toThrow(/active vue-ssr-lite/)

    document.body.innerHTML = '<div id="app"></div>'
    let fresh!: UseFetchReturn<string>
    const replacement = await mountSpaApplication(
      {
        id: 'context-browser-replacement',
        root: defineComponent({
          setup() {
            fresh = useFetch<string>('/api/fresh')
            return () => h('main', fresh.data.value)
          },
        }),
      },
      { domain: createTestDomain('fetch.test') }
    )
    disposers.push(replacement.unmount)
    await flush()
    expect(
      new Headers(fetcher.mock.calls[3]![1]?.headers).has('authorization')
    ).toBe(false)
    expect(fresh.data.value).toBe('anonymous')
  })
})

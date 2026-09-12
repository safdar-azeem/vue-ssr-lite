// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://capability.test/"}
import { defineComponent, h, inject, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hydrateSsrApplication, mountSpaApplication } from './SsrBrowserRuntime'
import { createTestDomain, createTestRenderRequest } from './SsrTestFixtures'
import { renderSsrApplication } from './SsrRenderRuntime'
import { getSsrStateElementId } from './SsrSerialization'
import { FETCH_HYDRATION_KEY, SSR_FETCH_OWNER, type SsrFetchOwner } from './data/fetch/runtime/SsrFetchRuntimeScope'
import { useFetch } from './data/fetch/composables/useFetch'
import { setContext } from './data/fetch/context/setContext'
import { defineExtension } from './core/extensions/defineExtension'
import { useSeo } from './extensions/seo/useSeo'

const dispose: Array<() => void> = []
afterEach(() => {
  for (const cleanup of dispose.splice(0).reverse()) cleanup()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
const domain = createTestDomain('capability.test')
const options = { domain, url: 'https://capability.test/' }
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => { resolve = complete })
  return { promise, resolve }
}
const browserRoot = (label: string) =>
  defineComponent({ setup: () => () => h('main', label) })
const browserDefinition = (
  id: string,
  install?: NonNullable<Parameters<typeof mountSpaApplication>[0]['install']>
) => ({ id, seo: { enabled: false } as const, root: browserRoot(id), install })

describe('application-owned browser capabilities', () => {
  it('provides ownership before plugins and keeps unused fetch execution absent through mount and disposal', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    let owner!: SsrFetchOwner
    const mounted = await mountSpaApplication({
      id: 'minimal', seo: { enabled: false }, root: defineComponent({ setup: () => () => h('main') }),
      plugins: [{ install(app) { owner = app.runWithContext(() => inject(SSR_FETCH_OWNER)!) } }],
      install() { expect(owner.runtime).toBeUndefined() },
    }, options)
    expect(owner.runtime).toBeUndefined()
    mounted.unmount()
    expect(owner.disposed).toBe(true)
    expect(owner.runtime).toBeUndefined()
  })

  it('rejects a second initializing application before its initializer and preserves async setContext ownership', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    const entered = deferred()
    const resume = deferred()
    let owner!: SsrFetchOwner
    const secondPlugin = vi.fn()
    const secondInstall = vi.fn()
    const firstPromise = mountSpaApplication(browserDefinition('initializing-owner', async () => {
      owner = inject(SSR_FETCH_OWNER)!
      entered.resolve()
      await resume.promise
      setContext({ headers: { 'x-owner': 'initializing-owner' } })
    }), options)

    await entered.promise
    await expect(mountSpaApplication({
      ...browserDefinition('rejected-initializer', secondInstall),
      plugins: [{ install: secondPlugin }],
    }, options)).rejects.toThrow('already owns this browser document')
    expect(secondPlugin).not.toHaveBeenCalled()
    expect(secondInstall).not.toHaveBeenCalled()

    resume.resolve()
    const mounted = await firstPromise
    dispose.push(mounted.unmount)
    expect(owner.runtime?.getContextSnapshot().get('x-owner'))
      .toBe('initializing-owner')
  })

  it('rejects a second application while the first is mounted', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    const first = await mountSpaApplication(browserDefinition('mounted-owner'), options)
    dispose.push(first.unmount)
    const secondInstall = vi.fn()
    await expect(mountSpaApplication(
      browserDefinition('mounted-rejected', secondInstall), options
    )).rejects.toThrow('already owns this browser document')
    expect(secondInstall).not.toHaveBeenCalled()

    const stateId = getSsrStateElementId('rejected-hydration')
    document.body.insertAdjacentHTML(
      'beforeend',
      `<script id="${stateId}">{invalid hydration state</script>`
    )
    await expect(hydrateSsrApplication(
      browserDefinition('rejected-hydration')
    )).rejects.toThrow('already owns this browser document')
    expect(document.getElementById(stateId)?.textContent)
      .toBe('{invalid hydration state')
  })

  it('releases document ownership when initialization fails', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    await expect(mountSpaApplication(browserDefinition('failed-initializer', () => {
      throw new Error('initializer failure')
    }), options)).rejects.toThrow('initializer failure')

    const replacement = await mountSpaApplication(
      browserDefinition('after-initializer-failure'), options
    )
    dispose.push(replacement.unmount)
  })

  it('releases document ownership when SPA component mounting fails', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    await expect(mountSpaApplication({
      ...browserDefinition('failed-spa-mount'),
      root: defineComponent({ setup() { throw new Error('SPA mount failure') } }),
    }, options)).rejects.toThrow('SPA mount failure')

    document.body.innerHTML = '<div id="app"></div>'
    const replacement = await mountSpaApplication(
      browserDefinition('after-spa-mount-failure'), options
    )
    dispose.push(replacement.unmount)
  })

  it('releases document ownership on unmount', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    const first = await mountSpaApplication(browserDefinition('before-unmount'), options)
    first.unmount()
    document.body.innerHTML = '<div id="app"></div>'
    const replacement = await mountSpaApplication(browserDefinition('after-unmount'), options)
    dispose.push(replacement.unmount)
  })

  it('releases document ownership when hydration fails', async () => {
    const serverDefinition = browserDefinition('failed-hydration')
    const rendered = await renderSsrApplication(
      serverDefinition,
      createTestRenderRequest('capability.test')
    )
    const stateId = getSsrStateElementId(serverDefinition.id)
    document.body.innerHTML = `<div id="app">${rendered.html}</div><script id="${stateId}"></script>`
    document.getElementById(stateId)!.textContent = JSON.stringify(rendered.hydrationState)

    await expect(hydrateSsrApplication({
      ...serverDefinition,
      root: defineComponent({ setup() { throw new Error('hydration failure') } }),
    })).rejects.toThrow('hydration failure')

    document.body.innerHTML = '<div id="app"></div>'
    const replacement = await mountSpaApplication(
      browserDefinition('after-hydration-failure'), options
    )
    dispose.push(replacement.unmount)
  })

  it('does not let stale cleanup release a newer document owner', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    const first = await mountSpaApplication(browserDefinition('shared-owner'), options)
    const staleCleanup = first.unmount
    staleCleanup()

    document.body.innerHTML = '<div id="app"></div>'
    const current = await mountSpaApplication(browserDefinition('shared-owner'), options)
    const readyKey = Symbol.for('vue-ssr-lite:client-ready:shared-owner')
    const readyMarker = Promise.resolve()
    const documentState = document as unknown as Record<PropertyKey, unknown>
    documentState[readyKey] = readyMarker
    staleCleanup()
    expect(documentState[readyKey]).toBe(readyMarker)
    await expect(mountSpaApplication(
      browserDefinition('must-remain-rejected'), options
    )).rejects.toThrow('application "shared-owner" already owns this browser document')
    current.unmount()
    expect(documentState[readyKey]).toBeUndefined()
  })

  it('activates fetch during first component setup and reuses SSR data without a browser request', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify('restored'), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)
    const definition = {
      id: 'lazy-fetch-hydration', seo: { enabled: false },
      root: defineComponent({ setup() {
        const result = useFetch<string>('/api/capability')
        return () => h('main', result.data.value ?? 'pending')
      } }),
    }
    const rendered = await renderSsrApplication(definition, createTestRenderRequest('capability.test'))
    expect(fetcher).toHaveBeenCalledTimes(1)
    const stateId = getSsrStateElementId(definition.id)
    document.body.innerHTML = `<div id="app">${rendered.html}</div><script id="${stateId}"></script>`
    document.getElementById(stateId)!.textContent = JSON.stringify(rendered.hydrationState)
    let owner!: SsrFetchOwner
    await hydrateSsrApplication({ ...definition, install({ app }) {
      dispose.push(() => app.unmount())
      owner = inject(SSR_FETCH_OWNER)!
      expect(owner.runtime).toBeUndefined()
    } })
    expect(document.querySelector('main')?.textContent).toBe('restored')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(owner.runtime).toBeDefined()
    expect(owner.hydrating).toBe(false)
  })

  it('forgets unused fetch continuation at hydration completion without constructing execution', async () => {
    const definition = { id: 'unused-fetch', seo: { enabled: false }, root: defineComponent({ setup: () => () => h('main', 'minimal') }) }
    const rendered = await renderSsrApplication(definition, createTestRenderRequest('capability.test'))
    const stateId = getSsrStateElementId(definition.id)
    document.body.innerHTML = `<div id="app">${rendered.html}</div><script id="${stateId}"></script>`
    document.getElementById(stateId)!.textContent = JSON.stringify({
      ...rendered.hydrationState,
      plugins: { [FETCH_HYDRATION_KEY]: { orphan: { state: { data: 'unused', pending: false, error: null } } }, thirdParty: { keep: true } },
    })
    let owner!: SsrFetchOwner
    await hydrateSsrApplication({ ...definition, install({ app }) {
      dispose.push(() => app.unmount())
      owner = inject(SSR_FETCH_OWNER)!
      expect(owner.hydration.read(FETCH_HYDRATION_KEY)).toBeDefined()
    } })
    expect(owner.runtime).toBeUndefined()
    expect(owner.hydration.read(FETCH_HYDRATION_KEY)).toBeUndefined()
    expect(owner.hydration.read('thirdParty')).toEqual({ keep: true })
  })

  it('can activate fetch for the first time after hydration/mount completion', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    const show = ref(false)
    let owner!: SsrFetchOwner
    const fetcher = vi.fn(async () => new Response(JSON.stringify('late'), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)
    const Page = defineComponent({ setup() {
      useFetch('/api/late', { server: false })
      return () => h('aside', 'late page')
    } })
    const mounted = await mountSpaApplication({
      id: 'late', seo: { enabled: false },
      root: defineComponent({ setup: () => () => show.value ? h(Page) : h('main') }),
      install() { owner = inject(SSR_FETCH_OWNER)! },
    }, options)
    dispose.push(mounted.unmount)
    expect(owner.runtime).toBeUndefined()
    show.value = true
    await nextTick()
    expect(owner.runtime).toBeDefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('finishes required extension and SEO setup before the first component', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    const events: string[] = []
    const mounted = await mountSpaApplication({
      id: 'extensions', seo: { siteUrl: 'https://capability.test', titleTemplate: '%s | Site' },
      extensions: [defineExtension({ name: 'custom', setup() { events.push('extension') } })],
      install() { events.push('main') },
      root: defineComponent({ setup() {
        events.push('component')
        useSeo({ title: 'Ready' })
        return () => h('main')
      } }),
    }, options)
    dispose.push(mounted.unmount)
    expect(events).toEqual(['main', 'extension', 'component'])
    expect(document.title).toBe('Ready | Site')
  })
})

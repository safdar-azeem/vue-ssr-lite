// @vitest-environment jsdom
import {
  createSSRApp, defineAsyncComponent, defineComponent, h, nextTick, Suspense, Teleport,
  type App, type Component, type VNode,
} from 'vue'
import { renderToString } from 'vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { completeSsrBrowserHydration, createSsrHydrationController } from '../SsrHydrationRuntime'

// Exercise the actual installed renderer. Run this suite manually against the
// minimum and latest supported Vue 3.5.x releases; mocks of renderer internals
// cannot establish compatibility.
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})
const deferred = () => {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
const flush = async () => { for (let index = 0; index < 12; index++) await nextTick() }
const mount = (root: Component, html: string) => {
  document.body.innerHTML = `<div id="app">${html}</div><div id="teleported"></div>`
  const app = createSSRApp(root)
  app.config.errorHandler = vi.fn()
  const hydration = createSsrHydrationController({ continuation: 'initial' }, false)
  const completed = vi.fn(() => hydration.forget('continuation'))
  const disposed = vi.fn(() => hydration.forget('continuation'))
  hydration.onHydrated(completed)
  hydration.onDispose(disposed)
  cleanup.push(() => { hydration.dispose(); app.unmount() })
  app.mount('#app')
  return { app, hydration, completed, disposed }
}
const rootVNode = (app: App) => (app._container as unknown as { _vnode: VNode })._vnode

describe('Vue 3.5 renderer hydration compatibility', () => {
  it.each(['stateful', 'functional'] as const)('completes a %s root without the devtools app instance', async (kind) => {
    const render = () => h('main', 'SSR content')
    const root = kind === 'functional' ? render : defineComponent({ setup: () => render })
    const mounted = mount(root, await renderToString(createSSRApp(root)))
    mounted.app._instance = null // Vue production does not retain this devtools field.
    await completeSsrBrowserHydration(mounted.app, mounted.hydration)
    expect(document.querySelector('main')?.textContent).toBe('SSR content')
    expect(mounted.completed).toHaveBeenCalledTimes(1)
    expect(mounted.disposed).not.toHaveBeenCalled()
  })

  it('waits for newly discovered async descendants across nested Suspense boundaries', async () => {
    const parent = deferred()
    const child = deferred()
    let browser = false
    const childSetup = vi.fn()
    const Child = defineComponent({ async setup() {
      if (browser) { childSetup(); await child.promise }
      return () => h('main', 'nested SSR')
    } })
    const Parent = defineComponent({ async setup() {
      if (browser) await parent.promise
      return () => h(Suspense, null, { default: () => h(Child) })
    } })
    const root = defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(Parent) }) })
    const html = await renderToString(createSSRApp(root))
    browser = true
    const mounted = mount(root, html)
    const completion = completeSsrBrowserHydration(mounted.app, mounted.hydration)
    await flush()
    expect(childSetup).not.toHaveBeenCalled()
    expect(mounted.completed).not.toHaveBeenCalled()
    parent.resolve()
    await flush()
    expect(childSetup).toHaveBeenCalledTimes(1)
    expect(mounted.hydration.read('continuation')).toBe('initial')
    expect(mounted.completed).not.toHaveBeenCalled()
    child.resolve()
    await completion
    expect(document.querySelector('main')?.textContent).toBe('nested SSR')
    expect(mounted.completed).toHaveBeenCalledTimes(1)
    expect(mounted.hydration.read('continuation')).toBeUndefined()
  })

  it('waits for an async component loader outside Suspense and then its async descendants', async () => {
    const loader = deferred()
    const setup = deferred()
    const Child = defineComponent({ async setup() {
      await setup.promise
      return () => h('main', 'loaded SSR')
    } })
    const Loaded = defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(Child) }) })
    // A fresh browser wrapper avoids warming __asyncResolved by the SSR render.
    const load = vi.fn(async () => { await loader.promise; return Loaded })
    const Async = defineAsyncComponent(load)
    const root = defineComponent({ setup: () => () => h(Async) })
    const mounted = mount(root, '<main>loaded SSR</main>')
    const completion = completeSsrBrowserHydration(mounted.app, mounted.hydration)
    await flush()
    expect(load).toHaveBeenCalledTimes(1)
    expect(mounted.completed).not.toHaveBeenCalled()
    loader.resolve()
    await flush()
    expect(mounted.completed).not.toHaveBeenCalled()
    setup.resolve()
    await completion
    expect(load).toHaveBeenCalledTimes(1)
    expect(document.querySelector('main')?.textContent).toBe('loaded SSR')
    expect(mounted.completed).toHaveBeenCalledTimes(1)
  })

  it('discovers async content in a hydrated Teleport target', async () => {
    const gate = deferred()
    let browser = false
    const Child = defineComponent({ async setup() {
      if (browser) await gate.promise
      return () => h('p', 'teleported SSR')
    } })
    const root = defineComponent({ setup: () => () => h(Teleport, { to: '#teleported' }, [
      h(Suspense, null, { default: () => h(Child) }),
    ]) })
    const context: { teleports?: Record<string, string> } = {}
    const html = await renderToString(createSSRApp(root), context)
    document.body.innerHTML = `<div id="app">${html}</div><div id="teleported">${context.teleports!['#teleported']}</div>`
    browser = true
    const app = createSSRApp(root)
    const hydration = createSsrHydrationController(undefined, false)
    const completed = vi.fn()
    hydration.onHydrated(completed)
    cleanup.push(() => { hydration.dispose(); app.unmount() })
    app.mount('#app')
    const completion = completeSsrBrowserHydration(app, hydration)
    await flush()
    expect(completed).not.toHaveBeenCalled()
    gate.resolve()
    await completion
    expect(document.querySelector('#teleported p')?.textContent).toBe('teleported SSR')
    expect(completed).toHaveBeenCalledTimes(1)
  })

  it('does not traverse unused raw component slot input as mounted children', async () => {
    const Unused = defineComponent({ setup() { throw new Error('unused slot mounted') } })
    const Parent = defineComponent({ setup: () => () => h('main', 'no slot') })
    const root = defineComponent({ setup: () => () => h(Parent, null, [h(Unused)]) })
    const mounted = mount(root, await renderToString(createSSRApp(root)))
    await completeSsrBrowserHydration(mounted.app, mounted.hydration)
    expect(mounted.completed).toHaveBeenCalledTimes(1)
  })

  it.each(['reject', 'dispose'] as const)('never announces completion when async hydration must %s', async (action) => {
    const gate = deferred()
    const Child = defineComponent({ async setup() {
      await gate.promise
      return () => h('main', 'SSR')
    } })
    const root = defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(Child) }) })
    const mounted = mount(root, '<main>SSR</main>')
    const completion = completeSsrBrowserHydration(mounted.app, mounted.hydration)
    if (action === 'reject') {
      const rejected = expect(completion).rejects.toThrow('setup rejected')
      gate.reject(new Error('setup rejected'))
      await rejected
    } else {
      mounted.hydration.dispose()
      await completion // Disposal must interrupt a setup promise that has not settled.
      gate.resolve()
      await flush()
    }
    expect(mounted.completed).not.toHaveBeenCalled()
    expect(mounted.disposed).toHaveBeenCalledTimes(1)
    expect(mounted.hydration.read('continuation')).toBeUndefined()
  })

  it.each(['version', 'container', 'root', 'asyncDep', 'subTree', 'suspense'] as const)(
    'fails closed when the expected renderer %s structure is absent', async (missing) => {
      const root = defineComponent({ setup: () => () => h(Suspense, null, { default: () => h('main', 'SSR') }) })
      const mounted = mount(root, await renderToString(createSSRApp(root)))
      const vnode = rootVNode(mounted.app)
      let target: object
      let key: string
      switch (missing) {
        case 'version': target = mounted.app; key = 'version'; break
        case 'container': target = mounted.app; key = '_container'; break
        case 'root': target = mounted.app._container!; key = '_vnode'; break
        case 'asyncDep': target = vnode.component!; key = 'asyncDep'; break
        case 'subTree': target = vnode.component!; key = 'subTree'; break
        case 'suspense': target = vnode.component!.subTree.suspense!; key = 'activeBranch'; break
      }
      const original = Object.getOwnPropertyDescriptor(target, key)!
      if (missing === 'version') Object.defineProperty(target, key, { ...original, value: '3.6.0' })
      else Reflect.deleteProperty(target, key)
      try {
        await expect(completeSsrBrowserHydration(mounted.app, mounted.hydration)).rejects.toThrow(/cannot establish hydration completion/)
        expect(mounted.completed).not.toHaveBeenCalled()
        expect(mounted.disposed).toHaveBeenCalledTimes(1)
        expect(mounted.hydration.read('continuation')).toBeUndefined()
      } finally {
        Object.defineProperty(target, key, original)
      }
    }
  )
})

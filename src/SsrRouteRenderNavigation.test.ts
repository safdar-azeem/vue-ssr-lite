// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { installCrossRenderNavigation } from './SsrRouteRenderRuntime'

const Page = defineComponent({ setup: () => () => h('div') })

const routes = [
  { path: '/', component: Page, meta: { render: 'ssr' } },
  { path: '/about', component: Page, meta: { render: 'ssr' } },
  { path: '/app', component: Page, meta: { render: 'spa' } },
  { path: '/app/projects', component: Page, meta: { render: 'spa' } },
  { path: '/gone', redirect: '/app' },
  { path: '/go-app', redirect: '/app/projects' },
  { path: '/app/go-public', redirect: '/about' },
]

describe('cross-render history navigation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const stubLocation = () => {
    const assign = vi.fn()
    const replace = vi.fn()
    vi.stubGlobal('location', {
      assign,
      replace,
      href: 'http://localhost/',
    })
    return { assign, replace }
  }

  it('uses assign for RouterLink/push crossings and replace for replace() crossings', async () => {
    const { assign, replace } = stubLocation()
    const router = createRouter({ history: createMemoryHistory(), routes })
    installCrossRenderNavigation(router, 'ssr')
    await router.push('/')
    await router.isReady()
    await router.push('/app')
    expect(assign).toHaveBeenCalledWith('/app')
    expect(replace).not.toHaveBeenCalled()
    assign.mockClear()
    await router.replace('/app')
    expect(replace).toHaveBeenCalledWith('/app')
    expect(assign).not.toHaveBeenCalled()
  })

  it('does not leave a stale replace intent for a later push crossing', async () => {
    const { assign, replace } = stubLocation()
    const router = createRouter({ history: createMemoryHistory(), routes })
    installCrossRenderNavigation(router, 'ssr')
    await router.push('/')
    await router.isReady()
    await router.replace('/about')
    expect(replace).not.toHaveBeenCalled()
    await router.push('/app')
    expect(assign).toHaveBeenCalledWith('/app')
    expect(replace).not.toHaveBeenCalled()
  })

  it('uses replace for redirected crossings so history is not duplicated', async () => {
    const { assign, replace } = stubLocation()
    const router = createRouter({ history: createMemoryHistory(), routes })
    installCrossRenderNavigation(router, 'ssr')
    await router.push('/')
    await router.isReady()
    await router.push('/gone')
    expect(replace).toHaveBeenCalledWith('/app')
    expect(assign).not.toHaveBeenCalled()
  })

  it('follows SSR-to-SPA and SPA-to-SSR redirects into the destination render mode', async () => {
    const fromSsr = stubLocation()
    const ssrRouter = createRouter({ history: createMemoryHistory(), routes })
    installCrossRenderNavigation(ssrRouter, 'ssr')
    await ssrRouter.push('/')
    await ssrRouter.isReady()
    await ssrRouter.push('/go-app')
    expect(fromSsr.replace).toHaveBeenCalledWith('/app/projects')
    expect(fromSsr.assign).not.toHaveBeenCalled()

    const fromSpa = stubLocation()
    const spaRouter = createRouter({ history: createMemoryHistory(), routes })
    installCrossRenderNavigation(spaRouter, 'ssr')
    await spaRouter.push('/app/projects')
    await spaRouter.isReady()
    await spaRouter.push('/app/go-public')
    expect(fromSpa.replace).toHaveBeenCalledWith('/about')
    expect(fromSpa.assign).not.toHaveBeenCalled()
  })

  it('uses replace for browser Back/Forward so history is not duplicated', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes })
    await router.push('/')
    await router.push('/app')
    await router.isReady()
    const { assign, replace } = stubLocation()
    installCrossRenderNavigation(router, 'ssr')
    const finished = new Promise<void>((resolveDone) => {
      const stop = router.afterEach(() => {
        stop()
        resolveDone()
      })
    })
    router.back()
    await Promise.race([
      finished,
      new Promise((resolveWait) => setTimeout(resolveWait, 50)),
    ])
    expect(replace).toHaveBeenCalledWith('/')
    expect(assign).not.toHaveBeenCalled()
  })

  it('listens to popstate in the capture phase', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const router = createRouter({ history: createMemoryHistory(), routes })
    installCrossRenderNavigation(router, 'ssr')
    expect(add).toHaveBeenCalledWith('popstate', expect.any(Function), true)
  })
})

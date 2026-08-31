// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { createRouter, RouterView, type RouteRecordRaw } from 'vue-router'
import { createSsrApplication } from '../SsrApplicationRuntime'
import { mountSpaApplication } from '../SsrBrowserRuntime'
import {
  createTestApplication,
  createTestDomain,
  createTestRenderRequest,
} from '../SsrTestFixtures'
import { defineMiddleware } from './defineMiddleware'

const Page = defineComponent({ setup: () => () => h('main') })

describe('browser middleware navigation', () => {
  let dispose: (() => void) | undefined

  afterEach(() => {
    dispose?.()
    dispose = undefined
    window.history.replaceState({}, '', '/')
  })

  const create = async (routes: RouteRecordRaw[]) => {
    const controller = new AbortController()
    const created = await createSsrApplication(
      createTestApplication({
        id: 'browser-middleware',
        root: Page,
        router: ({ history }) => createRouter({ history, routes }),
      }),
      {
        server: false,
        spa: true,
        request: createTestRenderRequest('localhost', {
          url: 'http://localhost/',
          protocol: 'http',
          signal: controller.signal,
        }),
      }
    )
    dispose = () => {
      controller.abort()
      created.hydration.dispose()
    }
    await created.router!.isReady()
    return created.router!
  }

  it('uses Vue Router redirects and cancellation semantics', async () => {
    const redirect = defineMiddleware(() => '/login')
    const cancel = defineMiddleware(() => false)
    const router = await create([
      { path: '/', component: Page },
      { path: '/private', component: Page, meta: { middleware: [redirect] } },
      { path: '/blocked', component: Page, meta: { middleware: [cancel] } },
      { path: '/login', component: Page },
    ])

    await router.push('/private')
    expect(router.currentRoute.value.fullPath).toBe('/login')
    await router.push('/')
    await router.push('/blocked')
    expect(router.currentRoute.value.fullPath).toBe('/')
  })

  it('reports an unmatched previous URL instead of treating it as initial navigation', async () => {
    let previous: string | null | undefined
    const inspectPrevious = defineMiddleware(({ from }) => {
      previous = from?.fullPath ?? null
    })
    const router = await create([
      { path: '/', component: Page },
      {
        path: '/target',
        component: Page,
        meta: { middleware: [inspectPrevious] },
      },
    ])

    await router.push('/unmatched')
    await router.push('/target')
    expect(previous).toBe('/unmatched')
  })

  it('settles an initially cancelled SPA navigation without rendering its page', async () => {
    let setups = 0
    const cancel = defineMiddleware(() => false)
    window.history.replaceState({}, '', '/blocked')
    const mount = document.createElement('div')
    mount.id = 'middleware-app'
    document.body.append(mount)
    const mounted = await mountSpaApplication(
      {
        id: 'initial-cancel',
        root: defineComponent({ setup: () => () => h(RouterView) }),
        routes: [
          {
            path: '/blocked',
            component: defineComponent({
              setup() {
                setups += 1
                return () => h('main', 'blocked')
              },
            }),
            meta: { middleware: [cancel] },
          },
        ],
      },
      {
        mountSelector: '#middleware-app',
        url: '/blocked',
        domain: createTestDomain('localhost', { protocol: 'http' }),
        publicConfig: {},
      }
    )
    dispose = () => {
      mounted.unmount()
      mount.remove()
    }
    expect(setups).toBe(0)
    expect(mount.textContent).toBe('')
  })

  it('settles a cancelled target reached through an initial redirect without replaying middleware', async () => {
    let redirectRuns = 0
    let cancelRuns = 0
    const redirect = defineMiddleware(() => {
      redirectRuns += 1
      return '/blocked'
    })
    const cancel = defineMiddleware(() => {
      cancelRuns += 1
      return false
    })
    window.history.replaceState({}, '', '/private')
    const mount = document.createElement('div')
    mount.id = 'middleware-redirect-cancel-app'
    document.body.append(mount)
    const mounted = await mountSpaApplication(
      {
        id: 'initial-redirect-cancel',
        root: defineComponent({ setup: () => () => h(RouterView) }),
        routes: [
          { path: '/private', component: Page, meta: { middleware: [redirect] } },
          { path: '/blocked', component: Page, meta: { middleware: [cancel] } },
        ],
      },
      {
        mountSelector: '#middleware-redirect-cancel-app',
        url: '/private',
        domain: createTestDomain('localhost', { protocol: 'http' }),
        publicConfig: {},
      }
    )
    dispose = () => {
      mounted.unmount()
      mount.remove()
    }
    expect(redirectRuns).toBe(1)
    expect(cancelRuns).toBe(1)
    expect(mount.textContent).toBe('')
  })

  it('runs parent middleware for nested targets and clears stale route props', async () => {
    let marker: string | undefined = 'first'
    const middleware = defineMiddleware(() =>
      marker === undefined ? undefined : { props: { marker } }
    )
    const router = await create([
      { path: '/', component: Page },
      {
        path: '/parent',
        component: Page,
        props: { existing: 'route' },
        meta: { middleware: [middleware] },
        children: [{ path: 'child', component: Page }],
      },
    ])

    await router.push('/parent/child')
    const record = router.currentRoute.value.matched[0]!
    expect((record.props.default as Function)(router.currentRoute.value)).toEqual({
      existing: 'route',
      marker: 'first',
    })
    await router.push('/')
    marker = undefined
    await router.push('/parent/child')
    expect(record.props.default).toEqual({ existing: 'route' })
  })
})

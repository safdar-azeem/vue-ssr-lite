// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defineComponent,
  h,
  nextTick,
  onUnmounted,
  type App,
} from 'vue'
import {
  createRouter,
  RouterLink,
  RouterView,
  type RouteRecordRaw,
  type Router,
} from 'vue-router'
import { createSsrApplication } from '../SsrApplicationRuntime'
import {
  hydrateSsrApplication,
  mountSpaApplication,
} from '../SsrBrowserRuntime'
import { LoadingIndicator } from '../navigation/LoadingIndicator'
import { RouteSuspense } from '../navigation/RouteSuspense'
import { renderSsrApplication } from '../SsrRenderRuntime'
import { getSsrStateElementId } from '../SsrSerialization'
import {
  createTestApplication,
  createTestDomain,
  createTestRenderRequest,
} from '../SsrTestFixtures'
import { defineMiddleware } from './defineMiddleware'

const Page = defineComponent({ setup: () => () => h('main') })

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

const waitForVisualLoading = async (delay = 0) => {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise<void>((resolve) => window.setTimeout(resolve, delay))
  await nextTick()
}

describe('browser middleware navigation', () => {
  let dispose: (() => void) | undefined

  afterEach(() => {
    dispose?.()
    dispose = undefined
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.cookie = 'single_session=; Path=/; Max-Age=0; SameSite=Lax'
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

  const verifyHydratedRouterLinkLoading = async (options: {
    id: string
    authenticated: boolean
  }) => {
    const gate = deferred()
    let middlewareStarted = false
    let observedSession: string | undefined
    let browserApp: App | undefined
    let browserRouter: Router | undefined
    let browserHydration: { dispose(): void } | undefined

    const middleware = defineMiddleware(async (context) => {
      middlewareStarted = true
      if (options.authenticated) {
        observedSession = context.cookies.get('single_session')
      }
      await gate.promise
      if (options.authenticated && observedSession !== 'yes') return '/login'
    })
    const Home = defineComponent({
      setup: () => () => h('article', { class: 'home-page' }, 'Home page'),
    })
    const Dashboard = defineComponent({
      setup: () => () =>
        h('article', { class: 'dashboard-page' }, 'Dashboard page'),
    })
    const Login = defineComponent({
      setup: () => () => h('article', { class: 'login-page' }, 'Login page'),
    })
    const Root = defineComponent({
      setup: () => () =>
        h('div', { class: 'application-layout' }, [
          h(LoadingIndicator, { delay: 10 }),
          h('aside', { class: 'persistent-sidebar' }, 'Sidebar'),
          h('header', { class: 'persistent-header' }, [
            h(
              RouterLink,
              { to: '/dashboard', class: 'dashboard-link' },
              { default: () => 'Dashboard' }
            ),
          ]),
          h(
            'main',
            { class: 'route-content' },
            h(
              RouteSuspense,
              { delay: 10 },
              {
                default: () => h(RouterView),
                fallback: () =>
                  h('div', { class: 'page-loader' }, 'Loading page'),
              }
            )
          ),
        ]),
    })
    const definition = createTestApplication({
      id: options.id,
      root: Root,
      defaultRender: 'ssr',
      routes: [
        { path: '/', component: Home },
        {
          path: '/dashboard',
          component: Dashboard,
          meta: { middleware: [middleware] },
        },
        { path: '/login', component: Login },
      ],
      install({ app, router, hydration, server }) {
        if (server) return
        browserApp = app
        browserRouter = router ?? undefined
        browserHydration = hydration
      },
    })
    const request = createTestRenderRequest('localhost', {
      url: 'http://localhost/',
      protocol: 'http',
      domain: createTestDomain('localhost', { protocol: 'http' }),
    })
    const rendered = await renderSsrApplication(definition, request)
    expect(rendered.html).toContain('Home page')
    expect(rendered.html).not.toContain('Loading page')
    expect(rendered.html).not.toContain('vssl-loading-indicator')

    document.body.innerHTML = `<div id="app">${rendered.html}</div>`
    const state = document.createElement('script')
    state.id = getSsrStateElementId(options.id)
    state.type = 'application/json'
    state.textContent = JSON.stringify(rendered.hydrationState)
    document.body.append(state)
    window.history.replaceState({}, '', '/')
    if (options.authenticated) {
      document.cookie = 'single_session=yes; Path=/; SameSite=Lax'
    }

    await hydrateSsrApplication(definition)
    const mountedApp = browserApp!
    const mountedRouter = browserRouter!
    const mountedHydration = browserHydration!
    dispose = () => {
      mountedApp.unmount()
      mountedHydration.dispose()
      document.body.innerHTML = ''
    }

    expect(document.querySelector('.page-loader')).toBeNull()
    expect(document.querySelector('.vssl-loading-indicator')).toBeNull()
    const home = document.querySelector('.home-page')
    const header = document.querySelector('.persistent-header')
    const sidebar = document.querySelector('.persistent-sidebar')
    expect(home).not.toBeNull()

    const assign = vi.fn()
    const replace = vi.fn()
    const location = window.location
    vi.stubGlobal('location', {
      href: location.href,
      protocol: location.protocol,
      host: location.host,
      hostname: location.hostname,
      port: location.port,
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
      origin: location.origin,
      assign,
      replace,
    })

    let navigationFailure: unknown = Symbol('navigation pending')
    const navigationSettled = new Promise<void>((resolve) => {
      const remove = mountedRouter.afterEach((to, _from, failure) => {
        if (to.path !== '/dashboard') return
        navigationFailure = failure
        remove()
        resolve()
      })
    })
    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    document.querySelector<HTMLAnchorElement>('.dashboard-link')!.dispatchEvent(
      click
    )
    await waitForVisualLoading(15)

    expect(click.defaultPrevented).toBe(true)
    expect(middlewareStarted).toBe(true)
    if (options.authenticated) expect(observedSession).toBe('yes')
    expect(assign).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(window.history.state.current).not.toBe('/dashboard')
    expect(document.querySelector('.home-page')).toBe(home)
    expect(document.querySelector('.persistent-header')).toBe(header)
    expect(document.querySelector('.persistent-sidebar')).toBe(sidebar)
    expect(document.querySelector('.route-content .page-loader')).not.toBeNull()
    expect(document.querySelector('.vssl-loading-indicator')).not.toBeNull()

    gate.resolve()
    await navigationSettled
    await nextTick()

    expect(navigationFailure).toBeUndefined()
    expect(mountedRouter.currentRoute.value.path).toBe('/dashboard')
    expect(document.querySelector('.dashboard-page')?.textContent).toBe(
      'Dashboard page'
    )
    expect(document.querySelector('.home-page')).toBeNull()
    expect(document.querySelector('.persistent-header')).toBe(header)
    expect(document.querySelector('.persistent-sidebar')).toBe(sidebar)
    expect(document.querySelector('.page-loader')).toBeNull()
    expect(document.querySelector('.vssl-loading-indicator')).toBeNull()
    expect(assign).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
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

  it('hydrates SSR markup and keeps RouterLink middleware navigation client-side', async () => {
    await verifyHydratedRouterLinkLoading({
      id: 'hydrated-navigation-loading',
      authenticated: false,
    })
  })

  it('keeps authenticated SSR-hydrated RouterLink navigation client-side', async () => {
    await verifyHydratedRouterLinkLoading({
      id: 'hydrated-auth-navigation-loading',
      authenticated: true,
    })
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

  it('shows automatic loading UI while async middleware succeeds', async () => {
    const gate = deferred()
    const wait = defineMiddleware(async () => {
      await gate.promise
    })
    const About = defineComponent({ setup: () => () => h('main', 'About') })
    const Dashboard = defineComponent({
      setup: () => () => h('main', 'Dashboard'),
    })
    const Root = defineComponent({
      setup: () => () =>
        h('div', [
          h(LoadingIndicator, { delay: 0 }),
          h(
            RouteSuspense,
            { delay: 0 },
            {
              default: () => h(RouterView),
              fallback: () => h('div', { class: 'page-loader' }, 'Loading page'),
            }
          ),
        ]),
    })
    const controller = new AbortController()
    const created = await createSsrApplication(
      createTestApplication({
        id: 'middleware-loading-success',
        root: Root,
        routes: [
          { path: '/', component: About },
          { path: '/dashboard', component: Dashboard, meta: { middleware: [wait] } },
        ],
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
    await created.router!.isReady()
    const mount = document.createElement('div')
    document.body.append(mount)
    created.app.mount(mount)
    dispose = () => {
      created.app.unmount()
      controller.abort()
      created.hydration.dispose()
      mount.remove()
    }

    const navigation = created.router!.push('/dashboard')
    await waitForVisualLoading()
    expect(mount.querySelector('.page-loader')).not.toBeNull()
    expect(mount.querySelector('.vssl-loading-indicator')).not.toBeNull()
    expect(mount.textContent).toContain('About')

    gate.resolve()
    await navigation
    await nextTick()
    expect(mount.querySelector('.page-loader')).toBeNull()
    expect(mount.textContent).toContain('Dashboard')
  })

  it('removes loading UI after cancellation without recreating the current page', async () => {
    const gate = deferred()
    const cancel = defineMiddleware(async () => {
      await gate.promise
      return false
    })
    let setups = 0
    let unmounts = 0
    const About = defineComponent({
      setup() {
        setups += 1
        onUnmounted(() => {
          unmounts += 1
        })
        return () => h('main', 'About')
      },
    })
    const Root = defineComponent({
      setup: () => () =>
        h(
          RouteSuspense,
          { delay: 0 },
          {
            default: () => h(RouterView),
            fallback: () => h('div', { class: 'page-loader' }, 'Loading page'),
          }
        ),
    })
    const controller = new AbortController()
    const created = await createSsrApplication(
      createTestApplication({
        id: 'middleware-loading-cancel',
        root: Root,
        routes: [
          { path: '/', component: About },
          { path: '/blocked', component: Page, meta: { middleware: [cancel] } },
        ],
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
    await created.router!.isReady()
    const mount = document.createElement('div')
    document.body.append(mount)
    created.app.mount(mount)
    dispose = () => {
      created.app.unmount()
      controller.abort()
      created.hydration.dispose()
      mount.remove()
    }

    const navigation = created.router!.push('/blocked')
    await waitForVisualLoading()
    expect(mount.querySelector('.page-loader')).not.toBeNull()
    expect(setups).toBe(1)
    expect(unmounts).toBe(0)

    gate.resolve()
    await navigation
    await nextTick()
    expect(created.router!.currentRoute.value.path).toBe('/')
    expect(mount.querySelector('.page-loader')).toBeNull()
    expect(mount.textContent).toContain('About')
    expect(setups).toBe(1)
    expect(unmounts).toBe(0)
  })

  it('keeps loading continuous across a middleware redirect chain', async () => {
    const privateGate = deferred()
    const loginGate = deferred()
    const loginEntered = deferred()
    const redirect = defineMiddleware(async () => {
      await privateGate.promise
      return '/login'
    })
    const Root = defineComponent({
      setup: () => () =>
        h(
          RouteSuspense,
          { delay: 0 },
          {
            default: () => h(RouterView),
            fallback: () => h('div', { class: 'page-loader' }, 'Loading page'),
          }
        ),
    })
    const controller = new AbortController()
    const created = await createSsrApplication(
      createTestApplication({
        id: 'middleware-loading-redirect',
        root: Root,
        routes: [
          { path: '/', component: Page },
          { path: '/private', component: Page, meta: { middleware: [redirect] } },
          { path: '/login', component: defineComponent({ setup: () => () => h('main', 'Login') }) },
        ],
        install({ router }) {
          router!.beforeEach(async (to) => {
            if (to.path !== '/login') return
            loginEntered.resolve()
            await loginGate.promise
          })
        },
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
    await created.router!.isReady()
    const mount = document.createElement('div')
    document.body.append(mount)
    created.app.mount(mount)
    dispose = () => {
      created.app.unmount()
      controller.abort()
      created.hydration.dispose()
      mount.remove()
    }

    const navigation = created.router!.push('/private')
    await waitForVisualLoading()
    expect(mount.querySelector('.page-loader')).not.toBeNull()

    privateGate.resolve()
    await loginEntered.promise
    await nextTick()
    expect(mount.querySelector('.page-loader')).not.toBeNull()

    loginGate.resolve()
    await navigation
    await nextTick()
    expect(created.router!.currentRoute.value.path).toBe('/login')
    expect(mount.querySelector('.page-loader')).toBeNull()
    expect(mount.textContent).toContain('Login')
  })
})

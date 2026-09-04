// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KeepAlive,
  defineComponent,
  h,
  nextTick,
  onUnmounted,
  ref,
  type App,
  type VNode,
} from 'vue'
import {
  createRouter,
  RouterLink,
  RouterView,
  START_LOCATION,
  useRoute,
  type RouteRecordRaw,
  type Router,
} from 'vue-router'
import { createSsrApplication } from '../SsrApplicationRuntime'
import {
  hydrateSsrApplication,
  mountSpaApplication,
} from '../SsrBrowserRuntime'
import { LoadingIndicator } from '../navigation/LoadingIndicator'
import { RouterView as SsrRouterView } from '../navigation/RouterView'
import { renderSsrApplication } from '../SsrRenderRuntime'
import { getSsrStateElementId } from '../SsrSerialization'
import {
  createTestApplication,
  createTestDomain,
  createTestRenderRequest,
} from '../SsrTestFixtures'
import { defineMiddleware } from './defineMiddleware'
import type { Middleware } from './SsrMiddlewareTypes'

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

const waitForSuccessfulNavigationUi = async () => {
  // Successful navigation settles after the route's DOM update. That settle
  // schedules the loading components' own render update for the following tick.
  await nextTick()
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

  const create = async (
    routes: RouteRecordRaw[],
    middleware: readonly Middleware<any>[] = []
  ) => {
    const controller = new AbortController()
    const created = await createSsrApplication(
      createTestApplication({
        id: 'browser-middleware',
        root: Page,
        router: ({ history }) => createRouter({ history, routes }),
        middleware,
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
              SsrRouterView,
              { delay: 10 },
              {
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
    expect(document.querySelector('.home-page')).toBeNull()
    expect(document.querySelector('.persistent-header')).toBe(header)
    expect(document.querySelector('.persistent-sidebar')).toBe(sidebar)
    expect(document.querySelector('.route-content .page-loader')).not.toBeNull()
    expect(document.querySelector('.vssl-loading-indicator')).not.toBeNull()

    gate.resolve()
    await navigationSettled
    await waitForSuccessfulNavigationUi()

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

  it('runs middleware again when a user retries after cancelled SPA bootstrap', async () => {
    let allow = false
    let runs = 0
    let router!: Router
    const middleware = defineMiddleware(() => {
      runs += 1
      if (!allow) return false
    })
    const Root = defineComponent({
      setup: () => () =>
        h('div', [
          h(
            RouterLink,
            { class: 'blocked-link', to: '/blocked' },
            { default: () => 'Blocked' }
          ),
          h(RouterView),
        ]),
    })
    window.history.replaceState({}, '', '/blocked')
    const mount = document.createElement('div')
    mount.id = 'middleware-bootstrap-retry-app'
    document.body.append(mount)
    const mounted = await mountSpaApplication(
      {
        id: 'initial-cancel-retry',
        root: Root,
        routes: [
          {
            path: '/blocked',
            component: Page,
            meta: { middleware: [middleware] },
          },
        ],
        install(setup) {
          router = setup.router!
        },
      },
      {
        mountSelector: '#middleware-bootstrap-retry-app',
        url: '/blocked',
        domain: createTestDomain('localhost', { protocol: 'http' }),
        publicConfig: {},
      }
    )
    dispose = () => {
      mounted.unmount()
      mount.remove()
    }

    expect(runs).toBe(1)
    expect(router.currentRoute.value).toBe(START_LOCATION)
    expect(mount.querySelector('.blocked-link')).not.toBeNull()

    allow = true
    await router.push('/blocked')

    expect(runs).toBe(2)
    expect(router.currentRoute.value.path).toBe('/blocked')
  })

  it('does not replay successful authorization after downstream bootstrap cancellation', async () => {
    let authenticated = true
    let cancelInitial = true
    let runs = 0
    let router!: Router
    const auth = defineMiddleware(() => {
      runs += 1
      if (!authenticated) return '/login'
      return { props: { user: 'old-user' } }
    })
    window.history.replaceState({}, '', '/private')
    const mount = document.createElement('div')
    mount.id = 'middleware-bootstrap-auth-app'
    document.body.append(mount)
    const mounted = await mountSpaApplication(
      {
        id: 'initial-auth-cancel-retry',
        root: defineComponent({
          setup: () => () =>
            h('div', [
              h(
                RouterLink,
                { class: 'private-link', to: '/private' },
                { default: () => 'Private' }
              ),
              h(RouterView),
            ]),
        }),
        routes: [
          { path: '/login', component: Page },
          {
            path: '/private',
            component: Page,
            props: { existing: 'route' },
            meta: { middleware: [auth] },
          },
        ],
        install(setup) {
          router = setup.router!
          router.beforeEach((to) => {
            if (cancelInitial && to.path === '/private') return false
          })
        },
      },
      {
        mountSelector: '#middleware-bootstrap-auth-app',
        url: '/private',
        domain: createTestDomain('localhost', { protocol: 'http' }),
        publicConfig: {},
      }
    )
    dispose = () => {
      mounted.unmount()
      mount.remove()
    }
    const privateRecord = router.resolve('/private').matched[0]!

    expect(runs).toBe(1)
    expect(router.currentRoute.value).toBe(START_LOCATION)
    expect(privateRecord.props.default).toEqual({ existing: 'route' })

    authenticated = false
    cancelInitial = false
    await router.push('/private')

    expect(runs).toBe(2)
    expect(router.currentRoute.value.path).toBe('/login')
    expect(privateRecord.props.default).toEqual({ existing: 'route' })
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

  it('runs global middleware but preserves parent middleware and props until re-entry', async () => {
    let marker: string | undefined = 'first'
    let globalRuns = 0
    let parentRuns = 0
    const global = defineMiddleware(() => {
      globalRuns += 1
    })
    const middleware = defineMiddleware(() => {
      parentRuns += 1
      return marker === undefined ? undefined : { props: { marker } }
    })
    const router = await create(
      [
        { path: '/', component: Page },
        {
          path: '/parent',
          component: Page,
          props: { existing: 'route' },
          meta: { middleware: [middleware] },
          children: [{ path: 'child', component: Page }],
        },
      ],
      [global]
    )

    await router.push('/parent')
    const record = router.currentRoute.value.matched[0]!
    expect((record.props.default as Function)(router.currentRoute.value)).toEqual({
      existing: 'route',
      marker: 'first',
    })
    const globalRunsBeforeChild = globalRuns
    await router.push('/parent/child')
    expect(globalRuns).toBe(globalRunsBeforeChild + 1)
    expect(parentRuns).toBe(1)
    expect((record.props.default as Function)(router.currentRoute.value)).toEqual({
      existing: 'route',
      marker: 'first',
    })

    await router.push('/')
    marker = undefined
    await router.push('/parent/child')
    expect(parentRuns).toBe(2)
    expect(record.props.default).toEqual({ existing: 'route' })
  })

  it('preserves and refreshes middleware props across canonical and alias records', async () => {
    let marker: string | undefined = 'first'
    let middlewareRuns = 0
    const middleware = defineMiddleware(() => {
      middlewareRuns += 1
      return marker === undefined ? undefined : { props: { marker } }
    })
    const router = await create([
      { path: '/', component: Page },
      {
        path: '/account',
        alias: '/profile',
        component: Page,
        props: { existing: 'route' },
        meta: { middleware: [middleware] },
      },
    ])
    const currentProps = () => {
      const route = router.currentRoute.value
      const value = route.matched[0]!.props.default
      return typeof value === 'function' ? value(route) : value
    }

    await router.push('/account')
    expect(middlewareRuns).toBe(1)
    expect(currentProps()).toEqual({ existing: 'route', marker: 'first' })

    await router.push('/profile')
    expect(middlewareRuns).toBe(1)
    expect(currentProps()).toEqual({ existing: 'route', marker: 'first' })

    await router.push('/')
    marker = 'second'
    await router.push('/profile')
    expect(middlewareRuns).toBe(2)
    expect(currentProps()).toEqual({ existing: 'route', marker: 'second' })

    await router.push('/account')
    expect(middlewareRuns).toBe(2)
    expect(currentProps()).toEqual({ existing: 'route', marker: 'second' })

    await router.push('/')
    marker = undefined
    await router.push('/account')
    expect(middlewareRuns).toBe(3)
    expect(currentProps()).toEqual({ existing: 'route' })

    await router.push('/profile')
    expect(middlewareRuns).toBe(3)
    expect(currentProps()).toEqual({ existing: 'route' })
  })

  it('runs a fresh middleware chain when revisiting a superseded target', async () => {
    const gates = [deferred(), deferred()]
    const signals: AbortSignal[] = []
    const fromPaths: Array<string | null> = []
    let runs = 0
    const middleware = defineMiddleware(async ({ signal, from }) => {
      const run = ++runs
      signals.push(signal)
      fromPaths.push(from?.fullPath ?? null)
      await gates[run - 1]!.promise
      return { props: { marker: `run-${run}` } }
    })
    const router = await create([
      { path: '/', component: Page },
      { path: '/about', component: Page },
      { path: '/settings', component: Page },
      {
        path: '/dashboard',
        component: Page,
        props: { existing: 'route' },
        meta: { middleware: [middleware] },
      },
    ])
    await router.push('/about')

    const first = router.push('/dashboard')
    await waitForVisualLoading()
    expect(runs).toBe(1)

    await router.push('/settings')
    expect(router.currentRoute.value.path).toBe('/settings')
    expect(signals[0]?.aborted).toBe(true)

    const second = router.push('/dashboard')
    await waitForVisualLoading()
    expect(runs).toBe(2)
    expect(signals[1]).not.toBe(signals[0])
    expect(signals[1]?.aborted).toBe(false)
    expect(fromPaths).toEqual(['/about', '/settings'])

    gates[1]!.resolve()
    await second
    await nextTick()
    expect(router.currentRoute.value.path).toBe('/dashboard')
    const record = router.currentRoute.value.matched[0]!
    const resolver = record.props.default
    expect(typeof resolver).toBe('function')
    expect((resolver as Function)(router.currentRoute.value)).toEqual({
      existing: 'route',
      marker: 'run-2',
    })

    gates[0]!.resolve()
    await first
    await nextTick()
    expect(router.currentRoute.value.path).toBe('/dashboard')
    expect((record.props.default as Function)(router.currentRoute.value)).toEqual({
      existing: 'route',
      marker: 'run-2',
    })
  })

  it('rolls back middleware props when a downstream guard redirects to current', async () => {
    let marker: string | undefined = 'pending'
    let middlewareRuns = 0
    const middleware = defineMiddleware(() => {
      middlewareRuns += 1
      return marker === undefined ? undefined : { props: { marker } }
    })
    const router = await create([
      { path: '/', component: Page },
      { path: '/login', component: Page },
      {
        path: '/private',
        component: Page,
        props: { existing: 'route' },
        meta: { middleware: [middleware] },
      },
    ])
    await router.push('/login?redirect=/private')
    const privateRecord = router.resolve('/private').matched[0]!
    const originalProps = privateRecord.props.default
    const removeDownstreamGuard = router.beforeEach((to) => {
      if (to.path === '/private') {
        return {
          path: '/login',
          query: { redirect: '/private' },
        }
      }
    })

    await router.push('/private')

    expect(router.currentRoute.value.fullPath).toBe('/login?redirect=/private')
    expect(middlewareRuns).toBe(1)
    expect(privateRecord.props.default).toBe(originalProps)

    removeDownstreamGuard()
    marker = undefined
    await router.push('/private')
    expect(middlewareRuns).toBe(2)
    expect(router.currentRoute.value.path).toBe('/private')
    expect(privateRecord.props.default).toBe(originalProps)
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
            SsrRouterView,
            { delay: 0 },
            {
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
    expect(mount.textContent).not.toContain('About')

    gate.resolve()
    await navigation
    await waitForSuccessfulNavigationUi()
    expect(mount.querySelector('.page-loader')).toBeNull()
    expect(mount.textContent).toContain('Dashboard')
  })

  it('keeps superseded async setup generations out of the active route', async () => {
    const Home = defineComponent({
      setup: () => () => h('main', { class: 'home-page' }, 'Home'),
    })
    const About = defineComponent({
      setup: () => () => h('main', { class: 'about-page' }, 'About'),
    })
    const pageGates: ReturnType<typeof deferred>[] = []
    const Products = defineComponent({
      async setup() {
        const gate = deferred()
        pageGates.push(gate)
        await gate.promise
        return () => h('main', { class: 'products-page' }, 'Products')
      },
    })
    const Root = defineComponent({
      setup: () => () =>
        h('div', [
          h(LoadingIndicator, { delay: 0 }),
          h(
            SsrRouterView,
            { delay: 0 },
            {
              fallback: () =>
                h('div', { class: 'page-loader' }, 'Loading page'),
            }
          ),
        ]),
    })
    const controller = new AbortController()
    const created = await createSsrApplication(
      createTestApplication({
        id: 'async-setup-navigation-generation',
        root: Root,
        routes: [
          { path: '/', component: Home },
          { path: '/about', component: About },
          { path: '/products', component: Products },
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
    const errors: unknown[] = []
    const consoleErrors: unknown[][] = []
    created.app.config.errorHandler = (error) => errors.push(error)
    vi.spyOn(console, 'error').mockImplementation((...values) => {
      consoleErrors.push(values)
    })
    const mount = document.createElement('div')
    document.body.append(mount)
    created.app.mount(mount)
    dispose = () => {
      created.app.unmount()
      controller.abort()
      created.hydration.dispose()
      mount.remove()
    }

    await created.router!.push('/products')
    await waitForVisualLoading()
    expect(pageGates).toHaveLength(1)
    expect(mount.querySelector('.page-loader')).not.toBeNull()
    expect(mount.querySelector('.vssl-loading-indicator')).not.toBeNull()

    await created.router!.push('/about')
    await waitForSuccessfulNavigationUi()
    await nextTick()
    expect(mount.querySelector('.about-page')).not.toBeNull()
    expect(mount.querySelector('.products-page')).toBeNull()
    expect(mount.querySelector('.vssl-loading-indicator')).toBeNull()

    pageGates[0]!.resolve()
    await Promise.resolve()
    await nextTick()
    expect(mount.querySelector('.about-page')).not.toBeNull()
    expect(mount.querySelector('.products-page')).toBeNull()
    expect(mount.querySelector('.vssl-loading-indicator')).toBeNull()

    await created.router!.push('/products')
    await waitForVisualLoading()
    expect(pageGates).toHaveLength(2)
    expect(mount.querySelector('.vssl-loading-indicator')).not.toBeNull()
    pageGates[1]!.resolve()
    await waitForSuccessfulNavigationUi()
    await nextTick()
    await nextTick()
    expect(pageGates).toHaveLength(2)
    expect(mount.querySelector('.products-page')).not.toBeNull()
    expect(mount.querySelector('.vssl-loading-indicator')).toBeNull()

    await created.router!.push('/')
    await waitForSuccessfulNavigationUi()
    await nextTick()
    expect(mount.querySelector('.home-page')).not.toBeNull()
    expect(mount.querySelector('.products-page')).toBeNull()
    expect(errors).toEqual([])
    expect(consoleErrors).toEqual([])
  })

  it('preserves application-owned KeepAlive pages across async navigation', async () => {
    const productGate = deferred()
    let homeSetups = 0
    let productSetups = 0
    const Home = defineComponent({
      setup() {
        homeSetups += 1
        return () => h('main', { class: 'home-page' }, 'Home')
      },
    })
    const Products = defineComponent({
      async setup() {
        productSetups += 1
        await productGate.promise
        return () => h('main', { class: 'products-page' }, 'Products')
      },
    })
    const Root = defineComponent({
      setup: () => () =>
        h(
          SsrRouterView,
          { delay: 0 },
          {
            default: ({ Component }: { Component: VNode }) =>
              h(KeepAlive, null, { default: () => Component }),
            fallback: () =>
              h('div', { class: 'page-loader' }, 'Loading page'),
          }
        ),
    })
    const controller = new AbortController()
    const created = await createSsrApplication(
      createTestApplication({
        id: 'application-owned-keep-alive-navigation',
        root: Root,
        routes: [
          { path: '/', component: Home },
          { path: '/products', component: Products },
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
    const home = mount.querySelector('.home-page')

    await created.router!.push('/products')
    await waitForVisualLoading()
    expect(mount.querySelector('.page-loader')).not.toBeNull()
    productGate.resolve()
    await waitForSuccessfulNavigationUi()
    await nextTick()
    expect(mount.querySelector('.products-page')).not.toBeNull()

    await created.router!.push('/')
    await waitForSuccessfulNavigationUi()
    await nextTick()
    expect(mount.querySelector('.home-page')).toBe(home)
    expect(homeSetups).toBe(1)

    await created.router!.push('/products')
    await waitForSuccessfulNavigationUi()
    await nextTick()
    expect(mount.querySelector('.products-page')).not.toBeNull()
    expect(productSetups).toBe(1)
  })

  it('waits for application composition to mount and resolve the accepted page generation', async () => {
    const mountIncoming = ref(false)
    const productGate = deferred()
    let productSetups = 0
    const Home = defineComponent({
      setup: () => () => h('main', { class: 'home-page' }, 'Home'),
    })
    const Products = defineComponent({
      async setup() {
        productSetups += 1
        await productGate.promise
        return () => h('main', { class: 'products-page' }, 'Products')
      },
    })
    const Root = defineComponent({
      setup: () => () =>
        h('div', [
          h(LoadingIndicator, { delay: 0 }),
          h(
            SsrRouterView,
            { delay: 0 },
            {
              // An out-in transition can similarly withhold its incoming
              // branch. Model that contract directly so readiness cannot rely
              // on a Suspense event failing to appear within one tick.
              default: ({
                Component,
                route,
              }: {
                Component: VNode
                route: { path: string }
              }) =>
                route.path === '/products' && !mountIncoming.value
                  ? null
                  : Component,
              fallback: () =>
                h('div', { class: 'page-loader' }, 'Loading page'),
            }
          ),
        ]),
    })
    const controller = new AbortController()
    const created = await createSsrApplication(
      createTestApplication({
        id: 'transition-delayed-page-readiness',
        root: Root,
        routes: [
          { path: '/', component: Home },
          { path: '/products', component: Products },
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

    await created.router!.push('/products')
    await nextTick()
    await nextTick()

    expect(mount.querySelector('.products-page')).toBeNull()
    expect(productSetups).toBe(0)
    expect(mount.querySelector('.vssl-loading-indicator')).not.toBeNull()

    mountIncoming.value = true
    await waitForVisualLoading()
    expect(productSetups).toBe(1)
    expect(mount.querySelector('.page-loader')).not.toBeNull()
    expect(mount.querySelector('.vssl-loading-indicator')).not.toBeNull()

    productGate.resolve()
    await vi.waitFor(() =>
      expect(mount.querySelector('.products-page')).not.toBeNull()
    )
    await vi.waitFor(() =>
      expect(mount.querySelector('.vssl-loading-indicator')).toBeNull()
    )
  })

  it('waits for the initial SPA async page before scrolling without starting the navigation indicator', async () => {
    window.history.replaceState({}, '', '/products#details')
    const productGate = deferred()
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
    let setupStarted = false
    const Products = defineComponent({
      async setup() {
        setupStarted = true
        await productGate.promise
        return () => h('main', { id: 'details' }, 'Product details')
      },
    })
    const Root = defineComponent({
      setup: () => () => h('div', [
        h(LoadingIndicator, { delay: 0 }),
        h(SsrRouterView, { delay: 0 }, {
          fallback: () => h('div', { class: 'page-loader' }, 'Loading page'),
        }),
      ]),
    })
    const controller = new AbortController()
    const created = await createSsrApplication(
      createTestApplication({
        id: 'initial-spa-page-owned-hash-scroll',
        root: Root,
        routes: [{ path: '/products', component: Products }],
      }),
      {
        server: false,
        spa: true,
        request: createTestRenderRequest('localhost', {
          url: 'http://localhost/products#details',
          protocol: 'http',
          signal: controller.signal,
        }),
      }
    )
    await created.router!.isReady()
    await waitForVisualLoading()
    expect(setupStarted).toBe(false)
    expect(scrollTo).not.toHaveBeenCalled()
    const mount = document.createElement('div')
    document.body.append(mount)
    created.app.mount(mount)
    dispose = () => {
      created.app.unmount()
      controller.abort()
      created.hydration.dispose()
      mount.remove()
    }

    await waitForVisualLoading()
    expect(setupStarted).toBe(true)
    expect(document.getElementById('details')).toBeNull()
    expect(scrollTo).not.toHaveBeenCalled()
    expect(mount.querySelector('.vssl-loading-indicator')).toBeNull()

    productGate.resolve()
    await vi.waitFor(() => expect(scrollTo).toHaveBeenCalled())
    expect(document.getElementById('details')?.textContent).toBe('Product details')
    expect(mount.querySelector('.vssl-loading-indicator')).toBeNull()
    expect(mount.querySelector('.page-loader')).toBeNull()
  })

  it('releases initial scrolling after a plain RouterView root with an exposed instance mounts', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
    const Root = defineComponent({
      setup(_props, { expose }) {
        // Script-setup roots also expose a different public instance. Root
        // detection must not depend on comparing that instance with `this`.
        expose({})
        return () => h(RouterView)
      },
    })
    const controller = new AbortController()
    const created = await createSsrApplication(
      createTestApplication({
        id: 'initial-plain-outlet-scroll',
        root: Root,
        routes: [{ path: '/', component: Page }],
        scrollBehavior: () => ({ top: 73 }),
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
    await waitForVisualLoading()
    expect(scrollTo).not.toHaveBeenCalled()

    const mount = document.createElement('div')
    document.body.append(mount)
    created.app.mount(mount)
    dispose = () => {
      created.app.unmount()
      controller.abort()
      created.hydration.dispose()
      mount.remove()
    }
    await vi.waitFor(() => expect(scrollTo).toHaveBeenCalled())
    expect(mount.querySelector('main')).not.toBeNull()
  })

  it('delays default hash scrolling until the async destination page is ready', async () => {
    const productGate = deferred()
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
    const Products = defineComponent({
      async setup() {
        await productGate.promise
        return () =>
          h('main', { class: 'products-page' }, [
            h('div', { id: 'details' }, 'Details'),
          ])
      },
    })
    const Root = defineComponent({
      setup: () => () =>
        h(SsrRouterView, { delay: 0 }, {
          fallback: () => h('div', { class: 'page-loader' }, 'Loading page'),
        }),
    })
    const controller = new AbortController()
    const created = await createSsrApplication(
      createTestApplication({
        id: 'page-owned-default-hash-scroll',
        root: Root,
        routes: [
          { path: '/', component: Page },
          { path: '/products', component: Products },
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
    await waitForVisualLoading()
    scrollTo.mockClear()
    dispose = () => {
      created.app.unmount()
      controller.abort()
      created.hydration.dispose()
      mount.remove()
    }

    await created.router!.push('/products#details')
    await waitForVisualLoading()
    expect(document.getElementById('details')).toBeNull()
    expect(scrollTo).not.toHaveBeenCalled()

    productGate.resolve()
    await waitForSuccessfulNavigationUi()
    await vi.waitFor(() => expect(scrollTo).toHaveBeenCalled())
    expect(document.getElementById('details')).not.toBeNull()
  })

  it('discards a custom scroll result after its page generation is superseded', async () => {
    const productScrollStarted = deferred()
    const productScrollResult = deferred()
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
    const Root = defineComponent({
      setup: () => () => h(SsrRouterView),
    })
    const controller = new AbortController()
    const created = await createSsrApplication(
      createTestApplication({
        id: 'stale-custom-scroll-generation',
        root: Root,
        routes: [
          { path: '/', component: Page },
          { path: '/products', component: Page },
          { path: '/about', component: Page },
        ],
        async scrollBehavior(to) {
          if (to.path === '/products') {
            productScrollStarted.resolve()
            await productScrollResult.promise
            return { top: 111 }
          }
          return { top: 222 }
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
    await waitForVisualLoading()
    scrollTo.mockClear()
    dispose = () => {
      created.app.unmount()
      controller.abort()
      created.hydration.dispose()
      mount.remove()
    }

    await created.router!.push('/products')
    await productScrollStarted.promise
    await created.router!.push('/about')
    await vi.waitFor(() =>
      expect(
        scrollTo.mock.calls.some((call) => JSON.stringify(call).includes('222'))
      ).toBe(true)
    )

    productScrollResult.resolve()
    await Promise.resolve()
    await nextTick()
    expect(
      scrollTo.mock.calls.some((call) => JSON.stringify(call).includes('111'))
    ).toBe(false)
  })

  it('keeps Vue Router reuse semantics for params and query changes', async () => {
    let setups = 0
    const ReusedPage = defineComponent({
      setup() {
        setups += 1
        const route = useRoute()
        return () =>
          h('main', { class: 'reused-page' }, route.fullPath)
      },
    })
    const Root = defineComponent({
      setup: () => () =>
        h(
          SsrRouterView,
          { delay: 0 },
          {
            fallback: () =>
              h('div', { class: 'page-loader' }, 'Loading page'),
          }
        ),
    })
    const controller = new AbortController()
    const created = await createSsrApplication(
      createTestApplication({
        id: 'route-component-reuse-navigation',
        root: Root,
        routes: [{ path: '/items/:id', component: ReusedPage }],
      }),
      {
        server: false,
        spa: true,
        request: createTestRenderRequest('localhost', {
          url: 'http://localhost/items/one?view=full',
          protocol: 'http',
          signal: controller.signal,
        }),
      }
    )
    await created.router!.isReady()
    await created.router!.push('/items/one?view=full')
    const mount = document.createElement('div')
    document.body.append(mount)
    created.app.mount(mount)
    dispose = () => {
      created.app.unmount()
      controller.abort()
      created.hydration.dispose()
      mount.remove()
    }
    const page = mount.querySelector('.reused-page')

    await created.router!.push('/items/two?view=compact')
    await waitForSuccessfulNavigationUi()
    await nextTick()

    expect(mount.querySelector('.reused-page')).toBe(page)
    expect(page?.textContent).toBe('/items/two?view=compact')
    expect(setups).toBe(1)
    expect(mount.querySelector('.page-loader')).toBeNull()
  })

  it.each([
    { outcome: 'cancel', nested: false },
    { outcome: 'cancel', nested: true },
    { outcome: 'error', nested: false },
    { outcome: 'redirect-back', nested: false },
  ])('preserves a pending page and its hash scroll after $outcome (nested: $nested)', async ({ outcome, nested }) => {
    const productGate = deferred()
    const cancellationGate = deferred()
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
    const cancel = defineMiddleware(async () => {
      await cancellationGate.promise
      if (outcome === 'error') throw new Error('rejected attempt')
      if (outcome === 'redirect-back') return '/products#details'
      return false
    })
    const Products = defineComponent({
      async setup() {
        await productGate.promise
        return () => h('main', { class: 'products-page', id: 'details' }, 'Products')
      },
    })
    const Root = defineComponent({
      setup: () => () =>
        h('div', [
          h(LoadingIndicator, { delay: 0 }),
          h(
            SsrRouterView,
            { delay: 0 },
            {
              fallback: () =>
                h('div', { class: 'page-loader' }, 'Loading page'),
            }
          ),
        ]),
    })
    const Layout = defineComponent({
      setup: () => () => h(SsrRouterView, { delay: 0 }, {
        fallback: () => h('div', { class: 'page-loader' }, 'Loading child page'),
      }),
    })
    const pages: RouteRecordRaw[] = [
      { path: nested ? '' : '/', component: Page },
      { path: nested ? 'products' : '/products', component: Products },
      {
        path: nested ? 'blocked' : '/blocked',
        component: Page,
        meta: { middleware: [cancel] },
      },
    ]
    const controller = new AbortController()
    const created = await createSsrApplication(
      createTestApplication({
        id: 'cancelled-navigation-over-pending-page',
        root: Root,
        routes: nested ? [{ path: '/', component: Layout, children: pages }] : pages,
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
    created.router!.onError(() => undefined)
    dispose = () => {
      created.app.unmount()
      controller.abort()
      created.hydration.dispose()
      mount.remove()
    }

    await waitForVisualLoading()
    scrollTo.mockClear()
    await created.router!.push('/products#details')
    await waitForVisualLoading()
    expect(scrollTo).not.toHaveBeenCalled()
    const cancelled = created.router!.push('/blocked').catch((error: unknown) => error)
    await waitForVisualLoading()
    cancellationGate.resolve()
    const failure = await cancelled
    if (outcome === 'error') expect(failure).toEqual(new Error('rejected attempt'))
    await nextTick()

    expect(created.router!.currentRoute.value.fullPath).toBe('/products#details')
    expect(scrollTo).not.toHaveBeenCalled()
    expect(mount.querySelector('.page-loader')).not.toBeNull()
    expect(mount.querySelector('.vssl-loading-indicator')).not.toBeNull()

    productGate.resolve()
    await waitForSuccessfulNavigationUi()
    await nextTick()
    await nextTick()
    expect(mount.querySelector('.products-page')).not.toBeNull()
    expect(mount.querySelector('.page-loader')).toBeNull()
    expect(mount.querySelector('.vssl-loading-indicator')).toBeNull()
    await vi.waitFor(() => expect(scrollTo).toHaveBeenCalled())
    expect(document.getElementById('details')).not.toBeNull()
  })

  it('keeps one loading clock when middleware redirects to an async page', async () => {
    const productGate = deferred()
    const redirect = defineMiddleware(() => '/products')
    const Products = defineComponent({
      async setup() {
        await productGate.promise
        return () => h('main', { class: 'products-page' }, 'Products')
      },
    })
    const Root = defineComponent({
      setup: () => () =>
        h('div', [
          h(LoadingIndicator, { delay: 0 }),
          h(
            SsrRouterView,
            { delay: 0 },
            {
              fallback: () =>
                h('div', { class: 'page-loader' }, 'Loading page'),
            }
          ),
        ]),
    })
    const controller = new AbortController()
    const created = await createSsrApplication(
      createTestApplication({
        id: 'redirect-to-async-page-navigation',
        root: Root,
        routes: [
          { path: '/', component: Page },
          {
            path: '/private',
            component: Page,
            meta: { middleware: [redirect] },
          },
          { path: '/products', component: Products },
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

    await created.router!.push('/private')
    await waitForVisualLoading()
    expect(created.router!.currentRoute.value.path).toBe('/products')
    expect(mount.querySelector('.page-loader')).not.toBeNull()
    expect(mount.querySelector('.vssl-loading-indicator')).not.toBeNull()

    productGate.resolve()
    await waitForSuccessfulNavigationUi()
    await nextTick()
    await nextTick()
    expect(mount.querySelector('.products-page')).not.toBeNull()
    expect(mount.querySelector('.page-loader')).toBeNull()
    expect(mount.querySelector('.vssl-loading-indicator')).toBeNull()
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
          SsrRouterView,
          { delay: 0 },
          {
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

  it('settles loading when middleware redirects back to the already-current route', async () => {
    const gate = deferred()
    const redirect = defineMiddleware(async ({ to }) => {
      await gate.promise
      return {
        path: '/login',
        query: { redirect: to.fullPath },
      }
    })
    const Login = defineComponent({
      setup: () => () => h('main', { class: 'login-page' }, 'Login'),
    })
    const Root = defineComponent({
      setup: () => () =>
        h('div', [
          h(LoadingIndicator, { delay: 0 }),
          h(
            RouterLink,
            { class: 'dashboard-link', to: '/dashboard' },
            { default: () => 'Dashboard' }
          ),
          h(
            SsrRouterView,
            { delay: 0 },
            {
              fallback: () =>
                h('div', { class: 'page-loader' }, 'Loading page'),
            }
          ),
        ]),
    })
    const controller = new AbortController()
    const created = await createSsrApplication(
      createTestApplication({
        id: 'middleware-redirect-current-loading',
        root: Root,
        routes: [
          { path: '/', component: Page },
          { path: '/login', component: Login },
          {
            path: '/dashboard',
            component: Page,
            meta: { middleware: [redirect] },
          },
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
    await created.router!.push('/login?redirect=/dashboard')
    const mount = document.createElement('div')
    document.body.append(mount)
    created.app.mount(mount)
    dispose = () => {
      created.app.unmount()
      controller.abort()
      created.hydration.dispose()
      mount.remove()
    }
    const login = mount.querySelector('.login-page')
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
    const navigationSettled = new Promise<void>((resolve) => {
      const remove = created.router!.afterEach((to) => {
        if (
          to.fullPath !== '/login?redirect=/dashboard' ||
          to.redirectedFrom?.fullPath !== '/dashboard'
        ) {
          return
        }
        remove()
        resolve()
      })
    })

    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    mount.querySelector<HTMLAnchorElement>('.dashboard-link')!.dispatchEvent(
      click
    )
    await waitForVisualLoading()
    expect(click.defaultPrevented).toBe(true)
    expect(mount.querySelector('.page-loader')).not.toBeNull()
    expect(mount.querySelector('.vssl-loading-indicator')).not.toBeNull()

    gate.resolve()
    await navigationSettled
    await nextTick()
    expect(created.router!.currentRoute.value.fullPath).toBe(
      '/login?redirect=/dashboard'
    )
    expect(mount.querySelector('.page-loader')).toBeNull()
    expect(mount.querySelector('.vssl-loading-indicator')).toBeNull()
    expect(mount.querySelector('.login-page')).toBe(login)
    expect(assign).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
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
          SsrRouterView,
          { delay: 0 },
          {
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

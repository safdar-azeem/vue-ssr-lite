import { describe, expect, it } from 'vitest'
import { defineComponent, h, inject } from 'vue'
import { RouterView, type RouteRecordRaw } from 'vue-router'
import { SSR_REQUEST_RESOLUTION } from '../SsrRequestResolution'
import { renderSsrApplication } from '../SsrRenderRuntime'
import {
  createTestApplication,
  createTestRenderRequest,
} from '../SsrTestFixtures'
import { defineMiddleware } from './defineMiddleware'

const RouterRoot = defineComponent({ setup: () => () => h(RouterView) })

describe('universal middleware SSR runtime', () => {
  it('executes middleware in the owning Vue application injection context', async () => {
    const injectionKey = Symbol('middleware-plugin')
    let observed: string | undefined
    const middleware = defineMiddleware(() => {
      observed = inject(injectionKey)
    })

    await renderSsrApplication(
      createTestApplication({
        id: 'middleware-injection-context',
        root: RouterRoot,
        routes: [{ path: '/', component: defineComponent({ render: () => h('main') }) }],
        middleware: [middleware],
        install({ app }) {
          app.provide(injectionKey, 'installed')
        },
      }),
      createTestRenderRequest('middleware.test')
    )

    expect(observed).toBe('installed')
  })

  it('executes global, parent, and child middleware for a direct nested SSR target', async () => {
    const order: string[] = []
    const global = defineMiddleware(async () => {
      await Promise.resolve()
      order.push('global')
    })
    const parentFirst = defineMiddleware(() => {
      order.push('parent-first')
      return { props: { user: 'john', collision: 'first' } }
    })
    const parentSecond = defineMiddleware(() => {
      order.push('parent-second')
      return { props: { collision: 'second' } }
    })
    const child = defineMiddleware(() => {
      order.push('child')
    })
    const Parent = defineComponent({
      props: ['existing', 'user', 'collision'],
      setup(props) {
        return () =>
          h('main', [
            h('p', `${props.existing}:${props.user}:${props.collision}`),
            h(RouterView),
          ])
      },
    })
    const Child = defineComponent({ setup: () => () => h('span', 'nested') })
    const routes: RouteRecordRaw[] = [
      {
        path: '/dashboard',
        component: Parent,
        props: (route) => ({ existing: route.query.source }),
        meta: { middleware: [global, parentFirst, parentSecond] },
        children: [
          {
            path: 'nested',
            component: Child,
            meta: { middleware: [child, parentFirst] },
          },
        ],
      },
    ]
    const rendered = await renderSsrApplication(
      createTestApplication({
        id: 'middleware-order',
        root: RouterRoot,
        routes,
        middleware: [global],
      }),
      createTestRenderRequest('middleware.test', {
        url: 'https://middleware.test/dashboard/nested?source=route',
      })
    )

    expect(order).toEqual(['global', 'parent-first', 'parent-second', 'child'])
    expect(rendered.html).toContain('route:john:second')
    expect(rendered.html).toContain('nested')
  })

  it('turns an internal middleware redirect into an early SSR response redirect', async () => {
    let protectedSetups = 0
    let loginSetups = 0
    const redirect = defineMiddleware(({ to }) => ({
      path: '/login',
      query: { redirect: to.fullPath },
    }))
    const routes: RouteRecordRaw[] = [
      {
        path: '/private',
        component: defineComponent({
          setup() {
            protectedSetups += 1
            return () => h('main', 'private')
          },
        }),
        meta: { middleware: [redirect] },
      },
      {
        path: '/login',
        component: defineComponent({
          setup() {
            loginSetups += 1
            return () => h('main', 'login')
          },
        }),
      },
    ]
    const rendered = await renderSsrApplication(
      createTestApplication({ id: 'middleware-redirect', root: RouterRoot, routes }),
      createTestRenderRequest('middleware.test', {
        url: 'https://middleware.test/private',
      })
    )

    expect(rendered.response.redirect).toEqual({
      location: '/login?redirect=/private',
      statusCode: 302,
      allowExternal: false,
    })
    expect(rendered.html).toBe('')
    expect(protectedSetups).toBe(0)
    expect(loginSetups).toBe(0)
  })

  it('does not render an initially cancelled SSR target', async () => {
    let setups = 0
    const cancel = defineMiddleware(() => false)
    const rendered = await renderSsrApplication(
      createTestApplication({
        id: 'middleware-cancel',
        root: RouterRoot,
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
      }),
      createTestRenderRequest('middleware.test', {
        url: 'https://middleware.test/blocked',
      })
    )
    expect(rendered.html).toBe('')
    expect(rendered.response.redirect).toBeNull()
    expect(setups).toBe(0)
  })

  it('preserves explicit status and external intent from context.redirect()', async () => {
    const redirect = defineMiddleware(({ redirect: redirectTo }) =>
      redirectTo('https://accounts.example.test/sign-in', {
        external: true,
        status: 307,
      })
    )
    const rendered = await renderSsrApplication(
      createTestApplication({
        id: 'middleware-special-redirect',
        root: RouterRoot,
        routes: [
          {
            path: '/',
            component: defineComponent({ setup: () => () => h('main') }),
            meta: { middleware: [redirect] },
          },
        ],
      }),
      createTestRenderRequest('middleware.test')
    )
    expect(rendered.response.redirect).toEqual({
      location: 'https://accounts.example.test/sign-in',
      statusCode: 307,
      allowExternal: true,
    })
    expect(rendered.html).toBe('')
  })

  it('reuses accepted middleware results across recreated SSR applications', async () => {
    let middlewareRuns = 0
    let renders = 0
    const props = defineMiddleware(() => {
      middlewareRuns += 1
      return { props: { marker: 'cached' } }
    })
    const Page = defineComponent({
      props: ['marker'],
      setup(pageProps) {
        renders += 1
        const resolution = inject(SSR_REQUEST_RESOLUTION)!
        if (resolution.pass === 0) resolution.requestAdditionalPass()
        return () => h('main', pageProps.marker)
      },
    })
    const rendered = await renderSsrApplication(
      createTestApplication({
        id: 'middleware-reconciliation',
        root: RouterRoot,
        routes: [{ path: '/', component: Page, meta: { middleware: [props] } }],
      }),
      createTestRenderRequest('middleware.test'),
      { maxResolutionPasses: 2 }
    )
    expect(rendered.metrics.renderPasses).toBe(2)
    expect(middlewareRuns).toBe(1)
    expect(renders).toBe(2)
    expect(rendered.html).toContain('cached')
  })

  it('isolates middleware cookies and props across concurrent requests', async () => {
    const session = defineMiddleware(async ({ cookies }) => {
      await Promise.resolve()
      return { props: { session: cookies.get('session') } }
    })
    const Page = defineComponent({
      props: ['session'],
      setup(props) {
        return () => h('main', props.session)
      },
    })
    const application = createTestApplication({
      id: 'middleware-isolation',
      root: RouterRoot,
      routes: [{ path: '/', component: Page, meta: { middleware: [session] } }],
    })
    const [left, right] = await Promise.all([
      renderSsrApplication(
        application,
        createTestRenderRequest('left.test', {
          headers: { cookie: 'session=left' },
        })
      ),
      renderSsrApplication(
        application,
        createTestRenderRequest('right.test', {
          headers: { cookie: 'session=right' },
        })
      ),
    ])
    expect(left.html).toContain('left')
    expect(left.html).not.toContain('right')
    expect(right.html).toContain('right')
    expect(right.html).not.toContain('left')
  })
})

import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createSsrMiddlewarePropsRuntime } from './SsrMiddlewareProps'

const Page = defineComponent({ setup: () => () => h('main') })

describe('transactional middleware route props', () => {
  it('composes boolean, static, and function route props', () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/boolean/:id', component: Page, props: true },
        { path: '/static', component: Page, props: { existing: 'static' } },
        {
          path: '/function/:id',
          component: Page,
          props: (route) => ({ existing: route.params.id }),
        },
      ],
    })
    for (const path of ['/boolean/1', '/static', '/function/2']) {
      const runtime = createSsrMiddlewarePropsRuntime()
      const route = router.resolve(path)
      const transaction = runtime.prepare(
        route,
        [
          {
            matchedIndex: 0,
            props: { middleware: path, existing: 'override' },
          },
        ],
        [0]
      )
      transaction.commit()
      const resolver = route.matched[0]!.props.default
      expect(typeof resolver).toBe('function')
      expect(
        (resolver as (value: typeof route) => Record<string, unknown>)(route)
      ).toMatchObject({
        existing: 'override',
        middleware: path,
      })
      if (path === '/boolean/1') {
        expect(
          (resolver as (value: typeof route) => Record<string, unknown>)(route)
            .id
        ).toBe('1')
      }
      runtime.dispose()
    }
  })

  it('rolls back a pending mutation and leaves named-view props untouched', () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/views',
          components: { default: Page, sidebar: Page },
          props: {
            default: { existing: 'default' },
            sidebar: { existing: 'sidebar' },
          },
        },
      ],
    })
    const route = router.resolve('/views')
    const runtime = createSsrMiddlewarePropsRuntime()
    const originalDefault = route.matched[0]!.props.default
    const originalSidebar = route.matched[0]!.props.sidebar
    const transaction = runtime.prepare(
      route,
      [{ matchedIndex: 0, props: { middleware: true } }],
      [0]
    )
    transaction.commit()
    expect(route.matched[0]!.props.sidebar).toBe(originalSidebar)
    transaction.rollback()
    expect(route.matched[0]!.props.default).toBe(originalDefault)
    expect(route.matched[0]!.props.sidebar).toBe(originalSidebar)
  })

  it('does not restore an obsolete props layer after overlapping navigations settle', () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/item/:id', component: Page, props: { base: true } }],
    })
    const runtime = createSsrMiddlewarePropsRuntime()
    const firstRoute = router.resolve('/item/first')
    const secondRoute = router.resolve('/item/second')
    const record = firstRoute.matched[0]!
    const first = runtime.prepare(
      firstRoute,
      [{ matchedIndex: 0, props: { marker: 'first' } }],
      [0]
    )
    const second = runtime.prepare(
      secondRoute,
      [{ matchedIndex: 0, props: { marker: 'second' } }],
      [0]
    )

    first.commit()
    second.commit()
    first.rollback()
    second.rollback()
    expect(record.props.default).toEqual({ base: true })
  })

  it('fails clearly when the declaring route has no default view', () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/named-only',
          components: { sidebar: Page },
        },
      ],
    })
    const route = router.resolve('/named-only')
    expect(() =>
      createSsrMiddlewarePropsRuntime().prepare(
        route,
        [{ matchedIndex: 0, props: { invalid: true } }],
        [0]
      )
    ).toThrow(/no default view/)
  })

  it('preserves accepted parent props when only a child record is entered', () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/parent',
          component: Page,
          props: { existing: 'route' },
          children: [{ path: 'child', component: Page }],
        },
      ],
    })
    const runtime = createSsrMiddlewarePropsRuntime()
    const parent = router.resolve('/parent')
    const enteredParent = runtime.prepare(
      parent,
      [{ matchedIndex: 0, props: { marker: 'first' } }],
      [0]
    )
    enteredParent.commit()
    enteredParent.accept()

    const child = router.resolve('/parent/child')
    const enteredChild = runtime.prepare(child, [], [1])
    enteredChild.commit()
    enteredChild.accept()

    const resolver = child.matched[0]!.props.default
    expect(typeof resolver).toBe('function')
    expect(
      (resolver as (route: typeof child) => Record<string, unknown>)(child)
    ).toEqual({
      existing: 'route',
      marker: 'first',
    })
  })

  it('clears accepted props when the record is entered again without new props', () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/parent', component: Page, props: { existing: 'route' } },
      ],
    })
    const runtime = createSsrMiddlewarePropsRuntime()
    const route = router.resolve('/parent')
    const first = runtime.prepare(
      route,
      [{ matchedIndex: 0, props: { marker: 'old' } }],
      [0]
    )
    first.commit()
    first.accept()

    const reentry = runtime.prepare(route, [], [0])
    reentry.commit()
    reentry.accept()
    expect(route.matched[0]!.props.default).toEqual({ existing: 'route' })
  })

  it('shares accepted props across canonical and alias route records', () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/account',
          alias: '/profile',
          component: Page,
          props: { existing: 'route' },
        },
      ],
    })
    const runtime = createSsrMiddlewarePropsRuntime()
    const canonical = router.resolve('/account')
    const enteredCanonical = runtime.prepare(
      canonical,
      [{ matchedIndex: 0, props: { marker: 'first' } }],
      [0]
    )
    enteredCanonical.commit()
    enteredCanonical.accept()

    const alias = router.resolve('/profile')
    const aliasUpdate = runtime.prepare(alias, [], [])
    aliasUpdate.commit()
    aliasUpdate.accept()
    const aliasResolver = alias.matched[0]!.props.default
    expect(typeof aliasResolver).toBe('function')
    expect(
      (aliasResolver as (route: typeof alias) => Record<string, unknown>)(alias)
    ).toEqual({
      existing: 'route',
      marker: 'first',
    })

    const aliasReentry = runtime.prepare(alias, [], [0])
    aliasReentry.commit()
    aliasReentry.accept()
    expect(alias.matched[0]!.props.default).toEqual({ existing: 'route' })

    const canonicalUpdate = runtime.prepare(canonical, [], [])
    canonicalUpdate.commit()
    canonicalUpdate.accept()
    expect(canonical.matched[0]!.props.default).toEqual({ existing: 'route' })
  })
})

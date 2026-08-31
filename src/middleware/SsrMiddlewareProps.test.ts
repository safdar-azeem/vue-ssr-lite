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
      const transaction = runtime.prepare(route, [
        { matchedIndex: 0, props: { middleware: path, existing: 'override' } },
      ])
      transaction.commit()
      const resolver = route.matched[0]!.props.default
      expect(typeof resolver).toBe('function')
      expect((resolver as (value: typeof route) => Record<string, unknown>)(route)).toMatchObject({
        existing: 'override',
        middleware: path,
      })
      if (path === '/boolean/1') {
        expect((resolver as (value: typeof route) => Record<string, unknown>)(route).id).toBe('1')
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
    const transaction = runtime.prepare(route, [
      { matchedIndex: 0, props: { middleware: true } },
    ])
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
    const first = runtime.prepare(firstRoute, [
      { matchedIndex: 0, props: { marker: 'first' } },
    ])
    const second = runtime.prepare(secondRoute, [
      { matchedIndex: 0, props: { marker: 'second' } },
    ])

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
      createSsrMiddlewarePropsRuntime().prepare(route, [
        { matchedIndex: 0, props: { invalid: true } },
      ])
    ).toThrow(/no default view/)
  })
})
